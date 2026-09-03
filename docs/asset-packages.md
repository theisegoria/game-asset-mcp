# Asset packages

Canonical packages turn a model file into an immutable, inspectable unit that
can be catalogued and admitted into projects without losing its origin.

## Layout

```text
<package-id>/
├── asset.json
├── receipt.json
├── model.glb
└── preview.usdz        optional
```

`asset.json` uses `game_dev.asset_package.v1`. It includes:

- content-derived package and asset identifiers
- semantic package version and display metadata
- SPDX-style or explicitly unknown license value
- portable GLB and optional USDZ preview names
- a closed list of file paths, byte counts, media roles, and SHA-256 digests
- validation pass, error count, and warning count
- provenance origin plus optional provider and source job ID

`receipt.json` records the build operation, source digest, requested
metadata, inspection and policy results, transformations, timestamps, and the
manifest digest. The exact schema is validated by the reader, not treated as
free-form notes.

## Build

```sh
game-dev package build model.glb \
  --name "Signal Beacon" \
  --version 1.0.0 \
  --license CC0-1.0 \
  --request metadata.json \
  --json
```

Metadata can declare category, description, preview path, provenance, and a
validation policy. The source is inspected and hashed before publication.
Package construction stages a new directory and never silently overwrites
different bytes.

Static inspection can establish GLB structure, declared geometry, image
dimensions, texture roles, and policy arithmetic. It does not establish
Blender normalization, target-engine import, GPU rendering, pixel correctness,
or human approval. Those remain separate receipt fields or later evidence.

## Verify

```sh
game-dev package verify PACKAGE_ID_OR_PATH --json
```

Verification checks the manifest schema, path safety, expected roster, byte
counts, and SHA-256 digests. It refuses symlinks, missing files, extra files,
path traversal, mutated model bytes, and a manifest whose package ID no longer
matches its canonical content.

Always verify immediately before project admission.

## Catalog

```sh
game-dev catalog list --query beacon --json
game-dev catalog show PACKAGE_ID --json
game-dev catalog admit /path/to/package --json
game-dev catalog rebuild --json
game-dev catalog rebuild --confirm --jsonl
```

The SQLite catalog accelerates search by name, category, license, provider,
source job, and validation state. It is derived from package manifests.
Rebuild plans first; a confirmed rebuild preserves the previous database as a
backup before replacement.

`catalog admit` indexes one already-built package directory into the catalog.
`package build` admits what it builds, so this is for a package that exists on
disk but is not yet indexed — a package produced on another machine, or one
restored from a backup. It writes to the catalog immediately rather than
planning first, because it only re-derives an index row from a manifest the
package already contains; the package itself is never modified.

## Project admission

```sh
game-dev vendor admit PACKAGE_ID --project /path/to/game --json
```

The plan resolves the exact package and destination, verifies the package,
checks the license and validation outcome, and reports blockers. Add
`--confirm` only after reviewing that plan.

By default, admission refuses:

- an unknown or empty license
- failed asset validation
- unsafe or symlinked project paths
- destination escape
- conflicting existing content
- changed package bytes

Confirmed admission copies the package atomically and writes a project-local
vendoring receipt. `--allow-unknown-license` and `--allow-invalid` waive only
their named blocker for that invocation.

## Migration

`game-dev migrate legacy` discovers earlier generated-asset layouts and shows
what would become packages. A confirmed migration admits each candidate
independently, records failures, and leaves legacy sources untouched.

Migration is not license inference. Supply a default only when it is true for
the selected sources; otherwise keep the unknown-license blocker visible.

## Preview

The GLB is the canonical game asset. A USDZ file is an optional macOS preview,
generated through the available Apple conversion tools or Blender path and
then hashed into the package. Preview generation does not change the GLB and
does not prove target-game compatibility.
