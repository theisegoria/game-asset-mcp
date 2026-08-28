---
name: game-development-studio
description: Route local game-asset production, package vendoring, offscreen render diagnosis, and bounded performance work through the game-dev CLI. Use only when a game-development request explicitly spans two or more of these workflows, needs a cross-workflow handoff, or asks for Game Development Studio orchestration; do not activate for unrelated development or general creative work.
---

# Game Development Studio

Use the local `game-dev` CLI as the durable, inspectable interface shared by
developers and coding agents.

## Route the request

- Use `$game-asset-production` for provider jobs, mesh inspection or normalization, PBR preparation, and canonical asset packages.
- Use `$game-asset-vendoring` for catalog search, license and hash checks, migration, and explicit admission into a game project.
- Use `$game-visual-debugging` for game adapters, windowless captures, structured telemetry, raster statistics, semantic attachment diffs, and heatmaps.
- Use `$game-performance-optimization` for metric summaries, run comparisons, and bounded optimization goals.

Read [references/routes.md](references/routes.md) when a request crosses workflows or needs an exact handoff.

## Shared operating contract

1. Confirm the CLI with `game-dev --version`, then inspect `game-dev capabilities --json` and `game-dev doctor --json` when environment readiness matters. Provider execution requires `game-dev` 1.0.2 or newer.
2. Prefer `--json` for one result and `--jsonl` for provider, Blender, capture, or other long-running work. Consume only the documented `game_dev.*` envelopes.
3. Never ask for, accept, reveal, or configure a provider credential in the conversation. It must already be configured by the account holder in a user-controlled local mechanism. Keep credentials out of arguments, request files, logs, screenshots, and receipts. Use `game-dev credentials status --json` to check only configured or missing without reading values.
4. Plan before mutation. Treat every command that can create, replace, delete, download, or modify a file—or launch a process—as an unexecuted plan until the user authorizes that exact invocation with its resolved inputs and destinations. This includes normalization, USDZ preview generation, package construction, adapter installation, project vendoring, launch execution, catalog rebuilding, and optimization-state updates. A command without a `--confirm` flag still requires this conversation-level authorization.
5. Keep authorizations independent: paid-provider spend, project execution, GPU capture, and hardware-performance measurement are separate decisions. Never persist or replay their flags as standing permission.
6. Verify every produced package or run bundle before using it downstream. Preserve receipt paths, manifest digests, run IDs, provider job IDs, prompts, licenses, and source provenance.

If `game-dev` is unavailable, report the missing local CLI and the blocked workflow. Do not install software, change credentials, solicit a key, or substitute an unrequested remote service.

## Evidence boundary

Report only what the returned receipt proves. Static inspection is not Blender, GPU, pixel, performance, signing, or human-review evidence. A decoded raster or adapter-reported GPU flag is useful diagnostic evidence, but it is not a human visual judgement or independent proof of hardware completion.
