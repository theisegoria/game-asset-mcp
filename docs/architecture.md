# Architecture

This document explains the decisions that are not obvious from reading the code, and — more importantly — the alternatives that were rejected and why. If you are about to change something here, the reasoning you need to overturn is written down.

---

## The shape of the system

Four layers, each of which knows only about the one below it:

```
  MCP tool surface          intention-shaped verbs an agent calls
        │                   ("make me a prop", not "POST /task")
        ▼
  Orchestration             AssetJob lifecycle, prompt construction,
        │                   download + inspection
        ▼
  Provider abstraction      ImageProvider · Model3DProvider
        │                   two small interfaces, no vendor types above here
        ▼
  Vendor clients            Tripo, Leonardo.Ai — REST, envelopes, quirks
```

Two invariants hold the layering together:

1. **No vendor type escapes the provider layer.** Tripo's `{ code, data, message }` envelope, Leonardo's `PENDING`/`COMPLETE`/`FAILED` vocabulary, their differing id schemes — all of it is normalized at the boundary. Nothing above the provider layer imports a vendor module.
2. **Nothing is lost in normalization.** Every mapped value keeps its raw counterpart beside it: `AssetJob.providerStatus` holds the provider's own string next to our `status`, and `Model3DTaskResult.raw` carries the entire untouched payload. Normalization that discards the original just relocates the debugging problem to a place where you no longer have the evidence.

### Why two interfaces and not one

`ImageProvider` and `Model3DProvider` are separate because they fail differently and are configured independently. A user with a Tripo key and no Leonardo key must still get a fully working 3D pipeline. Fusing them into one `AssetProvider` would make that user's configuration invalid for a capability they never asked for.

Both interfaces are deliberately *small*. The goal is not to abstract over every capability any vendor might ever ship — that produces a lowest-common-denominator interface that describes no provider well. The goal is narrower and testable: **adding a second provider must not change the MCP tool surface.** Vendor-specific extras travel in `raw` rather than being promoted into the interface. If a new provider forces a change to the tool surface, the abstraction is wrong.

---

## Why the MCP surface is intention-shaped

The tempting design is a thin mirror of the vendors' REST APIs: `tripo_create_task`, `tripo_get_task`, `leonardo_create_generation`, `leonardo_get_generation`. It is easy to write and easy to document. It is also the wrong product.

An agent handed vendor-shaped tools has to know the pipeline: that a reference image must be reconstructable rather than pretty, that the image is uploaded to get a file token before reconstruction, that the model URL expires and must be fetched promptly, that `texture_model` needs either a prior task id or an uploaded mesh but never both. Every one of those is a place to get it wrong, and every mistake costs credits to discover.

So the tools are named after **what the caller wants**, not what the vendor exposes. `create_game_prop` is the clearest case: the caller's intent is "I want a prop", and the server owns the knowledge of how that decomposes. `texture_existing_asset` is another — the caller's intent is "this mesh, different materials", and whether that becomes an `original_model_task_id` or an uploaded `file_token` is an implementation detail they should never have to hold.

This has a second, less obvious payoff: **an intention-shaped surface survives a provider swap.** Vendor-shaped tools are a permanent commitment to one vendor's REST vocabulary, in the client's config file, in every agent's learned habits. Change providers and every caller breaks.

The pipeline is nonetheless split at one specific seam — reference generation and 3D reconstruction are separate calls, with `select_reference` between them. That seam is not an abstraction leak; it is a **spend gate**. A bad reference produces a melted mesh, and reconstruction costs several times what the reference did. The split exists so a human or agent can look before paying. `create_game_prop` respects the same gate: it stops after references rather than running the whole pipeline unattended.

---

## The key decision: direct REST, not composition with Leonardo's MCP server

Leonardo.Ai publishes an official remote MCP server. On the surface, composing with it looks strictly better — no API client to write, no auth to maintain, no drift to track. It was seriously considered and rejected.

**What Leonardo's MCP server offers.** Essentially one tool: `generate-image`. It is built for interactive use — a person asking a chat client for a picture, then looking at the picture.

**Why that is not enough here.** This server's core obligation is provenance. `AssetJob` must persist, at the moment it is known and not reconstructed later, the fields that make a generation explicable and reproducible:

- the **generation status**, distinguishable from "still running", so the pipeline knows when it may proceed;
- the **seed**, without which the image cannot be reproduced and the record is decoration;
- the **image download URLs**, which we must fetch promptly because they expire;
- **stable per-image ids**, so a variation can name the parent it was varied from.

Leonardo's MCP tool does not reliably surface those. It surfaces an image, which is the right answer to a different question. Once a field like the seed is gone, it is gone — the generation cannot be re-derived after the fact.

**Why "compose where possible, REST for the rest" is worse than either.** The obvious compromise is to use the MCP server for generation and REST for everything else. That gives the worst of both: we become an MCP client for exactly one call, carry a second transport and a second failure mode, take a dependency on a remote service's uptime and tool schema, and *still* write and maintain the REST client for status, seeds, variations and downloads. The dependency buys nothing it does not also take back.

**The decision.** Talk to Leonardo's REST API directly, through the same `ImageProvider` interface every other image provider will implement. One transport, one error taxonomy, one retry policy, complete control over which fields are captured.

**This does not lock anyone out.** Leonardo's official MCP server is genuinely good at what it is for, and it composes at the *client* level rather than inside this server. Attach both to your agent: use Leonardo's server for interactive exploration and mood-boarding, and this one when a result needs to become a tracked, reproducible, downloadable asset. They are complementary tools, and nothing here prevents running them side by side.

**When to revisit.** If Leonardo's MCP server begins reliably exposing generation status, seeds, per-image ids and download URLs, this decision should be reopened — the reasoning above is entirely about which fields are available, not about MCP composition being wrong in principle.

---

## Why atomic JSON files, not SQLite

Jobs are persisted as one JSON file per job in `<ASSET_OUTPUT_DIR>/.jobs/`, written with the temp-file → `fsync` → `rename` sequence. SQLite was the obvious alternative and was rejected on installation cost.

**The two SQLite options, and what each costs:**

- **`node:sqlite`** (built in) is still flagged experimental and requires **Node >= 22.5**. Adopting it would raise this server's floor from 18.17 to 22.5 — excluding every user on an LTS runtime their studio has standardized on — in exchange for a feature this workload does not need.
- **A native driver** (`better-sqlite3` and friends) drags a **build toolchain** into every installation. Prebuilt binaries cover the common cases and fail exactly where you least want them to: an unusual Node ABI, a locked-down CI image, a fresh Windows machine with no compiler. `npx game-asset-mcp` stops being reliable, and "it wouldn't install" is a far worse first experience than any query performance this would have bought.

**Why a file store is genuinely sufficient here — not merely tolerable.** Read the actual workload honestly:

- **Scale is hundreds of jobs, not millions.** One JSON file per job, listed by reading a directory.
- **There is a single writer.** One MCP server process owns the directory. No concurrent-write contention to arbitrate.
- **Access is keyed.** The overwhelmingly common operation is "fetch job by id", which a filename answers directly. Job ids are validated against `^asset_[A-Za-z0-9-]{1,64}$` before touching the filesystem, so an id can never escape the directory.
- **The only scan is `list()`,** which reads the directory and sorts. At this scale it is imperceptible.

SQLite would buy indexed queries and transactions across rows. This workload has no cross-row transaction and one query pattern. That is paying an installation tax for capability that never gets used.

**Durability is not conceded.** `save()` writes to a temp file, **fsyncs**, then renames. Rename is atomic; the fsync is what stops the renamed file being empty after a power loss — atomic-but-unflushed is a real and commonly-missed failure. A crash mid-write leaves either the intact old file or the intact new one, never a half-parsed job. `list()` additionally tolerates one unreadable file rather than failing the whole listing: the other jobs are still valid and the caller still needs them.

**The extension point, if SQLite is later warranted.** `JobStore` is a class with a narrow async interface — `open`, `save`, `get`, `find`, `list`, `findByProviderTaskId`, `delete` — and every method already returns a promise. Nothing above it knows how a job is stored. If the workload ever changes shape (many thousands of jobs, cross-job queries, multiple writers), implement that interface over SQLite and change one construction site. The design keeps that door open; it just does not walk through it before there is a reason.

---

## Why AssetJob owns identity and provider ids are metadata

Every job gets **our** id — `asset_<uuid>` — generated locally at creation. The provider's task id is stored as a field on the job, never used as the primary key.

The alternative, keying jobs by provider task id, fails in several ordinary ways:

- **A job exists before any provider does.** The record is created when the request arrives; the provider task id only exists after a successful POST. Provider-keyed storage has nothing to write when that POST fails — which is exactly the moment you most want a durable record of what was attempted.
- **Provider ids expire.** Tripo tasks age out. When the remote task is gone, a provider-keyed record has lost its identity along with it, taking the prompt, the seed and the file hashes with it. Ours survives: the asset on disk is still explicable long after the task that made it is unreachable.
- **One job can span multiple provider tasks.** An image generation, then a reconstruction, then a retexture — different vendors, different id schemes. There is no single provider id that could serve as the key.
- **Providers get swapped.** Regenerate the same asset through a different vendor and the local identity, workspace directory and history should persist. Provider-keyed identity makes a vendor change a data migration.
- **Id schemes change.** A vendor is free to alter its id format; we are not free to rewrite every stored key when they do.

So identity flows one way: our id is stable and ours, and provider ids are *observations about* a job. `findByProviderTaskId` exists for the reverse lookup when a provider webhook or support ticket hands you their id — but it is a search over metadata, not a key lookup, and its position in the API reflects that.

The same principle governs provenance more broadly: prompts, seeds, model versions and credit costs are recorded **at the moment they are known**, not reconstructed later. Those answers become unrecoverable once a provider task ages out.

---

## Why credit-consuming POSTs are never retried

Retry-on-transient-failure is such standard practice that its absence looks like an oversight. It is not: `retries: 0` on task creation is load-bearing, and it is enforced by *default* in `requestJson` so that forgetting is the safe direction.

The argument is short and, once seen, hard to escape. When a POST that creates a generation task fails — timeout, socket reset, 502 — **the client cannot distinguish a request the provider never saw from one it accepted before the connection broke.** Both look identical from here. So:

- Retry a request the provider never received: free, correct, helpful.
- Retry a request the provider already accepted: **the user is charged twice** and receives one result, or two results where one is orphaned and untracked.

There is no client-side test that separates those cases. Idempotency keys would solve it, and are not universally available across the providers this server targets. Absent that, the only honest choice is to surface the failure and let a human decide. A duplicate charge is a real cost to a real person; a failed request that must be retried by hand is an inconvenience. Those are not symmetric, so the default is not symmetric.

The rule is drawn at the exact boundary that matters — **does this call spend money?** — not at the HTTP verb:

- **Never retried:** task creation (`POST /task` for `image_to_model`, `text_to_model`, `texture_model`), image generation. Uploads are also unretried, being POSTs whose duplicate side effects are pointless.
- **Retried freely,** with deterministic backoff (400 ms, 800 ms, 1600 ms, capped at 8 s): status polls, file downloads. Repeating them costs nothing and changes nothing.

The backoff carries no jitter, deliberately. Jitter exists to de-synchronize a herd of clients; a single client polling a single task has no herd to de-synchronize, and determinism makes the behaviour testable.

---

## Why reference prompts optimise for reconstruction, not beauty

A reference image destined for image-to-3D is **not concept art**, and treating it as such is the most expensive mistake in this pipeline.

Concept art rewards drama, and image models are trained to deliver it: shallow depth of field, a hero rim light, the subject half-lost in atmosphere, a three-quarter crop that runs off the frame. Every one of those choices is *information destruction* measured against reconstruction:

| Beautiful choice | What the reconstructor loses |
| --- | --- |
| Shallow depth of field / bokeh | Sharp geometry cues everywhere but the focal plane |
| Dramatic rim lighting | Baked highlights the reconstructor reads as *shape*, not light |
| Heavy cast shadows | Surfaces indistinguishable from dark material |
| Atmosphere, haze, particles | Silhouette boundaries, the strongest signal available |
| Cropped or cut-off framing | Geometry that is simply absent and must be invented |
| Busy background, foreground clutter | Figure/ground separation |
| Turnaround sheets, collages | A coherent single subject |

The failure is nastier than it sounds because it is **delayed and paid for twice**. A dramatic reference looks *great*. It is approved. Reconstruction is paid for. The melted, guessed-at mesh arrives several minutes and several credits later, and the cause — a rim light three steps back — is not visible in the artefact that reveals the problem.

So `reconstruction-prompt.ts` trades beauty for legibility on purpose: one isolated object, complete silhouette with margins, three-quarter view showing front/side/top, plain neutral mid-grey background, even diffuse light, sharp focus throughout. The negative prompt enumerates the destructive choices explicitly — depth of field, bokeh, rim lighting, cast shadows, clutter, crops, watermarks, collages — rather than hoping their absence is inferred.

Three supporting decisions follow from the same logic:

**The user's intent leads the prompt.** The object's identity is the first clause, verbatim; the mechanical directives follow. Image models weight early tokens more heavily, and the object must outrank our framing rules. Reversed, you get a beautifully-framed picture of the wrong thing.

**The module is pure.** No I/O, no clock, no randomness. The same spec yields the same prompt, which makes prompt construction fully testable without spending a credit and makes a recorded generation reproducible from its record.

**Variations anchor on the original.** `buildVariationPrompt` repeats the base description verbatim and nudges exactly one named axis. Without that anchor, "variation" degenerates into "different object" — the standard failure when exploring designs with an image model, and useless for a pipeline whose next step is picking one.

The texture prompt drops the framing directives entirely: there is no camera, the mesh already fixes the geometry, and framing language would only dilute the material signal that is the sole useful input.

---

## Cross-cutting rules

A few decisions apply everywhere and are enforced centrally rather than by convention, on the principle that the one call site that forgets is the one that leaks.

- **stdout belongs to the MCP protocol.** All logging goes to stderr. A stray `console.log` corrupts the transport.
- **Secrets are redacted in the logger,** not at call sites, by matching secret-bearing key names.
- **Provider responses are untrusted input.** Filenames are stripped to a basename and sanitized; every write path is resolved and refused if it escapes the workspace root; non-HTTPS URLs are rejected outright.
- **Download caps are enforced while streaming,** not from `Content-Length` — a server that lies about or omits the header would otherwise exhaust memory before the check ran.
- **Errors are structured.** A machine-readable `code` so an agent can branch without parsing prose, and a `retryable` flag so no caller retries something that would double-charge.
- **Illegal state transitions are refused,** not silently permitted. Allowing one would let a job report `ready` without ever having produced a model, which is the failure mode where the tool lies to the user.
- **Nothing is silently overwritten.** Colliding names get a numeric suffix; workspace reservation uses non-recursive `mkdir` so it is atomic against a concurrent caller rather than a racy check-then-create.
