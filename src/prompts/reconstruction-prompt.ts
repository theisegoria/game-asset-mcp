/**
 * Reconstruction-oriented prompt construction.
 *
 * A reference image for image-to-3D is NOT concept art. Concept art rewards
 * drama: shallow depth of field, a hero rim light, the subject half-buried in
 * atmosphere. Every one of those choices destroys information the
 * reconstructor needs, and the failure shows up two steps later as a melted
 * silhouette that costs real credits to discover.
 *
 * So this module trades beauty for legibility on purpose: one isolated object,
 * whole silhouette, even light, plain background.
 *
 * It is deliberately PURE — no I/O, no clock, no randomness. Given the same
 * spec it returns the same prompt, which makes it fully testable without
 * spending a credit, and makes a generation reproducible from its record.
 */

import type { GameAssetSpec } from '../domain/asset-spec.js';

/**
 * Framing rules that make an image reconstructable. Order is fixed for
 * determinism, and the array is frozen because it is returned to callers —
 * `as const` is compile-time only, so without this a caller could mutate the
 * shared array and silently poison every subsequent prompt.
 */
const RECONSTRUCTION_DIRECTIVES = Object.freeze([
  'single isolated object, centred in frame',
  'complete silhouette fully visible with generous margins',
  'three-quarter view showing front, side and top surfaces',
  'plain neutral mid-grey background',
  'even diffuse studio lighting that reveals form',
  'sharp focus across the entire object',
  'physically plausible construction with coherent material boundaries',
  'clearly readable geometry and panel separations',
] as const);

/** Everything that corrupts reconstruction. Also fixed order. */
const NEGATIVE_DIRECTIVES = [
  'depth of field',
  'bokeh',
  'motion blur',
  'cropped or cut-off edges',
  'foreground objects obstructing the subject',
  'environmental clutter',
  'additional floating objects',
  'busy or detailed background',
  'dramatic rim lighting',
  'heavy cast shadows',
  'lens flare',
  'text',
  'watermark',
  'signature',
  'logo',
  'multiple views',
  'collage',
  'turnaround sheet',
  'human hands holding the object',
  'reflections of the surroundings',
] as const;

export interface ReconstructionPrompt {
  prompt: string;
  negativePrompt: string;
  /** The directives applied, so a job record can show WHY the prompt looks like this. */
  directives: readonly string[];
}

function joinClauses(parts: readonly (string | undefined)[]): string {
  return parts
    .map((part) => part?.trim())
    // Strip a clause's own trailing period before joining: prose input almost
    // always ends in one, and "A crate.. single isolated object" is the result
    // of not doing this.
    .map((part) => part?.replace(/[.\s]+$/u, ''))
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join('. ');
}

/** Describe scale in a way an image model can act on. */
function describeScale(spec: GameAssetSpec): string | undefined {
  const dims = spec.dimensionsMeters;
  if (!dims) return undefined;
  const parts: string[] = [];
  if (dims.width !== undefined) parts.push(`${dims.width} m wide`);
  if (dims.height !== undefined) parts.push(`${dims.height} m tall`);
  if (dims.depth !== undefined) parts.push(`${dims.depth} m deep`);
  if (parts.length === 0) return undefined;
  return `Real-world scale approximately ${parts.join(', ')}`;
}

function describeArt(spec: GameAssetSpec): string | undefined {
  const art = spec.artDirection;
  if (!art) return undefined;
  const parts: string[] = [];
  if (art.style) parts.push(art.style);
  if (art.materials?.length) parts.push(`made of ${art.materials.join(', ')}`);
  if (art.condition) parts.push(art.condition);
  if (art.palette?.length) parts.push(`colour palette ${art.palette.join(', ')}`);
  if (art.references?.length) parts.push(`reference notes: ${art.references.join('; ')}`);
  if (parts.length === 0) return undefined;
  return parts.join(', ');
}

/**
 * Build the image prompt for a spec.
 *
 * The user's semantic intent leads — it is the first clause, unmodified — and
 * the mechanical directives follow. That ordering matters: image models weight
 * early tokens more heavily, and the object's identity must outrank our
 * framing rules.
 */
export function buildReconstructionPrompt(spec: GameAssetSpec): ReconstructionPrompt {
  const subject = spec.category
    ? `${spec.description.trim()} (${spec.category.replace(/_/g, ' ')})`
    : spec.description.trim();

  const prompt = joinClauses([
    subject,
    describeArt(spec),
    describeScale(spec),
    spec.gameplayPurpose ? `Intended use: ${spec.gameplayPurpose}` : undefined,
    RECONSTRUCTION_DIRECTIVES.join(', '),
    'product photograph style reference for 3D reconstruction',
  ]);

  return {
    prompt: `${prompt}.`,
    negativePrompt: NEGATIVE_DIRECTIVES.join(', '),
    directives: RECONSTRUCTION_DIRECTIVES,
  };
}

/**
 * Build a variation prompt that explores one axis while holding identity fixed.
 *
 * The base description is repeated verbatim so the object stays the same
 * object; only the named axis is nudged. Without that anchor, "variation"
 * degenerates into "different object", which is the common failure when
 * exploring designs with an image model.
 */
export const VARIATION_AXES = [
  'silhouette',
  'material_treatment',
  'industrial_detailing',
  'wear',
  'proportions',
  'functional_components',
] as const;

export type VariationAxis = (typeof VARIATION_AXES)[number];

const AXIS_INSTRUCTIONS: Record<VariationAxis, string> = {
  silhouette: 'Keep the same object and purpose, but explore a distinctly different outline and massing',
  material_treatment:
    'Keep the same object, form and proportions, but explore a different primary material and surface finish',
  industrial_detailing:
    'Keep the same object and overall form, but explore a different density and style of mechanical detailing',
  wear: 'Keep the same object and materials, but explore a different degree and pattern of wear, damage and ageing',
  proportions:
    'Keep the same object, materials and detailing, but explore different relative proportions of its major parts',
  functional_components:
    'Keep the same object and style, but explore a different arrangement of its functional components',
};

export function buildVariationPrompt(
  spec: GameAssetSpec,
  axis: VariationAxis,
): ReconstructionPrompt {
  const base = buildReconstructionPrompt(spec);
  return {
    prompt: `${AXIS_INSTRUCTIONS[axis]}. ${base.prompt}`,
    negativePrompt: base.negativePrompt,
    directives: base.directives,
  };
}

/**
 * Prompt for texturing an existing mesh.
 *
 * Framing directives are omitted entirely — there is no camera here. The mesh
 * already fixes the geometry, so the only useful signal is material identity,
 * and framing language would just dilute it.
 */
export function buildTexturePrompt(spec: GameAssetSpec): string {
  return `${joinClauses([
    spec.description.trim(),
    describeArt(spec),
    'physically based materials, realistic surface response, consistent texel density',
  ])}.`;
}
