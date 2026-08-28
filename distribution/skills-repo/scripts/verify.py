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
MARKETING_SCREENSHOTS = [
    "assets/screenshots/01-skill-suite.png",
    "assets/screenshots/02-cli-contract.png",
    "assets/screenshots/03-visual-debugging.png",
]
MARKETING_CAPTIONS = [
    "Product composition using the shipped skill names and metadata.",
    "Marketing composition based on actual v1.0.0 CLI output, shortened for display.",
    "The third image is a labelled synthetic validation fixture.",
]


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
        "repositorySourceFiles",
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
    allow_root_git_admin_state: bool = False,
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
        if allow_root_git_admin_state and normalized == ".git":
            if stat.S_ISDIR(info.st_mode):
                return
            require(stat.S_ISREG(info.st_mode), "repository-root .git must be a Git directory or gitdir file")
            contents = path.read_text(encoding="utf-8")
            lines = contents.splitlines()
            require(
                len(lines) == 1
                and lines[0].startswith("gitdir: ")
                and len(lines[0][len("gitdir: "):]) > 0
                and lines[0][len("gitdir: "):].strip() == lines[0][len("gitdir: "):]
                and "\x00" not in contents,
                "repository-root .git is not a well-formed single-line gitdir file",
            )
            return
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
    repository_files = _roster_paths(roster, "repositoryFiles")
    plugin_files = _roster_paths(roster, "pluginFiles")
    repository_source_files = _roster_paths(roster, "repositorySourceFiles")
    require(all(relative in repository_files for relative in repository_source_files), "repository source entries must be exported")
    require(
        not any(relative.startswith("assets/screenshots/") for relative in plugin_files),
        "skills-only plugin roster must not ship screenshots",
    )
    validate_tree(ROOT, repository_files, "repository", allow_root_git_admin_state=True)
    validate_tree(
        PLUGIN,
        plugin_files,
        "plugin",
        reject_source_artifacts=True,
    )

    manifest = load_json(PLUGIN / ".codex-plugin" / "plugin.json")
    require(manifest["name"] == "game-development-studio", "unexpected plugin name")
    require(manifest["version"] == "1.0.2", "unexpected plugin version")
    require(manifest["skills"] == "./skills/", "unexpected skills path")
    require("mcpServers" not in manifest and "apps" not in manifest, "plugin must be skills-only")
    require(not (PLUGIN / ".mcp.json").exists(), "plugin ships .mcp.json")
    require(not (PLUGIN / ".app.json").exists(), "plugin ships .app.json")
    interface = manifest.get("interface")
    require(isinstance(interface, dict), "plugin interface must be an object")
    require("screenshots" not in interface, "skills-only plugin must not declare screenshots")
    require(interface.get("privacyPolicyURL") == PRIVACY_POLICY_URL, "unexpected privacy URL")
    require(interface.get("termsOfServiceURL") == TERMS_OF_SERVICE_URL, "unexpected terms URL")
    allowed_interface_fields = {
        "displayName", "shortDescription", "longDescription", "developerName", "category",
        "capabilities", "websiteURL", "privacyPolicyURL", "termsOfServiceURL", "defaultPrompt",
        "brandColor", "composerIcon", "logo", "logoDark",
    }
    unexpected_interface_fields = sorted(set(interface) - allowed_interface_fields)
    require(not unexpected_interface_fields, f"unsupported plugin interface fields: {unexpected_interface_fields}")
    short_description = interface.get("shortDescription")
    require(isinstance(short_description, str) and len(short_description) <= 30, "short description exceeds 30 characters")
    marketing_copy = (ROOT / "marketing" / "COPY.md").read_text(encoding="utf-8")
    require(
        f"## Short store description\n\n{short_description}" in marketing_copy,
        "marketing short description must match the plugin manifest",
    )
    starter_prompts = interface.get("defaultPrompt")
    require(isinstance(starter_prompts, list) and len(starter_prompts) == 3, "plugin must declare exactly three starter prompts")

    privacy_policy = (ROOT / "PRIVACY.md").read_text(encoding="utf-8")
    terms = (ROOT / "TERMS.md").read_text(encoding="utf-8")
    public_readme = (ROOT / "README.md").read_text(encoding="utf-8")
    store_brief = (ROOT / "marketing" / "STORE_SUBMISSION.md").read_text(encoding="utf-8")
    router_skill = (PLUGIN / "skills" / "game-development-studio" / "SKILL.md").read_text(encoding="utf-8")
    production_skill = (PLUGIN / "skills" / "game-asset-production" / "SKILL.md").read_text(encoding="utf-8")
    production_commands = (
        PLUGIN / "skills" / "game-asset-production" / "references" / "commands.md"
    ).read_text(encoding="utf-8")
    for phrase in [
        "**Publisher retention is zero:**",
        "remain in the user-selected workspace until the user deletes",
        "Data sent in an authorized provider request is retained and controlled by that",
        "The plugin does not collect, solicit, accept, store, or transmit provider",
    ]:
        require(phrase in privacy_policy, f"privacy policy is missing required disclosure: {phrase}")
    for phrase in [
        "not a publisher-operated provider account",
        "Do not use another person's",
        "affiliation, sponsorship, endorsement, certification, partnership, or official",
    ]:
        require(phrase in terms, f"terms are missing required provider boundary: {phrase}")
    require(
        "export TRIPO_API_KEY=" not in public_readme and "export LEONARDO_API_KEY=" not in public_readme,
        "README must not solicit provider keys in shell commands",
    )
    require(
        "do not activate for unrelated development or general creative work" in router_skill,
        "router activation boundary is too broad",
    )
    require(
        "A command without a `--confirm` flag still requires" in router_skill,
        "router is missing the no-flag write boundary",
    )
    require(
        "never request, accept, reveal, or configure that credential" in production_skill,
        "production skill can solicit provider credentials",
    )
    require(
        "leave the command unexecuted until the user explicitly" in production_commands,
        "production commands are missing exact write authorization",
    )
    for prompt in starter_prompts:
        require(isinstance(prompt, str) and prompt in store_brief, f"submission brief is missing starter prompt: {prompt}")
    positive_marker = "## Positive test cases\n"
    negative_marker = "\n## Negative test cases\n"
    release_marker = "\n## Release notes\n"
    require(positive_marker in store_brief and negative_marker in store_brief and release_marker in store_brief, "submission test sections are incomplete")
    positive_block = store_brief.split(positive_marker, 1)[1].split(negative_marker, 1)[0]
    negative_block = store_brief.split(negative_marker, 1)[1].split(release_marker, 1)[0]
    positive_count = sum(1 for line in positive_block.splitlines() if line.startswith("### ") and line[4:5].isdigit())
    negative_count = sum(1 for line in negative_block.splitlines() if line.startswith("### ") and line[4:5].isdigit())
    require(positive_count == 5, "submission brief must contain exactly five positive tests")
    require(negative_count == 3, "submission brief must contain exactly three negative tests")
    require(
        "refuses to echo, save, configure, or use it" in negative_block,
        "negative tests must cover pasted credential refusal",
    )

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

    marketing_screenshot_provenance = load_json(ROOT / "assets" / "screenshots" / "provenance.json")
    repository_readme = (ROOT / "README.md").read_text(encoding="utf-8")
    for caption in MARKETING_CAPTIONS:
        require(caption in repository_readme, f"repository README is missing marketing caption: {caption}")
    for relative in MARKETING_SCREENSHOTS:
        require(relative in repository_source_files, f"marketing screenshot is not a repository source file: {relative}")
        path = ROOT / relative
        record = next(
            (item for item in marketing_screenshot_provenance["screenshots"] if item["path"] == path.name),
            None,
        )
        require(record is not None, f"missing marketing screenshot provenance for {path.name}")
        require(digest(path) == record["sha256"], f"{path.name} hash mismatch")
        require(png_size(path) == (1440, 900), f"{path.name} dimensions changed")
        require(f"]({relative})" in repository_readme, f"repository README does not caption {relative}")

    for name in ["README.md", "LICENSE", "PRIVACY.md", "TERMS.md", "SUPPORT.md", "SECURITY.md"]:
        require((ROOT / name).exists(), f"missing public {name}")
        require((PLUGIN / name).exists(), f"archive missing {name}")

    plugin_readme = (PLUGIN / "README.md").read_text(encoding="utf-8")
    require("assets/screenshots/" not in plugin_readme, "plugin README must not reference marketing screenshots")
    require((PLUGIN / "assets/icon.png").exists(), "plugin README suite icon is missing")
    return roster


def main() -> None:
    roster = verify_tree()
    skill_manifest = load_json(PLUGIN / "skills" / "manifest.json")
    print(json.dumps({
        "ok": True,
        "schema": "game_dev.public_plugin_verification.v1",
        "plugin": "game-development-studio",
        "version": "1.0.2",
        "skills": len(skill_manifest["skills"]),
        "screenshots": 0,
        "marketingScreenshots": len(MARKETING_SCREENSHOTS),
        "mcp": False,
        "roster": roster["schema"],
    }, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
