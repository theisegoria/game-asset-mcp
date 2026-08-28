# Game Development Studio

Game Development Studio is a screenshot-free, skills-only plugin for local
game asset production, package vendoring, sealed render-capture diagnosis, and
bounded performance work.

The five packaged skills provide workflow guidance, approval boundaries, and
evidence discipline. They do not include an MCP server, hosted backend, UI,
provider credential, shared provider account, hook, or automatic installation
step. They never ask a user to paste or configure a provider key in a plugin
conversation.

## Local execution boundary

The plugin can route work and analyze user-supplied manifests, telemetry,
metrics, capture summaries, and structured results. Executing local workflows
requires the separately installed `game-dev` 1.0.2-or-newer CLI in an
environment that exposes the chosen files and executable under the user's
approval policy.

Provider spend, every local file write, project execution, GPU work, and
performance measurement remain separately authorized for each invocation. A
plan never becomes standing permission. Commands that lack a `--confirm` flag
still require explicit conversation-level authorization for their resolved
inputs and destinations.

Optional provider work uses only a preconfigured credential and provider
account controlled by the user. The local CLI sends an authorized request
directly to the selected independent provider; the publisher does not proxy,
pool, receive, share, or resell provider credentials or access.

## Included skills

| Skill | Purpose |
| --- | --- |
| `game-development-studio` | Routes work and enforces the shared operating contract |
| `game-asset-production` | Provider jobs, GLB inspection, Blender preparation, and packages |
| `game-asset-vendoring` | Integrity, licenses, migration, catalogues, and project admission |
| `game-visual-debugging` | Adapters, captures, telemetry, semantic buffers, and heatmaps |
| `game-performance-optimization` | Comparable metrics and finite optimization goals |

## Evidence boundary

- static inspection is not Blender, GPU, or pixel evidence
- a decoded raster is not a human visual judgement
- adapter-reported GPU identity is not independent hardware proof
- arithmetic improvement is not causality or broad performance proof

See [Privacy](PRIVACY.md), [Terms](TERMS.md), [Support](SUPPORT.md), and
[Security](SECURITY.md).
