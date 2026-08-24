# game-asset-mcp

An MCP server that lets an AI agent produce game-ready 3D assets end to end — reference image, mesh, PBR textures, provenance — and retexture meshes you **already own**.

Most asset-generation tooling stops at "type a prompt, get a mesh". That is the easy half. The half that actually blocks a project is the mesh you already have: the kitbash you modelled last week, the marketplace prop whose materials are wrong for your art direction, the greybox that needs to look like corroded steel by Friday. `texture_existing_asset` takes a mesh you supply and gives it new PBR materials without regenerating the geometry you already approved.

Everything is recorded. Every job keeps the prompt, the seed, the provider model version, the provider task id, and a SHA-256 for every downloaded byte — so six months from now you can still answer "what produced this file?"

The server is provider-agnostic by construction. Today it drives [Tripo](https://platform.tripo3d.ai) for 3D and [Leonardo.Ai](https://app.leonardo.ai) for reference images and sound effects, behind three small interfaces (`ImageProvider`, `Model3DProvider`, `AudioProvider`). Adding a provider does not change the tool surface. See [docs/architecture.md](docs/architecture.md) for why it is built this way.

---

## Requirements

- **Node.js >= 18.17** — the server uses global `fetch`, `FormData`, `Blob` and `AbortController`.
- No native modules, no build toolchain, no database. It runs anywhere Node runs.
- **Optional:** a local [Blender](https://www.blender.org/download/) 4.x+ install enables `normalize_mesh`. Every other tool works without it; the tool refuses with instructions when it is absent. On macOS Blender is not on `PATH`, so set `BLENDER_PATH` or rely on the bundled `/Applications/Blender.app` default.
- At least one provider API key (see [Configuration](#configuration)). One is enough — they are validated lazily.

---

## Installation

Run it without installing anything permanently:

```bash
npx game-asset-mcp
```

Or install it into a project:

```bash
npm install game-asset-mcp
```

Or build from source:

```bash
git clone https://github.com/theisegoria/game-asset-mcp.git
cd game-asset-mcp
npm install
npm run build     # emits dist/
node dist/server.js
```

The server speaks MCP over **stdio**. Started directly in a terminal it will simply sit there waiting for a client to talk to it — that is correct behaviour, not a hang. Logs go to stderr; stdout belongs to the protocol.

---

## Configuration

Copy `.env.example` to `.env`, or set the variables in your MCP client's `env` block (which is usually the better option — see the snippets below).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TRIPO_API_KEY` | for 3D tools | — | Tripo API key. Create one at [platform.tripo3d.ai](https://platform.tripo3d.ai). |
| `LEONARDO_API_KEY` | for image and audio tools | — | Leonardo.Ai key with API access enabled. One key covers both reference images and sound effects. |
| `ASSET_OUTPUT_DIR` | no | `./assets/generated` | Where assets and job records are written. Relative to the server's working directory. |
| `ASSET_MAX_DOWNLOAD_BYTES` | no | `268435456` (256 MiB) | Hard ceiling on any single download, enforced while streaming. |
| `ASSET_HTTP_TIMEOUT_MS` | no | `60000` | Per-request HTTP timeout. |
| `ASSET_LOG_LEVEL` | no | `info` | `silent` \| `error` \| `warn` \| `info` \| `debug`. |
| `BLENDER_PATH` | no | auto-detected | Blender executable for `normalize_mesh`. Overrides discovery. |

### ⚠️ Tripo API credits are billed separately from a Tripo Studio subscription

This catches almost everyone. **A Tripo Studio web subscription does not fund API calls.** They are two different products with two different balances. If you have been happily generating models in the Studio web app and your very first `create_3d_asset` call comes back rejected for insufficient credits, you have not misconfigured anything — you need API credits on the developer platform. Buy them at [platform.tripo3d.ai](https://platform.tripo3d.ai), not in the Studio app.

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
  "args": ["-y", "game-asset-mcp"],
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

Only six tools can cost you money, and each one says so in its description before it is called.

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

**Calls that spend provider credits:** `generate_asset_reference`, `generate_reference_variations`, `create_3d_asset`, `texture_existing_asset`, `generate_sound_effect`, and the image-generation step inside `create_game_prop`. Nothing else in this server can be charged for.

**Calls that are free:** `select_reference`, `get_asset_job`, `download_asset`, `inspect_asset`, `list_asset_jobs`, `preview_asset_prompt`, `extract_pbr_trio`, `normalize_mesh`. Poll, inspect, split and download as often as you like.

**A credit-consuming POST is never retried automatically.** This is a deliberate, load-bearing rule and it lives in the HTTP layer, not in each call site. When a request that creates a generation task fails — timeout, socket reset, 502 — the client *cannot tell* whether the provider accepted it before the connection broke. Retrying might be free; it might also double-charge you for a mesh you never receive. So it does not retry, the error comes straight back, and the decision to try again is yours. Idempotent reads — status polls, file downloads — retry freely with backoff, because they cost nothing to repeat.

Other side effects worth knowing:

- **Files are written to disk.** Everything lands under `ASSET_OUTPUT_DIR`. Nothing is written outside it: paths are resolved and any that escapes the workspace root is refused.
- **Nothing is silently overwritten.** A colliding asset name gets a numeric suffix (`crate`, `crate_2`, …) rather than destroying a result you may already have reviewed.
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
    └── metadata/                   raw provider payloads, kept for debugging
```

`<asset_name>` is your spec's name, sanitized: lowercased, non-alphanumerics collapsed to underscores. The `.jobs` directory is a dot-directory on purpose — browsing your asset workspace should show assets, not bookkeeping.

---

## Troubleshooting

Every error carries a machine-readable `code` and a `retryable` flag, so an agent can decide what to do next without parsing prose.

**`CONFIG_MISSING` — missing credential.**
The tool you called needs a provider you have not configured. The message names the exact environment variable. Set it in your MCP client's `env` block and restart the client — a `.env` file is only read if the server's working directory is where you think it is, which under an MCP client it usually is not.

**`PROVIDER_HTTP` with status 401/403 — invalid API key.**
The key is wrong, revoked, or the wrong provider's. Two specific traps: Leonardo keys need API access enabled on the account (a web login alone does not grant it), and a Tripo key with no **API** credit balance can fail on the first paid call even though the key itself is valid. See the credits warning above.

**`RATE_LIMITED` — HTTP 429.**
Marked retryable. Polls and downloads back off and retry automatically (400 ms, 800 ms, 1600 ms, capped at 8 s). Generation requests do not — retry those yourself once the window clears, deliberately, because they cost money.

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

**Tripo's v3 endpoint paths are pinned in exactly one module** (`src/providers/model3d/tripo.ts`) and documented in a comment at the top of it. Tripo's public docs describe the v3 surface two different ways — a generic task endpoint and per-operation paths — and both appear in current documentation. This client implements the task form, which matches the observable behaviour that every generation returns a `task_id` to poll, and exposes `TRIPO_BASE_URL` so you can retarget without editing code. The paths are the **first** thing the live smoke test checks, because a wrong path returns a 404 that looks exactly like a bad API key.

**No call has ever been made to a live provider API.** This is the most important caveat here, so it is stated plainly rather than buried. Every one of the 165 tests runs against mocks or the local filesystem. They cover prompt construction, status mapping, path safety, the job store, the HTTP layer's retry and redirect rules, and glTF inspection against real files — but a green suite says nothing about whether Leonardo and Tripo behave the way this client assumes.

Concretely, these remain **unverified**:

- The Tripo v3 endpoint paths described above.
- Whether `texture_model` accepts an **uploaded** mesh (`file_token`) or only a mesh produced by a prior Tripo task (`original_model_task_id`). This decides whether you can retexture a model you already own, which is the feature this server exists for. Resolving it costs one HD texture call.
- **Sound-effect generation is unverified.** Leonardo documents the Sound Effects v2 *request*
  contract (`model`, `prompt`, `duration` 1-22s, `prompt_influence`, `loop`, `quantity`) but not
  its response shape or how the finished audio is retrieved. The client reads the generation id
  and audio URLs from several plausible shapes and throws with the raw payload attached when none
  match, rather than reporting an empty success. Expect the first real call to need a fix, and
  please open an issue with the payload shape you saw.
- The Leonardo model ids in `src/providers/image/leonardo.ts`, which were transcribed from published documentation. Check them against `GET /platformModels`; a stale id fails as an HTTP 400 that reads like a malformed request body. Both `LEONARDO_MODEL_ID` and a per-call `modelId` exist as escape hatches.

If you are the first person to run this with real keys, expect to fix an endpoint path, and please open an issue with what you found.

**What *is* verified:** `npm run verify` builds the server, starts it over stdio with a real MCP client, completes the handshake and asserts all eleven tools register. That is a protocol round-trip, not a version string — a server that fails to register its tools still starts perfectly happily.

---

## Contributing

Issues and pull requests welcome. If you add a provider, implement `ImageProvider` or `Model3DProvider` and change nothing else — if a new provider forces a change to the tool surface, the abstraction is wrong and that is the bug worth discussing first.

## License

MIT © 2026 Ben Haire. See [LICENSE](LICENSE).
