# Game Development Studio for macOS

Publication-ready copy for the native companion. Distribution and screenshot
claims remain intentionally conditional until those release gates are complete.

## Name

Game Development Studio

## Tagline

Produce, vendor, diagnose, and measure game assets from one local Mac workspace.

## Short description

A native macOS 26 companion for the local-first `game-dev` toolchain. Generate
and package assets, admit verified packages into projects, inspect evidence-rich
captures, and compare performance without routing the workflow through a hosted
backend or MCP server.

## Store-length summary

Game Development Studio gives asset production and game diagnosis a native Mac
control surface. Its four workspaces keep paid generation, canonical packaging,
project vendoring, sealed capture analysis, and performance comparison in one
inspectable workflow. Credentials stay in Keychain, results stay in the selected
local workspace, and consequential actions require explicit one-shot approval.

## Long description

Game development rarely has an asset problem or a rendering problem in
isolation. A generated model needs validation, provenance, packaging, and safe
project admission. A suspicious frame needs more than a screenshot: it needs
repeatable controls, semantic buffers, logs, counters, timings, and a receipt
that says what actually ran.

Game Development Studio brings those jobs together in a native macOS 26 app
backed by the open, local `game-dev` command-line contract.

**Production** checks the local toolchain, submits an explicitly approved Tripo
or Leonardo request, inspects and validates GLB assets, and builds canonical
packages with identity and license information.

**Library & Vendoring** searches the package catalog and plans admission before
any project write. Change the package, project, or destination and the plan must
be run again; approving one plan never becomes standing permission.

**Visual Debugging** discovers project-owned scenarios, separates process, GPU,
and hardware-performance authority, analyzes sealed captures, and compares
baseline and candidate runs with a chosen raster threshold. Color can be read
alongside declared depth, normal, object-ID, material-ID, motion, and overdraw
attachments, giving an agent or developer evidence beyond visual guesswork.

**Performance** summarizes admitted telemetry and compares bounded statistics
between sealed runs. New hardware measurements return to the scenario workflow,
where their authority is planned and approved for one run.

The result inspector keeps the latest structured response, receipt path, and
recent activity visible without revealing saved credentials. Native search,
toolbars, menus, keyboard shortcuts, settings, progress, cancellation, and
empty or error states make the CLI contract approachable without hiding its
boundaries.

## Feature bullets

- Four native workspaces: Production, Library & Vendoring, Visual Debugging,
  and Performance
- Tripo 3D generation and Leonardo image or sound generation with a finite
  estimated-cent ceiling
- Local GLB inspection, validation, and canonical package construction
- Dry-run-first package admission with an exact-input approval path
- Reproducible project scenario planning with separate process, GPU, and
  hardware-performance authority
- Sealed-capture analysis and baseline/candidate raster comparison
- Deterministic telemetry summaries and performance comparisons
- Structured results, receipt paths, and recent operation history in a native
  inspector
- macOS Keychain storage with masked entry and configured-state-only display
- Local CLI execution through the stable `game_dev.result.v1` protocol
- No MCP server or hosted application backend required

## Trust and approval copy

**Your keys are not interface content.** Provider credentials are entered in a
masked field, stored in macOS Keychain, and never read back into a visible
field. The app can report configured state, replace a value, or delete it.

**Approval is an invocation, not a preference.** Paid provider work, local
package construction, project writes, scenario execution, GPU capture, and
hardware-performance collection are reviewed in one-shot sheets. Each sheet
shows the operation and authority being granted. It is not saved as standing
permission.

**Evidence says what it can prove.** A package receipt does not prove that an
engine imported or rendered the asset. Semantic capture attachments do not
replace human visual review. Deterministic metric arithmetic does not prove
hardware comparability or causality. GPU and performance claims require a real,
admitted target-hardware run.

## Website hero

### A local studio for the evidence between asset and frame

Generate deliberately. Package reproducibly. Vendor with a plan. Debug from
sealed captures and telemetry instead of a screenshot alone.

**Primary call to action before a signed release:** View the source

**Primary call to action after a signed, notarized release:** Download for macOS

## Launch post

Game Development Studio now has a native macOS 26 companion. It brings asset
production, canonical package vendoring, evidence-rich visual debugging, and
performance comparison into four local workspaces backed by the same open
`game-dev` JSON contract.

Provider credentials stay in Keychain. Paid calls, project writes, scenario
execution, GPU work, and hardware timing collection receive explicit one-shot
approval. The CLI and Codex skills still work independently; no MCP server or
hosted backend is required.

Use the “available now” version of this post only after a release artifact has
been signed, notarized, published, and independently downloaded and launched.

## Screenshot plan and captions

### Screenshot 04 — native app overview

**Reserved path:** `assets/screenshots/04-native-macos-app.png`

**Status:** Placeholder only. A real runtime capture has not yet been created or
visually inspected. Do not publish an image claim or use the following caption
until the actual file has been reviewed.

**Proposed caption after review:** Game Development Studio on macOS 26, with
the four workflow workspaces in the native sidebar and a structured receipt in
the result inspector.

**Proposed alt text after review:** Native Game Development Studio window on
macOS, showing the workspace sidebar, selected workflow controls, and the result
inspector.

Recommended evidence set after real capture:

1. Production with a non-secret, synthetic request and approval sheet.
2. Library & Vendoring showing a successful dry-run plan, not a project write.
3. Visual Debugging with a clearly labelled synthetic fixture and semantic
   attachment summary.
4. Performance with synthetic or fixture data explicitly labelled as such.
5. Settings showing configured/not-configured state with every secret field
   empty.
6. Light and dark appearance plus a narrow-window layout check.

## System requirements and current distribution status

- macOS 26 or later
- Local `game-dev` installation or an explicitly configured executable path
- Blender only for workflows whose CLI operation requires Blender
- Tripo or Leonardo account and credential only for that provider's paid route
- A project adapter only for project-owned capture scenarios

The repository helper currently creates an ad-hoc-signed local development
bundle. It is not a Developer ID-signed or notarized release, has not passed Mac
App Store review, and should not be marketed as an externally distributable Mac
download until those gates are completed.

## Claims checklist before publication

Do not change conditional copy to an unconditional claim until the matching
evidence exists:

- “Runs on macOS 26” requires a real launch and workflow smoke test on macOS 26;
  compilation alone is insufficient.
- “Accessible” requires keyboard, VoiceOver, contrast, focus-order, text-size,
  and meaningful-state review; accessibility labels in source are insufficient.
- “Looks correct in light and dark mode” requires captured and inspected runtime
  states in both appearances.
- “GPU capture works” requires a real admitted GPU scenario and its receipt.
- “Improves performance” requires comparable target-hardware measurements and a
  bounded claim; deterministic comparison code alone is insufficient.
- “Secure” is too broad. State the narrower, verified Keychain, argument,
  redaction, approval, and local-storage properties instead.
- “Signed and notarized” requires the released artifact's signature and
  notarization evidence, not the helper's ad-hoc signature.
- “Available for download” requires a published artifact plus an independent
  clean download, quarantine, launch, and upgrade check.
