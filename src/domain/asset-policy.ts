/**
 * Is this asset shippable?
 *
 * `inspectGltf` already reports what a file contains and flags suspicious
 * things as prose. That answers "what is in it", not "may it ship" — which is a
 * question about a project's standards, not about the file.
 *
 * So this is a pure function over an inspection plus a policy: no I/O, no
 * provider, fully testable, and easy to point at a studio whose thresholds
 * differ from ours. Defaults are deliberately conservative but every one of
 * them is overridable, because an asset failing someone else's house style is
 * not a defect.
 */

import type { AssetInspection } from '../inspection/gltf.js';

export interface GameAssetPolicy {
  /** UVs are required to texture anything at all. */
  requireUVs: boolean;
  requireNormals: boolean;
  /** Tangents matter only when a normal map is actually bound. */
  requireTangentsWithNormalMap: boolean;
  requireBaseColorTexture: boolean;
  maxTriangles?: number;
  maxMaterials?: number;
  /** Smallest acceptable texture edge, in pixels. */
  minTextureSize?: number;
  requirePowerOfTwoTextures: boolean;
  /** Largest acceptable bounding-box edge, in metres. Catches unit-scale errors. */
  maxDimensionMeters?: number;
  /** Smallest acceptable bounding-box edge, in metres. Catches collapsed meshes. */
  minDimensionMeters?: number;
}

export const DEFAULT_POLICY: GameAssetPolicy = {
  requireUVs: true,
  requireNormals: true,
  requireTangentsWithNormalMap: true,
  requireBaseColorTexture: false,
  maxTriangles: 200_000,
  maxMaterials: 16,
  minTextureSize: 1024,
  requirePowerOfTwoTextures: true,
  maxDimensionMeters: 1000,
  minDimensionMeters: 0.001,
};

export type CheckSeverity = 'error' | 'warning';

export interface PolicyCheck {
  id: string;
  severity: CheckSeverity;
  passed: boolean;
  /** What the asset actually is. */
  actual: string;
  /** What the policy asked for. */
  expected: string;
  /** Why it matters, in terms of what breaks — not a restatement of the rule. */
  consequence?: string;
}

export interface ValidationReport {
  passed: boolean;
  errorCount: number;
  warningCount: number;
  checks: PolicyCheck[];
  /** Prose findings from the inspector, carried through rather than discarded. */
  inspectorWarnings: string[];
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

export function evaluateAsset(
  inspection: AssetInspection,
  overrides: Partial<GameAssetPolicy> = {},
): ValidationReport {
  const policy: GameAssetPolicy = { ...DEFAULT_POLICY, ...overrides };
  const checks: PolicyCheck[] = [];

  const add = (check: PolicyCheck): void => {
    checks.push(check);
  };

  // The attribute checks answer "do the DRAWN primitives carry this?", so with
  // no drawn primitive there is nothing to answer about. Evaluating anyway made
  // the report state something FALSE about the file: `hasUVs` is
  // `primitiveCount > 0 && missingUv === 0`, so zero drawn primitives produced
  // "at least one primitive has no TEXCOORD_0" for a file whose every primitive
  // is fully unwrapped. `has_geometry` below already names the real cause once;
  // three errors for one cause, two of them untrue, is worse than one that is.
  const anythingDrawn = inspection.primitiveCount > 0;

  if (policy.requireUVs && anythingDrawn) {
    add({
      id: 'uvs_present',
      severity: 'error',
      passed: inspection.hasUVs,
      actual: inspection.hasUVs ? 'every primitive has TEXCOORD_0' : 'at least one primitive has no TEXCOORD_0',
      expected: 'every primitive carries UV coordinates',
      consequence: 'Without UVs the mesh cannot be textured at all — not by a generator, not by hand.',
    });
  }

  if (policy.requireNormals && anythingDrawn) {
    add({
      id: 'normals_present',
      severity: 'error',
      passed: inspection.hasNormals,
      actual: inspection.hasNormals ? 'every primitive has NORMAL' : 'at least one primitive has no NORMAL',
      expected: 'every primitive carries normals',
      consequence: 'Missing normals leave lighting to a renderer guess, usually reading as faceted or black.',
    });
  }

  if (policy.requireTangentsWithNormalMap && inspection.pbr.hasNormalTexture) {
    add({
      id: 'tangents_for_normal_map',
      severity: 'error',
      passed: inspection.hasTangents,
      actual: inspection.hasTangents ? 'tangents present' : 'a normal map is bound but tangents are absent',
      expected: 'tangents whenever a normal map is bound',
      consequence:
        'A normal map without tangents is sampled against a guessed basis, so the surface lights wrongly in a way that looks like a shading bug rather than a missing attribute.',
    });
  }

  // The THIRD site of the same gate, and it was missed when the other two were
  // fixed. On a file that draws nothing this reported "no base colour texture"
  // at severity `error` about a material that binds one — the identical
  // falsehood uvs_present and normals_present were gated to stop.
  if (policy.requireBaseColorTexture && anythingDrawn) {
    add({
      id: 'base_color_texture',
      severity: 'error',
      passed: inspection.pbr.hasBaseColorTexture,
      actual: inspection.pbr.hasBaseColorTexture ? 'base colour texture bound' : 'no base colour texture',
      expected: 'a base colour texture',
      consequence: 'An untextured asset reads as flat colour regardless of lighting.',
    });
  }

  if (policy.maxTriangles !== undefined) {
    add({
      id: 'triangle_budget',
      severity: 'error',
      passed: inspection.triangleCount <= policy.maxTriangles,
      actual: `${inspection.triangleCount} triangles`,
      expected: `at most ${policy.maxTriangles}`,
      consequence: 'Over budget costs frame time on every instance drawn.',
    });
  }

  if (policy.maxMaterials !== undefined) {
    add({
      id: 'material_count',
      severity: 'warning',
      passed: inspection.materialCount <= policy.maxMaterials,
      actual: `${inspection.materialCount} materials`,
      expected: `at most ${policy.maxMaterials}`,
      consequence: 'Each material is a separate draw call unless the pipeline batches them.',
    });
  }

  if (policy.minTextureSize !== undefined && inspection.textureResolutions.length > 0) {
    const small = inspection.textureResolutions.filter(
      (texture) => Math.min(texture.width, texture.height) < (policy.minTextureSize ?? 0),
    );
    add({
      id: 'texture_resolution',
      severity: 'warning',
      passed: small.length === 0,
      actual:
        small.length === 0
          ? `all ${inspection.textureResolutions.length} textures at or above ${policy.minTextureSize}px`
          : `${small.length} texture(s) below ${policy.minTextureSize}px (smallest ${Math.min(
              ...small.map((texture) => Math.min(texture.width, texture.height)),
            )}px)`,
      expected: `every texture at least ${policy.minTextureSize}px on its shortest edge`,
      consequence: 'Under-resolution textures blur under close inspection and cannot be sharpened later.',
    });
  }

  if (policy.requirePowerOfTwoTextures && inspection.textureResolutions.length > 0) {
    const npot = inspection.textureResolutions.filter(
      (texture) => !isPowerOfTwo(texture.width) || !isPowerOfTwo(texture.height),
    );
    add({
      id: 'power_of_two_textures',
      severity: 'warning',
      passed: npot.length === 0,
      actual: npot.length === 0 ? 'all textures power-of-two' : `${npot.length} non-power-of-two texture(s)`,
      expected: 'power-of-two dimensions',
      consequence: 'Non-power-of-two textures can lose mipmapping or block compression on some targets.',
    });
  }

  const size = inspection.boundingBox.sizeMeters;
  const finite = size.every((value) => Number.isFinite(value));
  // An all-zero box from a file with no finite vertex is not a measurement, and
  // reporting "0.000 x 0.000 x 0.000 m" as a passing bound says otherwise.
  const measured = finite && !inspection.boundingBoxEmpty;
  add({
    id: 'bounding_box_finite',
    severity: 'error',
    passed: measured,
    actual: !finite
      ? 'non-finite bounds'
      : inspection.boundingBoxEmpty
        ? 'no finite vertex position was found, so there are no bounds to report'
        : `${size.map((v) => v.toFixed(3)).join(' x ')} m`,
    expected: 'finite bounds',
    consequence: 'Non-finite bounds produce a NaN view matrix in anything that frames the asset.',
  });

  // Dimensions are only asked when something was actually measured. Judging a
  // placeholder box produced "smallest edge 0.000000 m" at severity `error`
  // about a file whose real problem — no drawable geometry — has_geometry
  // already names once.
  if (measured) {
    const largest = Math.max(...size);
    const smallest = Math.min(...size);
    if (policy.maxDimensionMeters !== undefined) {
      add({
        id: 'max_dimension',
        severity: 'warning',
        passed: largest <= policy.maxDimensionMeters,
        actual: `largest edge ${largest.toFixed(3)} m`,
        expected: `at most ${policy.maxDimensionMeters} m`,
        consequence: 'An asset far larger than expected usually means the export used the wrong unit scale.',
      });
    }
    if (policy.minDimensionMeters !== undefined) {
      add({
        id: 'min_dimension',
        severity: 'error',
        passed: smallest >= policy.minDimensionMeters,
        actual: `smallest edge ${smallest.toFixed(6)} m`,
        expected: `at least ${policy.minDimensionMeters} m`,
        consequence: 'A collapsed axis means the mesh is flat or empty, whatever its triangle count says.',
      });
    }
  }

  add({
    id: 'has_geometry',
    severity: 'error',
    passed: inspection.triangleCount > 0,
    actual: `${inspection.triangleCount} triangles`,
    expected: 'at least one triangle',
    consequence: 'A file can parse cleanly and still contain nothing to draw.',
  });

  const errorCount = checks.filter((check) => !check.passed && check.severity === 'error').length;
  const warningCount = checks.filter((check) => !check.passed && check.severity === 'warning').length;

  return {
    // Warnings never fail the asset; they are judgement calls, not defects.
    passed: errorCount === 0,
    errorCount,
    warningCount,
    checks,
    inspectorWarnings: inspection.warnings,
  };
}
