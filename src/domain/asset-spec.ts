/**
 * What the caller wants, described in game-development terms.
 *
 * The schema deliberately separates five concerns that get muddled when a
 * request is a single prose string:
 *
 *   1. semantic  — what the object IS
 *   2. art       — how it should LOOK
 *   3. geometry  — the shape budget it must fit
 *   4. gameplay  — what it must DO in a game
 *   5. output    — the technical form we need back
 *
 * Keeping them apart is what lets the prompt builder emphasise the semantic
 * and art parts while routing geometry and output to provider parameters,
 * instead of hoping an image model honours a triangle budget.
 */

import { z } from 'zod';

export const ASSET_CATEGORIES = [
  'environment_prop',
  'architecture',
  'weapon',
  'vehicle',
  'character',
  'creature',
  'foliage',
  'decal',
  'other',
] as const;

export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const dimensionsSchema = z
  .object({
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    depth: z.number().positive().optional(),
  })
  .describe('Real-world size in metres. Used for scale sanity, not enforced by the generator.');

export const artDirectionSchema = z.object({
  style: z
    .string()
    .max(400)
    .optional()
    .describe('e.g. "grounded near-future military", "stylised hand-painted"'),
  materials: z
    .array(z.string().max(120))
    .max(12)
    .optional()
    .describe('Dominant substances, e.g. ["brushed steel", "cracked rubber"]'),
  condition: z
    .string()
    .max(200)
    .optional()
    .describe('Wear state, e.g. "heavily weathered, salt-corroded"'),
  palette: z.array(z.string().max(60)).max(8).optional().describe('Colour direction'),
  references: z
    .array(z.string().max(300))
    .max(8)
    .optional()
    .describe('Free-text reference notes (not URLs to fetch)'),
});

export const geometrySchema = z.object({
  targetTriangleCount: z.number().int().positive().max(2_000_000).optional(),
  symmetry: z.enum(['none', 'bilateral', 'radial']).optional(),
  silhouettePriority: z.enum(['low', 'medium', 'high']).optional(),
  reconstructionPriority: z.enum(['low', 'medium', 'high']).optional(),
  quadTopology: z
    .boolean()
    .optional()
    .describe('Request quad/clean topology where the provider supports it. Costs extra credits.'),
});

export const outputSchema = z.object({
  pbr: z.boolean().default(true).describe('Generate PBR material channels.'),
  textureQuality: z
    .enum(['standard', 'detailed'])
    .default('detailed')
    .describe('"detailed" is the provider\'s HD tier and costs more credits.'),
  format: z.enum(['glb', 'gltf', 'fbx', 'obj', 'usdz', 'stl']).default('glb'),
});

export const gameAssetSpecSchema = z.object({
  // `.trim()` before `.min(1)`: a whitespace-only description satisfies a bare
  // min(1) and then produces a prompt with no subject at all — which spends a
  // credit generating an arbitrary object.
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('Short identifier. Becomes the workspace folder name after sanitization.'),
  description: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('What the object is, in plain language. The semantic core of the prompt.'),
  category: z.enum(ASSET_CATEGORIES).optional(),
  gameplayPurpose: z
    .string()
    .max(600)
    .optional()
    .describe('What it does in the game, e.g. "chest-high cover a player can vault"'),
  dimensionsMeters: dimensionsSchema.optional(),
  artDirection: artDirectionSchema.optional(),
  geometry: geometrySchema.optional(),
  output: outputSchema.optional(),
});

export type GameAssetSpec = z.infer<typeof gameAssetSpecSchema>;

/**
 * Filesystem-safe folder name derived from the spec name.
 *
 * Lowercased, non-alphanumerics collapsed to underscores, leading/trailing
 * separators stripped, length-capped. Returns `unnamed_asset` when the input
 * sanitizes away to nothing so we never produce an empty path segment.
 */
export function sanitizeAssetName(raw: string): string {
  const collapsed = raw
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '_')
    .replace(/_+/g, '_')
    .toLowerCase();

  // Slice by CODE POINT, not UTF-16 unit: cutting at 64 units can split an
  // astral character in half and leave a lone surrogate, which is not valid
  // UTF-8 and produces a directory name that no longer round-trips.
  const truncated = [...collapsed].slice(0, 64).join('');

  // Strip separators AFTER truncating, so a cut that lands on '_' does not
  // leave a trailing one.
  const cleaned = truncated.replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'unnamed_asset';
}
