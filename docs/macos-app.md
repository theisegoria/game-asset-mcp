# Native macOS app

Game Development Studio includes a native macOS 26 companion for developers
who prefer a desktop control surface over issuing `game-dev` commands directly.
It uses the same local CLI and structured `game_dev.result.v1` contract as the
skills. The app has no publisher-hosted backend or alternate asset format, and
the CLI and skills remain independently usable.

## Status and requirements

- Source package: `apps/macos/GameDevelopmentStudio`
- Product: `GameDevelopmentStudio`
- Interface: SwiftUI with Swift Observation
- Package format: SwiftPM, Swift tools 6.2, Swift language mode 6
- Deployment target: macOS 26
- Local bundle: `apps/macos/GameDevelopmentStudio/dist/GameDevelopmentStudio.app`

The application source compiles and has automated model, credential-store, CLI
client, and value-model tests. The repository helper builds a local app bundle
and applies an ad-hoc signature. Developer ID signing, notarization, external
Gatekeeper validation, and Mac App Store distribution are not part of that
helper and remain separate release gates.

## Architecture

The app keeps presentation, orchestration, credentials, and process execution
in distinct layers:

```text
WindowGroup + Settings
        |
SwiftUI workspaces, toolbar, commands, inspector, approval sheets
        |
@MainActor @Observable AppModel
        |                         |
GameDevCLIClient                 KeychainCredentialStore
        |
local game-dev process -> game_dev.result.v1 -> redacted result/history
```

`GameDevelopmentStudioApp` owns one `AppModel`, injects it through the SwiftUI
environment, and presents both a primary `WindowGroup` and a separate
`Settings` scene. `ContentView` uses a native `NavigationSplitView`, toolbar
search, focused menu commands, and a trailing result inspector. The views call
asynchronous `AppModel` operations; they do not launch `Process` themselves.

`AppModel` owns selected workspace, search text, local preferences, operation
state, cancellation, the latest structured result, and recent result history.
It translates a UI operation into a typed CLI invocation. `GameDevCLIClient`
executes the configured local executable with an argument array rather than
shell interpolation, bounds standard input and captured output, validates the
result schema, and redacts configured secrets from diagnostics before a result
is presented.

The interface relies on native controls, semantic colors, and system materials
so it follows the active light or dark appearance. It includes labelled controls,
keyboard commands, progress and cancellation affordances, and explicit empty
and error states. Those source properties and automated checks do not by
themselves prove every rendered or assistive-technology state; see
[Evidence boundaries](#evidence-boundaries).

## Workspaces

### Production

Production provides local environment checks, paid generation, inspection,
validation, and canonical package construction. The current app exposes Tripo
3D generation plus Leonardo image and sound generation. A paid request includes
the provider, operation, asset name, prompt, and a finite estimated-cent ceiling
on its one-shot approval sheet. Provider receipts are starting evidence, not a
claim that a downloaded asset is game-ready; inspection, validation, packaging,
and project admission remain separate steps.

Package construction is also a local write. The approval sheet binds the source
path, package identity, version, and SPDX license before `AppModel` permits the
build.

### Library & Vendoring

Library & Vendoring searches the derived catalog and admits a canonical package
into a selected game project. Admission is dry-run-first. A successful plan is
associated with the exact package reference, project path, and destination; any
field change invalidates that plan. The user must then approve a fresh confirmed
invocation before project files can be written.

An admission receipt can establish the copied roster and package provenance. It
does not establish engine import success, runtime rendering, target-GPU
behavior, or artistic acceptance.

### Visual Debugging

Visual Debugging discovers and plans project-owned capture scenarios, runs one
approved scenario, analyzes a sealed run, and compares baseline and candidate
runs with an explicit raster threshold. The project, scenario, GPU authority,
and hardware-performance authority form the plan identity; changing any of
them requires a new plan.

Process execution is always shown on the run approval sheet. GPU capture and
hardware-performance collection are independent, opt-in authorities for that
single run. Analysis can combine color with declared semantic attachments such
as depth, normals, object IDs, material IDs, motion, and overdraw. Those buffers
can make a diagnosis more inspectable, but they are not human visual approval or
independent proof that a particular GPU path executed.

### Performance

Performance summarizes metrics in sealed runs and compares baseline and
candidate statistics. The app exposes mean, median, p95, and p99 comparisons;
the model and CLI contract also accept min and max. New hardware measurement is
not started from this workspace: the interface routes the user to Visual
Debugging, where the exact scenario and performance authority are planned and
approved together.

Deterministic arithmetic over admitted telemetry is not proof that two runs are
hardware-comparable, that a timer is accurate, that a change is statistically
significant, or that a measured change has the proposed cause.

## CLI and Keychain boundary

General settings store the configured CLI executable and output directory in
local application preferences. The output directory remains the home for CLI
jobs, packages, captures, comparisons, and receipts.

Tripo and Leonardo credentials use the macOS Keychain through
`KeychainCredentialStore`:

- Entry uses a masked `SecureField`.
- The app reports only configured or not configured.
- A saved value is never loaded back into a visible field.
- The user may replace or explicitly delete a saved value.
- Credentials are not accepted as CLI arguments or written into request files.
- `AppModel` requests credentials only for invocations that explicitly declare
  provider access. Environment and capability checks may inspect both provider
  configurations; a paid production request receives only its selected
  provider. Asset, vendoring, capture-analysis, and performance-analysis
  invocations receive none.
- The CLI child receives an applicable credential through its process
  environment. Result parsing and diagnostic presentation redact the configured
  secret values.

This boundary reduces accidental disclosure; it is not a general claim about
the security of the host, third-party provider, target game, or every external
tool that an approved scenario may run.

## Approval model

Approval sheets are summaries of the exact operation about to run. Every sheet
states that approval applies once to the displayed values and is not saved as
standing permission.

| Action | Preview or plan | Required one-shot authority | Model/CLI enforcement |
| --- | --- | --- | --- |
| Paid Tripo or Leonardo job | Request fields and finite cent ceiling | Paid provider | `approved` plus `--approve-spend` and `--spend-limit-cents` |
| Build canonical package | Source, name, version, and license | Local process/file write | `confirmed` before package build |
| Vendor package | Successful dry-run for exact package, project, and destination | Local process/project write | Fresh `confirmed` invocation adds `--confirm` |
| Run capture scenario | Successful plan for exact project, scenario, and capability flags | Local process | `confirmed` adds `--confirm` |
| Use scenario GPU path | Same scenario plan | GPU capture | Independent `--allow-gpu` flag |
| Collect hardware timings | Same scenario plan | Performance measurement | Independent `--allow-performance` flag |

Closing or cancelling a sheet grants nothing. Changing a vendoring or scenario
plan input invalidates the UI's current-plan token. CLI-side validation and
adapter-declared capabilities remain authoritative even after the UI approves a
request.

## Build, test, and run

Run the helper from the repository root. It uses the SwiftPM package, generates
the local `.app` structure and `Info.plist`, derives `AppIcon.icns` from
`assets/icon.png`, and signs the result ad hoc.

Run the Swift tests without building an app bundle:

```sh
./script/build_and_run.sh --test
```

Build the local bundle without launching it:

```sh
./script/build_and_run.sh --build-only
```

Build, bundle, ad-hoc sign, and launch:

```sh
./script/build_and_run.sh
```

Build and perform the helper's process-level launch check:

```sh
./script/build_and_run.sh --verify
```

Development modes are also available:

```sh
./script/build_and_run.sh --debug
./script/build_and_run.sh --logs
./script/build_and_run.sh --telemetry
```

`--debug` starts LLDB for the bundled executable. `--logs` follows process logs,
and `--telemetry` follows the app's logging subsystem. These modes can continue
running until the developer exits the debugger or log stream.

## Local bundle and distribution status

The build helper runs `codesign --sign -`, which creates an ad-hoc signature.
The bundle is therefore not literally unsigned, but it has no Developer ID or
Mac App Store distribution identity. It is a local development artifact:

- no Developer ID signing is claimed;
- no hardened-runtime or distribution entitlement assessment is claimed;
- no Apple notarization ticket is claimed;
- no validation of a quarantined download on another Mac is claimed;
- no Mac App Store archive, upload, or review is claimed.

A publication build needs its own signing, entitlement, packaging,
notarization, installation, upgrade, and clean-machine acceptance process.

## Evidence boundaries

The strongest supported statement depends on the check that actually ran:

| Evidence | What it supports | What it does not support |
| --- | --- | --- |
| Source inspection | The described SwiftUI, model, Keychain, and CLI boundaries exist in source | Launch, pixels, accessibility behavior, provider behavior, GPU execution |
| `./script/build_and_run.sh --test` | The exercised automated tests passed in that toolchain and environment | Untested workflows, live providers, app launch, pixels, signing or notarization |
| `--build-only` | Swift compiled and linked, and the helper constructed an ad-hoc-signed local bundle | Successful launch, usable workflows, visual correctness, external distribution |
| `--verify` | The helper launched the bundle and found its process after a two-second delay | Window readiness, workflow completion, crash-free duration, pixels, accessibility, human acceptance |
| A real runtime screenshot | One captured visual state on one machine | All workspaces, themes, displays, dynamic states, keyboard use, accessibility, or human acceptance |
| A sealed capture or performance result | The bundle's declared controls, files, hashes, attachments, and telemetry | Causality or undeclared hardware behavior; GPU/performance claims require a real admitted target-hardware run |

At the time this document was prepared, the native screenshot reserved for
`assets/screenshots/04-native-macos-app.png` had not yet been captured or
visually inspected. It must not be treated as evidence until the file is
created from a real runtime and reviewed.

Live Tripo or Leonardo acceptance, Blender-backed workflows, target-game
scenario execution, GPU capture, hardware-performance measurement, long-running
stability, pixel comparison of the app itself, assistive-technology review,
Developer ID signing, notarization, and external human review are separate
gates unless their own receipts or review records are produced.
