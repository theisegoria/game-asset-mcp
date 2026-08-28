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

if [[ ! -f "$ICON_SOURCE" ]]; then
  echo "missing app icon master: $ICON_SOURCE" >&2
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

swift build --disable-sandbox --package-path "$PACKAGE_DIR"
BUILD_BINARY="$(swift build --disable-sandbox --package-path "$PACKAGE_DIR" --show-bin-path)/$APP_NAME"

STAGE_ROOT="$(mktemp -d "$DIST_REAL/.gds-stage.XXXXXX")"
trap 'rm -rf "$STAGE_ROOT"' EXIT
APP_BUNDLE="$STAGE_ROOT/$APP_NAME.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_BINARY="$APP_MACOS/$APP_NAME"
INFO_PLIST="$APP_CONTENTS/Info.plist"
ICONSET_DIR="$APP_RESOURCES/AppIcon.iconset"

mkdir -p "$APP_MACOS" "$APP_RESOURCES"
cp "$BUILD_BINARY" "$APP_BINARY"
chmod +x "$APP_BINARY"

mkdir -p "$ICONSET_DIR"
make_icon() {
  local size="$1"
  local output="$2"
  /usr/bin/sips -z "$size" "$size" "$ICON_SOURCE" --out "$ICONSET_DIR/$output" >/dev/null
}
make_icon 16 icon_16x16.png
make_icon 32 icon_16x16@2x.png
make_icon 32 icon_32x32.png
make_icon 64 icon_32x32@2x.png
make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
make_icon 1024 icon_512x512@2x.png
/usr/bin/iconutil -c icns "$ICONSET_DIR" -o "$APP_RESOURCES/AppIcon.icns"
rm -rf "$ICONSET_DIR"

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
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$APP_NAME"
/usr/bin/xattr -cr "$APP_BUNDLE"

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
