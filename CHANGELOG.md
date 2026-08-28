# Changelog

## 1.0.1

Release-candidate hardening and public-product alignment:

- assigns one immutable 1.0.1 identity to the CLI and five-skill bundle after
  the already-published skills v1.0.0 archive
- adds byte-verifiable macOS icon provenance and refreshed publication metadata
- hardens native CLI identity checks, exact operation validation, credential
  routing, cancellation, process cleanup, and bounded output draining
- hardens detached Blender/scenario cleanup and caps hostile receipt/output
  streams without changing the per-invocation authority model

## 1.0.0

Game Development Studio replaces the retired MCP entry point with a local-first
`game-dev` CLI, a stable JSON/JSONL automation protocol, and five publishable
skills. The v0.4.0 MCP implementation remains available in Git history and tags;
it is not shipped by 1.0.0.

### Production and vendoring

- durable provider jobs for Tripo 3D and Leonardo image/audio generation
- explicit per-invocation spend approval and estimated-cent ceilings
- GLB inspection, validation, Blender-backed normalization, and optional USDZ
  preview export
- canonical, content-addressed asset packages with manifests, receipts,
  provenance, closed hash rosters, license gates, and a rebuildable SQLite
  catalog
- dry-run-first project vendoring, legacy migration, and Finder, Quick Look, or
  Blender launch plans

### Capture and diagnosis

- declarative game adapters and separately authorized execution, GPU, and
  hardware-performance capabilities
- sealed run bundles with color and semantic attachments, structured telemetry,
  logs, metrics, manifests, and hashes
- deterministic raster statistics, heatmaps, attachment-aware comparisons,
  metric summaries, and bounded optimization goals

### Native macOS app

- native macOS 26 SwiftUI companion, built as a Swift 6.2 SwiftPM executable,
  with a `WindowGroup`, separate Settings scene, `NavigationSplitView`, toolbar
  search, result inspector, desktop menu commands, and adaptive system styling
- four first-class workspaces for Production, Library & Vendoring, Visual
  Debugging, and Performance, all calling the injected `AppModel` rather than
  launching processes from views
- Keychain-backed Tripo and Leonardo credential entry that reports only
  configured state and never restores a saved value to a visible field
- one-shot approval sheets for paid providers and local process, package,
  vendoring, GPU, and performance actions; vendoring and scenarios remain
  dry-run-first and invalidate their plan when bound inputs change
- local build, test, debug, log, telemetry, and process-level verification modes
  through `./script/build_and_run.sh`
- the helper's `.app` is ad-hoc signed for local development; Developer ID
  signing, notarization, external Gatekeeper validation, Mac App Store review,
  runtime screenshot inspection, pixel acceptance, and target-hardware evidence
  remain separate gates

### Distribution and safety

- router plus four focused skills with generated icon metadata and byte-checked
  provenance
- explicitly confirmed, atomic skill installation; no automatic writes to a
  user profile or game project
- secrets excluded from arguments and receipts, HTTPS-only provider traffic,
  bounded downloads, atomic persistence, and literal evidence ceilings
- Node.js 22.5 or newer is now required; CI covers supported Node releases and
  executes the Blender-gated normalization suite in a dedicated job

Provider-contract tests use local HTTPS fixtures, not paid live requests.
Static inspection and fixture captures do not prove live-provider behavior,
hardware GPU execution, pixel correctness, performance on a target machine,
signing, notarization, or human visual review.

## 0.4.0

No defect fixes. Two additions, one of them the first proof of something that
had only ever been asserted.

### `generate_sound_effect` is now proven built, end to end

It has always registered, and its provider layer was thoroughly tested —
request contract, credit safety, undocumented response shapes, URL recognition,
retrieval discovery. The **tool** was tested by nothing, so "it registers" was
the only claim anyone could honestly make about it.

It is now driven end to end with the provider stubbed and everything else real:
the spend ledger, the job store, the bounded poll, the HTTPS download, the
atomic write, the workspace layout, `asset.json`, and the JSON a client
receives. Five properties, each falsified against a reverted fix:

- clips land on disk carrying the **bytes** the server sent, not just a path in
  a response
- `asset.json` records prompt, provider, model and generation id — a clip
  nobody can trace back to a prompt is what this server exists to prevent
- a `PENDING` poll is retried rather than abandoned
- a provider failure becomes a **failed job**, not a thrown call: a spent credit
  with a traceable record beats an exception with none
- the spend ceiling is charged **before** the provider is contacted, and moving
  that charge after the call is caught by this test and nothing else

⚠ Still not a substitute for one live call. Leonardo documents the sound-effect
*request* contract but not its response shape, so the parsing in
`providers/audio/leonardo.ts` remains unverified against the real API and is
marked as such below. What is proven is that everything around it is wired up.

The test harness now accepts context overrides, so any provider-backed tool can
be exercised this way without a credential.

### A Features section in the README

A capability inventory rather than a tool list: what the pipeline does, what the
offline half answers, the glTF correctness the tools enforce on your behalf, the
safety properties (and that most of them exist because they were once wrong),
spend control, provenance, and how it fails. Every number in it was checked
against the running server rather than recalled.

## 0.3.9

A fifteenth review, six findings. Four are defects that 0.3.8's own fixes
introduced, and one is in the check written to prevent exactly that.

### A non-strict reader turned a refusal into a stated falsehood

Making `extract_pbr_trio` read non-strictly was right — one broken normal map
should not cost you the albedo and roughness you could still have had. But it
converted a loud, correct refusal into a **success that asserts something
untrue**:

| | result |
| --- | --- |
| 0.3.8 (strict) | `isError: true` — `ENOENT … THE_NORMAL_MAP_IS_MISSING.png` |
| 0.3.8 (non-strict) | success: *"normal was not written at all: the material declares no such texture"* |

The material **does** declare one. The reader knew precisely what was wrong and
said so, into a logger constructed inline and never read. There are now three
states — loaded, **declared but unreadable**, not declared — and the reader's
diagnostic is surfaced so the caller learns *which file* is missing.

### The guard against false greens had two false greens

`assert-blender-tests-ran.mjs`, added last release to stop CI passing by
skipping, could itself pass while proving nothing: its suite list was
hardcoded, so renaming one `describe` made that suite invisible and its tests
were reported as allowed platform skips; and *"at least one must have passed"*
was documented but never implemented — the count was used only in a log line.
The list is now derived from the source, and a suite present in the source but
absent from the report is a failure.

### Half-applied, again

- **`anythingDrawn` had a third site.** `base_color_texture` reported "no base
  colour texture" at severity `error` about a material that binds one.
- **`bounds.empty` reached no consumer** — the fifth instance of that class
  here. `bounding_box_finite` **passed** while reporting `0.000 x 0.000 x
  0.000 m` for a file where no finite vertex was found.
- **An orphan texture is not an extension-bound one.** 0.3.8 counted both,
  reopening the `texture_resolution` and `power_of_two_textures` warnings that
  scoping textures to drawn materials exists to suppress — and on one file made
  `inspect_asset` report *only* the texture nothing samples. The reader's log
  now decides it, and both directions are pinned.
- **Reader diagnostics were misattributed.** Drained inside the texture loop,
  so the first texture with a missing image took every message: with two
  missing sidecars, one texture was labelled with another's URI and the other
  named with none. Reported once, unattributed, which is what they are.

### The sentinel refused where refusing protects nothing

A mesh whose faces are **all** zero-area has no non-zero edge, so the safety
check found nothing to protect and skipped: 6 → 6 triangles while the receipt
called the object cleaned. "No real geometry" is safe, not unknown.

`"scale-independent by construction"` is retracted — the third overreaching
claim about this function. Two files with identical world geometry can still be
answered differently when one is authored so finely that no expressible
threshold is safe for it; that asymmetry is forced, and the honest response is
to skip and say so. The 10× factor's justification is also corrected: the
dissolve removes faces by **altitude**, not shortest edge, so the factor is a
sound proxy rather than the proof the comment claimed.

### Verification

The node-scale sweep added last release **could not see its own rule** — its
fixture holds vertices at 0…1 whatever the node scale, so all five cases ran
the identical branch. It swept the axis the rule ignores. There is now a sweep
over local edge length, across the threshold where the answer must change.

Three tests written this release passed for the wrong reason before they were
real: one insertion silently matched nothing, one passed a policy flag nested
where the schema is flat, and one asserted a field that does not exist. Each
was caught by reverting the fix and watching the test stay green.

## 0.3.8

A fourteenth review, six findings. The first is the same mistake for the third
consecutive release, and it is worth stating why it kept surviving.

### Framing a LOCAL question in WORLD terms — three times

`mergeDistance: 0` means "merge nothing, but still repair faces that are
degenerate at any scale". Two releases tried to express that as a world-space
number and both were wrong, in opposite directions:

| release | framing | failure |
| --- | --- | --- |
| 0.3.7 | `1e-6` **local** | world radius grew with scale; a mesh with 4e-7 local features **lost 98% of itself** and reported ready |
| 0.3.7 fix | `1e-6` **world** / divisor | gate reduces to `divisor <= 1`, so **every object scaled above 1.0 silently stopped being repaired** |

Each time the fixture sat at scale `[1,1,1]` — the one value at which that
release's bug is invisible. The second cliff sat at **1.0001**.

The dissolve runs on LOCAL coordinates, so the safety question is the mesh's own
local feature size and nothing else. It now dissolves at Blender's floor exactly
when the mesh's smallest real local edge is at least 10x that floor:
scale-independent by construction, which is what both previous framings lacked.
Measured across node scale 0.001 / 1 / 1.0001 / 2 / 1000: repaired at every one.

The test sweeps **scale**, not merge distance, and kills both historical
framings — the strongest check available.

`"monotonic by construction"` is retracted; `mergeDistance: 0` is a sentinel,
not a distance, and is documented as one. 0.3.7's entry is corrected in place
rather than quietly edited.

### Reports that stated things that were not true

- **The bounding box still used the OLD scene predicate**, so one response
  carried `sceneGraphFallback: false` beside the warning "no scene references
  the meshes" — contradicting itself, with `min_dimension` (severity `error`)
  judged against geometry the same report called undrawn.
- **`hasUVs` is `primitiveCount > 0 && missingUv === 0`**, so a file that draws
  nothing produced *"at least one primitive has no TEXCOORD_0"* about a file
  whose every primitive is fully unwrapped. Three errors for one cause, two of
  them untrue. The attribute checks now run only when something is drawn.

### Textures

- **One missing sidecar discarded every other texture in the file.**
  `extractTextures` read strictly while `inspectGltf` did not, and that reader's
  comment already stated the rule. All three readers now agree.
- **A texture bound through an extension vanished.** Scoping to drawn materials
  was done by enumerating the five core PBR slots, which cannot see a
  KHR_materials_clearcoat / sheen / transmission binding. Now three cases are
  distinguished: bound-and-drawn (counted), bound-but-undrawn (excluded),
  **binding not parseable (counted, because "unknown" is not "unused")**.
- The missing-image branch added in 0.3.7 was **dead code** under strict
  reading, which is why reverting it left the suite green — and why that
  release's "every fix observed to fail" claim was false for it. Now reachable
  and pinned.

## 0.3.7

A thirteenth review, six findings. The worst is mine from 0.3.6, and it is the
same defect that release's own comment quotes while introducing it.

### Data destruction

- **`mergeDistance: 0` destroyed geometry on a scaled object and reported
  success.** 0.3.6 special-cased the zero branch as a `1e-6` constant in LOCAL
  units with no divisor, while both other branches divided. The world radius was
  therefore `1e-6 x divisor`, and the branch below *skips* whenever the request
  is narrower than that — so **asking for zero merging applied a strictly wider
  repair than asking for a small positive one.** Two files with byte-identical
  world geometry went to 100 and 0 triangles; a partial case lost 98% (102
  triangles to 2) with `readyToTexture: true` and the skip counter reading zero.

  The test could not see it: hardcoded to one merge distance, against a fixture
  at scale `[1,1,1]` — divisor 1 is the single value at which it is invisible.

  > ⚠️ **CORRECTED in 0.3.8.** This release's replacement was wrong too, in the
  > opposite direction: framed as `1e-6 world / divisor`, the gate reduced to
  > `divisor <= 1`, so every object scaled above 1.0 silently stopped being
  > repaired — and the fixture was *still* at scale `[1,1,1]`, with the cliff at
  > 1.0001. The claim "monotonic by construction" was also false. Both framings
  > asked about WORLD scale; the dissolve runs on LOCAL coordinates, so the
  > safety question is the mesh's own local feature size and nothing else.

### Wrong verdicts, at severity `error`

- **`sceneGraphFallback` asked "does the *default* scene draw nothing?"** rather
  than "does any scene reference a mesh?". A Blender export whose default scene
  holds only a camera, geometry in a second scene, is ordinary — and it took the
  mesh-library fallback, counting undrawn meshes as drawn. That restored *both*
  defects the narrowing exists to prevent. It worked only when the default scene
  happened to be non-empty, which is exactly what its test covered.
- **Materials, textures and the PBR summary stayed file-scoped** while geometry
  was narrowed, so the two halves of one report described two different files.
  A normal map bound only by an undrawn collision proxy failed
  `tangents_for_normal_map` on a model that correctly needs no tangents; a
  base-colour texture on an undrawn LOD satisfied `base_color_texture` for a
  drawn mesh that has none. Textures now derive from the drawn materials.

### Values that reached no caller

- **The batch dropped the new dissolve-skip flag** — the fourth consecutive
  release in which that seam lost a flag the layer below computed.
- **`textureFailures` on the unreadable-container path was pinned by nothing**;
  deleting it left the whole suite green. Now covered end-to-end through a real
  HTTPS server, because the download layer refuses non-HTTPS URLs outright.
- **The four inspection fields were pinned only at the helper.** `ok()` takes
  `unknown`, so the compiler guards summarizer-to-interface and nothing guards
  interface-to-client — the exact hop where four fields have now been lost. A
  mutant destructuring them out on the way to the response **compiles cleanly**;
  only a test through a real MCP client can see it.
- A texture with no image data was silently skipped, vanishing from
  `textureCount` with nothing said.

### Verification

Every fix reverted and observed to fail, each mutant confirmed to compile *and*
to have actually applied. One near-miss worth recording: a field assignment
landed while its interface declaration silently did not, and **the tests passed
while `tsc` failed**, because vitest does not typecheck. The rule that keeps
catching this remains: put the field on the output type first.

## 0.3.6

A twelfth review. Two of these are mine from 0.3.5 — one a regression, one the
same defect class for the third consecutive release.

### I claimed to ship two fields that reached no caller

`undrawnMeshCount` and `undrawnTriangleCount` were declared, computed,
documented in the source as "Reported, not discarded", and headlined in 0.3.5's
release note. **They were in no response.** They were never added to the output
interface, so `tsc` had nothing to object to — a field that exists nowhere
cannot be a type error. The test meant to pin them is titled "and reports the
rest separately" and asserts neither.

This is the third consecutive instance of one class: `weldSkipped` (0.3.4),
`factorApplied` (0.3.5), these (0.3.5). The rule that actually prevents it:
**put the field on the output type first.** The moment they were added there,
the compiler named both missing sites immediately.

### A regression 0.3.5 introduced

Narrowing every count to the drawn scene turned a **mesh library** — meshes
present with no scene graph referencing them, valid glTF that real exporters
emit — into `0 triangles`, which `validate_game_asset` refuses at severity
`error`. The report contradicted itself: "nothing renders as a solid surface"
beside a real bounding box, because `computeBoundingBox` carries a documented
fallback for exactly that shape and the triangle counter had none. Two readers
of one fact disagreeing, which is the same shape as the defect 0.3.5 fixed.

### Half-applied fixes, again

- **The drawn-scene narrowing reached `triangleCount` and the bounding box, and
  not the attribute counters.** `hasUVs` derives from `missingUv`, and
  `uvs_present` is severity `error` — so a never-drawn, unwrapped collision
  proxy in a second scene FAILED a model whose drawn mesh is perfectly
  unwrapped. The exact mirror of the bug 0.3.5 fixed, in the same function.
- **The reservation cleanup wrapped only the plane loop** and stopped one
  statement short of the receipt write. Both of its tests fail *inside* the
  loop, so neither could see it — and the leak was worse than the one it fixed:
  four **fully written** planes holding the canonical names after a call the
  caller was told had failed.
- **`mergeDistance: 0` meant "repair nothing".** The weld gate and the dissolve
  gate were one flag, folding together "the caller asked for zero welding" and
  "the threshold cannot be expressed". Only the second is a reason to skip the
  dissolve: a zero-area face is degenerate at any threshold, including
  Blender's 1e-6 floor. Measured on a quad plus five zero-area triangles:
  7 to 2 at the default, 7 to 7 at zero, both reporting `objectsCleaned: 1`.
  The caller most likely to pass 0 is the one protecting screws, gems and PCB
  detail — exactly who most needs the repair.
- **An unreadable container reported `textureCount: 0`** with no failure named,
  indistinguishable from "no embedded textures". Draco/meshopt/KTX2 GLBs land
  there and providers do return them. The per-texture half was fixed in 0.3.5;
  this sibling path was not.

### Verification

0.3.5's verification claim was independently re-checked this round and found
**accurate** — all ten of its fixes were confirmed pinned, each mutant verified
to compile and to have actually applied. That is the first release note here
whose verification claim survived review.

## 0.3.5

An eleventh review found nine defects. One destroys geometry; one is a false
claim I published in 0.3.4's own release note.

### The correction first

0.3.4 said every fix in it was pinned by a test observed to fail against
reverted code. **Five of its six fixes were pinned by nothing** — reverting each
left the suite fully green. The discipline was applied to 0.3.3's fixes and then
written up as though it had been applied to 0.3.4's. All six are pinned now, and
0.3.4's claim is left standing with a correction beside it rather than quietly
edited.

### Data destruction

- **The unrepresentable-threshold fix reached `remove_doubles` and not
  `dissolve_degenerate`, thirteen lines below it in the same function.** Not an
  edge case but an identity: the weld is skipped exactly when the local
  threshold falls under Blender's 1e-6 floor, and the dissolve's old clamp then
  produced exactly 1e-6 — by construction *wider* than the caller asked for. So
  the honesty counter fired precisely on the runs where the protection had
  failed. Two meshes with byte-identical world geometry, differing only in how
  scale was split between node and vertices, normalized to **100 and 0
  triangles**, and the husk was reported `readyToTexture`.

### Wrong output

- **`baseColorFactor` was ignored whenever a base-colour texture was present.**
  0.3.4 claimed "both branches now apply the factor"; that meant both branches
  of metallicRoughness. A red-tinted white texture exported pure white. Albedo
  is now multiplied in linear light, unlike the data channels.
- **`occlusionStrength` and `normalScale` were dropped entirely.** Occlusion is
  `1 + strength x (sampled - 1)`, not a multiply — at strength 0 a multiply
  gives black, the exact opposite of "no occlusion".
- **The bounding box unioned every scene** while the triangle counter walked
  one, with doc comments that contradicted each other. `sizeMeters` feeds
  `min_dimension`, severity `error`: a flat plate correctly refused on its own
  was reported **shippable** once an undrawn second scene existed.
- **Meshes in a non-default scene were counted as drawn**, so a three-LOD file
  reported 3x what a renderer submits. Drawn and present are now separate
  counts (`undrawnMeshCount`, `undrawnTriangleCount`).

### False success

- **`factorApplied` was declared, passed by two call sites, headlined in a
  release note, and never written into the receipt.** Optional-property typing
  means `tsc` says nothing. This is the `weldSkipped` defect verbatim, one
  release later, inside the fix that promised to report it.
- **`stdoutTruncated` reached no tool response at all.** It matters here
  specifically: the receipt is the last line of stdout, so a dropped tail is how
  a forged receipt near byte 0 wins.
- **A partial texture extraction reported `textureCount: 0`.** The `catch`
  wrapped the whole loop, so a failure on texture 3 of 5 discarded the record of
  1 and 2 — already on disk — and `asset.json`, the provenance document, denied
  them. The guard is now per-texture, and failures are named in the response.
- **`extract_pbr_trio` had no cleanup for its reservations**, the third call
  site of a fix `normalize_mesh` and the batch both have. A failure partway
  left earlier planes plus a zero-byte `<stem>_metallic.png` holding the
  canonical name — sorting first in any glob — while the caller was told the
  call had failed. Cleanup is keyed on device+inode, so it can only remove a
  file this call still owns.
- **The summary called a missing normal plane a "flat constant".** The normal
  plane has no factor fallback and is simply not written; absent and constant
  are different answers. Reported separately as `missingPlanes`.

### Verification

Every fix above was reverted and observed to fail, and **each mutant was
confirmed to compile and to have actually applied** — a build failure is not a
kill, and a mutation that silently matched nothing is worse.

New: `tests/helpers/tool-harness.ts`. Until now nothing in the suite invoked a
tool through its registered handler; it tested domain helpers and the Blender
subprocess and stopped at the tool boundary. That is the structural reason
"computed correctly, dropped on the way out" kept shipping — the helper is
right, so a helper test cannot see it. Tool responses are now asserted as the
JSON a client actually receives.

One test in this release passed for the wrong reason before being fixed, and it
is worth naming: the `destination: ""` tests asserted only that the call failed,
against a nonexistent model, a nonexistent job and an unconfigured provider —
all of which fail anyway. Reverting the constraint left them green.

## 0.3.4

A tenth review. Six of these are fixes that 0.3.3 made *somewhere* and left
undone somewhere else — the same defect, a second time, one call site over.

- **The receipt forgery fix did not survive a chatty Blender.** 0.3.3 took the
  LAST matching stdout line, but stdout capture stopped at 4 MiB — so on a real
  export with megabytes of chatter the genuine receipt was *dropped by the cap*
  and a forged line near byte 0 became "the last one". Receipt scanning is now
  independent of the capture cap, and `stdoutTruncated` is reported.
- **`extract_pbr_trio` dropped the factor whenever a texture was present.** The
  glTF effective value is texture x factor. 0.3.3 fixed this for the untextured
  branch only, so a material declaring `metallicFactor: 0` alongside a shared
  metallicRoughness texture still exported **fully metallic**. Both branches now
  apply the factor and report it as `factorApplied`.
- **`triangleCount` summed every scene.** glTF `scenes` are alternatives and a
  renderer draws one. A mesh referenced from two scenes was counted twice, so a
  12-triangle asset reported 24 and failed a 20-triangle budget — while Blender,
  which walks one scene, disagreed systematically. Only the default scene counts.
- **The batch dropped the honesty flag 0.3.3 had just added.** It copied three
  receipt fields and not `weldSkipped`, so a mesh whose weld was skipped came
  back "game-ready" with no sign a repair had not run.
- **The batch discarded the only text naming a failure.** A failed item kept the
  error *message* and threw away `stderrTail`, which holds the Blender traceback.
  Now surfaced as `errorDetail`.
- **`destination: ""` was accepted by three tools**, resolving to the process
  working directory — which an MCP client chooses, not the user. Now `min(1)`.

### Verification

> ⚠️ **CORRECTION, added in 0.3.5: the paragraph below was FALSE when
> published.** An eleventh review reverted all six fixes and found **five of
> them pinned by nothing** — the suite stayed fully green on each. The
> discipline described here was genuinely applied to 0.3.3's fixes, then
> written up as though it had also been applied to 0.3.4's own. It had not.
> The claim is left standing rather than quietly edited, because a release note
> that silently rewrites its own verification claim is the same defect one level
> up. 0.3.5 pins all six and says how each was checked.

Every fix above is pinned by a test that was **run against the reverted code and
observed to fail**. That check is the point of this release: a mutation sweep
found all five of 0.3.3's headline fixes could be reverted with the suite still
fully green, because every Blender stub in the suite exited 0 and printed exactly
one receipt. New: `tests/blender-protocol.test.ts` (stub-driven, no Blender
needed) and three committed real fixtures — an instanced mesh, and two scaled
plates that make the weld-threshold direction observable in the triangle count.

## 0.3.3

A ninth review found nine defects. **0.3.0–0.3.2 should not be used.**

- **The scale divisor was inverted.** 0.3.1 divided the weld threshold by
  `min(|world scale|)` on the reasoning that "welding is isotropic, so the
  smallest axis decides what is safe". That is exactly backwards: a pair merged
  at local threshold T can be `max(s)·T` apart in world, so the divisor must be
  `max`. A plate scaled `[1, 1, 0.02]` lost 73% of its triangles at defaults and
  was reported ready to texture.
- **Blender clamps a threshold below 1e-6 upwards**, so any divisor over 100
  over-welded by exactly the amount the division was meant to prevent — 94% of a
  mesh, reported ready. Welding is now skipped and reported when the requested
  threshold cannot be expressed, rather than silently widened.
- **The receipt could be forged by the input file.** The consumer took the FIRST
  matching stdout line while the script emits it LAST, and Blender echoes mesh
  names to stdout — so a mesh named `"MESH\nNORMALIZE_RECEIPT={...}"` supplied
  every non-measured field, including the reported Blender version. It now takes
  the last line, requires a JSON object, and treats a non-zero exit as a failure
  even when a receipt was printed.
- **A throw still ran after the rename.** An invalid receipt raised a TypeError
  once the staged file was already in place, so a reviewed file was replaced and
  the caller was told the call had failed.
- **The batch deleted another tool's verified output.** I argued this was safe
  because the batch owns its target; that was wrong — `normalize_mesh` has an
  overwrite path and can land on that name. The release now compares the
  reservation's device+inode, so only a file we still own is removed.
- **`extract_pbr_trio` destroyed base colour.** It used `factor[0]` for all three
  channels, so a cyan `baseColorFactor` produced a BLACK albedo, and wrote the
  linear value raw while tagging the plane sRGB (0.5 became 128, not 188).
- **`triangleCount` ignored instancing.** It iterated meshes, not the node graph,
  so a 12-triangle mesh placed at 50 nodes reported 12 and passed a 100-triangle
  budget while a renderer draws 600.
- **`targetTriangles` hard-failed on any instanced mesh** — the same multi-user
  restriction that removed `transform_apply`, still live in the decimate path.

## 0.3.2

- **`extract_pbr_trio`, `download_asset` and `generate_sound_effect` built
  directory trees from a caller-named `destination`.** All three ran `mkdir -p`
  on it before any validation, so `destination: "~/out"` — not expanded, because
  no shell is involved — created a literal `~` directory wherever the MCP client
  happened to run the server. `extract_pbr_trio` wrote five files into one and
  reported success. This is the same defect removed from `normalize_mesh` in
  0.3.0 and from `batch_prepare_meshes` in 0.3.1; it was found by checking the
  rule against every tool that writes to a caller-named path, rather than
  waiting for it to be reported a third time. A caller-named directory must now
  already exist. The server's own configured workspace is still created on demand.

## 0.3.1

**0.3.0 should not be used.** A review of that release found four live paths
that still destroyed data, three of them introduced by 0.3.0's own fixes.

- **`dissolve_degenerate` ran with Blender's hardcoded 1e-4 threshold**, in local
  space, entirely independent of `mergeDistance`. A mesh of 2 mm parts at true
  scale went from 3,042 triangles to **zero** even with `mergeDistance: 0` — and
  the refusal named the one setting that could not fix it. Screws, gems, coins
  and PCB detail all sit inside that default. The threshold is now explicit.
- **The zero-geometry refusal fired *after* the rename.** The destination was
  atomically replaced by a husk and the caller was told "The destination is
  unchanged" — a false reassurance, which is worse than no check, because nobody
  re-checks. Measured: 70,492 bytes to 224. The check now runs before the rename.
- **Scale is no longer baked into geometry.** 0.3.0 applied `transform_apply`,
  which read the object's own scale and so missed a scale on a **parent** node —
  92% of a mesh was still destroyed at defaults — and which raised "Cannot apply
  to a multi user" on **instanced** meshes, turning a working input into a hard
  failure. The world scale is now read and the *threshold* divided by it: parents
  are included, instancing is untouched, and no geometry is mutated.
- **The threshold adjustment applies whether or not `cleanGeometry` is on.** It
  sat inside that branch, so turning welding off silently degraded UV texel
  density by 2.8x on a non-uniformly scaled mesh.
- The receipt's scale counters were provably false for a scale like `[-1, 1, 1]`.
  They now describe the threshold adjustment, which is what actually happens.

## 0.3.0

Seven rounds of adversarial review, each of which found a real way this server
could destroy a file or report success for work it had not done. Everything
below is a fix for a defect that was reproduced, not a hypothetical.

### If you are upgrading, these will change your calls

- **`normalize_mesh` `outputPath` must end in `.glb`** (or have no extension, in
  which case `.glb` is appended). Blender's exporter rewrites the extension, so
  `mesh.gltf` silently became `mesh.glb` — which could be a *different file*
  from the one you named, and destroyed input meshes that way.
- **`normalize_mesh` refuses an `outputPath` whose parent directory does not
  exist**, rather than creating the tree. It used to `mkdir -p` before any
  validation, so a typo built directories anywhere the server could write. A
  leading `~` is not expanded — no shell is involved.
- **`batch_prepare_meshes` refuses an `outputDir` that does not exist**, for the
  same reason.
- **Replacing an existing file needs `overwrite: true`.** Writing over the input
  mesh is refused unconditionally and has no opt-out.

### Data loss fixed

- **`normalize_mesh` could destroy the mesh you passed it.** The in-place guard
  compared path *strings*; a symlink, a hardlink, a symlinked parent directory,
  or a different capitalisation on a case-insensitive volume all name the same
  file differently. Identity is now device+inode.
- **Blender wrote straight to the destination**, so the read-back could not tell
  a fresh write from the file that was already there. With `overwrite: true`, a
  Blender that wrote *nothing* returned a success carrying the previous file's
  size and hash. Output is now staged, verified, and renamed into place, so the
  destination is only ever replaced by a result that parsed.
- **A failed call deleted a concurrent call's verified output.** Cleanup now
  removes only a zero-byte placeholder it still owns.
- **`mergeDistance` was applied in the mesh's local coordinate space** while every
  size reported is world space. On an asset whose node carries a scale — the
  ordinary output of Blender, Maya and FBX round-trips — the threshold was wrong
  by that factor. Measured at defaults, a 0.69 m prop lost 96% of its triangles
  and was still reported ready to texture. The node scale is baked before welding.

### Truthfulness fixed

- **`readyToTexture` is measured from the produced file**, not taken from the
  normalizer's receipt. It was derived from a receipt field that, when simply
  absent, became zero and therefore "ready".
- A result with **no drawable geometry is refused**, however the receipt reads.
- **`trianglesMeasured` and `hasUVsMeasured`** are reported beside the claimed
  values, and `batch_prepare_meshes` flags a receipt that disagrees with the file.
- **`outputsWritten`** counts files on disk. `prepared` is a verdict and was
  never a file count.
- **`timeoutSeconds` is now a real bound.** It killed only the direct child and
  waited for pipe holders, so a wrapper (`xvfb-run`, `flatpak run`) could keep a
  call pending long past its timeout while claiming it had been terminated.

### Security

- **`TRIPO_BASE_URL` and `LEONARDO_BASE_URL` are validated at construction.** The
  Tripo upload used a raw `fetch` with no HTTPS check, so an `http://` base put
  the mesh *and* the API key on the wire in cleartext. Authenticated uploads also
  refuse redirects outright.
- The **spend ceiling is checked before any provider contact**, including before
  a mesh is uploaded. It previously refused only after the upload.

### Removed

- `metadata/` is no longer created in asset workspaces. It was documented as
  holding raw provider payloads and nothing ever wrote to it.

## 0.2.0

Added `extract_pbr_trio`, `generate_sound_effect`, `normalize_mesh`,
`validate_game_asset`, `batch_prepare_meshes`, `rig_asset`, `animate_asset`,
`retopologize_asset`, and a session spend ceiling.

## 0.1.0

Initial release: reference images, image-to-3D, retexturing a mesh you already
own, job lifecycle, downloads with provenance.
