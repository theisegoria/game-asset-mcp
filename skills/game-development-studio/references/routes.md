# Workflow routes

## Asset request to project admission

1. Produce or locate source bytes with `$game-asset-production`.
2. Inspect and validate the source; normalize with Blender only when policy requires it.
3. Build and verify a canonical package with provenance and a license.
4. Hand the verified package ID or package path to `$game-asset-vendoring`.
5. Dry-run admission, resolve blockers, obtain explicit write approval, then verify the copied package and lock receipt.

Provider submission, download, normalization, packaging, and project admission are distinct receipts. Do not collapse them into one success claim.

## Visual problem to performance goal

1. Use `$game-visual-debugging` to inspect an adapter, plan the scenario, and capture a baseline.
2. Verify the run bundle. Use color plus depth, normal, object-ID, material-ID, motion, or overdraw attachments when the adapter can emit them.
3. Correlate deterministic raster deltas with telemetry and profiles to form a bounded hypothesis.
4. If the problem is measurable, hand the sealed baseline run and exact metric to `$game-performance-optimization`.
5. Create a goal with a small path allowlist and fixed iteration ceiling. Stop when met or exhausted.

Raster and telemetry correlations guide code inspection; they do not establish causality by themselves.

## Existing game integration

Adapter templates are opt-in. `game-dev adapter install` is dry-run-first and must not be treated as permission to run its scenarios. Inspect the installed declarative manifest, plan the chosen scenario, and request each required execution flag separately.
