<p align="center">
  <img src="plugins/game-development-studio/assets/icon.png" width="128" alt="Game Development Studio icon">
</p>

# Game Development Studio Skills

Five local-first skills for game asset production, package vendoring, sealed
render-capture diagnosis, and bounded performance work through the inspectable
`game-dev` CLI.

The plugin gives ChatGPT and Codex the workflow language, approval model, and
evidence discipline. Local execution uses the separately installed
`game-dev` CLI; the plugin does not embed a daemon, hosted backend, provider
credential, shared provider account, or standing permission.

This public repository carries skills bundle **1.0.2**. Provider execution
requires the separately installed `game-dev` CLI **1.0.2** or newer; the plugin
archive itself contains no executable provider client or credential.

![Five-skill Game Development Studio suite](assets/screenshots/01-skill-suite.png)

Product composition using the shipped skill names and metadata.

![Stable local CLI contract and approval boundaries](assets/screenshots/02-cli-contract.png)

Marketing composition based on actual v1.0.0 CLI output, shortened for display.
It illustrates the command contract; it is not a current-run claim.

![Synthetic sealed-capture visual-debugging example](assets/screenshots/03-visual-debugging.png)

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
codex plugin marketplace add theisegoria/game-development-studio-skills --ref v1.0.2
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

Plans never become standing permission. Normalization, preview generation, and
package construction write files even though those CLI commands have no
`--confirm` option; the skills must leave their resolved command unexecuted
until the user authorizes that exact source, destination, and invocation.

## Public plugin archive

GitHub Releases includes
`game-development-studio-plugin-1.0.2.zip`. It contains the screenshot-free
plugin root (`.codex-plugin/`, `skills/`, the suite icon, and policy files) and
is the same skills-only shape prepared for OpenAI review. The repository-root
marketing illustrations above are intentionally excluded from that upload.

Build and verify it locally:

```sh
python3 scripts/verify.py
python3 scripts/build_release.py /tmp/game-development-studio-plugin-1.0.2.zip
```

`build_release.py` requires an explicit output path outside the exported
repository (for example, under `/tmp`), so archive generation cannot alter the
closed release tree it verifies.

## Evidence boundary

The skills are intentionally strict about claims:

- static inspection is not Blender, GPU, or pixel evidence
- a decoded raster is not a human visual judgement
- adapter-reported GPU identity is not independent hardware proof
- arithmetic improvement is not causality or broad performance proof
- Store submission is not publication until OpenAI approves and the developer
  publishes the approved version

## Privacy and support

The plugin contains static instructions and assets. It runs no publisher
backend or resident Game Development Studio service and sends no publisher
analytics. It never asks for a provider credential. Optional provider calls
use an account and preconfigured local credential controlled by the user and
connect directly from the user's machine under the provider's terms; the
publisher operates no proxy, shared account, resale layer, or provider job
queue.

See [Privacy](PRIVACY.md), [Terms](TERMS.md), [Support](SUPPORT.md), and
[Security](SECURITY.md).

## License

MIT © 2026 Benjamin Michael Haire. Provider services, generated content, input
assets, and vendored assets remain subject to their own terms and licenses.
