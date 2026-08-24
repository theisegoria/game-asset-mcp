/**
 * Unit tests for the pure prompt layer and the asset spec schema.
 *
 * These are the only two modules in the pipeline that can be verified without
 * spending a provider credit, so they carry the assertions the provider tests
 * cannot afford: exact strings, exact defaults, exact sanitizer outputs.
 *
 * Deliberately no snapshots. A snapshot records whatever the code currently
 * does, so it would happily absorb a malformed prompt as the new truth — the
 * exact regression these tests exist to catch.
 */

import { describe, expect, it } from 'vitest';

import {
  buildReconstructionPrompt,
  buildTexturePrompt,
  buildVariationPrompt,
  VARIATION_AXES,
} from '../src/prompts/reconstruction-prompt.js';
import { gameAssetSpecSchema, sanitizeAssetName } from '../src/domain/asset-spec.js';
import type { VariationAxis } from '../src/prompts/reconstruction-prompt.js';
import type { GameAssetSpec } from '../src/domain/asset-spec.js';

const MINIMAL_SPEC: GameAssetSpec = { name: 'x', description: 'a crate' };

const FULL_SPEC: GameAssetSpec = {
  name: 'fire_hydrant',
  description: 'a cast-iron street hydrant',
  category: 'environment_prop',
  gameplayPurpose: 'chest-high cover a player can vault',
  dimensionsMeters: { width: 0.4, height: 0.9, depth: 0.4 },
  artDirection: {
    style: 'grounded contemporary municipal',
    materials: ['cast iron', 'flaking enamel paint'],
    condition: 'weathered and chipped',
    palette: ['fire red', 'oxide grey'],
    references: ['thick chamfered flanges'],
  },
  geometry: {
    targetTriangleCount: 40_000,
    symmetry: 'radial',
    silhouettePriority: 'high',
    reconstructionPriority: 'high',
    quadTopology: false,
  },
  output: { pbr: true, textureQuality: 'detailed', format: 'glb' },
};

/**
 * Pinned verbatim rather than reconstructed from the module's own constants:
 * rebuilding the expectation from the same arrays under test would make the
 * assertion tautological and blind to a reordered or reworded directive.
 */
const EXPECTED_MINIMAL_PROMPT =
  'a crate. ' +
  'single isolated object, centred in frame, ' +
  'complete silhouette fully visible with generous margins, ' +
  'three-quarter view showing front, side and top surfaces, ' +
  'plain neutral mid-grey background, ' +
  'even diffuse studio lighting that reveals form, ' +
  'sharp focus across the entire object, ' +
  'physically plausible construction with coherent material boundaries, ' +
  'clearly readable geometry and panel separations. ' +
  'product photograph style reference for 3D reconstruction.';

/** Phrases unique to each axis instruction, since AXIS_INSTRUCTIONS is not exported. */
const AXIS_FINGERPRINTS: Record<VariationAxis, string> = {
  silhouette: 'a distinctly different outline and massing',
  material_treatment: 'a different primary material and surface finish',
  industrial_detailing: 'a different density and style of mechanical detailing',
  wear: 'a different degree and pattern of wear, damage and ageing',
  proportions: 'different relative proportions of its major parts',
  functional_components: 'a different arrangement of its functional components',
};

describe('buildReconstructionPrompt', () => {
  it('is deterministic across repeated calls with the same spec', () => {
    const first = buildReconstructionPrompt(FULL_SPEC);
    const second = buildReconstructionPrompt(FULL_SPEC);

    expect(second.prompt).toBe(first.prompt);
    expect(second.negativePrompt).toBe(first.negativePrompt);
    expect([...second.directives]).toEqual([...first.directives]);
  });

  it('is deterministic across two structurally equal but distinct spec objects', () => {
    const a = buildReconstructionPrompt({ name: 'x', description: 'a crate' });
    const b = buildReconstructionPrompt({ name: 'x', description: 'a crate' });

    expect(b.prompt).toBe(a.prompt);
    expect(b.negativePrompt).toBe(a.negativePrompt);
  });

  it('produces the exact expected prompt for a minimal spec', () => {
    expect(buildReconstructionPrompt(MINIMAL_SPEC).prompt).toBe(EXPECTED_MINIMAL_PROMPT);
  });

  it('produces a well-formed prompt for a minimal spec', () => {
    const { prompt } = buildReconstructionPrompt(MINIMAL_SPEC);

    expect(prompt.endsWith('.')).toBe(true);
    expect(prompt.endsWith('..')).toBe(false);
    expect(prompt).not.toContain('..');
    expect(prompt).not.toContain(', .');
    expect(prompt).not.toContain('. .');
    expect(prompt).not.toContain(', ,');
    expect(prompt).not.toContain(' ,');
    expect(prompt).not.toContain('.,');
    expect(prompt).not.toContain('  ');
    expect(prompt.trim()).toBe(prompt);

    // Exactly one terminating period and no empty clause between separators.
    for (const clause of prompt.slice(0, -1).split('. ')) {
      expect(clause.trim().length).toBeGreaterThan(0);
    }
  });

  it('stays well formed when the description already ends in a period', () => {
    const { prompt } = buildReconstructionPrompt({
      name: 'x',
      description: 'A weathered wooden crate.',
    });

    expect(prompt).not.toContain('..');
  });

  it('places the description before the framing directives', () => {
    const { prompt } = buildReconstructionPrompt(MINIMAL_SPEC);

    const descriptionIndex = prompt.indexOf('a crate');
    const framingIndex = prompt.indexOf('single isolated object');
    const styleIndex = prompt.indexOf('product photograph style');

    expect(descriptionIndex).toBe(0);
    expect(framingIndex).toBeGreaterThan(descriptionIndex);
    expect(styleIndex).toBeGreaterThan(framingIndex);
  });

  it('keeps the description first even when art, scale and purpose are supplied', () => {
    const { prompt } = buildReconstructionPrompt(FULL_SPEC);

    expect(prompt.indexOf('a cast-iron street hydrant')).toBe(0);
    expect(prompt.indexOf('grounded contemporary municipal')).toBeGreaterThan(0);
    expect(prompt.indexOf('grounded contemporary municipal')).toBeLessThan(
      prompt.indexOf('single isolated object'),
    );
  });

  it('lists the anti-reconstruction terms in the negative prompt', () => {
    const { negativePrompt } = buildReconstructionPrompt(MINIMAL_SPEC);
    const terms = negativePrompt.split(', ');

    for (const required of ['depth of field', 'motion blur', 'text', 'watermark']) {
      expect(terms).toContain(required);
    }

    expect(terms.length).toBe(new Set(terms).size);
    expect(negativePrompt).not.toContain('..');
  });

  it('returns the same negative prompt regardless of spec content', () => {
    expect(buildReconstructionPrompt(FULL_SPEC).negativePrompt).toBe(
      buildReconstructionPrompt(MINIMAL_SPEC).negativePrompt,
    );
  });

  it('includes art direction, dimensions and gameplay purpose when supplied', () => {
    const { prompt } = buildReconstructionPrompt(FULL_SPEC);

    expect(prompt).toContain('grounded contemporary municipal');
    expect(prompt).toContain('made of cast iron, flaking enamel paint');
    expect(prompt).toContain('weathered and chipped');
    expect(prompt).toContain('colour palette fire red, oxide grey');
    expect(prompt).toContain('reference notes: thick chamfered flanges');
    expect(prompt).toContain('Real-world scale approximately 0.4 m wide, 0.9 m tall, 0.4 m deep');
    expect(prompt).toContain('Intended use: chest-high cover a player can vault');
    expect(prompt).toContain('(environment prop)');
  });

  it('omits art direction, dimensions and gameplay purpose when not supplied', () => {
    const { prompt } = buildReconstructionPrompt(MINIMAL_SPEC);

    expect(prompt).not.toContain('Real-world scale');
    expect(prompt).not.toContain('Intended use');
    expect(prompt).not.toContain('made of');
    expect(prompt).not.toContain('colour palette');
    expect(prompt).not.toContain('reference notes');
    expect(prompt).not.toContain('(');
  });

  it('omits a dimensions clause when the dimensions object carries no axes', () => {
    const { prompt } = buildReconstructionPrompt({ ...MINIMAL_SPEC, dimensionsMeters: {} });

    expect(prompt).not.toContain('Real-world scale');
    expect(prompt).toBe(EXPECTED_MINIMAL_PROMPT);
  });

  it('omits an art clause when the art direction object is empty', () => {
    const { prompt } = buildReconstructionPrompt({ ...MINIMAL_SPEC, artDirection: {} });

    expect(prompt).toBe(EXPECTED_MINIMAL_PROMPT);
  });
});

describe('buildVariationPrompt', () => {
  it('preserves identity and adds the axis instruction for every axis', () => {
    const base = buildReconstructionPrompt(FULL_SPEC);

    for (const axis of VARIATION_AXES) {
      const variation = buildVariationPrompt(FULL_SPEC, axis);

      // Identity anchor: the whole base prompt, description included, survives.
      expect(variation.prompt).toContain('a cast-iron street hydrant');
      expect(variation.prompt).toContain(base.prompt);
      expect(variation.prompt).toContain(AXIS_FINGERPRINTS[axis]);
      expect(variation.prompt).not.toBe(base.prompt);

      // The axis instruction leads; the unchanged base follows it.
      expect(variation.prompt.indexOf(AXIS_FINGERPRINTS[axis])).toBeLessThan(
        variation.prompt.indexOf(base.prompt),
      );

      expect(variation.negativePrompt).toBe(base.negativePrompt);
      expect([...variation.directives]).toEqual([...base.directives]);
      expect(variation.prompt).not.toContain('..');
      expect(variation.prompt.endsWith('.')).toBe(true);
    }
  });

  it('produces a distinct prompt for each axis', () => {
    const prompts = VARIATION_AXES.map((axis) => buildVariationPrompt(FULL_SPEC, axis).prompt);

    expect(new Set(prompts).size).toBe(VARIATION_AXES.length);
  });

  it('is deterministic per axis', () => {
    for (const axis of VARIATION_AXES) {
      expect(buildVariationPrompt(MINIMAL_SPEC, axis).prompt).toBe(
        buildVariationPrompt(MINIMAL_SPEC, axis).prompt,
      );
    }
  });
});

describe('buildTexturePrompt', () => {
  it('omits framing language, because there is no camera when texturing a mesh', () => {
    const prompt = buildTexturePrompt(FULL_SPEC);

    for (const framingWord of ['background', 'three-quarter', 'silhouette']) {
      expect(prompt.toLowerCase()).not.toContain(framingWord);
    }
    expect(prompt).not.toContain('centred in frame');
    expect(prompt).not.toContain('studio lighting');
    expect(prompt).not.toContain('product photograph');
  });

  it('keeps the description and art direction, which are the useful signal', () => {
    const prompt = buildTexturePrompt(FULL_SPEC);

    expect(prompt).toContain('a cast-iron street hydrant');
    expect(prompt).toContain('made of cast iron, flaking enamel paint');
    expect(prompt).toContain('physically based materials');
    expect(prompt.endsWith('.')).toBe(true);
    expect(prompt).not.toContain('..');
  });

  it('is well formed and deterministic for a minimal spec', () => {
    const prompt = buildTexturePrompt(MINIMAL_SPEC);

    expect(prompt).toBe(
      'a crate. physically based materials, realistic surface response, consistent texel density.',
    );
    expect(prompt).toBe(buildTexturePrompt(MINIMAL_SPEC));
  });
});

describe('sanitizeAssetName', () => {
  it('strips path traversal from a POSIX path', () => {
    expect(sanitizeAssetName('../../etc/passwd')).toBe('etc_passwd');
  });

  it('strips path traversal from a Windows path', () => {
    expect(sanitizeAssetName('..\\..\\windows\\system32')).toBe('windows_system32');
  });

  it('normalises spacing and punctuation', () => {
    expect(sanitizeAssetName('  Fire Hydrant!! ')).toBe('fire_hydrant');
  });

  it('falls back when the input sanitizes away to nothing', () => {
    expect(sanitizeAssetName('...')).toBe('unnamed_asset');
    expect(sanitizeAssetName('')).toBe('unnamed_asset');
    expect(sanitizeAssetName('   ')).toBe('unnamed_asset');
    expect(sanitizeAssetName('!@#$%^&*()')).toBe('unnamed_asset');
  });

  it('caps the length at 64 characters', () => {
    expect(sanitizeAssetName('x'.repeat(200))).toBe('x'.repeat(64));
  });

  it('does not leave a trailing separator when the cut lands on one', () => {
    // The 64th code point here is the separator standing in for the space, so
    // this is the case that regresses if the strip is ever moved back before
    // the truncation.
    const capped = sanitizeAssetName(`${'a'.repeat(63)} ${'b'.repeat(200)}`);

    expect(capped).toBe('a'.repeat(63));
    expect(capped.endsWith('_')).toBe(false);
  });

  it('caps by code point, never splitting an astral character', () => {
    const capped = sanitizeAssetName(`${'a'.repeat(63)}\u{2000B}${'b'.repeat(50)}`);

    expect(capped).toBe(`${'a'.repeat(63)}\u{2000B}`);
    expect([...capped].length).toBe(64);
    // A UTF-16 slice would cut the surrogate pair and leave an unpaired half,
    // which is not valid UTF-8 and would not round-trip as a directory name.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(capped)).toBe(
      false,
    );
  });

  it('decomposes and folds unicode', () => {
    expect(sanitizeAssetName('Café Münchén 東京')).toBe('cafe_mu_nche_n_東京');
    expect(sanitizeAssetName('ÜBER')).toBe('u_ber');
  });

  it('never returns an empty string and never emits a path separator', () => {
    const hostile = [
      '',
      '   ',
      '...',
      '..',
      '/',
      '\\',
      '../..',
      '/../../root',
      '..\\..',
      './.',
      '!@#$%^&*()',
      ' ',
      '💥💥',
      '\n\t\r',
      'a'.repeat(500),
      '\u{2000B}'.repeat(200),
      'Café Münchén 東京',
      '  Fire Hydrant!! ',
      '../../etc/passwd',
      'valid_name_42',
    ];

    for (const input of hostile) {
      const out = sanitizeAssetName(input);

      expect(out.length).toBeGreaterThan(0);
      // Code points, not UTF-16 units: the cap is a code-point cap.
      expect([...out].length).toBeLessThanOrEqual(64);
      expect(out).not.toContain('/');
      expect(out).not.toContain('\\');
      expect(out).not.toContain('..');
      expect(out).toBe(out.toLowerCase());
    }
  });
});

describe('gameAssetSpecSchema', () => {
  it('rejects an empty name', () => {
    const result = gameAssetSpecSchema.safeParse({ name: '', description: 'a crate' });

    expect(result.success).toBe(false);
  });

  it('rejects a missing name', () => {
    expect(gameAssetSpecSchema.safeParse({ description: 'a crate' }).success).toBe(false);
  });

  it('rejects an empty description', () => {
    const result = gameAssetSpecSchema.safeParse({ name: 'crate', description: '' });

    expect(result.success).toBe(false);
  });

  it('rejects a missing description', () => {
    expect(gameAssetSpecSchema.safeParse({ name: 'crate' }).success).toBe(false);
  });

  it('rejects an unknown category', () => {
    const result = gameAssetSpecSchema.safeParse({
      name: 'crate',
      description: 'a crate',
      category: 'spaceship',
    });

    expect(result.success).toBe(false);
  });

  it('applies output defaults when output is supplied but empty', () => {
    const parsed = gameAssetSpecSchema.parse({ name: 'crate', description: 'a crate', output: {} });

    expect(parsed.output).toEqual({ pbr: true, textureQuality: 'detailed', format: 'glb' });
  });

  it('applies output defaults only to the fields that were omitted', () => {
    const parsed = gameAssetSpecSchema.parse({
      name: 'crate',
      description: 'a crate',
      output: { format: 'usdz' },
    });

    expect(parsed.output).toEqual({ pbr: true, textureQuality: 'detailed', format: 'usdz' });
  });

  it('leaves output undefined when it is not supplied at all', () => {
    const parsed = gameAssetSpecSchema.parse({ name: 'crate', description: 'a crate' });

    expect(parsed.output).toBeUndefined();
  });

  it('accepts a full spec unchanged', () => {
    const result = gameAssetSpecSchema.safeParse(FULL_SPEC);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(FULL_SPEC);
    }
  });

  it('accepts a minimal spec', () => {
    const result = gameAssetSpecSchema.safeParse({ name: 'x', description: 'a crate' });

    expect(result.success).toBe(true);
  });

  it('rejects a non-positive dimension', () => {
    const result = gameAssetSpecSchema.safeParse({
      name: 'crate',
      description: 'a crate',
      dimensionsMeters: { width: 0 },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a fractional triangle budget', () => {
    const result = gameAssetSpecSchema.safeParse({
      name: 'crate',
      description: 'a crate',
      geometry: { targetTriangleCount: 1.5 },
    });

    expect(result.success).toBe(false);
  });
});
