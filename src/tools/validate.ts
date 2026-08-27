/**
 * The shippable-or-not verdict.
 *
 * `inspect_asset` answers "what is in this file". This answers "may it ship",
 * which is a question about a project's standards rather than about the file —
 * so the thresholds are arguments, not constants.
 */

import path from 'node:path';
import { z } from 'zod';
import type { ToolRegistrar } from '../commands/registry.js';
import { inspectGltf } from '../inspection/gltf.js';
import { DEFAULT_POLICY, evaluateAsset, type GameAssetPolicy } from '../domain/asset-policy.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { guard, ok, type ToolContext } from './context.js';

export function registerValidateTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    'validate_game_asset',
    {
      title: 'Check whether an asset is game-ready',
      description:
        'FREE and fully local: no network call, no credits. Judges a glTF/GLB against a shipping ' +
        'policy and returns a pass/fail verdict with per-check reasons — UVs, normals, tangents ' +
        'where a normal map is bound, triangle budget, material count, texture resolution, ' +
        'power-of-two textures, and bounding-box sanity. Errors fail the asset; warnings are ' +
        'judgement calls and do not. Every threshold is overridable, because an asset failing ' +
        'someone else\'s house style is not a defect. Pair with normalize_mesh: run this first to ' +
        'see what is wrong, normalize, then run it again to prove the repair.',
      inputSchema: {
        modelPath: z.string().optional().describe('Absolute path to a local .glb or .gltf.'),
        assetJobId: z.string().optional().describe('A job that has already been downloaded.'),
        requireUVs: z.boolean().optional(),
        requireNormals: z.boolean().optional(),
        requireTangentsWithNormalMap: z.boolean().optional(),
        requireBaseColorTexture: z.boolean().optional(),
        maxTriangles: z.number().int().positive().max(50_000_000).optional(),
        maxMaterials: z.number().int().positive().max(4096).optional(),
        minTextureSize: z.number().int().positive().max(16384).optional(),
        requirePowerOfTwoTextures: z.boolean().optional(),
        maxDimensionMeters: z.number().positive().optional(),
        minDimensionMeters: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'validate_game_asset', async (args) => {
      if (Boolean(args.modelPath) === Boolean(args.assetJobId)) {
        throw invalidInput('provide exactly one of modelPath or assetJobId');
      }

      let target: string;
      if (args.modelPath) {
        const ext = path.extname(args.modelPath).toLowerCase();
        if (ext !== '.glb' && ext !== '.gltf') {
          throw invalidInput(`validate_game_asset reads .glb or .gltf; received "${ext}"`);
        }
        target = path.resolve(args.modelPath);
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
        target = model.path;
      }

      const overrides: Partial<GameAssetPolicy> = {};
      for (const key of Object.keys(DEFAULT_POLICY) as (keyof GameAssetPolicy)[]) {
        const supplied = (args as Record<string, unknown>)[key];
        if (supplied !== undefined) {
          (overrides as Record<string, unknown>)[key] = supplied;
        }
      }

      const inspection = await inspectGltf(target);
      const report = evaluateAsset(inspection, overrides);
      const failed = report.checks.filter((check) => !check.passed);

      return ok({
        schema: 'org.gamedebug.asset_validation.v1',
        modelPath: target,
        passed: report.passed,
        errorCount: report.errorCount,
        warningCount: report.warningCount,
        summary: {
          triangles: inspection.triangleCount,
          materials: inspection.materialCount,
          textures: inspection.textureCount,
          hasUVs: inspection.hasUVs,
          hasNormals: inspection.hasNormals,
          hasTangents: inspection.hasTangents,
          sizeMeters: inspection.boundingBox.sizeMeters,
        },
        // Only the failures, so a passing asset returns a short answer rather
        // than a wall of green rows nobody reads.
        failures: failed.map((check) => ({
          id: check.id,
          severity: check.severity,
          actual: check.actual,
          expected: check.expected,
          ...(check.consequence ? { why: check.consequence } : {}),
        })),
        checksRun: report.checks.length,
        inspectorWarnings: report.inspectorWarnings,
        nextStep: report.passed
          ? report.warningCount > 0
            ? 'Passes. The warnings are judgement calls, not blockers.'
            : 'Passes cleanly.'
          : failed.some((check) => check.id === 'uvs_present')
            ? 'Fails. Run normalize_mesh to generate UVs, then validate again.'
            : 'Fails. See failures[] for what to fix.',
      });
    }),
  );
}
