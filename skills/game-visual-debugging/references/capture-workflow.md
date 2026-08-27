# Capture and comparison workflow

## Adapter discovery

```text
game-dev adapter templates --json
game-dev adapter install TEMPLATE_ID --project PROJECT --json
game-dev adapter inspect --project PROJECT --json
game-dev scenario list --project PROJECT --json
```

`adapter install` is a no-write plan until `--confirm` is added. Installation writes only `.game-dev/adapter.json`; it neither executes the game nor proves a capture.

## Plan and run

```text
game-dev scenario plan SCENARIO_ID --project PROJECT --request params.json --json
game-dev scenario run SCENARIO_ID --project PROJECT --request params.json --confirm --jsonl
```

Add `--allow-gpu` only for a plan that declares GPU capability. Add `--allow-performance` only when the scenario declares hardware-performance capability and the user authorizes that measurement. A missing required flag must stop before the project executable runs.

## Verify and inspect

```text
game-dev capture verify RUN_ID_OR_PATH --json
game-dev visual analyze RUN_ID_OR_PATH --json
game-dev performance summarize RUN_ID_OR_PATH --json
```

Useful attachments:

- `color`: final raster differences and luminance or edge changes.
- `depth`: geometry visibility, clipping, camera, and ordering clues.
- `normal`: normal transforms, tangent-space, and lighting-input clues.
- `object_id`: per-object localization and instance visibility.
- `material_id`: material binding and shading-path localization.
- `motion`: temporal reprojection and velocity-buffer clues.
- `overdraw`: fill-rate, transparency, and duplicate-draw clues.

Attachments are diagnostic signals, not automatic conclusions.

## Compare sealed runs

```text
game-dev visual compare BASELINE_RUN CANDIDATE_RUN --threshold 0 --json
game-dev visual compare BASELINE_RUN CANDIDATE_RUN --threshold 0 --output NEW_DIRECTORY --jsonl
game-dev performance compare BASELINE_RUN CANDIDATE_RUN --stat median --json
```

The output directory must be new. It contains deterministic heatmaps and `comparison.json`. Compare only equivalent scene, camera, seed, resolution, renderer mode, and adapter scenario. If those controls differ, describe the result as exploratory rather than a regression verdict.
