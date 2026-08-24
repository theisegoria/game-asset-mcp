/**
 * Preparing many meshes in one call.
 *
 * The single-asset tools are the right shape for one asset and the wrong shape
 * for forty. This is the MCP surface over `runMeshBatch`; the loop itself lives
 * in `domain/mesh-batch.ts` so its failure handling can be tested without a
 * server, a Blender install, or a staged broken file.
 */

import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { inspectGltf } from '../inspection/gltf.js';
import { uniqueFilePath } from '../storage/filesystem.js';
import type { GameAssetPolicy } from '../domain/asset-policy.js';
import { runMeshBatch, type MeshBatchDeps } from '../domain/mesh-batch.js';
import { packagedScript, runBlenderScript, findBlender } from '../util/blender.js';
import { guard, ok, type ToolContext } from './context.js';

export function registerBatchTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'batch_prepare_meshes',
    {
      title: 'Normalize and validate many meshes in one call',
      description:
        'FREE and fully local: no network call, no credits. Runs the preparation pipeline over a ' +
        'list of meshes — validate, normalize the ones that fail, validate again — and returns a ' +
        'per-item verdict plus a summary. Meshes that already pass are left untouched rather than ' +
        'rewritten. One failing item never stops the run; its error is reported and the batch ' +
        'continues. Normalization needs a local Blender install; without one this still validates ' +
        'and simply reports what would need repairing.',
      inputSchema: {
        modelPaths: z
          .array(z.string().min(1))
          .min(1)
          .max(500)
          .describe('Absolute paths to .glb/.gltf meshes.'),
        outputDir: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Where normalized copies go, resolved against the SERVER\'s working directory. ' +
            'Omit to write beside each source; an empty string is rejected rather than silently ' +
            'meaning "beside the source".',
          ),
        normalize: z
          .boolean()
          .default(true)
          .describe('Repair meshes that fail validation. When false, only reports.'),
        skipAlreadyValid: z
          .boolean()
          .default(true)
          .describe('Leave meshes that already pass untouched instead of rewriting them.'),
        maxTriangles: z.number().int().positive().optional(),
        minTextureSize: z.number().int().positive().optional(),
        requireUVs: z.boolean().optional(),
        timeoutSecondsPerItem: z.number().int().min(10).max(900).default(300),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(ctx.logger, 'batch_prepare_meshes', async (args) => {
      const policy: Partial<GameAssetPolicy> = {};
      if (args.maxTriangles !== undefined) policy.maxTriangles = args.maxTriangles;
      if (args.minTextureSize !== undefined) policy.minTextureSize = args.minTextureSize;
      if (args.requireUVs !== undefined) policy.requireUVs = args.requireUVs;

      const blenderAvailable = Boolean(findBlender());
      if (args.normalize && !blenderAvailable) {
        ctx.logger.warn('batch running in report-only mode: Blender not found');
      }

      const deps: MeshBatchDeps = {
        access: (file) => fs.access(file),
        mkdir: async (dir) => {
          await fs.mkdir(dir, { recursive: true });
        },
        inspect: (file) => inspectGltf(file),
        reserveOutputPath: (dir, fileName) => uniqueFilePath(dir, fileName),
        normalize: async (source, target) => {
          const result = await runBlenderScript(
            packagedScript('blender_normalize.py'),
            {
              input: source,
              output: target,
              unwrapMissingUVs: true,
              cleanGeometry: true,
              mergeDistance: 0.0001,
              normalizeMaterials: true,
              angleLimitDegrees: 66,
              islandMargin: 0.002,
            },
            { timeoutMs: args.timeoutSecondsPerItem * 1000 },
          );
          return result.receipt as Record<string, number>;
        },
        blenderAvailable,
      };

      const batch = await runMeshBatch(
        args.modelPaths,
        {
          ...(args.outputDir !== undefined ? { outputDir: args.outputDir } : {}),
          normalize: args.normalize,
          skipAlreadyValid: args.skipAlreadyValid,
          policy,
        },
        deps,
      );

      return ok({
        schema: 'org.gamedebug.mesh_batch.v1',
        ...batch,
        nextStep:
          batch.failed === 0
            ? `All ${batch.total} mesh(es) are game-ready.`
            : `${batch.failed} of ${batch.total} still fail; see items[].failures for what remains.`,
      });
    }),
  );
}
