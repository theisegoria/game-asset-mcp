# Changelog

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
