#!/usr/bin/env bash
set -euo pipefail

APP_PRODUCT="GameDevelopmentStudio"
APP_DISPLAY_NAME="Game Development Studio"
BUNDLE_IDENTIFIER="com.theisegoria.GameDevelopmentStudio"
MINIMUM_SYSTEM_VERSION="26.0"
EXPECTED_ARCHITECTURES="arm64"
RELEASE_REPOSITORY="theisegoria/game-development-studio-macos"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PACKAGE_DIR="$ROOT_DIR/macos/GameDevelopmentStudio"
DEFAULT_APP="$PACKAGE_DIR/dist/$APP_PRODUCT.app"
TEMPLATE_DIR="$ROOT_DIR/distribution/macos-app-repo"
SCREENSHOT_SOURCE_DIR="$ROOT_DIR/assets/screenshots"
SCREENSHOT_PROVENANCE="$SCREENSHOT_SOURCE_DIR/provenance.json"

die() {
  echo "error: $*" >&2
  exit 1
}

note() {
  echo "release: $*"
}

usage() {
  cat <<'USAGE'
Usage:
  ./script/package_macos_release.sh package \
    --version 1.0.0 \
    --screenshot assets/screenshots/04-native-macos-app.png \
    --output /private/tmp/GameDevelopmentStudio-1.0.0-release \
    [--app macos/GameDevelopmentStudio/dist/GameDevelopmentStudio.app]

  ./script/package_macos_release.sh verify \
    --version 1.0.0 \
    --release-root /path/to/GameDevelopmentStudio-1.0.0-release

  ./script/package_macos_release.sh self-test

The package command requires a clean Git worktree and a prebuilt local app
bundle. It compiles a fresh SwiftPM release executable, replaces the local
bundle's development executable, strips debug symbols, signs the staged bundle
ad hoc, creates a deterministic ZIP twice, and refuses if the bytes differ.

The output has two siblings:
  repository/      metadata and screenshots safe to commit publicly
  release-assets/  ZIP to attach to the GitHub release (never commit the ZIP)
USAGE
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

sha256_file() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

plist_value() {
  local plist="$1"
  local key="$2"
  /usr/bin/plutil -extract "$key" raw -o - "$plist" 2>/dev/null \
    || die "missing or invalid Info.plist key: $key"
}

resolve_existing_path() {
  local input="$1"
  local parent
  [[ -e "$input" ]] || die "path does not exist: $input"
  parent="$(cd "$(dirname "$input")" && pwd -P)"
  printf '%s/%s\n' "$parent" "$(basename "$input")"
}

resolve_new_path() {
  local input="$1"
  local parent_input
  local parent
  local base
  parent_input="$(dirname "$input")"
  base="$(basename "$input")"
  [[ -n "$base" && "$base" != "." && "$base" != ".." ]] \
    || die "unsafe output path: $input"
  mkdir -p "$parent_input"
  parent="$(cd "$parent_input" && pwd -P)"
  [[ "$parent/$base" != "/" ]] || die "refusing root output path"
  printf '%s/%s\n' "$parent" "$base"
}

assert_clean_source_tree() {
  local status
  status="$(git -C "$ROOT_DIR" status --porcelain=v1 --untracked-files=all)"
  [[ -z "$status" ]] || die "Git worktree must be clean before public packaging"
}

assert_safe_version() {
  local version="$1"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || die "version must be an exact numeric semantic version"
  [[ "$version" == "1.0.0" ]] \
    || die "this audited release lane is pinned to version 1.0.0"
}

assert_no_symlinks() {
  local root="$1"
  local first
  first="$(find "$root" -path "$root/.git" -prune -o -type l -print -quit)"
  [[ -z "$first" ]] || die "symlink is not permitted in release input: $first"
}

assert_no_source_material() {
  local root="$1"
  local path
  local rel
  local lowered

  while IFS= read -r -d '' path; do
    rel="${path#"$root"/}"
    lowered="$(printf '%s' "$rel" | /usr/bin/tr '[:upper:]' '[:lower:]')"

    case "/$lowered/" in
      */sources/*|*/source/*|*/src/*|*/tests/*|*/test/*|*/scripts/*|*/examples/*|*/fixtures/*|*/node_modules/*|*/.build/*|*/.swiftpm/*|*/.xcodeproj/*|*/.xcworkspace/*)
        die "source-oriented directory is forbidden: $rel"
        ;;
    esac

    case "$lowered" in
      *.swift|*.swiftinterface|*.swiftmodule|*.swiftdoc|*.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs|*.c|*.h|*.m|*.mm|*.cc|*.cpp|*.cxx|*.hpp|*.hh|*.py|*.pyc|*.rb|*.go|*.rs|*.java|*.kt|*.kts|*.scala|*.sh|*.bash|*.zsh|*.fish|*.ps1|*.xcodeproj|*.xcworkspace|*.dsym|*.o|*.d|*.map|*.pch)
        die "source or build-intermediate file is forbidden: $rel"
        ;;
      package.swift|package.resolved|package.json|package-lock.json|yarn.lock|pnpm-lock.yaml|tsconfig.json|makefile|cmakelists.txt)
        die "source build manifest is forbidden: $rel"
        ;;
    esac
  done < <(find "$root" -mindepth 1 -path "$root/.git" -prune -o -print0)
}

assert_no_publication_placeholders() {
  local root="$1"
  local file
  while IFS= read -r -d '' file; do
    if /usr/bin/grep -I -n -E 'TODO|TBD|PLACEHOLDER|\{\{[^}]+\}\}' "$file"; then
      die "publication file contains unresolved text: ${file#"$root"/}"
    fi
  done < <(find "$root" -path "$root/.git" -prune -o -type f -print0)
}

assert_exact_file_roster() {
  local root="$1"
  shift
  local expected_file
  local actual_file

  expected_file="$(mktemp "${TMPDIR:-/tmp}/gds-expected.XXXXXX")"
  actual_file="$(mktemp "${TMPDIR:-/tmp}/gds-actual.XXXXXX")"
  trap 'rm -f "$expected_file" "$actual_file"' RETURN

  printf '%s\n' "$@" | LC_ALL=C /usr/bin/sort >"$expected_file"
  find "$root" -path "$root/.git" -prune -o -type f -print \
    | while IFS= read -r path; do printf '%s\n' "${path#"$root"/}"; done \
    | LC_ALL=C /usr/bin/sort >"$actual_file"

  if ! /usr/bin/diff -u "$expected_file" "$actual_file"; then
    die "public repository file roster differs from the strict allowlist"
  fi

  rm -f "$expected_file" "$actual_file"
  trap - RETURN
}

validate_template() {
  local template="$1"
  [[ -d "$template" ]] || die "distribution template is missing: $template"
  assert_no_symlinks "$template"
  assert_no_source_material "$template"
  assert_exact_file_roster "$template" \
    "LICENSE" \
    "PRIVACY.md" \
    "README.md" \
    "RELEASE_NOTES.md" \
    "SECURITY.md" \
    "SUPPORT.md" \
    "THIRD_PARTY_NOTICES.md"
  assert_no_publication_placeholders "$template"
}

validate_app_bundle() {
  local app="$1"
  local version="$2"
  local plist="$app/Contents/Info.plist"
  local binary="$app/Contents/MacOS/$APP_PRODUCT"
  local signature
  local architectures
  local bundle_version
  local entitlements
  local binary_strings

  [[ -d "$app" ]] || die "app bundle is missing: $app"
  [[ -f "$plist" ]] || die "app Info.plist is missing"
  [[ -x "$binary" ]] || die "app executable is missing or not executable"
  [[ -f "$app/Contents/Resources/AppIcon.icns" ]] \
    || die "compiled AppIcon.icns is missing"

  assert_no_symlinks "$app"
  assert_no_source_material "$app"

  [[ "$(plist_value "$plist" CFBundleIdentifier)" == "$BUNDLE_IDENTIFIER" ]] \
    || die "unexpected bundle identifier"
  [[ "$(plist_value "$plist" CFBundleDisplayName)" == "$APP_DISPLAY_NAME" ]] \
    || die "unexpected bundle display name"
  [[ "$(plist_value "$plist" CFBundleName)" == "$APP_DISPLAY_NAME" ]] \
    || die "unexpected bundle name"
  [[ "$(plist_value "$plist" CFBundleExecutable)" == "$APP_PRODUCT" ]] \
    || die "unexpected bundle executable"
  [[ "$(plist_value "$plist" CFBundlePackageType)" == "APPL" ]] \
    || die "unexpected bundle package type"
  [[ "$(plist_value "$plist" CFBundleShortVersionString)" == "$version" ]] \
    || die "bundle marketing version does not match requested release"
  [[ "$(plist_value "$plist" LSMinimumSystemVersion)" == "$MINIMUM_SYSTEM_VERSION" ]] \
    || die "minimum system version must be exactly $MINIMUM_SYSTEM_VERSION"
  [[ "$(plist_value "$plist" CFBundleIconFile)" == "AppIcon" ]] \
    || die "unexpected bundle icon declaration"
  [[ "$(plist_value "$plist" LSApplicationCategoryType)" == "public.app-category.developer-tools" ]] \
    || die "unexpected application category"

  bundle_version="$(plist_value "$plist" CFBundleVersion)"
  [[ "$bundle_version" == "1" ]] \
    || die "bundle build version must be exactly 1 for release 1.0.0"

  /usr/bin/file "$binary" | /usr/bin/grep -q 'Mach-O' \
    || die "app executable is not Mach-O"
  architectures="$(/usr/bin/lipo -archs "$binary")"
  [[ "$architectures" == "$EXPECTED_ARCHITECTURES" ]] \
    || die "architecture must be exactly '$EXPECTED_ARCHITECTURES', found '$architectures'"

  /usr/bin/codesign --verify --deep --strict --verbose=2 "$app" >/dev/null 2>&1 \
    || die "strict deep code-signature verification failed"
  signature="$(/usr/bin/codesign -dvvv "$app" 2>&1)"
  printf '%s\n' "$signature" | /usr/bin/grep -q '^Signature=adhoc$' \
    || die "release must be ad-hoc signed"
  printf '%s\n' "$signature" | /usr/bin/grep -q '^TeamIdentifier=not set$' \
    || die "ad-hoc release unexpectedly contains a Team Identifier"
  if printf '%s\n' "$signature" | /usr/bin/grep -q '^Authority='; then
    die "ad-hoc release unexpectedly contains a signing authority"
  fi
  if printf '%s\n' "$signature" | /usr/bin/grep -q 'flags=.*runtime'; then
    die "Hardened Runtime is present but the audited public metadata says it is not claimed"
  fi
  entitlements="$(/usr/bin/codesign -d --entitlements :- "$app" 2>/dev/null || true)"
  [[ -z "$entitlements" ]] \
    || die "release contains entitlements that are not declared by this distribution lane"

  if /usr/bin/otool -l "$binary" | /usr/bin/grep -q '__DWARF'; then
    die "release executable still contains a __DWARF debug segment"
  fi
  binary_strings="$(/usr/bin/strings "$binary")"
  if printf '%s\n' "$binary_strings" | /usr/bin/grep -Fq "$ROOT_DIR"; then
    die "release executable leaks the private source checkout path"
  fi
}

validate_zip_entry_names() {
  local archive="$1"
  local entry
  local count=0

  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    count=$((count + 1))
    case "$entry" in
      /*|../*|*/../*|*\\*|__MACOSX/*)
        die "unsafe or unwanted ZIP entry: $entry"
        ;;
    esac
    case "$entry" in
      "$APP_PRODUCT.app"|"$APP_PRODUCT.app/"|"$APP_PRODUCT.app/"*) ;;
      *) die "ZIP entry is outside the single app bundle: $entry" ;;
    esac
  done < <(/usr/bin/unzip -Z1 "$archive")

  [[ "$count" -gt 0 ]] || die "ZIP has no entries"
}

create_deterministic_zip() {
  local bundle_parent="$1"
  local destination="$2"
  (
    cd "$bundle_parent"
    find "$APP_PRODUCT.app" -print \
      | LC_ALL=C /usr/bin/sort \
      | /usr/bin/zip -X -q -y "$destination" -@
  )
}

extract_and_validate_archive() {
  local archive="$1"
  local version="$2"
  local extraction_root="$3"

  /usr/bin/unzip -tq "$archive" >/dev/null || die "ZIP integrity test failed"
  validate_zip_entry_names "$archive"
  mkdir -p "$extraction_root"
  /usr/bin/unzip -q "$archive" -d "$extraction_root"
  assert_exact_file_roster_for_top_level_bundle "$extraction_root"
  validate_app_bundle "$extraction_root/$APP_PRODUCT.app" "$version"
}

assert_exact_file_roster_for_top_level_bundle() {
  local root="$1"
  local item
  local count=0
  while IFS= read -r -d '' item; do
    count=$((count + 1))
    [[ "$(basename "$item")" == "$APP_PRODUCT.app" && -d "$item" ]] \
      || die "archive extraction contains an unexpected top-level item: $item"
  done < <(find "$root" -mindepth 1 -maxdepth 1 -print0)
  [[ "$count" -eq 1 ]] || die "archive must extract exactly one top-level app bundle"
}

write_public_screenshot_provenance() {
  local destination="$1"
  local hash_01="$2"
  local hash_02="$3"
  local hash_03="$4"
  local hash_04="$5"
  cat >"$destination" <<JSON
{
  "schema": "game_dev.public_macos_screenshots.v1",
  "generatedOn": "2026-08-28",
  "screenshots": [
    {
      "path": "01-skill-suite.png",
      "sha256": "$hash_01",
      "kind": "product illustration",
      "claim": "Product composition using the released skill names and metadata; not native-app runtime evidence."
    },
    {
      "path": "02-cli-contract.png",
      "sha256": "$hash_02",
      "kind": "product illustration",
      "claim": "Composition based on version 1.0.0 CLI output shortened for display; not native-app runtime evidence."
    },
    {
      "path": "03-visual-debugging.png",
      "sha256": "$hash_03",
      "kind": "synthetic fixture illustration",
      "claim": "Explicitly synthetic; not target-game, GPU, pixel-approval, causality, or performance evidence."
    },
    {
      "path": "04-native-macos-app.png",
      "sha256": "$hash_04",
      "kind": "native macOS runtime capture",
      "claim": "One provenance-recorded visual state on one Mac; not proof of every workspace, theme, display, accessibility state, or workflow."
    }
  ]
}
JSON
}

write_release_metadata() {
  local destination="$1"
  local version="$2"
  local artifact_name="$3"
  local artifact_hash="$4"
  local source_revision="$5"
  cat >"$destination" <<JSON
{
  "schema": "game_dev.macos_binary_release.v1",
  "version": "$version",
  "bundleVersion": "1",
  "bundleIdentifier": "$BUNDLE_IDENTIFIER",
  "minimumSystemVersion": "$MINIMUM_SYSTEM_VERSION",
  "architectures": ["arm64"],
  "artifact": "$artifact_name",
  "sha256": "$artifact_hash",
  "distribution": "compiled-app-zip",
  "sourceFilesInRepository": false,
  "signing": {
    "kind": "ad-hoc",
    "developerId": false,
    "teamIdentifier": null,
    "hardenedRuntimeClaimed": false,
    "notarized": false,
    "stapledTicket": false
  },
  "sourceRevision": "$source_revision",
  "releaseRepository": "$RELEASE_REPOSITORY"
}
JSON
}

validate_public_repository() {
  local repository="$1"
  local artifact_name="$2"
  local artifact_hash="$3"
  local file
  local mode_file

  [[ -d "$repository" ]] || die "public repository staging directory is missing"
  assert_no_symlinks "$repository"
  assert_no_source_material "$repository"
  assert_exact_file_roster "$repository" \
    "CHECKSUMS.txt" \
    "LICENSE" \
    "PRIVACY.md" \
    "README.md" \
    "RELEASE_NOTES.md" \
    "SECURITY.md" \
    "SUPPORT.md" \
    "THIRD_PARTY_NOTICES.md" \
    "release-metadata.json" \
    "screenshots/01-skill-suite.png" \
    "screenshots/02-cli-contract.png" \
    "screenshots/03-visual-debugging.png" \
    "screenshots/04-native-macos-app.png" \
    "screenshots/provenance.json"

  mode_file="$(find "$repository" -path "$repository/.git" -prune -o -type f -perm -111 -print -quit)"
  [[ -z "$mode_file" ]] || die "public metadata file must not be executable: $mode_file"

  assert_no_publication_placeholders "$repository"

  [[ "$(cat "$repository/CHECKSUMS.txt")" == "$artifact_hash  $artifact_name" ]] \
    || die "CHECKSUMS.txt does not exactly match the release artifact"
  /usr/bin/grep -Fq "\"artifact\": \"$artifact_name\"" "$repository/release-metadata.json" \
    || die "release metadata artifact name mismatch"
  /usr/bin/grep -Fq "\"sha256\": \"$artifact_hash\"" "$repository/release-metadata.json" \
    || die "release metadata checksum mismatch"
  /usr/bin/grep -Fq '"architectures": ["arm64"]' "$repository/release-metadata.json" \
    || die "release metadata architecture mismatch"
  /usr/bin/grep -Fq '"kind": "ad-hoc"' "$repository/release-metadata.json" \
    || die "release metadata signing state mismatch"
  /usr/bin/grep -Fq '"notarized": false' "$repository/release-metadata.json" \
    || die "release metadata notarization state mismatch"

  /usr/bin/grep -Fq 'Apple silicon (`arm64`) only' "$repository/README.md" \
    || die "README does not disclose the exact architecture"
  /usr/bin/grep -Fq 'not Developer ID signed' "$repository/README.md" \
    || die "README does not disclose the Developer ID state"
  /usr/bin/grep -Fq 'notarized' "$repository/README.md" \
    || die "README does not disclose the notarization state"
  /usr/bin/grep -Fq 'no Swift or TypeScript source' "$repository/README.md" \
    || die "README does not disclose the binary-only repository boundary"

  for file in "$repository"/screenshots/*.png; do
    /usr/bin/file "$file" | /usr/bin/grep -q 'PNG image data' \
      || die "screenshot is not a PNG image: $file"
    /usr/bin/grep -Fq "$(sha256_file "$file")" "$repository/screenshots/provenance.json" \
      || die "screenshot checksum is absent from provenance: $file"
  done
}

assert_runtime_screenshot_provenance() {
  local screenshot="$1"
  local provenance="$2"
  local screenshot_hash
  [[ -f "$provenance" ]] || die "screenshot provenance is missing: $provenance"
  screenshot_hash="$(sha256_file "$screenshot")"
  /usr/bin/grep -Fq '04-native-macos-app.png' "$provenance" \
    || die "runtime screenshot is not recorded in source provenance"
  /usr/bin/grep -Fq "$screenshot_hash" "$provenance" \
    || die "runtime screenshot hash does not match source provenance"
}

copy_public_repository_template() {
  local destination="$1"
  mkdir -p "$destination/screenshots"
  cp "$TEMPLATE_DIR/LICENSE" "$destination/LICENSE"
  cp "$TEMPLATE_DIR/PRIVACY.md" "$destination/PRIVACY.md"
  cp "$TEMPLATE_DIR/README.md" "$destination/README.md"
  cp "$TEMPLATE_DIR/RELEASE_NOTES.md" "$destination/RELEASE_NOTES.md"
  cp "$TEMPLATE_DIR/SECURITY.md" "$destination/SECURITY.md"
  cp "$TEMPLATE_DIR/SUPPORT.md" "$destination/SUPPORT.md"
  cp "$TEMPLATE_DIR/THIRD_PARTY_NOTICES.md" "$destination/THIRD_PARTY_NOTICES.md"
}

stage_screenshots() {
  local runtime_screenshot="$1"
  local destination="$2"
  local source
  local hash_01
  local hash_02
  local hash_03
  local hash_04

  for source in \
    "$SCREENSHOT_SOURCE_DIR/01-skill-suite.png" \
    "$SCREENSHOT_SOURCE_DIR/02-cli-contract.png" \
    "$SCREENSHOT_SOURCE_DIR/03-visual-debugging.png" \
    "$runtime_screenshot"; do
    [[ -f "$source" ]] || die "required screenshot is missing: $source"
    /usr/bin/file "$source" | /usr/bin/grep -q 'PNG image data' \
      || die "required screenshot is not a PNG: $source"
  done

  assert_runtime_screenshot_provenance "$runtime_screenshot" "$SCREENSHOT_PROVENANCE"

  cp "$SCREENSHOT_SOURCE_DIR/01-skill-suite.png" "$destination/01-skill-suite.png"
  cp "$SCREENSHOT_SOURCE_DIR/02-cli-contract.png" "$destination/02-cli-contract.png"
  cp "$SCREENSHOT_SOURCE_DIR/03-visual-debugging.png" "$destination/03-visual-debugging.png"
  cp "$runtime_screenshot" "$destination/04-native-macos-app.png"

  hash_01="$(sha256_file "$destination/01-skill-suite.png")"
  hash_02="$(sha256_file "$destination/02-cli-contract.png")"
  hash_03="$(sha256_file "$destination/03-visual-debugging.png")"
  hash_04="$(sha256_file "$destination/04-native-macos-app.png")"
  write_public_screenshot_provenance \
    "$destination/provenance.json" "$hash_01" "$hash_02" "$hash_03" "$hash_04"
}

prepare_release_bundle() {
  local source_app="$1"
  local version="$2"
  local work_parent="$3"
  local staged_app="$work_parent/$APP_PRODUCT.app"
  local module_cache="$PACKAGE_DIR/.build/ModuleCache"
  local release_binary

  [[ -d "$source_app" ]] \
    || die "prebuilt app is missing; run ./script/build_and_run.sh --build-only first"
  mkdir -p "$module_cache"
  export CLANG_MODULE_CACHE_PATH="$module_cache"
  export SWIFTPM_MODULECACHE_OVERRIDE="$module_cache"

  note "compiling the native executable with SwiftPM release optimization"
  swift build --disable-sandbox --configuration release --package-path "$PACKAGE_DIR"
  release_binary="$(swift build --disable-sandbox --configuration release --package-path "$PACKAGE_DIR" --show-bin-path)/$APP_PRODUCT"
  [[ -x "$release_binary" ]] || die "SwiftPM release executable is missing"

  /usr/bin/ditto --norsrc --noextattr --noqtn "$source_app" "$staged_app"
  cp "$release_binary" "$staged_app/Contents/MacOS/$APP_PRODUCT"
  chmod 755 "$staged_app/Contents/MacOS/$APP_PRODUCT"
  /usr/bin/strip -S "$staged_app/Contents/MacOS/$APP_PRODUCT"
  /usr/bin/xattr -cr "$staged_app"
  /usr/bin/codesign --force --sign - --identifier "$BUNDLE_IDENTIFIER" "$staged_app" >/dev/null

  find "$staged_app" -type d -exec chmod 755 {} +
  find "$staged_app" -type f -exec chmod 644 {} +
  chmod 755 "$staged_app/Contents/MacOS/$APP_PRODUCT"

  # Fixed mtimes make the ordered, extra-field-free ZIP byte-reproducible.
  find "$staged_app" -exec touch -h -t 202608280000 {} +
  validate_app_bundle "$staged_app" "$version"
}

package_release() {
  local version="$1"
  local screenshot="$2"
  local output_input="$3"
  local app_input="$4"
  local output
  local app
  local screenshot_path
  local repository
  local assets
  local artifact_name
  local artifact
  local second_artifact
  local artifact_hash
  local second_hash
  local source_revision
  local temp_root
  local bundle_parent
  local extraction_root

  assert_safe_version "$version"
  validate_template "$TEMPLATE_DIR"
  assert_clean_source_tree
  [[ "$(uname -m)" == "$EXPECTED_ARCHITECTURES" ]] \
    || die "release build host must be arm64 for this audited architecture lane"

  app="$(resolve_existing_path "$app_input")"
  screenshot_path="$(resolve_existing_path "$screenshot")"
  output="$(resolve_new_path "$output_input")"
  [[ ! -e "$output" ]] || die "output path already exists; refusing to overwrite: $output"

  artifact_name="$APP_PRODUCT-$version-macOS-arm64.zip"
  repository="$output/repository"
  assets="$output/release-assets"
  source_revision="$(git -C "$ROOT_DIR" rev-parse --verify HEAD)"
  temp_root="$(mktemp -d "${TMPDIR:-/tmp}/gds-macos-release.XXXXXX")"
  trap 'rm -rf "$temp_root"' EXIT
  bundle_parent="$temp_root/bundle"
  extraction_root="$temp_root/extracted"
  mkdir -p "$bundle_parent"

  prepare_release_bundle "$app" "$version" "$bundle_parent"

  mkdir -p "$repository" "$assets"
  artifact="$assets/$artifact_name"
  second_artifact="$temp_root/$artifact_name"
  create_deterministic_zip "$bundle_parent" "$artifact"
  create_deterministic_zip "$bundle_parent" "$second_artifact"
  artifact_hash="$(sha256_file "$artifact")"
  second_hash="$(sha256_file "$second_artifact")"
  [[ "$artifact_hash" == "$second_hash" ]] \
    || die "two normalized archive passes were not byte-identical"

  extract_and_validate_archive "$artifact" "$version" "$extraction_root"

  copy_public_repository_template "$repository"
  stage_screenshots "$screenshot_path" "$repository/screenshots"
  printf '%s  %s\n' "$artifact_hash" "$artifact_name" >"$repository/CHECKSUMS.txt"
  write_release_metadata \
    "$repository/release-metadata.json" "$version" "$artifact_name" "$artifact_hash" "$source_revision"
  validate_public_repository "$repository" "$artifact_name" "$artifact_hash"

  note "binary-only repository staging: $repository"
  note "release attachment: $artifact"
  note "SHA-256: $artifact_hash"
  note "architecture: $EXPECTED_ARCHITECTURES"
  note "signature: ad-hoc; Developer ID: no; notarized: no; Hardened Runtime claim: no"

  rm -rf "$temp_root"
  trap - EXIT
}

verify_release() {
  local version="$1"
  local release_root_input="$2"
  local release_root
  local artifact_name
  local artifact
  local artifact_hash
  local expected_hash
  local temp_root

  assert_safe_version "$version"
  release_root="$(resolve_existing_path "$release_root_input")"
  artifact_name="$APP_PRODUCT-$version-macOS-arm64.zip"
  artifact="$release_root/release-assets/$artifact_name"
  [[ -f "$artifact" ]] || die "release artifact is missing: $artifact"
  artifact_hash="$(sha256_file "$artifact")"
  expected_hash="$(/usr/bin/awk -v name="$artifact_name" '$2 == name {print $1}' "$release_root/repository/CHECKSUMS.txt")"
  [[ "$expected_hash" == "$artifact_hash" ]] || die "release artifact checksum mismatch"

  temp_root="$(mktemp -d "${TMPDIR:-/tmp}/gds-macos-verify.XXXXXX")"
  trap 'rm -rf "$temp_root"' EXIT
  extract_and_validate_archive "$artifact" "$version" "$temp_root/extracted"
  validate_public_repository "$release_root/repository" "$artifact_name" "$artifact_hash"
  note "release staging verified: $release_root"
  note "SHA-256: $artifact_hash"
  rm -rf "$temp_root"
  trap - EXIT
}

self_test() {
  local fixture_root
  local repository
  local dummy_artifact="GameDevelopmentStudio-1.0.0-macOS-arm64.zip"
  local dummy_hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  local hash_01
  local hash_02
  local hash_03
  local hash_04

  validate_template "$TEMPLATE_DIR"
  fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/gds-release-self-test.XXXXXX")"
  trap 'rm -rf "$fixture_root"' EXIT
  repository="$fixture_root/repository"
  copy_public_repository_template "$repository"
  cp "$SCREENSHOT_SOURCE_DIR/01-skill-suite.png" "$repository/screenshots/01-skill-suite.png"
  cp "$SCREENSHOT_SOURCE_DIR/02-cli-contract.png" "$repository/screenshots/02-cli-contract.png"
  cp "$SCREENSHOT_SOURCE_DIR/03-visual-debugging.png" "$repository/screenshots/03-visual-debugging.png"
  cp "$SCREENSHOT_SOURCE_DIR/01-skill-suite.png" "$repository/screenshots/04-native-macos-app.png"
  hash_01="$(sha256_file "$repository/screenshots/01-skill-suite.png")"
  hash_02="$(sha256_file "$repository/screenshots/02-cli-contract.png")"
  hash_03="$(sha256_file "$repository/screenshots/03-visual-debugging.png")"
  hash_04="$(sha256_file "$repository/screenshots/04-native-macos-app.png")"
  write_public_screenshot_provenance \
    "$repository/screenshots/provenance.json" "$hash_01" "$hash_02" "$hash_03" "$hash_04"
  printf '%s  %s\n' "$dummy_hash" "$dummy_artifact" >"$repository/CHECKSUMS.txt"
  write_release_metadata \
    "$repository/release-metadata.json" "1.0.0" "$dummy_artifact" "$dummy_hash" \
    "0000000000000000000000000000000000000000"
  validate_public_repository "$repository" "$dummy_artifact" "$dummy_hash"

  mkdir -p "$repository/Sources"
  printf 'struct Leaked {}\n' >"$repository/Sources/Leaked.swift"
  if (validate_public_repository "$repository" "$dummy_artifact" "$dummy_hash") >/dev/null 2>&1; then
    die "self-test failed: Swift source was accepted"
  fi
  rm -rf "$repository/Sources"

  printf 'not an attached release\n' >"$repository/CommittedArtifact.zip"
  if (validate_public_repository "$repository" "$dummy_artifact" "$dummy_hash") >/dev/null 2>&1; then
    die "self-test failed: committed ZIP was accepted"
  fi
  rm -f "$repository/CommittedArtifact.zip"

  ln -s README.md "$repository/README-link.md"
  if (validate_public_repository "$repository" "$dummy_artifact" "$dummy_hash") >/dev/null 2>&1; then
    die "self-test failed: symlink was accepted"
  fi
  rm -f "$repository/README-link.md"

  chmod +x "$repository/README.md"
  if (validate_public_repository "$repository" "$dummy_artifact" "$dummy_hash") >/dev/null 2>&1; then
    die "self-test failed: executable metadata file was accepted"
  fi
  chmod -x "$repository/README.md"

  validate_public_repository "$repository" "$dummy_artifact" "$dummy_hash"
  git -C "$repository" init -q
  validate_public_repository "$repository" "$dummy_artifact" "$dummy_hash"
  note "self-test passed: allowlisted trees with or without .git were accepted; source, ZIP, symlink, and executable-file fixtures rejected"
  rm -rf "$fixture_root"
  trap - EXIT
}

main() {
  local command_name="${1:-}"
  local version=""
  local screenshot=""
  local output=""
  local app="$DEFAULT_APP"
  local release_root=""

  for command in git swift /usr/bin/awk /usr/bin/codesign /usr/bin/ditto \
    /usr/bin/file /usr/bin/lipo /usr/bin/otool /usr/bin/plutil /usr/bin/shasum \
    /usr/bin/strip /usr/bin/unzip /usr/bin/zip; do
    require_command "$command"
  done

  case "$command_name" in
    package|verify|self-test) shift ;;
    -h|--help|help|"") usage; exit 0 ;;
    *) usage >&2; die "unknown command: $command_name" ;;
  esac

  if [[ "$command_name" == "self-test" ]]; then
    [[ "$#" -eq 0 ]] || die "self-test takes no arguments"
    self_test
    exit 0
  fi

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --version)
        [[ "$#" -ge 2 ]] || die "--version requires a value"
        version="$2"
        shift 2
        ;;
      --screenshot)
        [[ "$#" -ge 2 ]] || die "--screenshot requires a value"
        screenshot="$2"
        shift 2
        ;;
      --output)
        [[ "$#" -ge 2 ]] || die "--output requires a value"
        output="$2"
        shift 2
        ;;
      --app)
        [[ "$#" -ge 2 ]] || die "--app requires a value"
        app="$2"
        shift 2
        ;;
      --release-root)
        [[ "$#" -ge 2 ]] || die "--release-root requires a value"
        release_root="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  [[ -n "$version" ]] || die "--version is required"
  case "$command_name" in
    package)
      [[ -n "$screenshot" ]] || die "--screenshot is required"
      [[ -n "$output" ]] || die "--output is required"
      [[ -z "$release_root" ]] || die "--release-root is only valid with verify"
      package_release "$version" "$screenshot" "$output" "$app"
      ;;
    verify)
      [[ -n "$release_root" ]] || die "--release-root is required"
      [[ -z "$screenshot" && -z "$output" ]] \
        || die "--screenshot and --output are only valid with package"
      verify_release "$version" "$release_root"
      ;;
  esac
}

main "$@"
