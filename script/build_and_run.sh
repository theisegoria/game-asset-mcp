#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="GameDevelopmentStudio"
DISPLAY_NAME="Game Development Studio"
BUNDLE_ID="com.theisegoria.GameDevelopmentStudio"
MIN_SYSTEM_VERSION="26.0"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PACKAGE_DIR="$ROOT_DIR/apps/macos/GameDevelopmentStudio"
DIST_DIR="$PACKAGE_DIR/dist"
FINAL_APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
APP_MODULE_CACHE="$PACKAGE_DIR/.build/ModuleCache"
ICON_SOURCE="$ROOT_DIR/assets/macos/AppIcon.png"
ICON_COMPILED="$ROOT_DIR/assets/macos/AppIcon.icns"
RUNTIME_NAME="GameDevelopmentStudioRuntime"
RUNTIME_BUILDER="$ROOT_DIR/scripts/build-cli-runtime.mjs"
RUNTIME_VERIFIER="$ROOT_DIR/scripts/verify-cli-runtime.mjs"
RUNTIME_PROVENANCE_VERIFIER="$ROOT_DIR/scripts/verify-macos-runtime-provenance.mjs"
THIRD_PARTY_TEMPLATE_DIR="$ROOT_DIR/distribution/macos-app-repo"
THIRD_PARTY_NOTICE="$THIRD_PARTY_TEMPLATE_DIR/THIRD_PARTY_NOTICES.md"
THIRD_PARTY_PROVENANCE="$THIRD_PARTY_TEMPLATE_DIR/THIRD_PARTY_PROVENANCE.json"
THIRD_PARTY_LICENSE_SOURCE="$THIRD_PARTY_TEMPLATE_DIR/legal/third-party-licenses"
THIRD_PARTY_LICENSE_DESTINATION_NAME="ThirdPartyLicenses"

case "$MODE" in
  run|--test|test|--build-only|build-only|--debug|debug|--logs|logs|--telemetry|telemetry|--verify|verify) ;;
  *)
    echo "usage: $0 [run|--test|--build-only|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac

mkdir -p "$APP_MODULE_CACHE"
export CLANG_MODULE_CACHE_PATH="$APP_MODULE_CACHE"
export SWIFTPM_MODULECACHE_OVERRIDE="$APP_MODULE_CACHE"

if [[ "$MODE" == "--test" || "$MODE" == "test" ]]; then
  swift test --disable-sandbox --package-path "$PACKAGE_DIR"
  exit 0
fi

if [[ ! -f "$ICON_SOURCE" || ! -f "$ICON_COMPILED" ]]; then
  echo "missing app icon master or compiled ICNS asset" >&2
  exit 1
fi
if [[ ! -f "$RUNTIME_BUILDER" || ! -f "$RUNTIME_VERIFIER" || ! -f "$RUNTIME_PROVENANCE_VERIFIER" ]]; then
  echo "missing closed CLI runtime builder or verifier" >&2
  exit 1
fi
if [[ ! -f "$THIRD_PARTY_NOTICE" || ! -f "$THIRD_PARTY_PROVENANCE" \
  || ! -d "$THIRD_PARTY_LICENSE_SOURCE" ]]; then
  echo "missing canonical macOS third-party notice resources" >&2
  exit 1
fi
if [[ -n "$(find "$THIRD_PARTY_LICENSE_SOURCE" -type l -print -quit)" ]]; then
  echo "refusing symlinked macOS third-party license resources" >&2
  exit 1
fi

if [[ -L "$DIST_DIR" ]]; then
  echo "refusing symlinked distribution directory: $DIST_DIR" >&2
  exit 1
fi
mkdir -p "$DIST_DIR"
DIST_REAL="$(cd "$DIST_DIR" && pwd -P)"
if [[ "$DIST_REAL" != "$PACKAGE_DIR/dist" ]]; then
  echo "refusing distribution directory outside the package: $DIST_REAL" >&2
  exit 1
fi
case "$FINAL_APP_BUNDLE" in
  "$DIST_REAL/$APP_NAME.app") ;;
  *)
    echo "refusing unsafe final app bundle path: $FINAL_APP_BUNDLE" >&2
    exit 1
    ;;
esac

npm run build
swift build --disable-sandbox --package-path "$PACKAGE_DIR"
BUILD_BINARY="$(swift build --disable-sandbox --package-path "$PACKAGE_DIR" --show-bin-path)/$APP_NAME"

STAGE_ROOT="$(mktemp -d /private/tmp/game-development-studio-app-stage.XXXXXX)"
trap 'rm -rf "$STAGE_ROOT"' EXIT
APP_BUNDLE="$STAGE_ROOT/$APP_NAME.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_BINARY="$APP_MACOS/$APP_NAME"
INFO_PLIST="$APP_CONTENTS/Info.plist"
NODE_EXECUTABLE="$(node -p 'process.execPath')"

mkdir -p "$APP_MACOS" "$APP_RESOURCES"
cp "$BUILD_BINARY" "$APP_BINARY"
chmod +x "$APP_BINARY"

cp "$ICON_COMPILED" "$APP_RESOURCES/AppIcon.icns"
/usr/bin/sips -g format -g pixelWidth -g pixelHeight "$APP_RESOURCES/AppIcon.icns" \
  | /usr/bin/grep -q 'format: icns' \
  || { echo "compiled app icon is not a valid ICNS asset" >&2; exit 1; }

if [[ "$NODE_EXECUTABLE" != /* || ! -f "$NODE_EXECUTABLE" || -L "$NODE_EXECUTABLE" ]]; then
  echo "Node did not report an absolute regular executable path" >&2
  exit 1
fi
node "$RUNTIME_BUILDER" \
  --source "$ROOT_DIR" \
  --node "$NODE_EXECUTABLE" \
  --output "$APP_RESOURCES/$RUNTIME_NAME" >/dev/null
node "$RUNTIME_VERIFIER" \
  --runtime "$APP_RESOURCES/$RUNTIME_NAME" >/dev/null
STAGED_NODE_VERSION="$("$APP_RESOURCES/$RUNTIME_NAME/payload/node/bin/node" --version | /usr/bin/head -n 1)"
node "$RUNTIME_PROVENANCE_VERIFIER" \
  --runtime "$APP_RESOURCES/$RUNTIME_NAME" \
  --provenance "$THIRD_PARTY_PROVENANCE" \
  --node-version "$STAGED_NODE_VERSION" >/dev/null

cp "$THIRD_PARTY_NOTICE" "$APP_RESOURCES/THIRD_PARTY_NOTICES.md"
cp "$THIRD_PARTY_PROVENANCE" "$APP_RESOURCES/THIRD_PARTY_PROVENANCE.json"
cp -R "$THIRD_PARTY_LICENSE_SOURCE" \
  "$APP_RESOURCES/$THIRD_PARTY_LICENSE_DESTINATION_NAME"
[[ "$(/usr/bin/plutil -extract schema raw -o - \
  "$APP_RESOURCES/THIRD_PARTY_PROVENANCE.json")" \
  == "game_dev.macos_bundled_third_party_provenance.v1" ]] \
  || { echo "staged third-party provenance schema is invalid" >&2; exit 1; }
/usr/bin/cmp -s "$THIRD_PARTY_NOTICE" \
  "$APP_RESOURCES/THIRD_PARTY_NOTICES.md" \
  || { echo "staged third-party notice differs from its canonical source" >&2; exit 1; }
/usr/bin/cmp -s "$THIRD_PARTY_PROVENANCE" \
  "$APP_RESOURCES/THIRD_PARTY_PROVENANCE.json" \
  || { echo "staged third-party provenance differs from its canonical source" >&2; exit 1; }
/usr/bin/diff -qr "$THIRD_PARTY_LICENSE_SOURCE" \
  "$APP_RESOURCES/$THIRD_PARTY_LICENSE_DESTINATION_NAME" >/dev/null \
  || { echo "staged third-party license tree differs from its canonical source" >&2; exit 1; }

cat >"$INFO_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>$DISPLAY_NAME</string>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$DISPLAY_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MIN_SYSTEM_VERSION</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

/usr/bin/xattr -cr "$APP_BUNDLE"
/usr/bin/codesign --force --sign - --identifier "$BUNDLE_ID" "$APP_BUNDLE" >/dev/null
/usr/bin/xattr -cr "$APP_BUNDLE"

rm -rf "$FINAL_APP_BUNDLE"
mv "$APP_BUNDLE" "$FINAL_APP_BUNDLE"
rmdir "$STAGE_ROOT"
trap - EXIT
APP_BUNDLE="$FINAL_APP_BUNDLE"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$APP_NAME"
/usr/bin/xattr -cr "$APP_BUNDLE"
node "$RUNTIME_VERIFIER" --runtime "$APP_RESOURCES/$RUNTIME_NAME" >/dev/null

# The clear above is already stale by the time codesign looks. When the checkout
# lives under an iCloud-synced path, the File Provider re-attaches
# com.apple.FinderInfo and com.apple.fileprovider.fpfs#P to the bundle root
# during the window the runtime verifier occupies, and the signature check then
# fails with "resource fork, Finder information, or similar detritus not
# allowed". Clearing only com.apple.FinderInfo, only at the bundle root, missed
# both the second attribute and everything below the root.
#
# It is a race, so it presents as intermittent rather than broken: clear
# recursively immediately before the check, and retry once if the provider wins
# anyway.
verify_bundle_signature() {
  /usr/bin/xattr -cr "$APP_BUNDLE" 2>/dev/null || true
  /usr/bin/codesign --verify --deep --strict "$APP_BUNDLE"
}
verify_bundle_signature || {
  sleep 1
  verify_bundle_signature
}

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --build-only|build-only)
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    sleep 2
    pgrep -x "$APP_NAME" >/dev/null
    ;;
esac
