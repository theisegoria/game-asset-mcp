/**
 * A picture of the asset's UV layout and textures, so the caller can look.
 *
 * inspect_asset reports that a mesh HAS UVs. It cannot report that they are
 * mirrored, that one island is stretched across the seam, that the whole
 * layout sits outside the unit square, or that the "albedo" is a 2048x2048
 * plane of one flat colour. Those are visible at a glance and invisible in a
 * table of counts -- and they are the defects a generated asset most often
 * ships with.
 *
 * Pure JS. No Blender, no renderer, no GPU: the UV plot is a rasterised
 * diagram of the accessor data, and the texture thumbnails are the embedded
 * images resampled with the right colorimetry. That makes it cheap enough to
 * run on every asset, and honest about what it is -- a diagram of the data,
 * not a render of the model.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { Document, NodeIO, type Material, type Node, type Primitive, type Texture } from '@gltf-transform/core';
import type { ToolRegistrar } from '../commands/registry.js';
import { decodeImage, encodePNG, resizeImage, type RasterImage } from '../inspection/image.js';
import { safeJoin, sanitizeFileName, writeFileAtomic } from '../storage/filesystem.js';
import { invalidInput } from '../util/errors.js';
import { guard, ok, type ToolContext, type VisualAttachment } from './context.js';

type TextureSlot = 'baseColor' | 'normal' | 'metallicRoughness' | 'occlusion' | 'emissive';

/** Which slots hold colour and which hold data. Resampling a normal map in gamma space bends it. */
const SLOT_COLORIMETRY: Record<TextureSlot, VisualAttachment['colorimetry']> = {
  baseColor: 'srgb',
  emissive: 'srgb',
  normal: 'data',
  metallicRoughness: 'data',
  occlusion: 'data',
};

interface MaterialSheet {
  materialIndex: number;
  materialName: string;
  uvPlotPath: string;
  uvTriangles: number;
  /** Triangles with any vertex outside [0,1]: tiling by intent, or a broken unwrap. */
  uvTrianglesOutsideUnitSquare: number;
  textures: Array<{
    slot: TextureSlot;
    path: string;
    sourceWidth: number;
    sourceHeight: number;
    colorimetry: VisualAttachment['colorimetry'];
  }>;
}

function plot(image: RasterImage, x: number, y: number, rgb: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const offset = (y * image.width + x) * 4;
  image.data[offset] = rgb[0];
  image.data[offset + 1] = rgb[1];
  image.data[offset + 2] = rgb[2];
  image.data[offset + 3] = 255;
}

/** Bresenham, clipped by plot(). Coordinates may fall outside the canvas. */
function line(image: RasterImage, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]): void {
  let ax = Math.round(x0);
  let ay = Math.round(y0);
  const bx = Math.round(x1);
  const by = Math.round(y1);
  const dx = Math.abs(bx - ax);
  const dy = -Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1;
  const sy = ay < by ? 1 : -1;
  let error = dx + dy;
  // Bounded so a degenerate accessor cannot spin forever.
  for (let steps = 0; steps < 1_000_000; steps += 1) {
    plot(image, ax, ay, rgb);
    if (ax === bx && ay === by) break;
    const doubled = 2 * error;
    if (doubled >= dy) { error += dy; ax += sx; }
    if (doubled <= dx) { error += dx; ay += sy; }
  }
}

/**
 * The plot covers UV space from PLOT_LOW to PLOT_HIGH, not just [0,1].
 *
 * The first version drew only the unit square, and a triangle that had
 * wandered entirely outside it was clipped away -- the count said "one
 * triangle outside" and the picture showed nothing, which is precisely the
 * disagreement the picture exists to prevent. Framing wider shows WHERE the
 * geometry went, with the unit square outlined for reference.
 */
const PLOT_LOW = -0.5;
const PLOT_HIGH = 1.5;

function toCanvas(value: number, size: number): number {
  return ((value - PLOT_LOW) / (PLOT_HIGH - PLOT_LOW)) * (size - 1);
}

function blank(size: number): RasterImage {
  // Checker INSIDE the unit square only, plain outside: the square reads at a
  // glance, and islands that mirror or straddle its edge read against it.
  const data = new Uint8Array(size * size * 4);
  const cell = Math.max(1, Math.floor(size / 32));
  const low = Math.round(toCanvas(0, size));
  const high = Math.round(toCanvas(1, size));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const inside = x >= low && x <= high && y >= low && y <= high;
      let value = 246;
      if (inside) {
        const dark = ((Math.floor(x / cell) + Math.floor(y / cell)) % 2) === 0;
        value = dark ? 214 : 236;
      }
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const outline: [number, number, number] = [70, 110, 200];
  line({ width: size, height: size, data }, low, low, high, low, outline);
  line({ width: size, height: size, data }, high, low, high, high, outline);
  line({ width: size, height: size, data }, high, high, low, high, outline);
  line({ width: size, height: size, data }, low, high, low, low, outline);
  return { width: size, height: size, data };
}

/** Primitives reachable from the default scene, in the order a renderer would meet them. */
function drawnPrimitives(document: Document): Array<{ primitive: Primitive; material: Material | null }> {
  const root = document.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const found: Array<{ primitive: Primitive; material: Material | null }> = [];
  if (!scene) return found;
  const visit = (node: Node): void => {
    const mesh = node.getMesh();
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        found.push({ primitive, material: primitive.getMaterial() });
      }
    }
    for (const child of node.listChildren()) visit(child);
  };
  for (const node of scene.listChildren()) visit(node);
  return found;
}

function drawUvs(canvas: RasterImage, primitive: Primitive): { triangles: number; outside: number } {
  const uv = primitive.getAttribute('TEXCOORD_0');
  const indices = primitive.getIndices();
  if (!uv) return { triangles: 0, outside: 0 };
  const count = uv.getCount();
  const index = (i: number): number => (indices ? indices.getScalar(i) : i);
  const total = indices ? indices.getCount() : count;
  const size = canvas.width;
  const corner: number[] = [0, 0];
  let triangles = 0;
  let outside = 0;
  for (let i = 0; i + 2 < total; i += 3) {
    const points: Array<[number, number]> = [];
    let anyOutside = false;
    for (let k = 0; k < 3; k += 1) {
      uv.getElement(index(i + k), corner);
      const u = corner[0] ?? 0;
      const v = corner[1] ?? 0;
      if (u < 0 || u > 1 || v < 0 || v > 1) anyOutside = true;
      // glTF UV origin is the top-left of the image, so v maps straight down.
      points.push([toCanvas(u, size), toCanvas(v, size)]);
    }
    triangles += 1;
    if (anyOutside) outside += 1;
    // Out-of-range triangles in red: tiling by intent, or an unwrap that
    // wandered off. Either way the caller should see it, not infer it.
    const colour: [number, number, number] = anyOutside ? [200, 40, 40] : [30, 30, 30];
    for (let k = 0; k < 3; k += 1) {
      const a = points[k] as [number, number];
      const b = points[(k + 1) % 3] as [number, number];
      line(canvas, a[0], a[1], b[0], b[1], colour);
    }
  }
  return { triangles, outside };
}

function slotsOf(material: Material): Array<{ slot: TextureSlot; texture: Texture | null }> {
  return [
    { slot: 'baseColor', texture: material.getBaseColorTexture() },
    { slot: 'normal', texture: material.getNormalTexture() },
    { slot: 'metallicRoughness', texture: material.getMetallicRoughnessTexture() },
    { slot: 'occlusion', texture: material.getOcclusionTexture() },
    { slot: 'emissive', texture: material.getEmissiveTexture() },
  ];
}

export function registerContactSheetTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    'render_asset_contact_sheet',
    {
      title: 'Draw the UV layout and textures of a 3D asset so you can look at them',
      description:
        'FREE and fully local: no network, no credits, no Blender. For each material the default ' +
        'scene draws, rasterises the UV layout over a checker (out-of-range triangles in red) and ' +
        'resamples every bound texture with the right colorimetry, returning them as images. Use ' +
        'it to SEE mirrored or stretched islands, a layout outside the unit square, or a texture ' +
        'that is one flat colour -- none of which a count can show. It is a diagram of the data, ' +
        'not a render of the model, and no human has looked at it.',
      inputSchema: {
        modelPath: z.string().min(1).describe('Path to a .glb or .gltf file.'),
        size: z.number().int().min(128).max(2048).default(512)
          .describe('Pixel size of the UV plot and the longest side of each texture thumbnail.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'render_asset_contact_sheet', async (args) => {
      const modelPath = path.resolve(args.modelPath);
      const extension = path.extname(modelPath).toLowerCase();
      if (extension !== '.glb' && extension !== '.gltf') {
        throw invalidInput('contact sheets are drawn from .glb or .gltf files; convert or normalize first', {
          modelPath,
        });
      }
      await fs.access(modelPath);

      const document = await new NodeIO().read(modelPath);
      const stem = sanitizeFileName(path.basename(modelPath, extension), 'asset');
      const outputRoot = safeJoin(ctx.config.outputDir, '.contact-sheets', stem);
      await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });

      // Group drawn primitives by material, so one UV plot per material shows
      // every island that shares a texture space.
      const byMaterial = new Map<Material | null, Primitive[]>();
      for (const { primitive, material } of drawnPrimitives(document)) {
        const list = byMaterial.get(material) ?? [];
        list.push(primitive);
        byMaterial.set(material, list);
      }

      const materials = document.getRoot().listMaterials();
      const sheets: MaterialSheet[] = [];
      const visuals: VisualAttachment[] = [];
      let materialOrdinal = 0;

      for (const [material, primitives] of byMaterial) {
        const materialIndex = material ? materials.indexOf(material) : -1;
        const materialName = material?.getName() || (material ? `material-${materialIndex}` : 'no-material');
        const fileStem = sanitizeFileName(`${materialOrdinal}-${materialName}`, `material-${materialOrdinal}`);
        materialOrdinal += 1;

        const canvas = blank(args.size);
        let triangles = 0;
        let outside = 0;
        for (const primitive of primitives) {
          const drawn = drawUvs(canvas, primitive);
          triangles += drawn.triangles;
          outside += drawn.outside;
        }
        const uvPlotPath = path.join(outputRoot, `${fileStem}_uv.png`);
        await writeFileAtomic(uvPlotPath, encodePNG(canvas));
        visuals.push({
          path: uvPlotPath,
          mimeType: 'image/png',
          role: 'render_preview',
          label: `${materialName}: UV layout over [-0.5, 1.5] with the unit square outlined, ` +
            `${triangles} triangles` +
            (outside > 0 ? `, ${outside} outside the unit square (red)` : ''),
          // A diagram, not data: the checker and lines are for eyes.
          colorimetry: 'srgb',
          width: args.size,
          height: args.size,
        });

        const textures: MaterialSheet['textures'] = [];
        if (material) {
          for (const { slot, texture } of slotsOf(material)) {
            const bytes = texture?.getImage();
            if (!bytes) continue;
            let decoded: RasterImage;
            try {
              decoded = decodeImage(new Uint8Array(bytes));
            } catch {
              // An undecodable embedded image is reported by inspect_asset; a
              // contact sheet should still show everything else.
              continue;
            }
            const scale = Math.min(1, args.size / Math.max(decoded.width, decoded.height));
            const width = Math.max(1, Math.round(decoded.width * scale));
            const height = Math.max(1, Math.round(decoded.height * scale));
            const colorimetry = SLOT_COLORIMETRY[slot];
            const thumb = scale < 1
              ? resizeImage(decoded, width, height, { srgb: colorimetry === 'srgb' })
              : decoded;
            const texturePath = path.join(outputRoot, `${fileStem}_${slot}.png`);
            await writeFileAtomic(texturePath, encodePNG(thumb));
            textures.push({ slot, path: texturePath, sourceWidth: decoded.width, sourceHeight: decoded.height, colorimetry });
            visuals.push({
              path: texturePath,
              mimeType: 'image/png',
              role: 'texture_plane',
              label: `${materialName}: ${slot} (${decoded.width}x${decoded.height} source)`,
              colorimetry,
              width: thumb.width,
              height: thumb.height,
            });
          }
        }

        sheets.push({
          materialIndex,
          materialName,
          uvPlotPath,
          uvTriangles: triangles,
          uvTrianglesOutsideUnitSquare: outside,
          textures,
        });
      }

      return ok({
        schema: 'game_dev.contact_sheet.v1',
        modelPath,
        outputRoot,
        size: args.size,
        materials: sheets,
        evidence: {
          uvLayoutRasterizedFromAccessors: true,
          texturesResampledWithDeclaredColorimetry: true,
          renderedByTargetEngine: false,
          renderMatchesTargetEngine: false,
          humanVisualReviewPerformed: false,
        },
        evidenceCeiling:
          'A contact sheet is a diagram of accessor and texture data, not a render of the model. ' +
          'It shows the UV layout and the bound textures as stored; it proves nothing about how ' +
          'any engine shades them, and no human has looked at it.',
      }, visuals);
    }),
  );
}
