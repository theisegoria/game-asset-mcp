---
name: game-performance-optimization
description: Summarize sealed game-run telemetry, compare baseline and candidate metrics, and execute bounded code-optimization goals with explicit path and iteration limits. Use for measurable performance work after a reproducible adapter scenario exists; not for visual diagnosis without a metric.
---

# Game Performance Optimization

Use `game-dev` run bundles as the measurement boundary. Begin only after a reproducible scenario emits the requested metric with a stable unit.

Read [references/optimization-loop.md](references/optimization-loop.md) for goal requests, commands, and comparison rules.

## Workflow

1. Verify the baseline run, summarize its metrics, and choose one named metric, statistic, unit, direction, and target. Do not optimize a proxy without explaining why it represents the user's outcome.
2. Confirm scene, seed, workload, build mode, renderer path, hardware, power state, and instrumentation are comparable. Hardware timings require the separately authorized evidence path; arithmetic over unadmitted values is not hardware-performance proof.
3. Create a dry-run goal with a narrow source-path allowlist and a fixed maximum iteration count. Exclude repository metadata, dependencies, build output, run bundles, and broad project roots.
4. After explicit confirmation, make one bounded candidate change, run relevant non-performance tests, capture one candidate, verify it, and evaluate it once.
5. Compare the target metric and inspect correctness signals, raster evidence, errors, and secondary regressions. A numeric improvement does not establish which change caused it.
6. Stop when the target is met, the iteration budget is exhausted, the measurement becomes incomparable, correctness regresses, or progress requires broader authority.

Do not reuse a candidate run as another iteration, silently widen allowed paths, change the target mid-goal, or turn a bounded goal into an open-ended autonomous loop.

## Evidence boundary

The summarizer proves deterministic arithmetic over sealed telemetry and profile fields. It does not prove timer quality, GPU synchronization, hardware comparability, statistical significance, or causal attribution. Report the adapter's measurement claims and the harness's admitted evidence separately.
