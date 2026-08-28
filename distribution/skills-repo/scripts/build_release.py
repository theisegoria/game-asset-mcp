#!/usr/bin/env python3

import hashlib
import pathlib
import stat
import sys
import zipfile

sys.dont_write_bytecode = True

SCRIPT_PATH = pathlib.Path(__file__).absolute()
ROOT = SCRIPT_PATH.parents[1]
PLUGIN = ROOT / "plugins" / "game-development-studio"
VERIFY_SCRIPT = SCRIPT_PATH.with_name("verify.py")

if len(sys.argv) != 2:
    raise SystemExit("usage: python3 scripts/build_release.py OUTPUT_PATH")

OUTPUT = pathlib.Path(sys.argv[1]).resolve()


def is_within(path: pathlib.Path, root: pathlib.Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


if is_within(OUTPUT, ROOT.resolve()) or is_within(OUTPUT, PLUGIN.resolve()):
    raise SystemExit(f"release output must be outside the exported repository and plugin: {OUTPUT}")

if OUTPUT.exists():
    raise SystemExit(f"refusing to overwrite {OUTPUT}")

try:
    verify_info = VERIFY_SCRIPT.lstat()
except FileNotFoundError as error:
    raise SystemExit(f"missing release verifier: {VERIFY_SCRIPT}") from error
if stat.S_ISLNK(verify_info.st_mode) or not stat.S_ISREG(verify_info.st_mode):
    raise SystemExit(f"release verifier must be a regular file: {VERIFY_SCRIPT}")
if verify_info.st_mode & 0o111:
    raise SystemExit(f"release verifier must not be executable: {VERIFY_SCRIPT}")

from verify import verify_tree

roster = verify_tree()
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
files = [PLUGIN / relative for relative in roster["pluginFiles"]]

with zipfile.ZipFile(OUTPUT, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        relative = path.relative_to(PLUGIN).as_posix()
        info = zipfile.ZipInfo(relative, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

sha256 = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
print(f"{OUTPUT}\nsha256 {sha256}\nfiles {len(files)}")
