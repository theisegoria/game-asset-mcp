#!/usr/bin/env bash
# Compiles Resources/AnvilIcon.png into Resources/AnvilIcon.icns.
# Kept inside the Anvil package: assets/ and scripts/ are exact-tree release
# scopes checked by scripts/verify-plugin.mjs, and apps/ deliberately is not.
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC="$PACKAGE_DIR/Resources/AnvilIcon.png"
OUT="$PACKAGE_DIR/Resources/AnvilIcon.icns"
[[ -f "$SRC" ]] || { echo "missing icon master: $SRC" >&2; exit 1; }

STAGE="$(mktemp -d /private/tmp/anvil-iconset.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
SET="$STAGE/AnvilIcon.iconset"
mkdir -p "$SET"

for spec in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" \
            "128 128x128" "256 128x128@2x" "256 256x256" "512 256x256@2x" \
            "512 512x512" "1024 512x512@2x"; do
  px="${spec%% *}"; name="${spec##* }"
  /usr/bin/sips -z "$px" "$px" "$SRC" --out "$SET/icon_$name.png" >/dev/null
done

/usr/bin/iconutil -c icns "$SET" -o "$OUT"
/usr/bin/sips -g format "$OUT" | /usr/bin/grep -q 'format: icns' \
  || { echo "compiled icon is not a valid ICNS asset" >&2; exit 1; }
echo "wrote $OUT ($(/usr/bin/stat -f%z "$OUT") bytes)"
