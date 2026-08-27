/**
 * Retexturing meshes that already exist.
 *
 * This is the tool most image-to-3D pipelines omit, and the one most projects
 * actually need. Studios and hobbyists alike accumulate geometry — bought,
 * commissioned, or previously generated — whose materials are missing, wrong,
 * or placeholder. Regenerating the mesh to fix a material throws away the very
 * thing that was already correct, along with any UVs, scale and naming that
 * downstream tooling depends on.
 *
 * So this keeps the geometry and replaces only the surface.
 */

import { z } from 'zod';
import type { ToolRegistrar } from '../commands/registry.js';
import { createAssetJob, summarizeAssetJob } from '../domain/asset-job.js';
import type { AssetJob } from '../domain/asset-job.js';
import { gameAssetSpecSchema, sanitizeAssetName } from '../domain/asset-spec.js';
import type { GameAssetSpec } from '../domain/asset-spec.js';
import { buildTexturePrompt } from '../prompts/reconstruction-prompt.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { IMAGE_EXTENSIONS, MESH_EXTENSIONS, readLocalFile } from '../util/local-file.js';
import { TRIPO_DEFAULT_MODEL_VERSION } from '../providers/model3d/tripo.js';
import { guard, ok, type ToolContext } from './context.js';

export function registerTextureTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    'texture_existing_asset',
    {
      title: 'Generate PBR textures for a mesh you already have',
      description:
        'SPENDS 3D CREDITS. Applies newly generated PBR materials to an EXISTING mesh, keeping its ' +
        'geometry untouched. Use this when you already own a model and only the materials are missing ' +
        'or wrong — it is cheaper than regenerating and preserves the mesh exactly. ' +
        'Provide the mesh as either modelPath (local .glb/.gltf/.fbx/.obj/.stl) or originalAssetJobId ' +
        '(a previous job from this server whose 3D task produced a model). ' +
        'Direct the material with EITHER prompt OR styleImagePath, not both. ' +
        'ASYNCHRONOUS: poll get_asset_job until "ready", then download_asset. ' +
        'NOTE: providers may only support retexturing meshes that originated from their own prior ' +
        'task; if a provider rejects an uploaded mesh, use originalAssetJobId instead.',
      inputSchema: {
        modelPath: z.string().optional().describe('Absolute path to a local mesh file.'),
        originalAssetJobId: z
          .string()
          .optional()
          .describe('A previous asset job from this server whose 3D task produced a model.'),
        prompt: z.string().max(2000).optional().describe('Text direction for the material.'),
        styleImagePath: z
          .string()
          .optional()
          .describe('Local image whose look should be transferred onto the mesh.'),
        spec: gameAssetSpecSchema
          .optional()
          .describe('Required with modelPath, so the result has a name and provenance.'),
        modelVersion: z.string().optional(),
        pbr: z.boolean().default(true),
        textureQuality: z
          .enum(['standard', 'detailed'])
          .default('detailed')
          .describe('"detailed" is the HD tier and costs more credits.'),
        textureAlignment: z
          .enum(['original_image', 'geometry'])
          .optional()
          .describe('"geometry" aligns to the mesh shape; "original_image" to the reference image.'),
        textureSeed: z.number().int().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(ctx.logger, 'texture_existing_asset', async (args) => {
      if (Boolean(args.modelPath) === Boolean(args.originalAssetJobId)) {
        throw invalidInput('provide exactly one of modelPath or originalAssetJobId');
      }
      if (args.prompt && args.styleImagePath) {
        throw invalidInput('provide prompt OR styleImagePath, not both — providers accept one direction');
      }

      const provider = ctx.model3dProvider();
      // Before ANY provider contact, including the mesh upload. reserve() can
      // only run once the job exists, which is after that upload — so a caller
      // at their ceiling used to ship the whole mesh and be refused afterwards.
      ctx.assertHeadroom('texture_existing_asset');
      let job: AssetJob;
      let modelToken: string | undefined;
      let originalModelTaskId: string | undefined;

      if (args.originalAssetJobId) {
        const source = await ctx.store.get(args.originalAssetJobId);
        if (!source.model3d?.providerTaskId) {
          throw invalidState(
            `job ${source.id} has no provider 3D task to retexture`,
            { status: source.status },
          );
        }
        originalModelTaskId = source.model3d.providerTaskId;
        job = createAssetJob({
          spec: (args.spec as GameAssetSpec | undefined) ?? source.spec,
          slug: sanitizeAssetName(((args.spec as GameAssetSpec | undefined) ?? source.spec).name),
          parentJobId: source.id,
        });
      } else {
        const spec = args.spec as GameAssetSpec | undefined;
        if (!spec) throw invalidInput('spec is required when supplying modelPath');
        const mesh = await readLocalFile(args.modelPath as string, ctx.config.maxDownloadBytes, MESH_EXTENSIONS);
        modelToken = await provider.uploadModel(mesh.bytes, mesh.fileName);
        job = createAssetJob({ spec, slug: sanitizeAssetName(spec.name) });
      }

      let styleImageToken: string | undefined;
      if (args.styleImagePath) {
        const style = await readLocalFile(args.styleImagePath, ctx.config.maxDownloadBytes, IMAGE_EXTENSIONS);
        styleImageToken = await provider.uploadImage(style.bytes, style.fileName);
      }

      // Fall back to a prompt derived from the spec so the provider always has
      // some material direction; an untargeted retexture wastes the credits.
      const prompt = args.prompt ?? (styleImageToken ? undefined : buildTexturePrompt(job.spec));

      job.model3d = {
        provider: provider.name,
        modelVersion: args.modelVersion ?? TRIPO_DEFAULT_MODEL_VERSION,
        taskType: 'texture_model',
        parameters: {
          pbr: args.pbr,
          texture_quality: args.textureQuality,
          ...(args.textureAlignment ? { texture_alignment: args.textureAlignment } : {}),
          ...(args.textureSeed !== undefined ? { texture_seed: args.textureSeed } : {}),
          ...(prompt ? { prompt } : {}),
          source: originalModelTaskId ? 'original_model_task_id' : 'uploaded_mesh',
        },
        requestedAt: new Date().toISOString(),
      };
      job.status = 'generating_3d';
      await ctx.store.save(job);

      await ctx.charge('texture_existing_asset', { assetJobId: job.id });

      const handle = await provider.textureExisting({
        ...(originalModelTaskId !== undefined ? { originalModelTaskId } : {}),
        ...(modelToken !== undefined ? { modelToken } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(styleImageToken !== undefined ? { styleImageToken } : {}),
        ...(args.modelVersion !== undefined ? { modelVersion: args.modelVersion } : {}),
        pbr: args.pbr,
        textureQuality: args.textureQuality,
        ...(args.textureAlignment !== undefined ? { textureAlignment: args.textureAlignment } : {}),
        ...(args.textureSeed !== undefined ? { textureSeed: args.textureSeed } : {}),
      });

      job.model3d.providerTaskId = handle.providerTaskId;
      job.updatedAt = new Date().toISOString();
      await ctx.store.save(job);

      return ok({
        ...summarizeAssetJob(job),
        nextStep: 'Poll get_asset_job until status is "ready", then download_asset and inspect_asset.',
      });
    }),
  );
}
