---
name: game-development-studio
description: Route local game-asset production, package vendoring, offscreen render diagnosis, and bounded performance work through the game-dev CLI. Use when a game-development request spans these workflows or the right specialized skill is not yet clear.
---

# Game Development Studio

Use the local `game-dev` CLI as the durable interface. It does not require an MCP server.

## Route the request

- Use `$game-asset-production` for provider jobs, mesh inspection or normalization, PBR preparation, and canonical asset packages.
- Use `$game-asset-vendoring` for catalog search, license and hash checks, migration, and explicit admission into a game project.
- Use `$game-visual-debugging` for game adapters, windowless captures, structured telemetry, raster statistics, semantic attachment diffs, and heatmaps.
- Use `$game-performance-optimization` for metric summaries, run comparisons, and bounded optimization goals.

Read [references/routes.md](references/routes.md) when a request crosses workflows or needs an exact handoff.

## Shared operating contract

1. Confirm the CLI with `game-dev --version`, then inspect `game-dev capabilities --json` and `game-dev doctor --json` when environment readiness matters.
2. Prefer `--json` for one result and `--jsonl` for provider, Blender, capture, or other long-running work. Consume only the documented `game_dev.*` envelopes.
3. Keep credentials out of arguments, request files, logs, and receipts. Use `game-dev credentials status --json` to check presence without reading values.
4. Plan before mutation. Treat adapter installation, project vendoring, launch execution, catalog rebuilding, and optimization-state updates as dry runs until the user authorizes the exact write.
5. Keep authorizations independent: paid-provider spend, project execution, GPU capture, and hardware-performance measurement are separate decisions. Never persist or replay their flags as standing permission.
6. Verify every produced package or run bundle before using it downstream. Preserve receipt paths, manifest digests, run IDs, provider job IDs, prompts, licenses, and source provenance.

If `game-dev` is unavailable, report the missing local CLI and the blocked workflow. Do not install software, change credentials, or substitute an unrequested remote service.

## Evidence boundary

Report only what the returned receipt proves. Static inspection is not Blender, GPU, pixel, performance, signing, or human-review evidence. A decoded raster or adapter-reported GPU flag is useful diagnostic evidence, but it is not a human visual judgement or independent proof of hardware completion.
