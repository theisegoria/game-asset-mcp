#!/usr/bin/env python3

import hashlib
import json
import pathlib
import stat
import struct
import sys

SCRIPT_PATH = pathlib.Path(__file__).absolute()
ROOT = SCRIPT_PATH.parents[1]
PLUGIN = ROOT / "plugins" / "game-development-studio"
ROSTER_PATH = ROOT / "release-roster.json"
PLUGIN_ROOT = PLUGIN.resolve()
PRIVACY_POLICY_URL = "https://github.com/theisegoria/game-development-studio-skills/blob/main/PRIVACY.md"
TERMS_OF_SERVICE_URL = "https://github.com/theisegoria/game-development-studio-skills/blob/main/TERMS.md"
ICON_DIMENSIONS = (1254, 1254)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_json(path: pathlib.Path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def png_size(path: pathlib.Path) -> tuple[int, int]:
    data = path.read_bytes()[:24]
    require(len(data) == 24, f"{path} is not a complete PNG")
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG")
    require(data[12:16] == b"IHDR", f"{path} has no PNG IHDR")
    return struct.unpack(">II", data[16:24])


def local_path(relative: object, label: str) -> pathlib.Path:
    require(isinstance(relative, str) and relative.startswith("./"), f"{label} must begin with ./")
    resolved = (PLUGIN / relative).resolve()
    try:
        resolved.relative_to(PLUGIN_ROOT)
    except ValueError as error:
        raise RuntimeError(f"{label} escapes the plugin root") from error
    return resolved


def _roster_paths(roster: dict, field: str) -> list[str]:
    values = roster.get(field)
    require(isinstance(values, list), f"release roster {field} must be an array")
    normalized: list[str] = []
    for value in values:
        require(isinstance(value, str) and value, f"release roster {field} contains an invalid path")
        path = pathlib.PurePosixPath(value)
        require(not path.is_absolute() and ".." not in path.parts, f"release roster {field} escapes its root")
        require("\\" not in value, f"release roster {field} must use POSIX paths")
        normalized.append(value)
    require(len(set(normalized)) == len(normalized), f"release roster {field} contains duplicate paths")
    return normalized


def load_roster() -> dict:
    info = ROSTER_PATH.lstat()
    require(not stat.S_ISLNK(info.st_mode), "release roster must not be a symlink")
    require(stat.S_ISREG(info.st_mode), "release roster must be a regular file")
    require((info.st_mode & 0o111) == 0, "release roster must not be executable")
    roster = load_json(ROSTER_PATH)
    require(roster.get("schema") == "game_dev.skills_release_roster.v1", "unexpected skills release roster schema")
    for field in [
        "repositoryFiles",
        "pluginFiles",
        "templateFiles",
        "templateOnlyFiles",
        "sourceOnlyFiles",
        "sourceOnlyDirectoryPrefixes",
    ]:
        _roster_paths(roster, field)
    return roster


def forbidden_artifact(relative: pathlib.PurePosixPath) -> str | None:
    basename = relative.name.lower()
    if basename == ".env" or basename.startswith(".env."):
        return ".env files are not releasable"
    if basename.endswith((".key", ".pem", ".crt", ".cer", ".csr", ".p12", ".pfx", ".der", ".jks", ".keystore")):
        return "credential and certificate files are not releasable"
    if basename.endswith((
        ".swift", ".m", ".mm", ".h", ".hpp", ".c", ".cc", ".cpp", ".rs", ".go", ".java", ".kt",
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rb", ".php", ".sh", ".bash", ".zsh", ".fish",
    )):
        return "source files are not releasable"
    return None


def validate_tree(
    tree: pathlib.Path,
    expected_paths: list[str],
    label: str,
    *,
    reject_source_artifacts: bool = False,
) -> None:
    expected = set(expected_paths)
    actual: set[str] = set()

    def walk(path: pathlib.Path, relative: pathlib.PurePosixPath) -> None:
        try:
            info = path.lstat()
        except FileNotFoundError as error:
            raise RuntimeError(f"missing {label} entry: {relative.as_posix() or '.'}") from error
        normalized = relative.as_posix()
        require(not stat.S_ISLNK(info.st_mode), f"symlink is not allowed in {label}: {normalized or '.'}")
        if stat.S_ISDIR(info.st_mode):
            children = sorted(path.iterdir(), key=lambda item: item.name)
            require(children, f"empty directory is not allowed in {label}: {normalized or '.'}")
            for child in children:
                walk(child, relative / child.name)
            return
        require(stat.S_ISREG(info.st_mode), f"non-regular file is not allowed in {label}: {normalized}")
        require((info.st_mode & 0o111) == 0, f"executable file is not allowed in {label}: {normalized}")
        if reject_source_artifacts:
            reason = forbidden_artifact(relative)
            require(reason is None, f"forbidden artifact in {label}: {normalized} ({reason})")
        require(normalized in expected, f"unexpected file in {label}: {normalized}")
        actual.add(normalized)

    walk(tree, pathlib.PurePosixPath())
    for relative in expected_paths:
        target = tree / pathlib.PurePosixPath(relative)
        try:
            info = target.lstat()
        except FileNotFoundError as error:
            raise RuntimeError(f"missing {label} entry: {relative}") from error
        require(not stat.S_ISLNK(info.st_mode), f"symlink is not allowed in {label}: {relative}")
        require(stat.S_ISREG(info.st_mode), f"non-regular file is not allowed in {label}: {relative}")
    require(sorted(actual) == sorted(expected_paths), f"{label} does not match the closed release roster")


def verify_tree() -> dict:
    roster = load_roster()
    validate_tree(ROOT, _roster_paths(roster, "repositoryFiles"), "repository")
    validate_tree(
        PLUGIN,
        _roster_paths(roster, "pluginFiles"),
        "plugin",
        reject_source_artifacts=True,
    )

    manifest = load_json(PLUGIN / ".codex-plugin" / "plugin.json")
    require(manifest["name"] == "game-development-studio", "unexpected plugin name")
    require(manifest["version"] == "1.0.1", "unexpected plugin version")
    require(manifest["skills"] == "./skills/", "unexpected skills path")
    require("mcpServers" not in manifest and "apps" not in manifest, "plugin must be skills-only")
    require(not (PLUGIN / ".mcp.json").exists(), "plugin ships .mcp.json")
    require(not (PLUGIN / ".app.json").exists(), "plugin ships .app.json")
    interface = manifest.get("interface")
    require(isinstance(interface, dict), "plugin interface must be an object")
    require(interface.get("privacyPolicyURL") == PRIVACY_POLICY_URL, "unexpected privacy URL")
    require(interface.get("termsOfServiceURL") == TERMS_OF_SERVICE_URL, "unexpected terms URL")
    allowed_interface_fields = {
        "displayName", "shortDescription", "longDescription", "developerName", "category",
        "capabilities", "websiteURL", "privacyPolicyURL", "termsOfServiceURL", "defaultPrompt",
        "brandColor", "composerIcon", "logo", "logoDark", "screenshots",
    }
    unexpected_interface_fields = sorted(set(interface) - allowed_interface_fields)
    require(not unexpected_interface_fields, f"unsupported plugin interface fields: {unexpected_interface_fields}")
    short_description = interface.get("shortDescription")
    require(isinstance(short_description, str) and len(short_description) <= 30, "short description exceeds 30 characters")
    require("screenshots" not in interface, "skills-only manifest must not declare screenshots")

    marketplace = load_json(ROOT / ".agents" / "plugins" / "marketplace.json")
    entry = marketplace["plugins"][0]
    require(entry["name"] == manifest["name"], "marketplace and plugin names differ")
    require(entry["source"]["path"] == "./plugins/game-development-studio", "unexpected marketplace path")

    skill_manifest = load_json(PLUGIN / "skills" / "manifest.json")
    require(skill_manifest["version"] == manifest["version"], "skill version differs")
    require(len(skill_manifest["skills"]) == 5, "exactly five skills required")
    expected = sorted(item["relativePath"] for item in skill_manifest["skills"])
    actual = sorted(path.name for path in (PLUGIN / "skills").iterdir() if path.is_dir())
    require(actual == expected, "skill folders are not a closed manifest roster")

    icon_provenance = load_json(PLUGIN / "assets" / "icon-provenance.json")
    icon = local_path(interface.get("composerIcon"), "composerIcon")
    require(icon == local_path(interface.get("logo"), "logo"), "composer icon and logo must share the suite mark")
    require(digest(icon) == icon_provenance["sha256"], "suite icon hash mismatch")
    require(png_size(icon) == ICON_DIMENSIONS, "suite icon dimensions changed")

    for skill in skill_manifest["skills"]:
        skill_root = PLUGIN / "skills" / skill["relativePath"]
        require((skill_root / "SKILL.md").exists(), f"{skill['id']} has no SKILL.md")
        provenance = load_json(skill_root / "assets" / "icon-provenance.json")
        skill_icon = skill_root / "assets" / "icon.png"
        require(digest(skill_icon) == provenance["sha256"], f"{skill['id']} icon hash mismatch")
        require(png_size(skill_icon) == ICON_DIMENSIONS, f"{skill['id']} icon dimensions changed")

    screenshot_provenance = load_json(PLUGIN / "assets" / "screenshots" / "provenance.json")
    screenshots = [
        "./assets/screenshots/01-skill-suite.png",
        "./assets/screenshots/02-cli-contract.png",
        "./assets/screenshots/03-visual-debugging.png",
    ]
    require(len(screenshots) == 3, "three screenshots required")
    for relative in screenshots:
        path = PLUGIN / relative.removeprefix("./")
        record = next(item for item in screenshot_provenance["screenshots"] if item["path"] == path.name)
        require(digest(path) == record["sha256"], f"{path.name} hash mismatch")
        require(png_size(path) == (1440, 900), f"{path.name} dimensions changed")

    for name in ["README.md", "LICENSE", "PRIVACY.md", "TERMS.md", "SUPPORT.md", "SECURITY.md"]:
        require((ROOT / name).exists(), f"missing public {name}")
        require((PLUGIN / name).exists(), f"archive missing {name}")

    plugin_readme = (PLUGIN / "README.md").read_text(encoding="utf-8")
    require("plugins/game-development-studio/assets/" not in plugin_readme, "plugin README contains repository-root image paths")
    for relative in ["assets/icon.png", *[item.removeprefix("./") for item in screenshots]]:
        require((PLUGIN / relative).exists(), f"plugin README asset is missing: {relative}")
    return roster


def main() -> None:
    roster = verify_tree()
    skill_manifest = load_json(PLUGIN / "skills" / "manifest.json")
    print(json.dumps({
        "ok": True,
        "schema": "game_dev.public_plugin_verification.v1",
        "plugin": "game-development-studio",
        "version": "1.0.1",
        "skills": len(skill_manifest["skills"]),
        "screenshots": 3,
        "mcp": False,
        "roster": roster["schema"],
    }, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
