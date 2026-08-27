---
name: game-visual-debugging
description: Diagnose game-rendering problems with declarative local adapters, windowless captures, structured telemetry, semantic render attachments, sealed run bundles, and deterministic raster comparisons. Use for visual bugs or renderer regressions where screenshots alone are insufficient.
---

# Game Visual Debugging

Use `game-dev` to turn a game-owned capture command into a sealed, comparable evidence bundle. The adapter remains declarative; the game owns its build, renderer, GPU synchronization, and capture implementation.

Read [references/capture-workflow.md](references/capture-workflow.md) for commands, useful attachment types, and interpretation rules.

## Workflow

1. Inspect the project's `.game-dev/adapter.json` and list scenarios. Do not install a packaged adapter unless the user asks for that exact project write.
2. Plan the smallest scenario that can reproduce the defect. Validate contracts and preflight on CPU before requesting a GPU scenario when the adapter provides those stages.
3. Show all required authorizations. Project execution requires `--confirm`; GPU and hardware-performance capabilities require separate flags. Do not treat prior runs as standing permission.
4. Execute once, verify the closed run roster, and preserve stdout, stderr, capture manifest, telemetry, profiles, native evidence, and hashes.
5. Analyze color plus any available depth, normal, object-ID, material-ID, motion, and overdraw attachments. Use semantic object regions to localize changes that a full-frame score would hide.
6. Compare a sealed baseline and candidate from the same adapter scenario. Correlate raster deltas with telemetry events and profile measurements, then inspect the implicated code or resources.
7. State hypotheses and discriminating next captures. Do not label an artistic defect as diagnosed merely because a metric changed.

Prefer bounded diagnostic shots over large galleries when narrowing a bug. Once the defect is localized, use the smallest deterministic regression capture the game can retain.

## Evidence boundary

The harness proves process status, schema validation, decoded raster statistics, and sealed hashes. GPU completion and hardware timings remain adapter-reported unless joined to native evidence. Heatmaps and semantic deltas are machine measurements, not human visual review, artistic intent, or causal proof.
