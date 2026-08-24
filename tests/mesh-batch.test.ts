/**
 * Tests for the batch preparation loop.
 *
 * The pipeline itself is already covered by the single-asset tests. What is
 * only true of a batch is its behaviour under partial failure: an unattended
 * forty-item run must not be stopped by item three, must not silently skip the
 * rest, and must not pay to rewrite meshes that were already fine.
 *
 * The dependencies are fakes that COUNT their calls, because "did not
 * normalize" is a claim about work not done, and only a counter can prove it.
 */

import { describe, expect, it } from 'vitest';
import type { AssetInspection } from '../src/inspection/gltf.js';
import { runMeshBatch, type MeshBatchDeps, type MeshBatchOptions } from '../src/domain/mesh-batch.js';

function inspection(overrides: Partial<AssetInspection> = {}): AssetInspection {
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

interface Harness {
  deps: MeshBatchDeps;
  normalizeCalls: string[];
  inspectCalls: string[];
}

/**
 * `broken` names sources that fail validation until normalized; `missing` names
 * sources whose `access` rejects. Normalized output always inspects clean
 * unless `repairFails` says otherwise.
 */
function harness(opts: {
  broken?: string[];
  missing?: string[];
  normalizeThrows?: string[];
  repairFails?: boolean;
  blenderAvailable?: boolean;
} = {}): Harness {
  const broken = new Set(opts.broken ?? []);
  const missing = new Set(opts.missing ?? []);
  const throws = new Set(opts.normalizeThrows ?? []);
  const normalized = new Set<string>();
  const normalizeCalls: string[] = [];
  const inspectCalls: string[] = [];

  return {
    normalizeCalls,
    inspectCalls,
    deps: {
      blenderAvailable: opts.blenderAvailable ?? true,
      async access(file) {
        if (missing.has(file)) throw new Error(`ENOENT: no such file, access '${file}'`);
      },
      async mkdir() {},
      async inspect(file) {
        inspectCalls.push(file);
        if (normalized.has(file)) {
          return inspection({ hasUVs: !opts.repairFails });
        }
        return inspection({ hasUVs: !broken.has(file) });
      },
      async normalize(source, target) {
        normalizeCalls.push(source);
        if (throws.has(source)) throw new Error(`Blender exited non-zero for ${source}`);
        normalized.add(target);
        return { objectsUnwrapped: 2, trianglesBefore: 3183, trianglesAfter: 1750 };
      },
    },
  };
}

const OPTIONS: MeshBatchOptions = { normalize: true, skipAlreadyValid: true, policy: {} };

describe('a batch survives its bad items', () => {
  it('processes every remaining item after one fails', async () => {
    const h = harness({ missing: ['/a/two.glb'] });
    const result = await runMeshBatch(['/a/one.glb', '/a/two.glb', '/a/three.glb'], OPTIONS, h.deps);

    expect(result.total).toBe(3);
    expect(result.failed).toBe(1);
    // The item AFTER the failure is what proves the loop did not stop.
    expect(result.items[2]?.status).toBe('already_valid');
    expect(result.items[1]?.error).toContain('ENOENT');
  });

  it('rejects a non-glTF path as that item, not as the whole batch', async () => {
    const h = harness();
    const result = await runMeshBatch(['/a/one.glb', '/a/two.fbx'], OPTIONS, h.deps);

    expect(result.alreadyValid).toBe(1);
    expect(result.items[1]?.error).toContain('.glb or .gltf');
  });

  it('reports a normalizer crash against its own item and continues', async () => {
    const h = harness({ broken: ['/a/one.glb', '/a/two.glb'], normalizeThrows: ['/a/one.glb'] });
    const result = await runMeshBatch(['/a/one.glb', '/a/two.glb'], OPTIONS, h.deps);

    expect(result.items[0]?.status).toBe('failed');
    expect(result.items[0]?.error).toContain('Blender exited non-zero');
    expect(result.items[1]?.status).toBe('prepared');
  });

  it('counts every item exactly once across the three outcomes', async () => {
    const h = harness({ broken: ['/a/two.glb'], missing: ['/a/three.glb'] });
    const result = await runMeshBatch(['/a/one.glb', '/a/two.glb', '/a/three.glb'], OPTIONS, h.deps);

    expect(result.prepared + result.alreadyValid + result.failed).toBe(result.total);
  });
});

describe('work not done is proven by a counter', () => {
  it('never normalizes a mesh that already passes', async () => {
    const h = harness({ broken: ['/a/two.glb'] });
    await runMeshBatch(['/a/one.glb', '/a/two.glb', '/a/three.glb'], OPTIONS, h.deps);

    expect(h.normalizeCalls).toEqual(['/a/two.glb']);
  });

  it('normalizes nothing at all when normalize is false', async () => {
    const h = harness({ broken: ['/a/one.glb', '/a/two.glb'] });
    const result = await runMeshBatch(
      ['/a/one.glb', '/a/two.glb'],
      { ...OPTIONS, normalize: false },
      h.deps,
    );

    expect(h.normalizeCalls).toHaveLength(0);
    expect(result.failed).toBe(2);
    // Report-only still has to say WHAT is wrong, or it is not a report.
    expect(result.items[0]?.failures).toContain('uvs_present');
  });

  it('reports rather than repairing when Blender is absent, and says so', async () => {
    const h = harness({ broken: ['/a/one.glb'], blenderAvailable: false });
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, h.deps);

    expect(h.normalizeCalls).toHaveLength(0);
    expect(result.blenderAvailable).toBe(false);
    expect(result.items[0]?.error).toContain('Blender not found');
    expect(result.items[0]?.failures).toContain('uvs_present');
  });

  it('re-normalizes an already-valid mesh when asked to', async () => {
    const h = harness();
    await runMeshBatch(['/a/one.glb'], { ...OPTIONS, skipAlreadyValid: false }, h.deps);

    expect(h.normalizeCalls).toEqual(['/a/one.glb']);
  });
});

describe('the verdict tracks the repair, not the attempt', () => {
  it('marks an item prepared only when it validates AFTER normalizing', async () => {
    const h = harness({ broken: ['/a/one.glb'] });
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, h.deps);

    expect(result.items[0]).toMatchObject({
      status: 'prepared',
      passedBefore: false,
      passedAfter: true,
      unwrapped: 2,
      trianglesBefore: 3183,
      trianglesAfter: 1750,
    });
  });

  it('still fails an item whose normalization ran but did not fix it', async () => {
    const h = harness({ broken: ['/a/one.glb'], repairFails: true });
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, h.deps);

    // A normalizer that returned a receipt is not the same as a repaired mesh.
    expect(h.normalizeCalls).toEqual(['/a/one.glb']);
    expect(result.items[0]?.status).toBe('failed');
    expect(result.items[0]?.failures).toContain('uvs_present');
    expect(result.prepared).toBe(0);
  });
});
