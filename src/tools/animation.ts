/**
 * Rigging, animation and retopology.
 *
 * These are the steps between "a mesh exists" and "a character moves". They
 * share one shape: each takes a prior job, submits a provider task, and returns
 * a job to poll — so they reuse `get_asset_job` and `download_asset` unchanged
 * rather than inventing a parallel lifecycle.
 *
 * Ordering is enforced, not merely documented: retargeting an unrigged model
 * produces nothing useful and the provider bills for the attempt anyway.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createAssetJob, summarizeAssetJob } from '../domain/asset-job.js';
import type { AssetJob } from '../domain/asset-job.js';
import { sanitizeAssetName } from '../domain/asset-spec.js';
import { invalidState } from '../util/errors.js';
import { TRIPO_DEFAULT_MODEL_VERSION } from '../providers/model3d/tripo.js';
import { guard, ok, type ToolContext } from './context.js';

/** Every tool here derives a child job from a prior one, so this is shared. */
async function childJobFrom(
  ctx: ToolContext,
  sourceJobId: string,
  suffix: string,
): Promise<{ job: AssetJob; sourceTaskId: string }> {
  const source = await ctx.store.get(sourceJobId);
  const sourceTaskId = source.model3d?.providerTaskId;
  if (!sourceTaskId) {
    throw invalidState(`job ${source.id} has no provider 3D task to build on`, {
      status: source.status,
    });
  }
  const job = createAssetJob({
    spec: { ...source.spec, name: `${source.spec.name}_${suffix}` },
    slug: sanitizeAssetName(`${source.spec.name}_${suffix}`),
    parentJobId: source.id,
  });
  return { job, sourceTaskId };
}

export function registerAnimationTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'rig_asset',
    {
      title: 'Generate a skeleton and skin weights',
      description:
        'SPENDS 3D CREDITS. Rigs an existing generated asset — builds a skeleton and skin weights ' +
        'so it can be animated. Takes an asset job that already produced a model. ASYNCHRONOUS: ' +
        'poll get_asset_job, then download_asset. Rig before animating; retargeting an unrigged ' +
        'model wastes the credits. ' +
        'NOTE: the provider task name is taken from published docs and is UNVERIFIED live.',
      inputSchema: {
        assetJobId: z.string().describe('A job whose 3D task produced a model.'),
        spec: z
          .enum(['humanoid', 'quadruped', 'generic'])
          .default('humanoid')
          .describe('Which skeleton convention to target.'),
        outFormat: z.enum(['glb', 'fbx']).default('glb'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(ctx.logger, 'rig_asset', async (args) => {
      const provider = ctx.model3dProvider();
      const { job, sourceTaskId } = await childJobFrom(ctx, args.assetJobId, 'rigged');

      job.model3d = {
        provider: provider.name,
        modelVersion: TRIPO_DEFAULT_MODEL_VERSION,
        taskType: 'animate_rig',
        parameters: { spec: args.spec, out_format: args.outFormat, source_task: sourceTaskId },
        requestedAt: new Date().toISOString(),
      };
      job.status = 'generating_3d';
      await ctx.store.save(job);

      await ctx.charge('rig_asset', { assetJobId: job.id });
      const handle = await provider.rig({
        originalModelTaskId: sourceTaskId,
        spec: args.spec,
        outFormat: args.outFormat,
      });

      job.model3d.providerTaskId = handle.providerTaskId;
      job.updatedAt = new Date().toISOString();
      await ctx.store.save(job);
      return ok({
        ...summarizeAssetJob(job),
        nextStep: 'Poll get_asset_job until ready, then animate_asset or download_asset.',
      });
    }),
  );

  server.registerTool(
    'animate_asset',
    {
      title: 'Retarget an animation onto a rigged asset',
      description:
        'SPENDS 3D CREDITS. Applies a preset animation to an asset that has ALREADY been rigged ' +
        'with rig_asset. Each animation costs separately. ASYNCHRONOUS: poll get_asset_job, then ' +
        'download_asset. Refuses when the source job was not a rig, because retargeting an ' +
        'unrigged model produces nothing while still being billed. ' +
        'NOTE: the provider task name is taken from published docs and is UNVERIFIED live.',
      inputSchema: {
        assetJobId: z.string().describe('A job produced by rig_asset.'),
        animation: z.string().min(1).max(120).describe('Provider preset animation name, e.g. "walk".'),
        outFormat: z.enum(['glb', 'fbx']).default('glb'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(ctx.logger, 'animate_asset', async (args) => {
      const provider = ctx.model3dProvider();
      const source = await ctx.store.get(args.assetJobId);
      // Enforce the ordering rather than trusting the description to be read.
      if (source.model3d?.taskType !== 'animate_rig') {
        throw invalidState(
          `job ${source.id} is a "${source.model3d?.taskType ?? 'unknown'}" task, not a rig — ` +
            'call rig_asset first, or animation credits are spent for nothing',
          { taskType: source.model3d?.taskType },
        );
      }
      const { job, sourceTaskId } = await childJobFrom(ctx, args.assetJobId, args.animation);

      job.model3d = {
        provider: provider.name,
        modelVersion: TRIPO_DEFAULT_MODEL_VERSION,
        taskType: 'animate_retarget',
        parameters: { animation: args.animation, out_format: args.outFormat, source_task: sourceTaskId },
        requestedAt: new Date().toISOString(),
      };
      job.status = 'generating_3d';
      await ctx.store.save(job);

      await ctx.charge('animate_asset', { assetJobId: job.id });
      const handle = await provider.retarget({
        originalModelTaskId: sourceTaskId,
        animation: args.animation,
        outFormat: args.outFormat,
      });

      job.model3d.providerTaskId = handle.providerTaskId;
      job.updatedAt = new Date().toISOString();
      await ctx.store.save(job);
      return ok({
        ...summarizeAssetJob(job),
        nextStep: 'Poll get_asset_job until ready, then download_asset.',
      });
    }),
  );

  server.registerTool(
    'retopologize_asset',
    {
      title: 'Rebuild an asset\'s topology, optionally as quads',
      description:
        'SPENDS 3D CREDITS. Rebuilds the topology of an existing generated asset. Quad output is ' +
        'the default because quads survive downstream mesh qualification and editing far better ' +
        'than the triangle soup generators typically emit. ASYNCHRONOUS: poll get_asset_job, then ' +
        'download_asset and validate_game_asset. ' +
        'NOTE: the provider task name is taken from published docs and is UNVERIFIED live.',
      inputSchema: {
        assetJobId: z.string().describe('A job whose 3D task produced a model.'),
        faceLimit: z.number().int().positive().max(2_000_000).optional().describe('Target face count.'),
        quad: z.boolean().default(true).describe('Quads rather than triangles.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(ctx.logger, 'retopologize_asset', async (args) => {
      const provider = ctx.model3dProvider();
      const { job, sourceTaskId } = await childJobFrom(ctx, args.assetJobId, 'retopo');

      job.model3d = {
        provider: provider.name,
        modelVersion: TRIPO_DEFAULT_MODEL_VERSION,
        taskType: 'refine_model',
        parameters: {
          quad: args.quad,
          ...(args.faceLimit !== undefined ? { face_limit: args.faceLimit } : {}),
          source_task: sourceTaskId,
        },
        requestedAt: new Date().toISOString(),
      };
      job.status = 'generating_3d';
      await ctx.store.save(job);

      await ctx.charge('retopologize_asset', { assetJobId: job.id });
      const handle = await provider.retopologize({
        originalModelTaskId: sourceTaskId,
        quad: args.quad,
        ...(args.faceLimit !== undefined ? { faceLimit: args.faceLimit } : {}),
      });

      job.model3d.providerTaskId = handle.providerTaskId;
      job.updatedAt = new Date().toISOString();
      await ctx.store.save(job);
      return ok({
        ...summarizeAssetJob(job),
        nextStep: 'Poll get_asset_job until ready, then download_asset and validate_game_asset.',
      });
    }),
  );
}
