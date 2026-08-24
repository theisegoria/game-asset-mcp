/**
 * Splitting a glTF material into independent PBR planes.
 *
 * glTF packs metallic and roughness into one texture (G = roughness,
 * B = metallic) because that is efficient for a renderer to sample. It is the
 * wrong shape for almost every *authoring* pipeline, which wants albedo,
 * normal and roughness as separate images it can inspect, edit, compress and
 * budget individually.
 *
 * This tool performs that split, resamples to an exact target resolution, and
 * emits a receipt naming which source texture and which channel produced each
 * plane — so a plane can never be silently mistaken for another.
 */

import path from 'node:path';
import { z } from 'zod';
import { NodeIO } from '@gltf-transform/core';
import type { Material } from '@gltf-transform/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  constantColorImage, constantImage,
  decodeImage,
  encodePNG,
  extractChannel,
  resizeImage,
  type ChannelName,
  type RasterImage,
} from '../inspection/image.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { MESH_EXTENSIONS } from '../util/local-file.js';
import { assertExistingDirectory, safeJoin, uniqueFilePath, writeFileAtomic, writeJsonAtomic } from '../storage/filesystem.js';
import { promises as fs } from 'node:fs';
import { guard, ok, type ToolContext } from './context.js';

/** What a plane is, where it came from, and whether it is real or a stand-in. */
interface PlaneReceipt {
  plane: 'albedo' | 'normal' | 'roughness' | 'metallic' | 'occlusion';
  path: string;
  width: number;
  height: number;
  sha256: string;
  /** `texture` when lifted from image data, `factor` when the material only declared a scalar. */
  source: 'texture' | 'factor';
  sourceChannel?: ChannelName;
  sourceTexture?: string;
  /** True when the source was smaller than the requested size, i.e. upscaled. */
  upsampled: boolean;
  colorSpace: 'srgb' | 'linear';
}

function imageFromTexture(texture: { getImage(): Uint8Array | null } | null): RasterImage | undefined {
  const bytes = texture?.getImage();
  if (!bytes) return undefined;
  return decodeImage(new Uint8Array(bytes));
}

export function registerPbrTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'extract_pbr_trio',
    {
      title: 'Split a material into separate PBR texture planes',
      description:
        'FREE and fully local: no network call, no credits. Splits a glTF material into ' +
        'independent albedo, normal and roughness images (plus metallic and occlusion when ' +
        'present), de-packing the glTF metallicRoughness texture — roughness is its GREEN ' +
        'channel, metallic its BLUE. Resamples to an exact resolution, averaging colour in ' +
        'linear light and data channels directly, and writes a receipt naming the source ' +
        'texture and channel behind every plane. Use after download_asset, or on any local ' +
        'glTF/GLB. Planes a material declares only as a scalar factor are emitted as flat ' +
        'images and marked source="factor" so a constant is never mistaken for measured data.',
      inputSchema: {
        assetJobId: z.string().optional().describe('A job that has already been downloaded.'),
        modelPath: z.string().optional().describe('Absolute path to a local .glb or .gltf.'),
        resolution: z
          .number()
          .int()
          .min(16)
          .max(8192)
          .optional()
          .describe('Square output size. Defaults to the largest source texture dimension.'),
        materialIndex: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Which material to split when the file has several.'),
        destination: z.string().optional().describe('Output directory. Defaults to the workspace.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(ctx.logger, 'extract_pbr_trio', async (args) => {
      if (Boolean(args.assetJobId) === Boolean(args.modelPath)) {
        throw invalidInput('provide exactly one of assetJobId or modelPath');
      }

      let source: string;
      let outputRoot: string;
      if (args.modelPath) {
        const ext = path.extname(args.modelPath).toLowerCase();
        if (!MESH_EXTENSIONS.has(ext) || (ext !== '.glb' && ext !== '.gltf')) {
          throw invalidInput(`extract_pbr_trio needs a .glb or .gltf; received "${ext}"`);
        }
        source = path.resolve(args.modelPath);
        outputRoot = args.destination
          ? path.resolve(args.destination)
          : path.join(path.dirname(source), 'textures');
      } else {
        const job = await ctx.store.get(args.assetJobId as string);
        const model = job.files.find(
          (file) => file.kind === 'model' && /\.(glb|gltf)$/i.test(file.path),
        );
        if (!model) {
          throw invalidState(`job ${job.id} has no downloaded glTF — call download_asset first`, {
            status: job.status,
          });
        }
        source = model.path;
        outputRoot = args.destination
          ? path.resolve(args.destination)
          : job.workspacePath
            ? safeJoin(job.workspacePath, 'textures')
            : path.join(path.dirname(source), 'textures');
      }

      const document = await new NodeIO().read(source);
      const materials = document.getRoot().listMaterials();
      if (materials.length === 0) {
        throw invalidState(`${path.basename(source)} declares no materials to split`);
      }
      const material: Material | undefined = materials[args.materialIndex];
      if (!material) {
        throw invalidInput(
          `materialIndex ${args.materialIndex} is out of range; the file has ${materials.length}`,
          { available: materials.length },
        );
      }

      const baseColor = imageFromTexture(material.getBaseColorTexture());
      const normal = imageFromTexture(material.getNormalTexture());
      const metallicRoughness = imageFromTexture(material.getMetallicRoughnessTexture());
      const occlusion = imageFromTexture(material.getOcclusionTexture());

      // Default to the largest source dimension so the operator does not
      // silently lose detail by accepting an arbitrary default.
      const sourceMax = Math.max(
        baseColor?.width ?? 0, baseColor?.height ?? 0,
        normal?.width ?? 0, normal?.height ?? 0,
        metallicRoughness?.width ?? 0, metallicRoughness?.height ?? 0,
        occlusion?.width ?? 0, occlusion?.height ?? 0,
      );
      const size = args.resolution ?? (sourceMax > 0 ? sourceMax : 1024);

      // A caller-named destination must already exist; only the configured
      // workspace is created on demand.
      if (args.destination) await assertExistingDirectory(outputRoot, 'destination');
      await fs.mkdir(outputRoot, { recursive: true });
      const stem = path.basename(source, path.extname(source));
      const planes: PlaneReceipt[] = [];

      async function emit(
        plane: PlaneReceipt['plane'],
        image: RasterImage,
        options: {
          srgb: boolean;
          source: PlaneReceipt['source'];
          channel?: ChannelName;
          sourceTexture?: string;
        },
      ): Promise<void> {
        const upsampled = image.width < size || image.height < size;
        const resized = resizeImage(image, size, size, { srgb: options.srgb });
        const encoded = encodePNG(resized);
        const target = await uniqueFilePath(outputRoot, `${stem}_${plane}.png`);
        const sha256 = await writeFileAtomic(target, encoded);
        planes.push({
          plane,
          path: target,
          width: size,
          height: size,
          sha256,
          source: options.source,
          ...(options.channel ? { sourceChannel: options.channel } : {}),
          ...(options.sourceTexture ? { sourceTexture: options.sourceTexture } : {}),
          upsampled,
          colorSpace: options.srgb ? 'srgb' : 'linear',
        });
      }

      // Albedo — the only sRGB plane here; everything else is data.
      if (baseColor) {
        await emit('albedo', baseColor, {
          srgb: true,
          source: 'texture',
          sourceTexture: material.getBaseColorTexture()?.getName() || 'baseColorTexture',
        });
      } else {
        const factor = material.getBaseColorFactor();
        // All THREE channels, and sRGB-encoded. This used factor[0] for every
        // channel, so a cyan [0, 0.6, 1] baseColorFactor came out BLACK, and it
        // wrote the linear value raw while tagging the plane sRGB.
        await emit(
          'albedo',
          constantColorImage(size, size, [factor[0] ?? 1, factor[1] ?? 1, factor[2] ?? 1]),
          { srgb: true, source: 'factor' },
        );
      }

      if (normal) {
        await emit('normal', normal, {
          srgb: false,
          source: 'texture',
          sourceTexture: material.getNormalTexture()?.getName() || 'normalTexture',
        });
      }

      // The de-pack: G is roughness, B is metallic. Reading the wrong channel
      // yields a surface that is confidently and silently wrong.
      if (metallicRoughness) {
        const textureName =
          material.getMetallicRoughnessTexture()?.getName() || 'metallicRoughnessTexture';
        await emit('roughness', extractChannel(metallicRoughness, 'g'), {
          srgb: false,
          source: 'texture',
          channel: 'g',
          sourceTexture: textureName,
        });
        await emit('metallic', extractChannel(metallicRoughness, 'b'), {
          srgb: false,
          source: 'texture',
          channel: 'b',
          sourceTexture: textureName,
        });
      } else {
        await emit(
          'roughness',
          constantImage(size, size, Math.round(material.getRoughnessFactor() * 255)),
          { srgb: false, source: 'factor' },
        );
        await emit(
          'metallic',
          constantImage(size, size, Math.round(material.getMetallicFactor() * 255)),
          { srgb: false, source: 'factor' },
        );
      }

      if (occlusion) {
        await emit('occlusion', extractChannel(occlusion, 'r'), {
          srgb: false,
          source: 'texture',
          channel: 'r',
          sourceTexture: material.getOcclusionTexture()?.getName() || 'occlusionTexture',
        });
      }

      const trio = ['albedo', 'normal', 'roughness'] as const;
      const measured = trio.filter(
        (name) => planes.find((plane) => plane.plane === name)?.source === 'texture',
      );
      const receipt = {
        schema: 'org.gamedebug.pbr_trio.v1',
        sourceModel: source,
        materialIndex: args.materialIndex,
        materialName: material.getName() || `material-${args.materialIndex}`,
        resolution: size,
        planes,
        /** True only when albedo, normal AND roughness all came from real texture data. */
        trioComplete: measured.length === trio.length,
        measuredPlanes: measured,
      };
      const receiptPath = await uniqueFilePath(outputRoot, `${stem}_pbr_trio.json`);
      await writeJsonAtomic(receiptPath, receipt);

      if (!(receipt.trioComplete as boolean)) {
        ctx.logger.warn('PBR trio is incomplete', {
          sourceModel: path.basename(source),
          measured,
        });
      }

      return ok({
        ...receipt,
        receiptPath,
        nextStep: receipt.trioComplete
          ? 'All three planes came from real texture data.'
          : `Only ${measured.join(', ') || 'no'} plane(s) came from texture data; the rest are flat ` +
            'constants derived from material factors and are NOT measured detail.',
      });
    }),
  );
}
