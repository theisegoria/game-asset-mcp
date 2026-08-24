/**
 * Reference-image tools.
 *
 * These produce the input to reconstruction, and they stop there on purpose.
 * Choosing between candidates is visual judgement, and the MCP client already
 * has a capable vision model — far better to hand it the images and let it
 * call `select_reference` than to embed a second paid model inside this
 * server to guess on its behalf.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createAssetJob, summarizeAssetJob } from '../domain/asset-job.js';
import { gameAssetSpecSchema, sanitizeAssetName } from '../domain/asset-spec.js';
import type { GameAssetSpec } from '../domain/asset-spec.js';
import { buildReconstructionPrompt, buildVariationPrompt, VARIATION_AXES } from '../prompts/reconstruction-prompt.js';
import type { VariationAxis } from '../prompts/reconstruction-prompt.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { guard, ok, type ToolContext } from './context.js';
import { pollUntilSettled } from './jobs.js';

/** Image dimensions must be multiples of 8 for the provider; keep it in one place. */
const DEFAULT_IMAGE_SIZE = 1024;

const sharedImageArgs = {
  numImages: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(4)
    .describe('How many candidates to generate. Each one costs image credits.'),
  width: z.number().int().min(512).max(1536).default(DEFAULT_IMAGE_SIZE),
  height: z.number().int().min(512).max(1536).default(DEFAULT_IMAGE_SIZE),
  modelId: z.string().optional().describe('Override the image model. Defaults to the provider recommendation.'),
  seed: z.number().int().optional().describe('Fix the seed for a reproducible generation.'),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(120)
    .default(45)
    .describe(
      'Seconds to wait for the images before returning. 0 returns immediately with a job id. ' +
        'Bounded on purpose: this call never blocks indefinitely.',
    ),
};

/**
 * The one implementation of "generate reference candidates".
 *
 * Exported so `create_game_prop` reuses it rather than keeping a convenience
 * copy that would drift — and drift here means two different prompts claiming
 * to be the same pipeline.
 */
export async function runImageGeneration(
  ctx: ToolContext,
  params: {
    /** Which tool is paying, so the spend report attributes it correctly. */
    toolName: string;
    spec: GameAssetSpec;
    prompt: string;
    negativePrompt: string;
    numImages: number;
    width: number;
    height: number;
    modelId?: string;
    seed?: number;
    waitSeconds: number;
    parentJobId?: string;
  },
): Promise<ReturnType<typeof ok>> {
  const provider = ctx.imageProvider();

  const job = createAssetJob({
    spec: params.spec,
    slug: sanitizeAssetName(params.spec.name),
    ...(params.parentJobId !== undefined ? { parentJobId: params.parentJobId } : {}),
  });
  job.status = 'generating_reference';
  job.image = {
    provider: provider.name,
    modelId: params.modelId ?? provider.defaultModelId,
    prompt: params.prompt,
    negativePrompt: params.negativePrompt,
    width: params.width,
    height: params.height,
    ...(params.seed !== undefined ? { seed: params.seed } : {}),
    requestedAt: new Date().toISOString(),
  };
  // Persist BEFORE spending credits. If the provider call succeeds but we then
  // crash, the job record already exists and the spend is traceable; the
  // reverse order would lose the evidence that money was spent at all.
  await ctx.store.save(job);

  // Charge the ceiling immediately before the paid call — never after.
  await ctx.charge(params.toolName, { units: params.numImages, assetJobId: job.id });

  const handle = await provider.generate({
    prompt: params.prompt,
    negativePrompt: params.negativePrompt,
    numImages: params.numImages,
    width: params.width,
    height: params.height,
    ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
    ...(params.seed !== undefined ? { seed: params.seed } : {}),
  });

  job.image.providerGenerationId = handle.providerGenerationId;
  job.updatedAt = new Date().toISOString();
  await ctx.store.save(job);

  const settled =
    params.waitSeconds > 0
      ? await pollUntilSettled(ctx, job, {
          budgetMs: params.waitSeconds * 1000,
          intervalMs: 2_500,
          until: (candidate) => candidate.candidates.length > 0 || candidate.status === 'failed',
        })
      : job;

  return ok({
    assetJobId: settled.id,
    status: settled.status,
    prompt: params.prompt,
    negativePrompt: params.negativePrompt,
    provider: provider.name,
    modelId: job.image.modelId,
    candidates: settled.candidates,
    nextStep:
      settled.candidates.length > 0
        ? 'Look at the candidate images, then call select_reference with the chosen candidateId, then create_3d_asset.'
        : 'Still generating. Call get_asset_job with this assetJobId until candidates appear.',
  });
}

export function registerReferenceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'generate_asset_reference',
    {
      title: 'Generate reference images for a game asset',
      description:
        'SPENDS IMAGE CREDITS. Generates candidate reference images for a game asset, framed for ' +
        '3D reconstruction rather than as concept art (isolated object, whole silhouette, neutral ' +
        'background, even lighting). Returns candidate image URLs for YOU to look at. ' +
        'It does NOT create a 3D model — after inspecting the candidates, call select_reference ' +
        'then create_3d_asset. Asynchronous: waits up to waitSeconds, then returns a job id to poll.',
      inputSchema: { spec: gameAssetSpecSchema, ...sharedImageArgs },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(ctx.logger, 'generate_asset_reference', async (args) => {
      const spec = args.spec as GameAssetSpec;
      const built = buildReconstructionPrompt(spec);
      return runImageGeneration(ctx, {
        toolName: 'generate_asset_reference',
        spec,
        prompt: built.prompt,
        negativePrompt: built.negativePrompt,
        numImages: args.numImages,
        width: args.width,
        height: args.height,
        ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
        waitSeconds: args.waitSeconds,
      });
    }),
  );

  server.registerTool(
    'generate_reference_variations',
    {
      title: 'Explore variations of an existing reference',
      description:
        'SPENDS IMAGE CREDITS. Generates variations of an existing asset job along ONE named axis ' +
        `(${VARIATION_AXES.join(', ')}) while holding the object identity fixed — a variation should ` +
        'still be the same object, not a different one. Creates a NEW child job linked to the parent.',
      inputSchema: {
        assetJobId: z.string().describe('The parent job whose spec should be varied.'),
        axis: z.enum(VARIATION_AXES).describe('Which design dimension to explore.'),
        ...sharedImageArgs,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(ctx.logger, 'generate_reference_variations', async (args) => {
      const parent = await ctx.store.get(args.assetJobId);
      const built = buildVariationPrompt(parent.spec, args.axis as VariationAxis);
      return runImageGeneration(ctx, {
        toolName: 'generate_reference_variations',
        spec: parent.spec,
        prompt: built.prompt,
        negativePrompt: built.negativePrompt,
        numImages: args.numImages,
        width: args.width,
        height: args.height,
        ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
        waitSeconds: args.waitSeconds,
        parentJobId: parent.id,
      });
    }),
  );

  server.registerTool(
    'select_reference',
    {
      title: 'Choose which reference image to reconstruct',
      description:
        'FREE and local: no network call, no credits. Records which candidate image should be used ' +
        'for 3D reconstruction. Call this after looking at the candidates from ' +
        'generate_asset_reference, and before create_3d_asset.',
      inputSchema: {
        assetJobId: z.string(),
        candidateId: z.string().describe('The candidate id, e.g. "cand_1".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'select_reference', async (args) => {
      const job = await ctx.store.get(args.assetJobId);
      if (job.candidates.length === 0) {
        throw invalidState(
          `job ${job.id} has no reference candidates yet (status: ${job.status})`,
          { status: job.status },
        );
      }
      const chosen = job.candidates.find((candidate) => candidate.id === args.candidateId);
      if (!chosen) {
        throw invalidInput(`no candidate "${args.candidateId}" on job ${job.id}`, {
          available: job.candidates.map((candidate) => candidate.id),
        });
      }
      job.selectedCandidateId = chosen.id;
      if (job.status === 'generating_reference') job.status = 'reference_ready';
      job.updatedAt = new Date().toISOString();
      await ctx.store.save(job);

      return ok({
        ...summarizeAssetJob(job),
        selected: chosen,
        nextStep: 'Call create_3d_asset with this assetJobId to reconstruct the chosen image.',
      });
    }),
  );
}
