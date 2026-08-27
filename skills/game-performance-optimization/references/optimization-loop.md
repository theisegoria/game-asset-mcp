# Bounded optimization loop

## Inspect measurements

```text
game-dev capture verify RUN_ID_OR_PATH --json
game-dev performance summarize RUN_ID_OR_PATH --json
game-dev performance compare BASELINE_RUN CANDIDATE_RUN --stat median --json
```

Available comparison statistics are `min`, `max`, `mean`, `median`, `p95`, and `p99`. The metric name and unit must match exactly between runs.

## Goal request

Create a JSON document like:

```json
{
  "id": "frame-time",
  "metric": "render.frame_time",
  "statistic": "median",
  "unit": "ms",
  "direction": "lower",
  "target": 8,
  "maximumIterations": 3,
  "allowedPaths": ["src/renderer"]
}
```

`direction` is `lower` or `higher`. `allowedPaths` must identify existing, non-symlinked project subtrees and must not name `.git`, `.game-dev`, dependencies, build output, or the project root.

## Create and evaluate

```text
game-dev performance goal-create BASELINE_RUN --project PROJECT --request goal.json --json
game-dev performance goal-create BASELINE_RUN --project PROJECT --request goal.json --confirm --jsonl
game-dev performance goal-evaluate GOAL_PATH CANDIDATE_RUN --json
game-dev performance goal-evaluate GOAL_PATH CANDIDATE_RUN --confirm --jsonl
```

The first form of each command is a dry run. Confirmed evaluation appends exactly one candidate result and advances the goal to `active`, `met`, or `exhausted`. Candidate run IDs cannot be reused.

## Per-iteration acceptance

- The requested functional and regression tests still pass.
- The candidate run is sealed and comparable to the baseline.
- The target metric and unit exist in both runs.
- Correctness and visual evidence have not regressed within the task's acceptance contract.
- The code change stays inside the goal allowlist.
- Claims distinguish arithmetic improvement from admitted hardware evidence and causal proof.
