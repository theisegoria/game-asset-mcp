# Game Development Studio for macOS

Game Development Studio is a native macOS control surface for the local
`game-dev` toolchain. It brings asset production, canonical package vendoring,
evidence-rich visual debugging, and performance comparison into four focused
workspaces without a publisher-hosted application backend.

![Game Development Studio running on macOS 26](screenshots/04-native-macos-app.png)

## Download

Download `GameDevelopmentStudio-1.0.0-macOS-arm64.zip` from the
[latest GitHub release](https://github.com/theisegoria/game-development-studio-macos/releases/latest)
and use the matching [CHECKSUMS.txt](CHECKSUMS.txt) from this repository.

This first release has a deliberately narrow platform contract:

- macOS 26.0 or later
- Apple silicon (`arm64`) only
- the bundled, roster-verified `game-dev` CLI 1.0.2 and its pinned Node runtime

Blender is needed only for CLI operations that explicitly use Blender. Tripo
or Leonardo credentials are needed only for the selected provider's paid
route.

## Verify the download

Put the ZIP and `CHECKSUMS.txt` in the same directory, then run:

```sh
shasum -a 256 -c CHECKSUMS.txt
ditto -x -k GameDevelopmentStudio-1.0.0-macOS-arm64.zip .
codesign --verify --deep --strict GameDevelopmentStudio.app
lipo -archs GameDevelopmentStudio.app/Contents/MacOS/GameDevelopmentStudio
```

The final command must print exactly `arm64`. The signature inspection command

```sh
codesign -dvvv GameDevelopmentStudio.app
```

must report `Signature=adhoc` and `TeamIdentifier=not set` for version 1.0.0.
The checksum detects a changed download; it is not a substitute for a
Developer ID identity or Apple notarization.

## Install and open

After verification, move `GameDevelopmentStudio.app` to `/Applications` or a
folder you control. This release is ad-hoc signed and not Developer ID signed or
notarized. macOS may therefore refuse a normal first launch after the
app is downloaded. If you trust the release and its verified checksum, use
Finder's Control-click **Open** flow or the specific **Open Anyway** control in
System Settings > Privacy & Security. Do not disable Gatekeeper globally.

The app selects its bundled closed runtime by default. Settings can restore that
default. A `game-dev` command from `PATH` or an arbitrary executable may be used
for credential-free diagnostics only; paid, write, capture, and performance
operations fail closed unless the configured path resolves to a complete
rostered Studio runtime. Provider credentials are optional and remain
provider-specific.

## Four local workspaces

- **Production** checks the local toolchain, submits explicitly approved Tripo
  or Leonardo work, inspects and validates GLB files, and builds canonical
  packages with identity and license data.
- **Library & Vendoring** searches the derived package catalog and plans an
  exact project admission before any confirmed write.
- **Visual Debugging** discovers project-owned scenarios, separates process,
  GPU, and hardware-performance authority, and analyzes sealed captures with
  declared semantic attachments and telemetry.
- **Performance** summarizes admitted metrics and compares bounded statistics
  between sealed runs.

Paid provider work, package construction, project writes, scenario execution,
GPU capture, and hardware-performance collection use one-shot approval sheets.
Approval is for the displayed invocation; it is not saved as standing
permission.

## Product tour

![The five local skills and their workflow boundaries](screenshots/01-skill-suite.png)

The skill-suite image is a product map built from the released skill names and
metadata. It is not a native-app runtime capture.

![The structured local CLI result contract](screenshots/02-cli-contract.png)

The CLI image shortens a released CLI result for display. It documents the
structured boundary; it is not evidence of a provider or project run.

![Synthetic visual-debugging fixture with semantic evidence](screenshots/03-visual-debugging.png)

The visual-debugging image is explicitly synthetic. It does not claim a target
game, GPU execution, pixel approval, causality, or measured performance.

## Local-first boundaries

The app includes a closed local runtime containing the compiled CLI, production
dependencies, required helper resources, and a direct Node executable. It does
not include Blender, a game engine, or provider services. Before a sensitive
operation it measures the exact runtime roster, performs a credential-free
handshake, rechecks the approved tree, copies it into a private snapshot, and
launches that snapshot directly. This binds a one-shot approval to local bytes;
it does not authenticate the publisher or attest external tools. Tripo and
Leonardo credentials are stored in macOS Keychain, entered through masked
fields, and are not restored into visible fields. See [PRIVACY.md](PRIVACY.md) and
[SECURITY.md](SECURITY.md) for the narrower guarantees and limitations.

No analytics or publisher-hosted backend is included. An explicitly approved
provider request goes directly from the user's machine to that provider under
the provider's own terms.

## Evidence, not overclaiming

A package receipt does not prove engine import or rendering. Semantic capture
attachments do not replace human visual review. Deterministic metric arithmetic
does not prove hardware comparability, causality, or statistical significance.
GPU and performance claims require a real admitted run on the stated target
hardware.

The native screenshot above records one provenance-reviewed state on one Mac.
The other images in `screenshots/` are labelled product illustrations; they are
not runtime, provider, target-game, GPU, pixel-approval, or performance evidence.

## Distribution trust state

Version 1.0.0 is:

- compiled as a native `arm64` macOS app bundle;
- ad-hoc signed (`Signature=adhoc`, no Team Identifier);
- not Developer ID signed;
- not notarized and has no stapled notarization ticket;
- not claimed to use Hardened Runtime;
- not a Mac App Store build; and
- distributed as a compiled app ZIP, with no Swift or TypeScript project source
  in this repository. The app necessarily carries compiled JavaScript and the
  two rostered Blender helper scripts as runtime payload files.

`release-metadata.json` records the observed ad-hoc signature state and
CodeDirectory hash used to compare the staged and extracted app bundles. Those
fields help detect an internally inconsistent release staging; they do not
authenticate a publisher identity or replace Developer ID signing.

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for the release boundary and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled-component details.

## Support

Use [GitHub Issues](https://github.com/theisegoria/game-development-studio-macos/issues)
for reproducible defects and documentation problems. Use GitHub private
vulnerability reporting for security-sensitive findings. Never attach provider
keys, private game assets, signed URLs, or private project paths to a report.
