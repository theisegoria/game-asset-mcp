# Changelog

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
