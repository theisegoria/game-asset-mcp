# Architecture

Game Development Studio is a local library and command-line program. The
`game-dev` CLI is the supported integration boundary for developers, coding
agents, CI, and the native app, so every caller uses the same executable and
inspectable JSON/JSONL contract.

```text
developer / Codex / Claude / native app
                  │
                  ▼
        game-dev JSON / JSONL CLI
                  │
       ┌──────────┼──────────────┐
       ▼          ▼              ▼
 provider jobs  asset core   capture harness
       │          │              │
 Tripo/Leonardo  packages      project adapter
                  │              │
               catalog       sealed run bundle
```

## Composition root

`src/runtime.ts` constructs the configured providers, storage, durable jobs,
and local command registry. `src/cli.ts` is the public process boundary. The
library exports reusable components through `src/index.ts`, but the CLI owns
argument parsing, approval flags, result envelopes, and stdout discipline.

The major source modules are:

- `providers/`: narrow Tripo and Leonardo HTTP clients
- `jobs/` and `storage/`: durable operations, atomic files, and spend state
- `tools/`: reusable intention-shaped local operations
- `inspection/` and `normalize/`: static GLB/PBR inspection and Blender
  orchestration
- `packages/`: canonical package format, catalog, migration, vendoring,
  launch planning, and USDZ previews
- `harness/`: adapters, run bundles, capture analysis, performance summaries,
  and optimization goals
- `skills/`: bundled skill discovery, hashing, and explicit installation

## Process protocol

The process contract is intentionally smaller than the internal API:

- stdout contains one JSON result or a JSONL event stream
- stderr contains human-readable diagnostics and redacted logs
- every terminal result names a stable schema and operation
- long-running operations emit progress and artifact events
- failures are structured; an interruption must not erase durable job state

This keeps local agents lightweight: they do not need a resident daemon,
transport registration, a port, or a second authorization system.

## Authority and approvals

Reading and planning are distinct from mutation. The following decisions are
never inferred from a previous invocation:

- `--confirm`: local mutation or process execution
- `--approve-spend` plus `--spend-limit-cents`: a paid provider request
- `--allow-gpu`: a scenario that declares GPU work
- `--allow-performance`: hardware-performance measurement
- `--allow-unknown-license` or `--allow-invalid`: a specific vendoring
  blocker override

The CLI does not persist these flags as standing permission. Plans include the
paths and capabilities a later confirmed invocation would use.

## Provider boundary

Provider adapters preserve vendor-specific request and response fields where
they matter but expose common job state, artifacts, hashes, and provenance to
the rest of the product. Provider URLs must use HTTPS. API keys remain in the
environment (and later Keychain through the native app); they are never command
arguments or persisted receipt fields.

Every paid submission is recorded before polling. A timeout after submission is
therefore an uncertain external state, not permission to automatically submit a
duplicate request. Resume requires fresh authorization.

Tests exercise provider contracts against local HTTPS fixtures. They prove
request construction, parsing, redaction, spend gating, polling, downloads, and
persistence in that fixture environment—not the live provider's current
behavior.

## Canonical asset packages

A package is a closed directory with a canonical JSON manifest, receipt,
portable GLB, and optional preview. The manifest binds each admitted file to a
SHA-256 digest, its source and transformations, license, inspection results,
and policy outcome.

The SQLite catalog is deliberately derived state. It can be backed up and
rebuilt from package manifests; it is not the provenance authority. Project
vendoring verifies package bytes immediately before admission and writes a
project-local receipt.

See [Asset packages](asset-packages.md).

## Capture harness

The core harness knows no game executable. A project adapter supplies:

- project-relative executable and working directory
- scenario arguments and typed parameters
- declared capabilities
- timeout
- output format and staging path

The harness validates the adapter and plan before process launch, refuses
symlink/path escapes, grants each declared capability separately, and normalizes
supported output formats into a versioned run manifest. A successful run is
sealed with a closed artifact roster and hashes.

The adapter-reported `gpu` or `metal` capability describes the requested and
reported lane. Hardware GPU evidence exists only when the underlying project
harness supplies admissible receipts. The generic wrapper does not manufacture
that proof.

See [Capture adapters](adapters.md).

## Visual and performance analysis

Visual analysis decodes admitted raster attachments and reports deterministic
statistics such as dimensions, channel ranges, luminance, edge density, and
coverage. Comparisons check scene controls and attachment semantics before
producing difference summaries and optional heatmaps.

Performance analysis summarizes numeric samples already present in a sealed run.
Bounded goals bind a baseline, metric, statistic, direction, target, maximum
iterations, and an allowed source-path set. The goal record can establish
arithmetic improvement against its own contract; it cannot establish causality
or general performance without equivalent admitted runs.

## Persistence and recovery

- User-visible files are written atomically.
- Closed-roster formats reject missing, extra, or modified artifacts.
- Durable jobs are resumable and retain provider identifiers.
- Catalog rebuild preserves a backup before replacing derived state.
- Skill installation stages an exact copy and refuses symlinked or drifted
  destinations.
- Migration is dry-run-first and records each admitted or failed legacy item.

## Evidence ceilings

The product reports the narrowest claim supported by the artifact:

| Evidence | Supports | Does not by itself support |
| --- | --- | --- |
| source/typecheck | source shape and compilation | runtime behavior |
| unit/contract test | exercised fixture contract | live provider behavior |
| headless Blender test | exercised Blender path | target-engine import or pixels |
| sealed run bundle | declared files, hashes, controls, telemetry | human visual judgement |
| adapter GPU receipt | the adapter's admitted GPU claim | independent hardware proof |
| performance samples | arithmetic for those samples | causality or broad optimization |

Signing, notarization, target-platform runtime, live-provider acceptance, and
human review remain explicit external gates.
