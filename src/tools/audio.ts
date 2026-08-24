/**
 * Sound-effect generation.
 *
 * Game SFX are short and numerous — a weapon report, a footstep, a UI blip,
 * a looping ambience bed. Because a clip is seconds long rather than minutes,
 * this tool polls and downloads inline instead of handing back a job to chase:
 * the common case completes inside one call, and the bounded wait keeps it from
 * ever hanging.
 */

import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createAssetJob, summarizeAssetJob, type DownloadedFile } from '../domain/asset-job.js';
import { sanitizeAssetName } from '../domain/asset-spec.js';
import { downloadFile } from '../util/http.js';
import { reserveWorkspace, safeJoin, sanitizeFileName, uniqueFilePath, writeFileAtomic, writeJsonAtomic } from '../storage/filesystem.js';
import {
  SOUND_EFFECT_MAX_QUANTITY,
  SOUND_EFFECT_MAX_SECONDS,
  SOUND_EFFECT_MIN_SECONDS,
} from '../providers/audio/leonardo.js';
import { guard, ok, type ToolContext } from './context.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function registerAudioTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'generate_sound_effect',
    {
      title: 'Generate a game sound effect',
      description:
        'SPENDS AUDIO CREDITS. Generates a short sound effect from a text description — weapon ' +
        'reports, impacts, footsteps, UI blips, or a seamless ambience loop. Set loop:true for ' +
        'anything that must tile without a seam. Each variation in quantity costs separately. ' +
        'Polls and downloads inline, returning local file paths; the wait is bounded, so a slow ' +
        'provider returns a job id to poll with get_asset_job rather than hanging. ' +
        'NOTE: the provider documents this request contract but not its response shape, so this ' +
        'path is UNVERIFIED against the live API — the first real call may need a client fix.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(120)
          .describe('Short identifier, e.g. "plasma_rifle_fire". Becomes the workspace folder.'),
        prompt: z
          .string()
          .min(1)
          .max(9999)
          .describe('What the sound is. Concrete physical description beats genre words.'),
        durationSeconds: z
          .number()
          .int()
          .min(SOUND_EFFECT_MIN_SECONDS)
          .max(SOUND_EFFECT_MAX_SECONDS)
          .optional()
          .describe(`Whole seconds, ${SOUND_EFFECT_MIN_SECONDS}-${SOUND_EFFECT_MAX_SECONDS}. Provider default is 2.`),
        loop: z
          .boolean()
          .optional()
          .describe('Request a seamless loop. Essential for ambience beds and engine tones.'),
        quantity: z
          .number()
          .int()
          .min(1)
          .max(SOUND_EFFECT_MAX_QUANTITY)
          .optional()
          .describe('How many variations. Each costs credits.'),
        promptInfluence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('0..1. Higher follows the prompt more literally; lower explores.'),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(120)
          .default(60)
          .describe('Bounded wait before returning a job id instead. 0 returns immediately.'),
        destination: z.string().optional().describe('Output root. Defaults to ASSET_OUTPUT_DIR.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(ctx.logger, 'generate_sound_effect', async (args) => {
      const provider = ctx.audioProvider();

      const job = createAssetJob({
        spec: {
          name: args.name,
          description: args.prompt,
          category: 'other',
          output: { pbr: false, textureQuality: 'standard', format: 'glb' },
        },
        slug: sanitizeAssetName(args.name),
      });
      job.audio = {
        provider: provider.name,
        model: provider.defaultModel,
        prompt: args.prompt,
        ...(args.durationSeconds !== undefined ? { durationSeconds: args.durationSeconds } : {}),
        ...(args.loop !== undefined ? { loop: args.loop } : {}),
        ...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
        ...(args.promptInfluence !== undefined ? { promptInfluence: args.promptInfluence } : {}),
        requestedAt: new Date().toISOString(),
      };
      job.status = 'generating_reference';
      // Persist BEFORE spending, so a crash leaves traceable evidence that
      // money was spent rather than an orphaned charge.
      await ctx.store.save(job);

      const handle = await provider.generateSoundEffect({
        prompt: args.prompt,
        ...(args.durationSeconds !== undefined ? { durationSeconds: args.durationSeconds } : {}),
        ...(args.loop !== undefined ? { loop: args.loop } : {}),
        ...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
        ...(args.promptInfluence !== undefined ? { promptInfluence: args.promptInfluence } : {}),
      });
      job.audio.providerGenerationId = handle.providerGenerationId;
      job.updatedAt = new Date().toISOString();
      await ctx.store.save(job);

      // Bounded poll.
      const deadline = Date.now() + args.waitSeconds * 1000;
      let clips: { url: string; durationSeconds?: number }[] = [];
      let rawStatus = handle.rawStatus ?? 'PENDING';
      while (args.waitSeconds > 0 && Date.now() < deadline) {
        const result = await provider.getGeneration(handle.providerGenerationId);
        rawStatus = result.rawStatus;
        if (result.errorMessage) {
          job.status = 'failed';
          job.error = { code: 'PROVIDER_TASK_FAILED', message: result.errorMessage };
          job.updatedAt = new Date().toISOString();
          await ctx.store.save(job);
          return ok({ ...summarizeAssetJob(job), providerStatus: rawStatus });
        }
        if (result.audio.length > 0) {
          clips = result.audio;
          break;
        }
        await sleep(Math.min(3_000, Math.max(0, deadline - Date.now())));
      }

      job.providerStatus = rawStatus;

      if (clips.length === 0) {
        job.updatedAt = new Date().toISOString();
        await ctx.store.save(job);
        return ok({
          ...summarizeAssetJob(job),
          nextStep:
            'Still generating. Poll get_asset_job with this assetJobId, then download when ready.',
        });
      }

      const root = args.destination ? path.resolve(args.destination) : ctx.config.outputDir;
      const workspace = await reserveWorkspace(root, job.slug);
      job.workspacePath = workspace.dir;
      const audioDir = safeJoin(workspace.dir, 'previews');

      const written: DownloadedFile[] = [];
      for (const [index, clip] of clips.entries()) {
        const payload = await downloadFile(clip.url, {
          timeoutMs: ctx.config.httpTimeoutMs,
          maxBytes: ctx.config.maxDownloadBytes,
        });
        const ext = path.extname(new URL(clip.url).pathname) || '.wav';
        const target = await uniqueFilePath(
          audioDir,
          sanitizeFileName(`${job.slug}_${index + 1}${ext}`, `sfx_${index + 1}.wav`),
        );
        const sha256 = await writeFileAtomic(target, payload.bytes);
        const file: DownloadedFile = {
          path: target,
          bytes: payload.bytes.byteLength,
          sha256,
          kind: 'audio',
          ...(payload.contentType ? { contentType: payload.contentType } : {}),
        };
        job.files.push(file);
        written.push(file);
      }

      job.status = 'ready';
      job.updatedAt = new Date().toISOString();
      await ctx.store.save(job);
      await writeJsonAtomic(safeJoin(workspace.dir, 'asset.json'), job);

      return ok({
        ...summarizeAssetJob(job),
        workspacePath: workspace.dir,
        clips: written.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
        nextStep: 'Listen to the clips and pick one; they are plain audio files on disk.',
      });
    }),
  );
}
