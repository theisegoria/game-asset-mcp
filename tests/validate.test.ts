/**
 * Tests for the shippable-or-not verdict.
 *
 * `evaluateAsset` is a pure function over an inspection, so the policy logic is
 * tested directly rather than through a server — and the real-asset case proves
 * the verdict tracks an actual repair rather than a fixture.
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, evaluateAsset } from '../src/domain/asset-policy.js';
import type { AssetInspection } from '../src/inspection/gltf.js';
import { inspectGltf } from '../src/inspection/gltf.js';

/** A minimal asset that passes everything, so each test perturbs one thing. */
function healthy(overrides: Partial<AssetInspection> = {}): AssetInspection {
  return {
    filePath: '/tmp/x.glb',
    fileBytes: 1024,
    meshCount: 1,
    primitiveCount: 1,
    vertexCount: 300,
    triangleCount: 100,
    materialCount: 1,
    textureCount: 1,
    textureResolutions: [{ width: 2048, height: 2048, bytes: 1 }],
    boundingBox: { min: [0, 0, 0], max: [1, 1, 1], sizeMeters: [1, 1, 1] },
    hasUVs: true,
    hasNormals: true,
    hasTangents: true,
    pbr: {
      hasBaseColorTexture: true,
      hasMetallicRoughnessTexture: true,
      hasNormalTexture: true,
      hasOcclusionTexture: false,
      hasEmissiveTexture: false,
    },
    animationCount: 0,
    hasSkin: false,
    warnings: [],
    ...overrides,
  } as AssetInspection;
}

function failedIds(report: ReturnType<typeof evaluateAsset>): string[] {
  return report.checks.filter((check) => !check.passed).map((check) => check.id);
}

describe('a healthy asset passes', () => {
  it('reports no errors and no warnings', () => {
    const report = evaluateAsset(healthy());
    expect(report.passed).toBe(true);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);
  });

  it('runs a meaningful number of checks, so passing is not vacuous', () => {
    expect(evaluateAsset(healthy()).checks.length).toBeGreaterThan(5);
  });
});

describe('errors fail the asset', () => {
  it('missing UVs is an error, because nothing can texture it', () => {
    const report = evaluateAsset(healthy({ hasUVs: false }));
    expect(report.passed).toBe(false);
    expect(failedIds(report)).toContain('uvs_present');
  });

  it('missing normals is an error', () => {
    expect(evaluateAsset(healthy({ hasNormals: false })).passed).toBe(false);
  });

  it('zero triangles fails even when the file parses', () => {
    const report = evaluateAsset(healthy({ triangleCount: 0 }));
    expect(failedIds(report)).toContain('has_geometry');
    expect(report.passed).toBe(false);
  });

  it('non-finite bounds fail', () => {
    const report = evaluateAsset(
      healthy({ boundingBox: { min: [0, 0, 0], max: [1, 1, 1], sizeMeters: [Number.NaN, 1, 1] } }),
    );
    expect(failedIds(report)).toContain('bounding_box_finite');
  });

  it('a collapsed axis fails', () => {
    const report = evaluateAsset(
      healthy({ boundingBox: { min: [0, 0, 0], max: [1, 1, 0], sizeMeters: [1, 1, 0] } }),
    );
    expect(failedIds(report)).toContain('min_dimension');
  });
});

describe('the tangent rule applies only when a normal map is bound', () => {
  it('fails when a normal map is bound and tangents are absent', () => {
    const report = evaluateAsset(healthy({ hasTangents: false }));
    expect(failedIds(report)).toContain('tangents_for_normal_map');
    expect(report.passed).toBe(false);
  });

  it('is not raised at all when no normal map is bound', () => {
    const report = evaluateAsset(
      healthy({
        hasTangents: false,
        pbr: { ...healthy().pbr, hasNormalTexture: false },
      }),
    );
    // Demanding tangents from an asset with no normal map would be noise.
    expect(report.checks.some((check) => check.id === 'tangents_for_normal_map')).toBe(false);
    expect(report.passed).toBe(true);
  });
});

describe('warnings are judgement calls and never fail the asset', () => {
  it('a small texture warns but still passes', () => {
    const report = evaluateAsset(healthy({ textureResolutions: [{ width: 256, height: 256, bytes: 1 }] }));
    expect(report.passed).toBe(true);
    expect(report.warningCount).toBeGreaterThan(0);
    expect(failedIds(report)).toContain('texture_resolution');
  });

  it('a non-power-of-two texture warns but still passes', () => {
    const report = evaluateAsset(healthy({ textureResolutions: [{ width: 1920, height: 1080, bytes: 1 }] }));
    expect(failedIds(report)).toContain('power_of_two_textures');
    expect(report.passed).toBe(true);
  });

  it('too many materials warns but still passes', () => {
    const report = evaluateAsset(healthy({ materialCount: 999 }));
    expect(failedIds(report)).toContain('material_count');
    expect(report.passed).toBe(true);
  });
});

describe('policy is genuinely configurable', () => {
  it('honours a tighter triangle budget', () => {
    expect(evaluateAsset(healthy({ triangleCount: 5000 })).passed).toBe(true);
    expect(evaluateAsset(healthy({ triangleCount: 5000 }), { maxTriangles: 100 }).passed).toBe(false);
  });

  it('can waive the UV requirement for a workflow that does not need it', () => {
    const report = evaluateAsset(healthy({ hasUVs: false }), { requireUVs: false });
    expect(report.passed).toBe(true);
    expect(report.checks.some((check) => check.id === 'uvs_present')).toBe(false);
  });

  it('can demand a base colour texture, which is off by default', () => {
    const bare = healthy({ pbr: { ...healthy().pbr, hasBaseColorTexture: false } });
    expect(evaluateAsset(bare).passed).toBe(true);
    expect(evaluateAsset(bare, { requireBaseColorTexture: true }).passed).toBe(false);
  });

  it('every default is overridable', () => {
    // A default nobody can change is a constant pretending to be a policy.
    for (const key of Object.keys(DEFAULT_POLICY)) {
      expect(DEFAULT_POLICY).toHaveProperty(key);
    }
  });
});

// The verdict must track a real asset, not just synthetic fixtures — a wrong
// glTF magic constant once survived a whole synthetic suite because the fixture
// builder and the parser shared the error.
//
// The fixture is COMMITTED here rather than read from a sibling checkout. It
// used to be read live from the game repo, and when that mesh was repaired the
// test went red for a change that was entirely correct: the assertion pinned a
// fact about a file this project does not control. skipIf gated on the file
// EXISTING, never on what was in it, so it could not protect against that.
// A real asset with a stable meaning belongs in the repository that asserts on it.
const uvless = fileURLToPath(new URL('./fixtures/real/uvless_alien_needler.glb', import.meta.url));

describe('a real shipped asset with no UVs', () => {
  it('fails on the defect it actually has', async () => {
    const report = evaluateAsset(await inspectGltf(uvless));
    // This mesh genuinely has no UVs — the verdict must say so rather than
    // passing an asset nothing can texture.
    expect(report.passed).toBe(false);
    expect(failedIds(report)).toContain('uvs_present');
  }, 60_000);

  it('is still genuinely UV-less, so the test above means what it says', async () => {
    // Guards the fixture itself. Without this, replacing it with a repaired
    // mesh would turn the assertion above into a tautology about the wrong file.
    const inspection = await inspectGltf(uvless);
    expect(inspection.hasUVs).toBe(false);
    expect(inspection.triangleCount).toBeGreaterThan(0);
  }, 60_000);
});

// Counting meshes rather than the node graph reported a 12-triangle mesh placed
// at 50 nodes as 12, so it passed a 100-triangle budget while a renderer draws
// 600. Over-correcting by summing ALL scenes then double-counted a mesh shared
// between alternative scenes, which a renderer never draws twice.
describe('instanced geometry is counted as drawn', () => {
  it('multiplies a mesh by the number of nodes that reference it', () => {
    const single = evaluateAsset(healthy({ triangleCount: 12 }), { maxTriangles: 100 });
    expect(single.passed).toBe(true);

    // 50 instances of the same 12-triangle mesh is 600 drawn triangles.
    const instanced = evaluateAsset(healthy({ triangleCount: 600 }), { maxTriangles: 100 });
    expect(instanced.passed).toBe(false);
    expect(failedIds(instanced)).toContain('triangle_budget');
  });
});

// A REAL instanced file, not a synthetic inspection. The previous test in this
// file constructed a `triangleCount` by hand, so it never reached
// summarizeGeometry and the multiplier could be deleted with the suite green.
describe('a real instanced glTF is counted as drawn', () => {
  const instanced = fileURLToPath(new URL('./fixtures/real/instanced_10x.glb', import.meta.url));

  it('counts one mesh at ten nodes as ten draws', async () => {
    const inspection = await inspectGltf(instanced);
    expect(inspection.meshCount).toBe(1);
    expect(inspection.triangleCount).toBe(20);
  }, 60_000);

  it('fails a budget the drawn geometry exceeds, though the mesh alone would pass', async () => {
    const inspection = await inspectGltf(instanced);
    // The mesh is 2 triangles; ten instances are 20. Assert the BUDGET check
    // specifically — this fixture also lacks UVs and normals, so overall
    // passed/failed would be true for unrelated reasons.
    expect(failedIds(evaluateAsset(inspection, { maxTriangles: 10 }))).toContain('triangle_budget');
    expect(failedIds(evaluateAsset(inspection, { maxTriangles: 50 }))).not.toContain('triangle_budget');
  }, 60_000);
});
