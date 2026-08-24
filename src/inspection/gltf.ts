/**
 * Local technical inspection of a downloaded glTF/GLB.
 *
 * A job that reports `ready` has proved only that a provider returned bytes.
 * Whether those bytes are a USABLE asset — unwrapped, textured, the right
 * size, inside a triangle budget — is a different question, and it is
 * answerable locally, offline, for free. Answering it here means the caller
 * learns that a mesh has no UVs now, rather than after an artist imports it.
 *
 * So this module never reports a bare "ok". It reports counts, dimensions and
 * a list of specific defects, because a count can be argued with and a boolean
 * cannot.
 *
 * Read-only and offline throughout: nothing here mutates the file, and network
 * access stays disabled so a malicious `.gltf` cannot make us fetch a URI.
 */

import { promises as fs } from 'node:fs';
import { NodeIO, getBounds } from '@gltf-transform/core';
import type { Document, ILogger, Material, Primitive, Root, Texture } from '@gltf-transform/core';
import { AssetPipelineError } from '../util/errors.js';

/** Below this on either axis, a map is too coarse for a close-up game surface. */
const MIN_RECOMMENDED_TEXTURE_SIZE = 1024;

/** Offenders named in an aggregate warning before it switches to "+N more". */
const MAX_NAMED_OFFENDERS = 4;

export interface ImageSize {
  width: number;
  height: number;
}

export interface TextureResolution {
  name?: string;
  width: number;
  height: number;
  mimeType?: string;
  /** Encoded size on disk. Not VRAM cost — that depends on the decoded format. */
  bytes: number;
}

export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
  /** Extent per axis. glTF units are metres by specification. */
  sizeMeters: [number, number, number];
}

export interface PbrChannels {
  hasBaseColorTexture: boolean;
  hasMetallicRoughnessTexture: boolean;
  hasNormalTexture: boolean;
  hasOcclusionTexture: boolean;
  hasEmissiveTexture: boolean;
}

export interface AssetInspection {
  filePath: string;
  fileBytes: number;
  /** `asset.generator` — which tool produced this, when the file says so. */
  generator?: string;

  meshCount: number;
  primitiveCount: number;
  /**
   * Summed per primitive. A vertex buffer shared by two primitives is counted
   * once per primitive, because that is the unit a renderer draws.
   */
  vertexCount: number;
  triangleCount: number;

  materialCount: number;
  textureCount: number;
  /**
   * One entry per texture whose dimensions could be read. A texture with an
   * unreadable or absent image is reported in `warnings` instead of being
   * guessed at, so `textureResolutions.length` may be below `textureCount`.
   */
  textureResolutions: TextureResolution[];

  boundingBox: BoundingBox;

  /** True only when EVERY primitive carries the attribute. */
  hasUVs: boolean;
  hasNormals: boolean;
  hasTangents: boolean;

  pbr: PbrChannels;

  animationCount: number;
  hasSkin: boolean;

  /** Specific, actionable defects. Empty means nothing suspicious was found. */
  warnings: string[];
}

/**
 * glTF-Transform's default logger writes through `console.info`, which lands on
 * stdout — the channel the MCP transport owns, where a stray line corrupts the
 * protocol. Rather than silence the reader, its complaints are captured: an
 * "unsupported extension" or a malformed-accessor warning is exactly the kind
 * of thing this report exists to surface.
 */
class CollectingLogger implements ILogger {
  readonly messages: string[] = [];
  debug(): void {}
  info(): void {}
  warn(text: string): void {
    this.messages.push(text);
  }
  error(text: string): void {
    this.messages.push(text);
  }
}

export async function inspectGltf(filePath: string): Promise<AssetInspection> {
  const readerLog = new CollectingLogger();
  let fileBytes: number;
  let document: Document;

  try {
    fileBytes = (await fs.stat(filePath)).size;
    // Non-strict resources: a `.gltf` whose sidecar texture is missing is a
    // defect worth REPORTING, not a reason to abandon everything else we could
    // have said about the file. A missing buffer still throws, as it must —
    // without it there is no geometry to describe.
    const io = new NodeIO().setLogger(readerLog).setStrictResources(false);
    document = await io.read(filePath);
  } catch (err) {
    // A file requiring an unregistered extension (Draco, meshopt, KTX2) fails
    // here, and the underlying message names the extension — which is the
    // useful part, so it is preserved verbatim.
    throw new AssetPipelineError(
      'INSPECTION_FAILED',
      `could not read ${filePath} as glTF/GLB: ${describeCause(err)}`,
      { details: { filePath }, cause: err },
    );
  }

  const root = document.getRoot();
  const geometry = summarizeGeometry(root);
  const materials = root.listMaterials();
  const textures = summarizeTextures(root.listTextures());
  const bounds = computeBoundingBox(root);
  const pbr = summarizePbr(materials);

  const hasUVs = geometry.primitiveCount > 0 && geometry.missingUv === 0;
  const hasNormals = geometry.primitiveCount > 0 && geometry.missingNormal === 0;
  const hasTangents = geometry.primitiveCount > 0 && geometry.missingTangent === 0;

  const warnings: string[] = [];

  for (const message of readerLog.messages) {
    warnings.push(`glTF reader: ${message}`);
  }

  if (geometry.primitiveCount === 0) {
    warnings.push('no mesh primitives: the file contains no drawable geometry');
  } else {
    if (geometry.missingUv > 0) {
      warnings.push(
        `${geometry.missingUv} of ${geometry.primitiveCount} primitives have no TEXCOORD_0: ` +
          'the mesh cannot be textured or retextured until it is UV unwrapped',
      );
    }
    if (geometry.missingNormal > 0) {
      warnings.push(
        `${geometry.missingNormal} of ${geometry.primitiveCount} primitives have no NORMAL: ` +
          'renderers must fall back to flat face normals, losing all smooth shading',
      );
    }
    if (geometry.nonTriangleCount > 0) {
      warnings.push(
        `${geometry.nonTriangleCount} of ${geometry.primitiveCount} primitives use a point or ` +
          'line draw mode and contribute no triangles',
      );
    }
    if (geometry.triangleCount === 0) {
      warnings.push('zero triangles: nothing in this file renders as a solid surface');
    }
  }

  if (materials.length === 0) {
    warnings.push('no materials: every primitive renders with the engine default');
  } else if (!pbr.hasBaseColorTexture) {
    warnings.push(
      'no base colour texture on any material: the asset is untextured and will read as flat colour',
    );
  }

  if (pbr.hasNormalTexture && !hasTangents) {
    warnings.push(
      'normal map present but not every primitive has TANGENT: tangents must be generated at ' +
        'import (MikkTSpace) or the normal map will light incorrectly',
    );
  }

  if (textures.missingImage.length > 0) {
    warnings.push(
      namedWarning(
        textures.missingImage,
        'texture has no image data — an external file referenced by the glTF is missing',
      ),
    );
  }
  if (textures.unreadable.length > 0) {
    warnings.push(
      namedWarning(
        textures.unreadable,
        'texture dimensions could not be read (unrecognised image format)',
      ),
    );
  }
  if (textures.lowResolution.length > 0) {
    warnings.push(
      namedWarning(
        textures.lowResolution,
        `texture is below ${MIN_RECOMMENDED_TEXTURE_SIZE}px on an axis and will blur at close range`,
      ),
    );
  }
  if (textures.nonPowerOfTwo.length > 0) {
    warnings.push(
      namedWarning(
        textures.nonPowerOfTwo,
        'texture is not power-of-two, which blocks full mip chains and block compression in some pipelines',
      ),
    );
  }

  if (bounds.empty) {
    warnings.push(
      'empty or degenerate bounding box: no finite vertex positions were found, so the asset ' +
        'has no measurable size',
    );
  } else if (largestExtent(bounds.box) === 0) {
    warnings.push('degenerate bounding box: every axis has zero extent (all vertices coincide)');
  }
  if (bounds.localSpaceFallback) {
    warnings.push(
      'no scene references the meshes, so the bounding box is local-space and ignores node ' +
        'transforms: reported size may not match how the asset imports',
    );
  }

  const generator = root.getAsset().generator;

  return {
    filePath,
    fileBytes,
    ...(generator !== undefined ? { generator } : {}),
    meshCount: geometry.meshCount,
    primitiveCount: geometry.primitiveCount,
    vertexCount: geometry.vertexCount,
    triangleCount: geometry.triangleCount,
    materialCount: materials.length,
    textureCount: root.listTextures().length,
    textureResolutions: textures.resolutions,
    boundingBox: bounds.box,
    hasUVs,
    hasNormals,
    hasTangents,
    pbr,
    animationCount: root.listAnimations().length,
    hasSkin: root.listSkins().length > 0,
    warnings,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Geometry
 * ────────────────────────────────────────────────────────────────────────── */

/** WebGL draw modes, named so the triangle formula below reads as spec text. */
const MODE_TRIANGLES = 4;
const MODE_TRIANGLE_STRIP = 5;
const MODE_TRIANGLE_FAN = 6;

interface GeometrySummary {
  meshCount: number;
  primitiveCount: number;
  vertexCount: number;
  /** Triangles a renderer actually draws: the default scene, instances counted. */
  triangleCount: number;
  /**
   * Meshes present in the file but never drawn — orphans, and meshes that live
   * only in a NON-default scene.
   *
   * Split out rather than folded into `triangleCount`, because "how big is the
   * download" and "how much does the renderer draw" are different budgets and
   * conflating them made both wrong. Undrawn meshes used to be counted once
   * each, indistinguishably from drawn ones, so a three-LOD file reported 3x
   * the triangles a renderer submits.
   */
  undrawnMeshCount: number;
  undrawnTriangleCount: number;
  missingUv: number;
  missingNormal: number;
  missingTangent: number;
  nonTriangleCount: number;
}

/**
 * Triangles produced by one primitive.
 *
 *   TRIANGLES (4)       floor(n / 3)   every three vertices form one triangle
 *   TRIANGLE_STRIP (5)  max(n - 2, 0)  each vertex after the second closes one
 *   TRIANGLE_FAN (6)    max(n - 2, 0)  same, every triangle sharing vertex 0
 *   POINTS / LINES / …  0              no filled surface at all
 *
 * `n` is the INDEX count when the primitive is indexed and the POSITION count
 * when it is not. Using the vertex count for an indexed primitive would
 * undercount every mesh that shares vertices — typically by a factor of ~6 for
 * a closed surface — which is the difference between "fits the budget" and
 * "does not".
 */
function trianglesInPrimitive(primitive: Primitive): number {
  const indices = primitive.getIndices();
  const position = primitive.getAttribute('POSITION');
  const n = indices ? indices.getCount() : (position?.getCount() ?? 0);

  switch (primitive.getMode()) {
    case MODE_TRIANGLES:
      return Math.floor(n / 3);
    case MODE_TRIANGLE_STRIP:
    case MODE_TRIANGLE_FAN:
      return Math.max(n - 2, 0);
    default:
      return 0;
  }
}

function summarizeGeometry(root: Root): GeometrySummary {
  const meshes = root.listMeshes();
  const summary: GeometrySummary = {
    meshCount: meshes.length,
    primitiveCount: 0,
    vertexCount: 0,
    triangleCount: 0,
    missingUv: 0,
    missingNormal: 0,
    undrawnMeshCount: 0,
    undrawnTriangleCount: 0,
    missingTangent: 0,
    nonTriangleCount: 0,
  };

  // How many NODES reference each mesh. Iterating meshes alone counts an
  // instanced mesh once however many times it is drawn, so a 12-triangle mesh
  // placed at 50 nodes reported 12 — and validate_game_asset passed it against
  // a 100-triangle budget while a renderer draws 600. The doc comment calls
  // this "the unit a renderer draws", which was false under instancing.
  const instancesPerMesh = new Map<string, number>();
  // Only the DEFAULT scene. glTF `scenes` are alternatives and a renderer draws
  // one; summing over all of them double-counted a mesh referenced from two
  // scenes, so a 12-triangle asset reported 24 and failed a 20-triangle budget.
  // Blender's own count walks one scene, so the two disagreed systematically.
  const drawnScene = root.getDefaultScene() ?? root.listScenes()[0];
  for (const scene of drawnScene ? [drawnScene] : []) {
    const visit = (node: ReturnType<typeof scene.listChildren>[number]): void => {
      const mesh = node.getMesh();
      if (mesh) {
        const key = String(mesh.getName() ?? '') + ':' + String(meshes.indexOf(mesh));
        instancesPerMesh.set(key, (instancesPerMesh.get(key) ?? 0) + 1);
      }
      for (const child of node.listChildren()) visit(child);
    };
    for (const node of scene.listChildren()) visit(node);
  }

  for (const mesh of meshes) {
    const key = String(mesh.getName() ?? '') + ':' + String(meshes.indexOf(mesh));
    // Zero means "not in the drawn scene" — either an orphan or a mesh that
    // lives only in a non-default scene. Both used to be forced to 1 by a
    // Math.max, which made an undrawn LOD variant indistinguishable from drawn
    // geometry and inflated the budget a renderer is checked against.
    const instances = instancesPerMesh.get(key) ?? 0;
    const drawn = instances > 0;
    if (!drawn) summary.undrawnMeshCount += 1;
    for (const primitive of mesh.listPrimitives()) {
      summary.primitiveCount += 1;
      if (!drawn) {
        // Reported, not discarded: it is still bytes in the file, and silently
        // dropping it would understate as badly as counting it drawn.
        summary.undrawnTriangleCount += trianglesInPrimitive(primitive);
      }
      summary.vertexCount += (primitive.getAttribute('POSITION')?.getCount() ?? 0) * instances;
      summary.triangleCount += trianglesInPrimitive(primitive) * instances;

      const mode = primitive.getMode();
      if (mode !== MODE_TRIANGLES && mode !== MODE_TRIANGLE_STRIP && mode !== MODE_TRIANGLE_FAN) {
        summary.nonTriangleCount += 1;
      }
      if (!primitive.getAttribute('TEXCOORD_0')) summary.missingUv += 1;
      if (!primitive.getAttribute('NORMAL')) summary.missingNormal += 1;
      if (!primitive.getAttribute('TANGENT')) summary.missingTangent += 1;
    }
  }

  return summary;
}

function summarizePbr(materials: Material[]): PbrChannels {
  return {
    hasBaseColorTexture: materials.some((m) => m.getBaseColorTexture() !== null),
    hasMetallicRoughnessTexture: materials.some((m) => m.getMetallicRoughnessTexture() !== null),
    hasNormalTexture: materials.some((m) => m.getNormalTexture() !== null),
    hasOcclusionTexture: materials.some((m) => m.getOcclusionTexture() !== null),
    hasEmissiveTexture: materials.some((m) => m.getEmissiveTexture() !== null),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Bounds
 * ────────────────────────────────────────────────────────────────────────── */

function largestExtent(box: BoundingBox): number {
  return Math.max(box.sizeMeters[0], box.sizeMeters[1], box.sizeMeters[2]);
}

/**
 * World-space bounds of every scene, falling back to local-space accessor
 * bounds when no scene references the meshes (valid glTF: `scenes` is optional,
 * and some exporters emit a mesh library with no scene graph). The fallback is
 * reported to the caller rather than silently substituted, because a size that
 * ignores node transforms can be wrong by orders of magnitude.
 *
 * `getBounds` visits every vertex to produce a TIGHT box under rotation. That
 * is the expensive choice; it is taken deliberately, because the cheap one
 * (transforming the eight corners of a local box) overstates the size of any
 * rotated part, and an overstated size is exactly the mistake this report is
 * supposed to catch.
 */
function computeBoundingBox(root: Root): {
  box: BoundingBox;
  localSpaceFallback: boolean;
  empty: boolean;
} {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  const expand = (lo: readonly number[], hi: readonly number[]): void => {
    minX = Math.min(minX, lo[0] ?? Infinity);
    minY = Math.min(minY, lo[1] ?? Infinity);
    minZ = Math.min(minZ, lo[2] ?? Infinity);
    maxX = Math.max(maxX, hi[0] ?? -Infinity);
    maxY = Math.max(maxY, hi[1] ?? -Infinity);
    maxZ = Math.max(maxZ, hi[2] ?? -Infinity);
  };

  const finite = (): boolean =>
    Number.isFinite(minX) &&
    Number.isFinite(minY) &&
    Number.isFinite(minZ) &&
    Number.isFinite(maxX) &&
    Number.isFinite(maxY) &&
    Number.isFinite(maxZ);

  // The DRAWN scene only — the same one summarizeGeometry walks.
  //
  // This iterated every scene while the triangle counter iterated one, and the
  // two doc comments contradicted each other a hundred lines apart. glTF
  // `scenes` are alternatives: a renderer draws `scene`, and the others are
  // variants, LODs or authoring leftovers. Unioning them makes an undrawn
  // variant enlarge the reported size of the drawn model.
  //
  // This is not cosmetic. `boundingBox.sizeMeters` feeds the `min_dimension`
  // check, whose severity is `error`. Measured: a default scene containing a
  // completely FLAT plate (zero Y extent) correctly failed min_dimension and was
  // refused; adding one unrelated second scene that no renderer draws made the
  // union non-flat and the same flat plate was reported SHIPPABLE.
  const bounded = root.getDefaultScene() ?? root.listScenes()[0];
  if (bounded) {
    const sceneBounds = getBounds(bounded);
    expand(sceneBounds.min, sceneBounds.max);
  }

  let localSpaceFallback = false;
  if (!finite()) {
    for (const mesh of root.listMeshes()) {
      for (const primitive of mesh.listPrimitives()) {
        const position = primitive.getAttribute('POSITION');
        if (!position) continue;
        expand(position.getMin([0, 0, 0]), position.getMax([0, 0, 0]));
      }
    }
    localSpaceFallback = finite();
  }

  if (!finite()) {
    return {
      box: { min: [0, 0, 0], max: [0, 0, 0], sizeMeters: [0, 0, 0] },
      localSpaceFallback: false,
      empty: true,
    };
  }

  return {
    box: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      sizeMeters: [maxX - minX, maxY - minY, maxZ - minZ],
    },
    localSpaceFallback,
    empty: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Textures
 * ────────────────────────────────────────────────────────────────────────── */

interface TextureSummary {
  resolutions: TextureResolution[];
  missingImage: string[];
  unreadable: string[];
  lowResolution: string[];
  nonPowerOfTwo: string[];
}

function textureLabel(texture: Texture, index: number): string {
  return texture.getName() || texture.getURI() || `texture[${index}]`;
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

function summarizeTextures(textures: Texture[]): TextureSummary {
  const summary: TextureSummary = {
    resolutions: [],
    missingImage: [],
    unreadable: [],
    lowResolution: [],
    nonPowerOfTwo: [],
  };

  textures.forEach((texture, index) => {
    const label = textureLabel(texture, index);
    const image = texture.getImage();
    if (!image || image.byteLength === 0) {
      summary.missingImage.push(label);
      return;
    }

    const size = readImageSize(image);
    if (!size) {
      summary.unreadable.push(label);
      return;
    }

    const name = texture.getName();
    const mimeType = texture.getMimeType();
    summary.resolutions.push({
      ...(name ? { name } : {}),
      width: size.width,
      height: size.height,
      ...(mimeType ? { mimeType } : {}),
      bytes: image.byteLength,
    });

    if (size.width < MIN_RECOMMENDED_TEXTURE_SIZE || size.height < MIN_RECOMMENDED_TEXTURE_SIZE) {
      summary.lowResolution.push(`${label} (${size.width}x${size.height})`);
    }
    if (!isPowerOfTwo(size.width) || !isPowerOfTwo(size.height)) {
      summary.nonPowerOfTwo.push(`${label} (${size.width}x${size.height})`);
    }
  });

  return summary;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Image headers
 *
 * glTF-Transform hands back raw encoded image bytes, never dimensions, and its
 * own ImageUtils only registers PNG and JPEG. Reading the header ourselves is
 * the right layer for this: it is image parsing, not glTF parsing, it needs no
 * decoder dependency, and it touches only the first few dozen bytes.
 *
 * Every reader returns `undefined` rather than a guess. A wrong resolution
 * would flow straight into a "texture too small" verdict that is simply false.
 * ────────────────────────────────────────────────────────────────────────── */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Dimensions of a PNG, JPEG or WebP image, or `undefined` for anything else.
 * Pure: no I/O, no allocation beyond a DataView onto the caller's bytes.
 */
export function readImageSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.byteLength < 16) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (startsWith(view, PNG_SIGNATURE)) return readPngSize(view);
  if (view.getUint8(0) === 0xff && view.getUint8(1) === 0xd8) return readJpegSize(view);
  if (readAscii(view, 0, 4) === 'RIFF' && readAscii(view, 8, 4) === 'WEBP') return readWebPSize(view);
  return undefined;
}

/**
 * PNG: the 8-byte signature is followed by the IHDR chunk, whose length and
 * type occupy bytes 8..15, so width and height sit at fixed offsets 16 and 20
 * as big-endian uint32. IHDR is mandated to be the first chunk, so no scan is
 * needed — but it is verified, because a file that puts something else there
 * is not a PNG we should be reading dimensions from.
 */
function readPngSize(view: DataView): ImageSize | undefined {
  if (view.byteLength < 24) return undefined;
  if (readAscii(view, 12, 4) !== 'IHDR') return undefined;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * JPEG frame markers. The 0xC0..0xCF block is NOT uniformly a start-of-frame:
 * 0xC4 is a Huffman table, 0xC8 a reserved JPEG extension, and 0xCC an
 * arithmetic-coding table. Treating any of those as a frame header reads
 * table data as width and height and silently produces nonsense.
 */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * JPEG: walk the segment chain rather than searching for a byte pattern, since
 * an 0xFFC0 pair occurs constantly inside entropy-coded data. Each segment is
 * `0xFF <marker> <uint16 length including these two bytes> <payload>`, with
 * three exceptions that carry no payload at all (SOI, TEM, RSTn) and two that
 * end the walk (EOI, and SOS after which the stream is compressed data).
 *
 * A start-of-frame payload is `precision(1) height(2) width(2) components(1)`,
 * putting height at length+1 and width at length+3.
 */
function readJpegSize(view: DataView): ImageSize | undefined {
  let offset = 2; // past SOI

  while (offset + 1 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return undefined; // lost segment alignment

    // Any number of 0xFF fill bytes may pad the gap before a marker id.
    let marker = view.getUint8(offset + 1);
    while (marker === 0xff) {
      offset += 1;
      if (offset + 1 >= view.byteLength) return undefined;
      marker = view.getUint8(offset + 1);
    }
    offset += 2;

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return undefined; // EOI or scan data

    if (offset + 2 > view.byteLength) return undefined;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > view.byteLength) return undefined;

    if (isStartOfFrame(marker)) {
      if (length < 7) return undefined;
      const height = view.getUint16(offset + 3);
      const width = view.getUint16(offset + 5);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }

    offset += length;
  }

  return undefined;
}

/**
 * WebP: a RIFF container whose first chunk identifies the variant. All three
 * encode dimensions differently, and all three store them 1-based or masked to
 * 14 bits, so none of them can be read as a plain integer.
 *
 *   VP8   lossy     14-bit width/height after the 0x9D01 2A sync code
 *   VP8L  lossless  packed 14+14 bits, stored as (value - 1)
 *   VP8X  extended  24-bit canvas width/height, stored as (value - 1)
 */
function readWebPSize(view: DataView): ImageSize | undefined {
  if (view.byteLength < 20) return undefined;
  const chunk = readAscii(view, 12, 4);

  if (chunk === 'VP8 ') {
    if (view.byteLength < 30) return undefined;
    // Only a keyframe carries dimensions, and it is identified by the sync code.
    if (view.getUint8(23) !== 0x9d || view.getUint8(24) !== 0x01 || view.getUint8(25) !== 0x2a) {
      return undefined;
    }
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }

  if (chunk === 'VP8L') {
    if (view.byteLength < 25) return undefined;
    if (view.getUint8(20) !== 0x2f) return undefined; // VP8L signature byte
    const packed = view.getUint32(21, true);
    const width = (packed & 0x3fff) + 1;
    const height = ((packed >>> 14) & 0x3fff) + 1;
    return { width, height };
  }

  if (chunk === 'VP8X') {
    if (view.byteLength < 30) return undefined;
    return {
      width: readUint24LE(view, 24) + 1,
      height: readUint24LE(view, 27) + 1,
    };
  }

  return undefined;
}

function readUint24LE(view: DataView, offset: number): number {
  return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
}

function startsWith(view: DataView, signature: readonly number[]): boolean {
  if (view.byteLength < signature.length) return false;
  return signature.every((byte, index) => view.getUint8(index) === byte);
}

function readAscii(view: DataView, offset: number, length: number): string {
  if (offset + length > view.byteLength) return '';
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reporting helpers
 * ────────────────────────────────────────────────────────────────────────── */

/** One warning per defect class, naming a few offenders instead of all of them. */
function namedWarning(names: readonly string[], message: string): string {
  const shown = names.slice(0, MAX_NAMED_OFFENDERS).join(', ');
  const remaining = names.length - Math.min(names.length, MAX_NAMED_OFFENDERS);
  return `${message}: ${shown}${remaining > 0 ? ` (+${remaining} more)` : ''}`;
}

function describeCause(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
