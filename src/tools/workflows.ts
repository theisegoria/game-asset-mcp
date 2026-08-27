/**
 * The opinionated one-shot entry point.
 *
 * `create_game_prop` deliberately STOPS after producing reference candidates.
 * It would be trivial to have it pick one and spend 3D credits automatically,
 * and that is exactly why it must not: choosing a reference is an art-direction
 * judgement, the caller is better at it than any heuristic here, and a wrong
 * automatic choice costs real money to discover.
 *
 * So the split is: this tool does the tedious part (turning a loose brief into
 * a reconstruction-grade prompt and a set of candidates), and hands the
 * decision back.
 */

import { z } from 'zod';
import type { ToolRegistrar } from '../commands/registry.js';
import { gameAssetSpecSchema } from '../domain/asset-spec.js';
import type { GameAssetSpec } from '../domain/asset-spec.js';
import { buildReconstructionPrompt } from '../prompts/reconstruction-prompt.js';
import { guard, ok, type ToolContext } from './context.js';
import { runImageGeneration } from './references.js';

export function registerWorkflowTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    'preview_asset_prompt',
    {
      title: 'Preview the prompt that would be generated',
      description:
        'FREE and fully local: no network call, no credits. Shows the exact reconstruction-oriented ' +
        'prompt and negative prompt that generate_asset_reference would send for a given spec. ' +
        'Use this to sanity-check art direction before spending image credits.',
      inputSchema: { spec: gameAssetSpecSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'preview_asset_prompt', async (args) => {
      const built = buildReconstructionPrompt(args.spec as GameAssetSpec);
      return ok({
        prompt: built.prompt,
        negativePrompt: built.negativePrompt,
        directives: built.directives,
      });
    }),
  );

  server.registerTool(
    'create_game_prop',
    {
      title: 'Start a game prop from a brief',
      description:
        'SPENDS IMAGE CREDITS ONLY. Convenience entry point: takes a loose brief, builds a ' +
        'reconstruction-grade prompt, and generates N candidate reference images. ' +
        'It deliberately STOPS THERE and does NOT spend 3D credits — look at the returned candidates, ' +
        'call select_reference with your choice, then create_3d_asset. ' +
        'This exists so art direction stays with you rather than being guessed at.',
      inputSchema: {
        name: z.string().min(1).max(120).describe('Short identifier, e.g. "portable_atmospheric_processor".'),
        description: z.string().min(1).max(2000).describe('What the object is, in plain language.'),
        artDirection: z.string().max(600).optional().describe('Free-text style, materials and wear.'),
        gameplayPurpose: z.string().max(600).optional(),
        category: gameAssetSpecSchema.shape.category,
        dimensionsMeters: gameAssetSpecSchema.shape.dimensionsMeters,
        targetTriangleCount: z.number().int().positive().max(2_000_000).optional(),
        numImages: z.number().int().min(1).max(8).default(4),
        waitSeconds: z.number().int().min(0).max(120).default(45),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(ctx.logger, 'create_game_prop', async (args) => {
      const spec: GameAssetSpec = {
        name: args.name,
        description: args.description,
        ...(args.category ? { category: args.category } : {}),
        ...(args.gameplayPurpose ? { gameplayPurpose: args.gameplayPurpose } : {}),
        ...(args.dimensionsMeters ? { dimensionsMeters: args.dimensionsMeters } : {}),
        ...(args.artDirection ? { artDirection: { style: args.artDirection } } : {}),
        ...(args.targetTriangleCount !== undefined
          ? { geometry: { targetTriangleCount: args.targetTriangleCount } }
          : {}),
      };

      // Delegate to the same code path the explicit tool uses, so there is one
      // implementation of "generate references" rather than a convenience copy
      // that quietly drifts from it.
      const built = buildReconstructionPrompt(spec);
      return runImageGeneration(ctx, {
        toolName: 'create_game_prop',
        spec,
        prompt: built.prompt,
        negativePrompt: built.negativePrompt,
        numImages: args.numImages,
        width: 1024,
        height: 1024,
        waitSeconds: args.waitSeconds,
      });
    }),
  );
}
