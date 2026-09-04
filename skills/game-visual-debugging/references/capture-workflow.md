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
game-dev visual compare BASELINE_RUN CANDIDATE_RUN --aa-tolerance 1 --json
game-dev visual compare BASELINE_RUN CANDIDATE_RUN --threshold 0 --output NEW_DIRECTORY --jsonl
game-dev performance compare BASELINE_RUN CANDIDATE_RUN --stat median --json
```

The output directory must be new. It contains deterministic heatmaps and `comparison.json`.

`--aa-tolerance N` treats a difference as the same content landing elsewhere when a matching pixel exists within N pixels, checked in both directions. Use `1` against a real renderer: anti-aliasing, a sub-pixel camera nudge and a driver's rasterisation rule all move colour by a pixel without changing what is drawn, so a strict comparison reports every edge in the frame as changed. Use `0` for a software-rasterized lane, which is bit-deterministic and should match exactly.

The comparison also carries a `verdict` and a `summary` of plain sentences derived from the statistics, and names objects that appeared or disappeared between the runs. `identical` and `within-tolerance` are different outcomes: the second means pixels differ but none by more than the threshold. Compare only equivalent scene, camera, seed, resolution, renderer mode, and adapter scenario. If those controls differ, describe the result as exploratory rather than a regression verdict.
