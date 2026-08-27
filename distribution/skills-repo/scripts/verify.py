#!/usr/bin/env python3

import hashlib
import json
import pathlib
import struct

ROOT = pathlib.Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "game-development-studio"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def load_json(path: pathlib.Path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def png_size(path: pathlib.Path) -> tuple[int, int]:
    data = path.read_bytes()[:24]
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG")
    return struct.unpack(">II", data[16:24])


manifest = load_json(PLUGIN / ".codex-plugin" / "plugin.json")
require(manifest["name"] == "game-development-studio", "unexpected plugin name")
require(manifest["version"] == "1.0.0", "unexpected plugin version")
require(manifest["skills"] == "./skills/", "unexpected skills path")
require("mcpServers" not in manifest and "apps" not in manifest, "plugin must be skills-only")
require(not (PLUGIN / ".mcp.json").exists(), "plugin ships .mcp.json")
require(not (PLUGIN / ".app.json").exists(), "plugin ships .app.json")
interface = manifest["interface"]
require(interface["supportURL"] == "https://github.com/theisegoria/game-development-studio-skills/issues", "unexpected support URL")
require(len(interface["shortDescription"]) <= 30, "short description exceeds 30 characters")
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
icon = PLUGIN / "assets" / "icon.png"
require(digest(icon) == icon_provenance["sha256"], "suite icon hash mismatch")
require(png_size(icon) == (1254, 1254), "suite icon dimensions changed")

for skill in skill_manifest["skills"]:
    root = PLUGIN / "skills" / skill["relativePath"]
    require((root / "SKILL.md").exists(), f"{skill['id']} has no SKILL.md")
    provenance = load_json(root / "assets" / "icon-provenance.json")
    require(digest(root / "assets" / "icon.png") == provenance["sha256"], f"{skill['id']} icon hash mismatch")

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

print(json.dumps({
    "ok": True,
    "schema": "game_dev.public_plugin_verification.v1",
    "plugin": manifest["name"],
    "version": manifest["version"],
    "skills": len(skill_manifest["skills"]),
    "screenshots": len(screenshots),
    "mcp": False,
}, sort_keys=True))
