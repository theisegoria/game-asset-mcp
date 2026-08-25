# game-asset-mcp

An MCP server that lets an AI agent produce game-ready 3D assets end to end — reference image, mesh, PBR textures, provenance — and retexture meshes you **already own**.

Most asset-generation tooling stops at "type a prompt, get a mesh". That is the easy half. The half that actually blocks a project is the mesh you already have: the kitbash you modelled last week, the marketplace prop whose materials are wrong for your art direction, the greybox that needs to look like corroded steel by Friday. `texture_existing_asset` takes a mesh you supply and gives it new PBR materials without regenerating the geometry you already approved.

Everything is recorded. Every job keeps the prompt, the seed, the provider model version, the provider task id, and a SHA-256 for every downloaded byte — so six months from now you can still answer "what produced this file?"

The server is provider-agnostic by construction. Today it drives [Tripo](https://platform.tripo3d.ai) for 3D and [Leonardo.Ai](https://app.leonardo.ai) for reference images and sound effects, behind three small interfaces (`ImageProvider`, `Model3DProvider`, `AudioProvider`). Adding a provider does not change the tool surface. See [docs/architecture.md](docs/architecture.md) for why it is built this way.

---

## Features

### The pipeline

- **Prompt preview before spend** — `preview_asset_prompt` shows the exact prompt and negative prompt a spec would produce, so art direction is corrected before anything is paid for.
- **Reference images built for reconstruction**, not for looking nice: isolated subject, whole silhouette, flat light, plain background — the conditions a photogrammetry-style reconstructor actually needs.
- **Variation on one axis at a time** — silhouette, material treatment, detailing, wear, proportions or functional components — while the object's identity is held fixed.
- **Text-to-3D and reference-to-3D**, with PBR textures, returning a pollable job rather than blocking.
- **Retexture a mesh you already own** — GLB, GLTF, FBX, OBJ or STL. New materials, geometry untouched. This is the half most tooling skips.
- **Rigging, animation retargeting and quad retopology** as first-class steps. `animate_asset` refuses an unrigged source rather than billing you for nothing.
- **Sound effects** — impacts, weapon reports, footsteps, UI blips, or a seamless ambience loop.

### The local half — no API key, no network

Eleven of the twenty tools spend nothing, and nine of those touch no network at all. If you already have meshes, this is the whole product.

- **`inspect_asset`** — what is genuinely inside a glTF: meshes, primitives, materials, texture channels, resolutions, bounds, and specific defects rather than a bare "ok".
- **`validate_game_asset`** — a shipping verdict with per-check reasons: UVs, normals, tangents where a normal map is bound, triangle budget, material count, texture resolution, power-of-two textures, bounding-box sanity. Every threshold overridable, because failing someone else's house style is not a defect.
- **`normalize_mesh`** — generates UVs for objects that have **none** (the usual reason a mesh cannot be textured at all), welds coincident vertices, dissolves degenerate faces, names every material, forces opaque blending. Needs a local Blender; every other tool works without one.
- **`batch_prepare_meshes`** — validate → normalize → validate across up to 500 paths, with a per-item verdict. One bad file is reported against its own item and never stops the run.
- **`extract_pbr_trio`** — splits a material into independent albedo / normal / roughness (plus metallic and occlusion) images, de-packing glTF's metallicRoughness correctly: roughness is GREEN, metallic is BLUE. Resamples to an exact size, averaging colour in **linear light** and data channels directly.

### Correctness the tools enforce for you

- **glTF factors are applied, not dropped.** The effective value is texture × factor, so `metallicFactor: 0` with a shared metallicRoughness texture exports as non-metallic — and `baseColorFactor`, `occlusionStrength` and `normalScale` are applied too, each reported as `factorApplied`.
- **Only the drawn scene is measured.** glTF `scenes` are alternatives; a renderer draws one. Triangle counts, bounds, attribute checks, materials and textures all describe the scene that ships. Undrawn LODs and collision proxies are counted separately rather than silently inflating a budget or flipping a verdict.
- **Instancing counts.** A 12-triangle mesh placed at 50 nodes is 600 triangles against your budget, because that is what gets submitted.
- **Scale is respected.** `mergeDistance` is documented in scene units and applied in local space, so the threshold is divided by the object's full world scale — parents included — and refused outright when Blender cannot express it, rather than silently widened.

### Safety — the parts that exist because they were once wrong

- **Your input mesh cannot be overwritten.** Identity is decided by device + inode, so a symlink, a hardlink, a symlinked parent, or a different capitalisation on a case-insensitive volume all count as the same file. The refusal never names a flag that would defeat it.
- **Output is staged, verified, then renamed.** A destination is only ever replaced by a result that parsed and contained geometry. A failed call leaves it untouched and says so truthfully.
- **Names are claimed by exclusive create**, not by an existence check, so two concurrent calls cannot both believe they own a path.
- **Cleanup only removes files this call still owns**, compared by device + inode — never a file another tool renamed onto the same name.
- **A caller-named directory must already exist.** No tool builds a directory tree from a path you typed; a leading `~` is not expanded, because no shell is involved.
- **Downloads are HTTPS-only**, size-capped while streaming, and refuse redirects on authenticated uploads.

### Spend control

- **A session ceiling in US cents** (`ASSET_SPEND_LIMIT_CENTS`), checked **before any provider contact** — including before a mesh or reference image is uploaded.
- **`get_spend_report`** shows what went where, by tool and job, and says which figures are published prices and which are deliberately pessimistic placeholders. It is a guard, not an invoice.
- **Every credit-spending tool says so in its own description**, before an agent calls it. Nine of twenty spend; the rest never can.

### Provenance

Every job records the prompt, the seed, the provider model version, the provider task id, and a **SHA-256 for every downloaded byte**, written to `asset.json` beside the files. Six months later you can still answer "what produced this?"

### How it fails

- **Loudly, and by naming the cause.** Errors carry a code, a message that says what to change, and the provider's raw status alongside the normalized one.
- **A partial result is reported as partial.** A texture that could not be written is named; the ones that succeeded are still recorded. A missing sidecar costs only itself.
- **Repairs that were skipped are reported as skipped**, so a mesh never comes back "game-ready" because a check quietly did nothing.

---

## Requirements

- **Node.js >= 18.17** — the server uses global `fetch`, `FormData`, `Blob` and `AbortController`.
- No native modules, no build toolchain, no database. It runs anywhere Node runs.
- **Optional:** a local [Blender](https://www.blender.org/download/) 4.x+ install enables the repair half of `normalize_mesh` and `batch_prepare_meshes`. Every other tool works without it; the tool refuses with instructions when it is absent. On macOS Blender is not on `PATH`, so set `BLENDER_PATH` or rely on the bundled `/Applications/Blender.app` default.
- At least one provider API key (see [Configuration](#configuration)). One is enough — they are validated lazily.

---

## Installation

Install straight from GitHub. Both forms build the TypeScript during install, so you get a runnable `game-asset-mcp` binary either way.

```bash
# run it without installing anything permanently
npx github:theisegoria/game-asset-mcp

# or add it to a project
npm install github:theisegoria/game-asset-mcp

# pin a specific version — recommended for anything you depend on
npm install github:theisegoria/game-asset-mcp#v0.4.0
```

**Pin the version.** Without a `#vX.Y.Z` suffix both forms resolve to whatever `main` is at that moment, which is not a stable dependency. Every release is tagged, so `#v0.4.0` gets you exactly that tree. Releases are listed at [github.com/theisegoria/game-asset-mcp/releases](https://github.com/theisegoria/game-asset-mcp/releases), each carrying the defects that release fixed.

> ⛔ **Do not pin v0.3.0, v0.3.1 or v0.3.2.** Later review found live paths in those that destroy the mesh you pass them and report success. They are tagged only so the history is complete. Their release pages say so too.

Or work from a clone, which is what you want if you intend to change anything:

```bash
git clone https://github.com/theisegoria/game-asset-mcp.git
cd game-asset-mcp
npm install
npm run build     # emits dist/
node dist/server.js
```

> **Not on npm.** There is no `npm install @theisegoria/game-asset-mcp` — the package is distributed from GitHub only. Anything telling you otherwise is out of date.

The server speaks MCP over **stdio**. Started directly in a terminal it will simply sit there waiting for a client to talk to it — that is correct behaviour, not a hang. Logs go to stderr; stdout belongs to the protocol.

---

## Configuration

Set these in your MCP client's `env` block — see the snippets below. **There is no `.env` loading**: the server reads `process.env` and nothing else, so a `.env` file on disk does nothing unless your shell or client exports it first.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TRIPO_API_KEY` | for 3D tools | — | Tripo API key. Create one at [platform.tripo3d.ai](https://platform.tripo3d.ai). |
| `LEONARDO_API_KEY` | for image and audio tools | — | Leonardo.Ai key with API access enabled. One key covers both reference images and sound effects. |
| `LEONARDO_MODEL_ID` | no | built-in default | Override the default Leonardo image model. A per-call `modelId` also exists. |
| `ASSET_OUTPUT_DIR` | no | `./assets/generated` | Where assets and job records are written. Relative to the server's working directory. |
| `ASSET_MAX_DOWNLOAD_BYTES` | no | `268435456` (256 MiB) | Hard ceiling on any single download, enforced while streaming — and on any LOCAL file you supply, so an over-large mesh you already own is refused with `DOWNLOAD_TOO_LARGE`. |
| `ASSET_HTTP_TIMEOUT_MS` | no | `60000` | Per-request HTTP timeout. |
| `ASSET_LOG_LEVEL` | no | `info` | `silent` \| `error` \| `warn` \| `info` \| `debug`. |
| `BLENDER_PATH` | no | auto-detected | Blender executable for `normalize_mesh` and `batch_prepare_meshes`. Overrides discovery. |
| `TRIPO_BASE_URL` | no | Tripo v3 endpoint | Retarget the 3D provider. Must be `https://`; an `http://` value is refused when the provider is first used, not at startup, because providers are constructed lazily. |
| `LEONARDO_BASE_URL` | no | Leonardo endpoint | Retarget the image/audio provider. Must be `https://`, refused on first use, same reason. |
| `ASSET_SPEND_LIMIT_CENTS` | no | unlimited | Session spend ceiling in **US cents**. Credit-consuming tools refuse once it is reached, before contacting the provider. |

### ⚠️ Tripo API credits are billed separately from a Tripo Studio subscription

This catches almost everyone. **A Tripo Studio web subscription does not fund API calls.** They are two different products with two different balances. If you have been happily generating models in the Studio web app and your very first `create_3d_asset` call comes back rejected for insufficient credits, you have not misconfigured anything — you need API credits on the developer platform. Buy them at [platform.tripo3d.ai](https://platform.tripo3d.ai), not in the Studio app.

### Capping what can be spent

Set `ASSET_SPEND_LIMIT_CENTS` and every credit-consuming tool checks it **before** contacting the provider at all — including before a mesh or reference image is uploaded — refusing with the remaining balance named rather than overspending. The ceiling is in US cents because the two providers bill in different units — Tripo in $0.01 credits, Leonardo in USD — and a limit mixing them would mean nothing.

Where a provider publishes a per-call price we use it. Where it does not, the guard uses a deliberately pessimistic placeholder and `get_spend_report` says which figures are which. It is a guard, not an invoice: real charges should come in at or under the estimate, never above it.

### One provider is enough

Credentials are validated **lazily**, at the moment a tool needs them, never at startup. If you only set `TRIPO_API_KEY`, the server starts fine and every 3D tool works; the image tools return a clear `CONFIG_MISSING` error naming the variable you are missing. The reverse holds too. You are never forced to hold an account you do not want just to use the half of the pipeline you do.

---

## MCP client setup

### Claude Code / Claude Desktop

Add to your MCP configuration (`claude_desktop_config.json`, or `.mcp.json` in a project for Claude Code):

```json
{
  "mcpServers": {
    "game-asset": {
      "command": "node",
      "args": ["/absolute/path/to/game-asset-mcp/dist/server.js"],
      "env": {
        "TRIPO_API_KEY": "tsk_...",
        "LEONARDO_API_KEY": "...",
        "ASSET_OUTPUT_DIR": "/absolute/path/to/your/project/assets/generated",
        "ASSET_LOG_LEVEL": "info"
      }
    }
  }
}
```

Use an **absolute** path for `args` and for `ASSET_OUTPUT_DIR`. An MCP client's working directory is not the one you think it is, and a relative output directory will scatter assets somewhere surprising.

### Any other MCP client

The same server, described generically — a stdio child process:

```json
{
  "name": "game-asset",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "github:theisegoria/game-asset-mcp"],
  "env": {
    "TRIPO_API_KEY": "tsk_...",
    "LEONARDO_API_KEY": "...",
    "ASSET_OUTPUT_DIR": "/absolute/path/to/assets/generated"
  }
}
```

---

## Available tools

| Tool | Spends credits | What it does |
| --- | --- | --- |
| `preview_asset_prompt` | No | Dry run. Shows the exact prompt and negative prompt a spec would produce, so art direction can be corrected before anything is paid for. |
| `generate_asset_reference` | **Yes** | Turns an asset spec into reference images built for *reconstruction* — isolated subject, whole silhouette, flat light, plain background. Creates the asset job. |
| `generate_reference_variations` | **Yes** | Explores one axis (silhouette, material treatment, detailing, wear, proportions, functional components) while holding the object's identity fixed. |
| `select_reference` | No | Marks which reference candidate the 3D step will reconstruct. Local bookkeeping only. |
| `create_3d_asset` | **Yes** | Reconstructs a mesh with PBR textures from the selected reference — or straight from text when no reference exists. Returns immediately with a job to poll. |
| `texture_existing_asset` | **Yes** | Applies new PBR materials to a mesh **you already own** (GLB/GLTF/FBX/OBJ/STL) or to a previously generated one. Geometry is untouched. |
| `get_asset_job` | No | Polls a job. Maps the provider's status vocabulary onto one normalized lifecycle and keeps the raw status alongside. |
| `download_asset` | No | Fetches the provider's model, textures and preview renders into your workspace, hashing and recording each file. |
| `inspect_asset` | No | Reads a downloaded glTF/GLB and reports what is actually in it — meshes, materials, texture channels, sizes. |
| `extract_pbr_trio` | No | Splits a glTF material into independent albedo, normal and roughness images, de-packing metallicRoughness (roughness = green, metallic = blue). Resamples to an exact size, averaging colour in linear light and data channels directly. |
| `normalize_mesh` | No | Repairs a mesh so it can be used: generates UVs for objects that have **none** (the usual reason a mesh cannot be textured), welds coincident vertices, dissolves degenerate triangles, names every material and forces opaque blending. Optional Blender dependency. |
| `generate_sound_effect` | **Yes** | Generates a short game sound effect from a description — impacts, weapon reports, UI blips, or a seamless ambience loop. Polls and downloads inline. |
| `create_game_prop` | **Yes — images only** | The intention-shaped entry point: plain-language request in, asset spec plus reference candidates out. Deliberately stops before the 3D spend so a human or agent picks the reference first. |
| `list_asset_jobs` | No | Lists known jobs, newest first, as compact summaries. |
| `rig_asset` | **Yes** | Builds a skeleton and skin weights for a generated asset so it can be animated. |
| `animate_asset` | **Yes** | Retargets a preset animation onto an asset that has already been rigged. Refuses an unrigged source rather than billing for nothing. |
| `retopologize_asset` | **Yes** | Rebuilds topology, quads by default — quads survive downstream editing and mesh qualification far better than generator triangle soup. |
| `validate_game_asset` | No | Judges a mesh against a shipping policy and returns pass/fail with per-check reasons — UVs, normals, tangents, triangle budget, materials, texture resolution, bounding-box sanity. Every threshold overridable. |
| `batch_prepare_meshes` | No | Runs validate → normalize → validate across a **list** of `.glb`/`.gltf` paths (up to 500) and returns a per-item verdict. Meshes that already pass are left untouched; one bad file is reported against its own item and never stops the run. |
| `get_spend_report` | No | What this workspace has spent, by tool, with remaining headroom — and whether each figure is a published price or a pessimistic placeholder. |

Only nine tools can cost you money, and each one says so in its description before it is called.

---

## The free local half (no API keys, no network)

Eleven of the twenty tools never spend a credit, and only **two of those eleven use the network at all** — `get_asset_job` polls, and `download_asset` fetches; both are free but are network calls. The other nine work offline. The five below are the mesh pipeline, and if you already have meshes they are the whole product.

| Tool | What it answers |
| --- | --- |
| `inspect_asset` | What is actually inside this glTF? Meshes, materials, texture channels, sizes, bounds. |
| `validate_game_asset` | Is this shippable? Pass/fail with per-check reasons and every threshold overridable. |
| `normalize_mesh` | Repair it: generate UVs for objects that have none, weld coincident vertices, dissolve degenerate triangles, name materials. |
| `batch_prepare_meshes` | The same, across a list of `.glb`/`.gltf` paths, with a per-item verdict. A *failed* item can still have written a file — when normalization succeeds but the result misses the policy, the mesh is kept for inspection. Use `outputsWritten`, not `prepared`, to predict the file count. |
| `extract_pbr_trio` | Split a material into albedo / normal / roughness images, de-packing metallicRoughness correctly. |

The usual loop is **validate → normalize → validate again**, so the repair is proven rather than assumed:

```
validate_game_asset  modelPath=/art/crate.glb
   → fails: uvs_present   ("nothing can texture this")
normalize_mesh       modelPath=/art/crate.glb  outputDir=/art/out
   → objectsUnwrapped=2, triangles 3183 → 1750
validate_game_asset  modelPath=/art/out/crate_normalized.glb
   → passes
```

`batch_prepare_meshes` runs that loop over a list and reports each item separately. Meshes that already pass are left untouched rather than rewritten, one bad file never stops the run, and two sources that share a basename get distinct outputs instead of overwriting each other.

**Missing UVs is the defect worth knowing about.** A mesh with no UV coordinates cannot be textured by anything — not this tool, not a provider, not you by hand. Generators and marketplace assets ship without them routinely. `validate_game_asset` names it first for that reason.

**Normalization needs Blender** (4.x+). Without it the tools still validate and report; they simply cannot repair. On macOS Blender is not on `PATH`, so either set `BLENDER_PATH` or rely on the bundled `/Applications/Blender.app` default.

---

## Example workflow

### Full pipeline: idea to inspected asset

```
1. generate_asset_reference   → spends image credits, returns assetJobId + N candidates
2. (inspect the images)       → look at the returned reference images and choose one
3. select_reference           → free; records which candidate wins
4. create_3d_asset            → spends 3D credits, returns a task to poll
5. get_asset_job              → free; poll until status is "ready" (or "failed")
6. download_asset             → free; pulls model + textures + previews into the workspace
7. inspect_asset              → free; confirms what actually landed on disk
```

Step 2 is not decoration. Picking the reference before spending 3D credits is the whole reason the pipeline is split here: a bad reference produces a melted mesh, and you only discover that *after* paying for the reconstruction.

### Retexture: shorter, cheaper, and the flow most tools do not have

You already have the mesh. There is nothing to reference, nothing to select, nothing to reconstruct:

```
1. texture_existing_asset     → spends texturing credits on a mesh you supply
2. get_asset_job              → free; poll until ready
3. download_asset             → free
4. inspect_asset              → free
```

One paid call instead of two, and the geometry you already approved comes back unchanged.

---

## Costs and side effects

**Calls that spend provider credits:** `generate_asset_reference`, `generate_reference_variations`, `create_3d_asset`, `texture_existing_asset`, `generate_sound_effect`, `rig_asset`, `animate_asset`, `retopologize_asset`, and the image-generation step inside `create_game_prop`. Nothing else in this server can be charged for.

**Calls that are free:** `select_reference`, `get_asset_job`, `download_asset`, `inspect_asset`, `list_asset_jobs`, `preview_asset_prompt`, `extract_pbr_trio`, `normalize_mesh`, `validate_game_asset`, `batch_prepare_meshes`, `get_spend_report`. Poll, inspect, split and download as often as you like.

**A credit-consuming POST is never retried automatically.** This is a deliberate, load-bearing rule and it lives in the HTTP layer, not in each call site. When a request that creates a generation task fails — timeout, socket reset, 502 — the client *cannot tell* whether the provider accepted it before the connection broke. Retrying might be free; it might also double-charge you for a mesh you never receive. So it does not retry, the error comes straight back, and the decision to try again is yours. Idempotent reads — status polls, file downloads — retry freely with backoff, because they cost nothing to repeat.

Other side effects worth knowing:

- **Files are written to disk.** *Downloaded* assets land under `ASSET_OUTPUT_DIR`, and a download path that escapes the workspace root is refused. Three tools are different and deliberately so: `extract_pbr_trio`, `normalize_mesh` and `batch_prepare_meshes` write where **you** tell them to, including outside the workspace, because they operate on meshes you already own and those do not live in an asset-generation directory. Give them a destination you meant.
- **`download_asset` and `generate_sound_effect` accept a `destination`** that overrides `ASSET_OUTPUT_DIR` for that one call. It is still contained: a path escaping the given root is refused.
- **`ASSET_OUTPUT_DIR` should be absolute.** A relative value resolves against the *server's* working directory, which your MCP client chooses — several spawn from `/`. The server refuses to start with a message naming the resolved path and the working directory it came from. That diagnosis covers the eight errnos this can realistically produce — ENOENT, EACCES, EPERM, EROFS, ENOTDIR, ELOOP, ENAMETOOLONG and ENOSPC, including ASSET_OUTPUT_DIR pointing at a file rather than a directory. Anything else still propagates raw.
- **Nothing is silently overwritten.** A derived output name gets a numeric suffix (`crate`, `crate_2`, …) rather than destroying a result you may already have reviewed, and the name is claimed by exclusive create so two items in one batch cannot race for it. An **explicit** `outputPath` is refused outright if a file is already there, unless you pass `overwrite: true` — and it is refused unconditionally, with no opt-out, if it resolves onto the input mesh. That resolution accounts for symlinks, hardlinks, case-insensitive volumes, and the exporter's habit of rewriting the extension, because every one of those has destroyed a source mesh here.
- **Downloads are capped** at `ASSET_MAX_DOWNLOAD_BYTES` and the cap is enforced while streaming, not from the `Content-Length` header — a server that lies about the size cannot exhaust your memory.
- **Only HTTPS.** Non-HTTPS URLs are refused outright, including ones that arrive inside a provider's response.
- **API keys are redacted from logs** centrally, so no individual log call site can leak one.

---

## Workspace layout

Every asset gets a self-contained directory. Open it in a file browser six months later and it still explains itself:

```
assets/generated/
├── .jobs/                          job records, one JSON file per job
│   └── asset_<uuid>.json
└── <asset_name>/
    ├── asset.json                  complete provenance: spec, prompt, seed,
    │                               model version, provider ids, file hashes
    ├── source/                     the reference image(s) the mesh was built from
    ├── model/                      the mesh (GLB by default)
    ├── textures/                   extracted PBR maps
    ├── previews/                   provider-rendered turnarounds
```

`<asset_name>` is your spec's name, sanitized: lowercased, non-alphanumerics collapsed to underscores. The `.jobs` directory is a dot-directory on purpose — browsing your asset workspace should show assets, not bookkeeping.

---

## Troubleshooting

Every error carries a machine-readable `error` field naming the class, plus a `retryable` flag, so an agent can decide what to do next without parsing prose. The names below are the values of that `error` field.

**The server starts and immediately exits — the client says only "connection closed".**
Three known causes, and the server now names the first two itself rather than dying silently.
- **A relative `ASSET_OUTPUT_DIR`.** It resolves against the *server's* working directory, which your MCP client chooses — several spawn from `/`, where `assets/generated` becomes `/assets` and cannot be created. **Use an absolute path.** The refusal names the resolved path and the working directory it came from.
- **A workspace the process cannot write to.** Same refusal, different errno.
- **A stale build.** If `dist/` predates a change to the entry point, rebuild. `npm run verify` builds and then completes a real MCP handshake, which is the fastest way to tell a broken server from a broken client config.

**`normalize_mesh` or `batch_prepare_meshes` refuses with "Blender not found".**
There is no local Blender on `PATH`. On macOS the app bundle is not on `PATH` even when Blender is installed — set `BLENDER_PATH` to the executable inside the bundle. `batch_prepare_meshes` degrades rather than failing: it still validates every mesh and reports what *would* need repairing.

**`CONFIG_MISSING` — missing credential.**
The tool you called needs a provider you have not configured. The message names the exact environment variable. Set it in your MCP client's `env` block and restart the client. A `.env` file is **never** read: there is no dotenv dependency, so the variable must be exported by whatever launches the server.

**`PROVIDER_HTTP` with status 401/403 — invalid API key.**
The key is wrong, revoked, or the wrong provider's. Two specific traps: Leonardo keys need API access enabled on the account (a web login alone does not grant it), and a Tripo key with no **API** credit balance can fail on the first paid call even though the key itself is valid. See the credits warning above.

**`RATE_LIMITED` — HTTP 429.**
Marked retryable. **Polls** back off and retry automatically (400 ms, 800 ms, 1600 ms, capped at 8 s). **Downloads do not retry** — `download_asset` streams in one attempt, so re-issue it yourself; because provider URLs expire, re-poll with `get_asset_job` first rather than retrying a stale URL. Generation requests do not retry either, deliberately, because they cost money. A 429 during a download surfaces as `PROVIDER_HTTP` with status 429, not as `RATE_LIMITED`.

**`PROVIDER_TASK_FAILED` — the task failed provider-side.**
The HTTP call succeeded and the generation did not. The provider's own message is preserved in the error details. A moderation refusal also lands here: rewrite the prompt rather than retrying it unchanged. Note that a Tripo response can carry HTTP 200 with a non-zero envelope `code`; that is a failure, and this server treats it as one instead of reporting a phantom success.

**Download fails with `PROVIDER_HTTP` 403/404 — the URL expired.**
This is the single most common surprise. **Provider model and preview URLs are short-lived.** They are signed, they expire, and a URL that worked twenty minutes ago is now dead. The fix is not to retry the same URL — call `get_asset_job` again to re-poll the provider for fresh URLs, then `download_asset` immediately. As a habit: download as soon as a job reports `ready`, not at the end of a long session.

**`INVALID_INPUT` — unsupported image format.**
Reference images should be standard web-safe raster formats (PNG, JPEG, WebP). HDR, EXR, layered PSD, SVG and multi-page TIFF are not reconstructable inputs. For `texture_existing_asset`, meshes must be GLB, GLTF, FBX, OBJ or STL. Convert first; the provider will not do it for you.

**`PROVIDER_MALFORMED_RESPONSE` — the provider returned something unexpected.**
Non-JSON body, an empty envelope, a success with no data, or an upload that returned no file token. Usually means a provider-side incident or an API version drift. Set `ASSET_LOG_LEVEL=debug` to see the request shape (keys are redacted), and check the provider's status page before assuming the bug is local.

**`DOWNLOAD_TOO_LARGE`.**
The file exceeded `ASSET_MAX_DOWNLOAD_BYTES`. A high-quality PBR GLB can be large; raise the limit if you genuinely want the file.

**`PATH_ESCAPE`.**
A provider-supplied filename tried to resolve outside your workspace. The write was refused. This should never happen in normal operation — please open an issue if it does.

---

## Status

This is early software, and the parts most likely to drift are marked as such rather than quietly assumed.

**Tripo's v3 endpoint paths are pinned in exactly one module** (`src/providers/model3d/tripo.ts`) and documented in a comment at the top of it. Tripo's public docs describe the v3 surface two different ways — a generic task endpoint and per-operation paths — and both appear in current documentation. This client implements the task form, which matches the observable behaviour that every generation returns a `task_id` to poll, and exposes `TRIPO_BASE_URL` so you can retarget without editing code. If they are wrong you will see a 404 that looks exactly like a bad API key, so check the path before the key.

**No call has ever been made to a live provider API.** This is the most important caveat here, so it is stated plainly rather than buried. Every one of the 413 tests runs against mocks or the local filesystem. They cover prompt construction, status mapping, path safety, the job store, the HTTP layer's retry and redirect rules, and glTF inspection against real files — but a green suite says nothing about whether Leonardo and Tripo behave the way this client assumes.

Concretely, these remain **unverified**:

- The Tripo v3 endpoint paths described above.
- Whether `texture_model` accepts an **uploaded** mesh (`file_token`) or only a mesh produced by a prior Tripo task (`original_model_task_id`). This decides whether you can retexture a model you already own, which is the feature this server exists for. Resolving it costs one HD texture call.
- **Sound-effect generation is unverified.** Leonardo documents the Sound Effects v2 *request*
  contract (`model`, `prompt`, `duration` 1-22s, `prompt_influence`, `loop`, `quantity`) but not
  its response shape or how the finished audio is retrieved. The client reads the generation id
  and audio URLs from several plausible shapes and throws with the response's top-level key NAMES attached (not the body, which could be large or carry a signed URL) when none
  match, rather than reporting an empty success. Expect the first real call to need a fix, and
  please open an issue with the payload shape you saw.
- The Leonardo model ids in `src/providers/image/leonardo.ts`, which were transcribed from published documentation. Check them against `GET /platformModels`; a stale id fails as an HTTP 400 that reads like a malformed request body. Both `LEONARDO_MODEL_ID` and a per-call `modelId` exist as escape hatches.

If you are the first person to run this with real keys, expect to fix an endpoint path, and please open an issue with what you found.

**What *is* verified:** `npm run verify` builds the server, starts it over stdio with a real MCP client, completes the handshake and asserts all twenty tools register. That is a protocol round-trip, not a version string — a server that fails to register its tools still starts perfectly happily.

Parts of the local pipeline — `inspect_asset`, `extract_pbr_trio`, `normalize_mesh`, `validate_game_asset` — are additionally checked against real shipped game assets rather than fixtures, because a synthetic fixture and the parser that reads it can share the same mistake and both look green. It has happened here: a wrong glTF magic constant survived a full synthetic suite and was caught only by a real file. The UV-less mesh they use is **committed here** rather than read from a sibling checkout. It used to be read live from the game repo, and when that mesh was repaired these tests went red for a change that was entirely correct — an assertion pinning a fact about a file this project does not control. A test may not depend on content it does not own.

One test spawns the built server through a **symlinked bin** — what `node_modules/.bin` actually contains — and speaks MCP to it, because that is where the entry-point guard failed: the server exited instantly on every install while passing every other test. It symlinks rather than installing, so it cannot catch a packaging regression in `files` or `prepare`; a real `npm install` from GitHub is still a manual check.

### Why the test count is not the point

In 0.3.4 each of the previous release's five headline fixes was reverted one at a time and the suite re-run. **All five survived — every mutant was fully green.** The fixes were real; nothing in the suite was holding them. The cause was a single shared assumption: every stubbed Blender exited 0 and printed exactly one receipt, so none of the subprocess-protocol hardening was observable by any test.

That is worth stating in a README because it is the honest reading of any test count, including this one. A suite certifies the author's assumptions, and a defect that lives *inside* an assumption is invisible to every test written under it. What changed is the discipline, not the number: fixes are now pinned by tests that were **run against the reverted code and observed to fail**, and shared fakes are treated as suspects rather than infrastructure.

The same check caught a bad proof twice in one sitting. Two successive fixtures written to prove a weld-threshold fix reported an *identical* triangle count with the code correct and with it broken, and either would have shipped as evidence. A fixture is not proof until it has been run through both the fixed and the broken code and the two numbers printed.

---

## Contributing

Issues and pull requests welcome. If you add a provider, implement `ImageProvider` or `Model3DProvider` and change nothing else — if a new provider forces a change to the tool surface, the abstraction is wrong and that is the bug worth discussing first.

## License

MIT © 2026 Ben Haire. See [LICENSE](LICENSE).
