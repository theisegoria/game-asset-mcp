#!/usr/bin/env python3

import hashlib
import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "game-development-studio"
OUTPUT = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else ROOT / "dist" / "game-development-studio-plugin-1.0.1.zip"

if OUTPUT.exists():
    raise SystemExit(f"refusing to overwrite {OUTPUT}")

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
files = sorted(path for path in PLUGIN.rglob("*") if path.is_file() and "__pycache__" not in path.parts)

with zipfile.ZipFile(OUTPUT, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        relative = path.relative_to(PLUGIN).as_posix()
        info = zipfile.ZipInfo(relative, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

sha256 = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
print(f"{OUTPUT}\nsha256 {sha256}\nfiles {len(files)}")
