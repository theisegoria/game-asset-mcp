<p align="center">
  <img src="plugins/game-development-studio/assets/icon.png" width="128" alt="Game Development Studio icon">
</p>

# Game Development Studio Skills

Five local-first skills for game asset production, package vendoring, sealed
render-capture diagnosis, and bounded performance work—without an MCP server.

The plugin gives ChatGPT and Codex the workflow language, approval model, and
evidence discipline. Local execution uses the separately installed
`game-dev` CLI; the plugin does not embed a daemon, hosted backend, provider
credential, or standing permission.

![Five-skill Game Development Studio suite](plugins/game-development-studio/assets/screenshots/01-skill-suite.png)

![Stable local CLI contract and approval boundaries](plugins/game-development-studio/assets/screenshots/02-cli-contract.png)

![Synthetic sealed-capture visual-debugging example](plugins/game-development-studio/assets/screenshots/03-visual-debugging.png)

The third image is a labelled synthetic validation fixture. It demonstrates
the diagnostic workflow; it is not a target-game GPU, pixel, performance, or
human-review claim.

## Included skills

| Skill | Purpose |
| --- | --- |
| `game-development-studio` | Routes work and enforces the shared operating contract |
| `game-asset-production` | Provider jobs, GLB inspection, Blender preparation, and packages |
| `game-asset-vendoring` | Integrity, licenses, migration, catalogues, and project admission |
| `game-visual-debugging` | Adapters, captures, telemetry, semantic buffers, and heatmaps |
| `game-performance-optimization` | Comparable metrics and finite optimization goals |

## Install as a Codex plugin

Add this tagged marketplace:

```sh
codex plugin marketplace add theisegoria/game-development-studio-skills --ref v1.0.0
codex plugin marketplace list
```

Restart the ChatGPT desktop app, open the Plugins Directory, choose the
**Game Development Studio** marketplace, and install
**Game Development Studio**. The repository follows the standard marketplace
layout at `.agents/plugins/marketplace.json`.

To inspect before installation:

```sh
git clone https://github.com/theisegoria/game-development-studio-skills.git
cd game-development-studio-skills
python3 scripts/verify.py
```

No command in this repository automatically installs into a Codex profile or a
game project.

## ChatGPT and local execution

This is a skills-only plugin. In ChatGPT without a local execution environment,
it can route workflows and analyze manifests, structured results, telemetry,
metrics, and summaries supplied by the user. It must not pretend that a local
CLI, Blender, provider, game harness, GPU lane, or file write ran.

In Codex with `game-dev` installed, the skills use its JSON/JSONL command
contract. Sensitive capabilities remain separate per invocation:

- `--confirm` for local mutation or process execution
- `--approve-spend` plus `--spend-limit-cents N` for paid providers
- `--allow-gpu` for a declared GPU scenario
- `--allow-performance` for hardware-performance capture

Plans never become standing permission.

## Public plugin archive

GitHub Releases includes
`game-development-studio-plugin-1.0.0.zip`. It contains the plugin root
(`.codex-plugin/`, `skills/`, assets, and policy files) and is the same
skills-only shape prepared for OpenAI review.

Build and verify it locally:

```sh
python3 scripts/verify.py
python3 scripts/build_release.py /tmp/game-development-studio-plugin-1.0.0.zip
```

## Evidence boundary

The skills are intentionally strict about claims:

- static inspection is not Blender, GPU, or pixel evidence
- a decoded raster is not a human visual judgement
- adapter-reported GPU identity is not independent hardware proof
- arithmetic improvement is not causality or broad performance proof
- Store submission is not publication until OpenAI approves and the developer
  publishes the approved version

## Privacy and support

The plugin contains static instructions and assets. It has no Game Development
Studio MCP server or publisher backend and sends no publisher analytics.
Explicit local provider calls connect directly from the user's machine and are
subject to the provider's terms.

See [Privacy](PRIVACY.md), [Terms](TERMS.md), [Support](SUPPORT.md), and
[Security](SECURITY.md).

## License

MIT © 2026 Benjamin Michael Haire. Provider services, generated content, input
assets, and vendored assets remain subject to their own terms and licenses.
