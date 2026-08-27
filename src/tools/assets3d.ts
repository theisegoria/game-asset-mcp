/**
 * 3D reconstruction tools.
 *
 * Every entry point here spends credits, so the job record is written before
 * the provider call and the provider task id is written immediately after.
 * That ordering is what makes a spend traceable if the process dies mid-call:
 * an orphaned job is recoverable evidence, an orphaned charge is not.
 */

import { z } from 'zod';
import type { ToolRegistrar } from '../commands/registry.js';
import { createAssetJob, summarizeAssetJob } from '../domain/asset-job.js';
import type { AssetJob } from '../domain/asset-job.js';
import { gameAssetSpecSchema, sanitizeAssetName } from '../domain/asset-spec.js';
import type { GameAssetSpec } from '../domain/asset-spec.js';
import { buildReconstructionPrompt } from '../prompts/reconstruction-prompt.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { assertHttps } from '../util/http.js';
import { IMAGE_EXTENSIONS, readLocalFile } from '../util/local-file.js';
import { TRIPO_DEFAULT_MODEL_VERSION } from '../providers/model3d/tripo.js';
import { guard, ok, type ToolContext } from './context.js';

const generationOptions = {
  modelVersion: z.string().optional().describe(`Provider model version. Defaults to ${TRIPO_DEFAULT_MODEL_VERSION}.`),
  pbr: z.boolean().default(true).describe('Generate PBR material channels.'),
  textureQuality: z
    .enum(['standard', 'detailed'])
    .default('detailed')
    .describe('"detailed" is the HD tier and costs more credits.'),
  faceLimit: z.number().int().positive().max(2_000_000).optional().describe('Cap the output triangle count.'),
  quad: z.boolean().optional().describe('Request quad topology. Costs extra credits, but is far kinder to downstream editing.'),
  seed: z.number().int().optional(),
};

export function registerAsset3DTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    'create_3d_asset',
    {
      title: 'Reconstruct a 3D asset',
      description:
        'SPENDS 3D CREDITS. Creates a textured 3D model. ASYNCHRONOUS — returns immediately with a ' +
        'job id; poll get_asset_job until status is "ready", then call download_asset. ' +
        'Provide exactly ONE source: assetJobId (uses that job\'s selected reference image), ' +
        'imagePath (a local png/jpg/webp), imageUrl (https), or textPrompt (skips images entirely). ' +
        'Model URLs from the provider EXPIRE, so download promptly once ready.',
      inputSchema: {
        assetJobId: z.string().optional().describe('An existing job with a selected reference image.'),
        imagePath: z.string().optional().describe('Absolute path to a local reference image.'),
        imageUrl: z.string().optional().describe('https URL of a reference image.'),
        textPrompt: z.string().max(2000).optional().describe('Generate directly from text, no reference image.'),
        spec: gameAssetSpecSchema.optional().describe('Required when NOT using assetJobId, so the result has a name and provenance.'),
        ...generationOptions,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(ctx.logger, 'create_3d_asset', async (args) => {
      const sources = [args.assetJobId, args.imagePath, args.imageUrl, args.textPrompt].filter(Boolean);
      if (sources.length !== 1) {
        throw invalidInput(
          'provide exactly one of assetJobId, imagePath, imageUrl or textPrompt',
          { provided: sources.length },
        );
      }

      const provider = ctx.model3dProvider();
      // Before ANY provider contact, including the reference-image upload.
      ctx.assertHeadroom('create_3d_asset');
      let job: AssetJob;
      let imageToken: string | undefined;
      let imageUrl: string | undefined;
      let textPrompt: string | undefined;

      if (args.assetJobId) {
        job = await ctx.store.get(args.assetJobId);
        const candidate = job.candidates.find((entry) => entry.id === job.selectedCandidateId);
        if (!candidate) {
          throw invalidState(
            `job ${job.id} has no selected reference — call select_reference first`,
            { status: job.status, candidates: job.candidates.map((entry) => entry.id) },
          );
        }
        // Hand the provider the URL directly rather than round-tripping the
        // bytes through this process: fewer moving parts, and the image is
        // already hosted by a party the provider can reach.
        imageUrl = assertHttps(candidate.url).toString();
      } else {
        const spec = args.spec as GameAssetSpec | undefined;
        if (!spec) {
          throw invalidInput('spec is required when not continuing an existing assetJobId');
        }
        job = createAssetJob({ spec, slug: sanitizeAssetName(spec.name) });
        if (args.imagePath) {
          const file = await readLocalFile(args.imagePath, ctx.config.maxDownloadBytes, IMAGE_EXTENSIONS);
          imageToken = await provider.uploadImage(file.bytes, file.fileName);
        } else if (args.imageUrl) {
          imageUrl = assertHttps(args.imageUrl).toString();
        } else {
          textPrompt = args.textPrompt ?? buildReconstructionPrompt(spec).prompt;
        }
      }

      const parameters: Record<string, unknown> = {
        pbr: args.pbr,
        texture_quality: args.textureQuality,
        ...(args.faceLimit !== undefined ? { face_limit: args.faceLimit } : {}),
        ...(args.quad !== undefined ? { quad: args.quad } : {}),
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
      };

      job.model3d = {
        provider: provider.name,
        modelVersion: args.modelVersion ?? TRIPO_DEFAULT_MODEL_VERSION,
        taskType: textPrompt ? 'text_to_model' : 'image_to_model',
        parameters,
        requestedAt: new Date().toISOString(),
      };
      job.status = 'generating_3d';
      await ctx.store.save(job);

      await ctx.charge('create_3d_asset', { assetJobId: job.id });

      const handle = textPrompt
        ? await provider.generateFromText({
            prompt: textPrompt,
            ...(args.modelVersion !== undefined ? { modelVersion: args.modelVersion } : {}),
            pbr: args.pbr,
            texture: true,
            textureQuality: args.textureQuality,
            ...(args.faceLimit !== undefined ? { faceLimit: args.faceLimit } : {}),
            ...(args.quad !== undefined ? { quad: args.quad } : {}),
            ...(args.seed !== undefined ? { seed: args.seed } : {}),
          })
        : await provider.generateFromImage({
            ...(imageToken !== undefined ? { imageToken } : {}),
            ...(imageUrl !== undefined ? { imageUrl } : {}),
            ...(args.modelVersion !== undefined ? { modelVersion: args.modelVersion } : {}),
            pbr: args.pbr,
            texture: true,
            textureQuality: args.textureQuality,
            ...(args.faceLimit !== undefined ? { faceLimit: args.faceLimit } : {}),
            ...(args.quad !== undefined ? { quad: args.quad } : {}),
            ...(args.seed !== undefined ? { seed: args.seed } : {}),
          });

      job.model3d.providerTaskId = handle.providerTaskId;
      job.updatedAt = new Date().toISOString();
      await ctx.store.save(job);

      return ok({
        ...summarizeAssetJob(job),
        nextStep:
          'Poll get_asset_job with this assetJobId until status is "ready", then call download_asset.',
      });
    }),
  );
}
