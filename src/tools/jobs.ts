/**
 * Job inspection and provider-state refresh.
 *
 * `refreshAssetJob` is the single place where remote state is folded into a
 * local job. Everything else calls it, so there is exactly one implementation
 * of "what does the provider say now, and what does that mean for us" — a
 * second copy would drift, and a drifted status is how a job ends up reported
 * `ready` with no model behind it.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssetJob } from '../domain/asset-job.js';
import { summarizeAssetJob } from '../domain/asset-job.js';
import type { AssetJobStatus } from '../domain/status.js';
import { canTransition, fromLeonardoStatus, fromTripoStatus, isTerminal } from '../domain/status.js';
import type { Logger } from '../util/logging.js';
import { guard, ok, type ToolContext } from './context.js';

/**
 * Apply a status change, enforcing the transition table.
 *
 * Providers legitimately report states out of order — a worker re-queue, a
 * load-balanced stale read, two polls landing in the wrong sequence — so a
 * backwards transition is normal traffic, not an attack. Dropping it is the
 * safe response: the job stays at the furthest point it has actually reached,
 * and a terminal job can never be reopened by a late poll.
 *
 * Returns whether the change was applied, so callers can avoid acting on a
 * status the job does not actually hold.
 */
function setStatus(logger: Logger, job: AssetJob, next: AssetJobStatus): boolean {
  if (job.status === next) return false;
  if (!canTransition(job.status, next)) {
    logger.debug('ignoring out-of-order status transition', {
      assetJobId: job.id,
      from: job.status,
      to: next,
    });
    return false;
  }
  job.status = next;
  return true;
}

/** Poll the provider for `job` and fold the answer into it. Persists any change. */
export async function refreshAssetJob(ctx: ToolContext, job: AssetJob): Promise<AssetJob> {
  if (isTerminal(job.status)) return job;

  const before = JSON.stringify(job);

  if (job.model3d?.providerTaskId) {
    const provider = ctx.model3dProvider();
    const task = await provider.getTask(job.model3d.providerTaskId);
    job.providerStatus = task.rawStatus;
    setStatus(ctx.logger, job, fromTripoStatus(task.rawStatus));

    if (task.modelUrl) job.model3d.modelUrl = task.modelUrl;
    if (task.pbrModelUrl) job.model3d.pbrModelUrl = task.pbrModelUrl;
    if (task.renderedImageUrl) job.model3d.renderedImageUrl = task.renderedImageUrl;
    if (task.creditCost !== undefined) job.model3d.creditCost = task.creditCost;

    if (job.status === 'failed') {
      job.error = {
        code: 'PROVIDER_TASK_FAILED',
        message: task.errorMessage ?? `provider task ended with status "${task.rawStatus}"`,
        details: { providerTaskId: task.providerTaskId, rawStatus: task.rawStatus },
      };
    }
  } else if (job.image?.providerGenerationId && job.status === 'generating_reference') {
    const provider = ctx.imageProvider();
    const generation = await provider.getGeneration(job.image.providerGenerationId);
    job.providerStatus = generation.rawStatus;
    // Keep the mapped value: `job.status` is narrowed by the guard above, so
    // reading it back after mutation would compare against a stale type.
    const mapped = fromLeonardoStatus(generation.rawStatus);
    setStatus(ctx.logger, job, mapped);

    if (generation.images.length > 0) {
      // Candidate ids are positional and stable for the life of the job, so an
      // agent can name one in select_reference without us persisting a second
      // id scheme.
      job.candidates = generation.images.map((image, index) => ({
        id: `cand_${index + 1}`,
        url: image.url,
        ...(image.seed !== undefined ? { seed: image.seed } : {}),
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
        ...(image.providerImageId !== undefined
          ? { providerImageId: image.providerImageId }
          : {}),
      }));
    }

    if (mapped === 'failed') {
      job.error = {
        code: 'PROVIDER_TASK_FAILED',
        message: generation.errorMessage ?? `image generation ended with "${generation.rawStatus}"`,
      };
    }
  }

  const after = JSON.stringify(job);
  if (after !== before) {
    job.updatedAt = new Date().toISOString();
    await ctx.store.save(job);
  }
  return job;
}

/**
 * Poll until the job leaves a pending state or the budget runs out.
 *
 * Bounded on purpose: an MCP call that blocks indefinitely is worse than one
 * that returns "still generating", because the client cannot tell a slow
 * provider from a hung server.
 */
export async function pollUntilSettled(
  ctx: ToolContext,
  job: AssetJob,
  options: { budgetMs: number; intervalMs?: number; until: (job: AssetJob) => boolean },
): Promise<AssetJob> {
  const interval = options.intervalMs ?? 3_000;
  const deadline = Date.now() + options.budgetMs;
  let current = job;

  while (Date.now() < deadline) {
    current = await refreshAssetJob(ctx, current);
    if (options.until(current)) return current;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
  }
  return current;
}

export const getAssetJobInput = {
  assetJobId: z.string().describe('The local asset job id returned when the job was created.'),
  detail: z
    .boolean()
    .default(false)
    .describe(
      'Return the FULL job record including prompts, provider parameters and every file. ' +
        'Defaults to false because full records are large and flood context on repeated polls.',
    ),
};

export const listAssetJobsInput = {
  limit: z.number().int().positive().max(200).default(25),
  status: z
    .enum(['queued', 'generating_reference', 'reference_ready', 'generating_3d', 'processing', 'ready', 'failed', 'cancelled'])
    .optional()
    .describe('Filter to one lifecycle status.'),
};

export function registerJobTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_asset_job',
    {
      title: 'Get asset job status',
      description:
        'Check an asset job, refreshing it from the provider if it is still running. ' +
        'READ-ONLY: makes a network call to the provider but never spends credits. ' +
        'Call this after create_3d_asset or texture_existing_asset until status is "ready", ' +
        'then call download_asset. Statuses: queued, generating_reference, reference_ready, ' +
        'generating_3d, processing, ready, failed, cancelled.',
      inputSchema: getAssetJobInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(ctx.logger, 'get_asset_job', async (args: { assetJobId: string; detail: boolean }) => {
      const job = await ctx.store.get(args.assetJobId);
      const refreshed = await refreshAssetJob(ctx, job);
      return ok(args.detail ? refreshed : summarizeAssetJob(refreshed));
    }),
  );

  server.registerTool(
    'list_asset_jobs',
    {
      title: 'List asset jobs',
      description:
        'List local asset jobs, newest first. READ-ONLY and fully local: no network call, no credits. ' +
        'Does not refresh provider state — use get_asset_job for that.',
      inputSchema: listAssetJobsInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'list_asset_jobs', async (args: { limit: number; status?: AssetJobStatus }) => {
      const all = await ctx.store.list();
      const filtered = args.status ? all.filter((job) => job.status === args.status) : all;
      return ok({
        total: filtered.length,
        jobs: filtered.slice(0, args.limit).map(summarizeAssetJob),
      });
    }),
  );
}
