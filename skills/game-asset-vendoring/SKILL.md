---
name: game-asset-vendoring
description: Search, verify, migrate, and safely admit canonical asset packages into local game projects. Use for asset catalogs, license gates, package integrity, project vendoring, lock receipts, and local preview launch; not for generating paid-provider assets.
---

# Game Asset Vendoring

Treat the canonical package as the supply-chain boundary. Use `game-dev` locally; do not copy loose provider downloads directly into a game project.

Read [references/commands.md](references/commands.md) for the supported catalog, migration, launch, and admission commands.

## Workflow

1. Locate the package through the catalog or an explicit path. Verify its closed hash roster and receipt before assessing suitability.
2. Review the recorded license, provenance, category, version, source digest, validation policy, and validation result. Unknown licenses and failed validation remain blockers unless the user explicitly accepts the named exception.
3. Dry-run `vendor admit` against the exact project and destination. Show the resulting path, blockers, and exception flags without writing.
4. Obtain explicit confirmation for that admission. Do not broaden it into permission to install an adapter, edit engine metadata, import through a GUI, or run the game.
5. After admission, verify the copied package and retain the project lock receipt. Report that vendoring proves copied-byte integrity, not engine import, GPU rendering, runtime behavior, or artistic approval.

Use migration only for a legacy Game Development Studio output workspace. Preview launch is also plan-first; executing Finder, Quick Look, or Blender is a separate external action.

## Safety boundaries

Never overwrite a different package, follow a destination symlink outside the project, suppress a license blocker silently, or claim an engine-native asset layout without project-specific integration evidence. Adapter templates are outside this skill unless the user separately requests game-harness setup.
