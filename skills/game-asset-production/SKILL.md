---
name: game-asset-production
description: Create, inspect, normalize, validate, and package game-development assets with local tools plus optional Tripo and Leonardo jobs. Use for 3D, texture, reference-image, sound-effect, Blender, GLB, PBR, or USDZ asset-production work; not for admitting packages into a game project.
---

# Game Asset Production

Drive the local `game-dev` CLI and finish with a verified canonical package whenever the result is meant for reuse or vendoring.

Read [references/commands.md](references/commands.md) for command shapes and lifecycle handoffs.

## Workflow

1. Run capability discovery and the relevant doctor checks. Inspect existing source bytes before requesting paid generation.
2. Define the asset specification, intended engine use, dimensions, topology and texture budgets, license, and stable name. Preserve the exact prompt and negative prompt.
3. For a paid provider, prepare a JSON request first. Do not submit until the user authorizes that invocation and sets a spend ceiling. Keep Tripo and Leonardo credentials out of arguments and files.
4. Follow the durable job to a terminal state. Record the provider job identity and receipt; local cancellation does not prove provider-side cancellation.
5. Download to a new destination, inspect the bytes, and validate against the explicit game policy. Never trust an extension, provider status, or Blender receipt without checking the produced file.
6. Normalize through Blender only when inspection identifies a repair or export need. Never modify the source in place. Re-inspect and re-validate the output.
7. Build a canonical package with provenance, license, hashes, validation results, and optional preview. Verify the package before reporting it ready.

Prefer ImageGen for a bespoke 2D concept or texture source only when the user requests generated imagery or it is genuinely the selected art workflow. Preserve that image's prompt and provenance before any Tripo or offline PBR derivation.

## Stop conditions

Stop and report the blocker when credentials, provider availability, Blender, a license decision, a required source file, or explicit spend approval is missing. Do not purchase credits, accept a new license, weaken validation, or silently substitute a provider.

## Evidence boundary

Separate provider acceptance, downloaded bytes, static GLB inspection, Blender normalization, policy validation, package integrity, GPU import, and human visual review. Claim only the stages with receipts or direct checks. Generated or normalized does not mean game-ready until the requested policy passes.
