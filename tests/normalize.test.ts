/**
 * Tests for the optional Blender-backed normalize path.
 *
 * Blender is an optional dependency, so the discovery and refusal behaviour is
 * tested unconditionally while the tests that actually invoke it are gated with
 * `skipIf` — a machine without Blender reports them SKIPPED rather than passing
 * for work that never ran.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import pathModule from 'node:path';
import { resolveNormalizeTarget } from '../src/domain/normalize-target.js';
import os from 'node:os';
import { findBlender, packagedScript, requireBlender, runBlenderScript } from '../src/util/blender.js';

const blender = findBlender();
const haveBlender = Boolean(blender);

// A real mesh confirmed to carry NO UV coordinates — the case this tool exists
// for. Committed here rather than read from a sibling checkout: this test used
// to read the game repo's copy, and repairing that copy turned this red for a
// change that was correct. A test may not pin a fact about a file it does not own.
const uvlessMesh = path.resolve('tests/fixtures/real/uvless_alien_needler.glb');
const haveFixture = existsSync(uvlessMesh);

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-'));
  scratch.push(dir);
  return dir;
}

describe('optional dependency discovery', () => {
  it('refuses with actionable instructions when the override points nowhere', () => {
    try {
      requireBlender({ BLENDER_PATH: '/definitely/not/here/blender' } as NodeJS.ProcessEnv);
      throw new Error('should have refused');
    } catch (err) {
      const described = err as { code?: string; message?: string };
      expect(described.code).toBe('CONFIG_MISSING');
      // A bare "not found" leaves a macOS user stuck, because Blender ships an
      // .app bundle that is deliberately not on PATH.
      expect(described.message).toContain('BLENDER_PATH');
      expect(described.message).toContain('Blender.app');
    }
  });

  it('an explicit override wins over discovery', () => {
    expect(findBlender({ BLENDER_PATH: '/nope' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('ships the normalize script inside the package', () => {
    const script = packagedScript('blender_normalize.py');
    expect(existsSync(script)).toBe(true);
    expect(script.endsWith('blender_normalize.py')).toBe(true);
  });

  it('reports whether Blender is present without throwing', () => {
    expect(typeof haveBlender).toBe('boolean');
  });
});

describe.skipIf(!haveBlender || !haveFixture)('normalizing a real UV-less mesh', () => {
  it('generates UVs, preserves the silhouette, and writes a real file', async () => {
    const dir = await tmpDir();
    const output = path.join(dir, 'normalized.glb');

    const result = await runBlenderScript(
      packagedScript('blender_normalize.py'),
      {
        input: uvlessMesh as string,
        output,
        unwrapMissingUVs: true,
        cleanGeometry: true,
        mergeDistance: 0.0001,
        normalizeMaterials: true,
        angleLimitDegrees: 66,
        islandMargin: 0.002,
      },
      { timeoutMs: 300_000 },
    );

    const receipt = result.receipt as Record<string, number>;
    // The decisive property: the mesh could not be textured before and can now.
    expect(receipt.objectsMissingUVsBefore).toBeGreaterThan(0);
    expect(receipt.objectsMissingUVsAfter).toBe(0);
    expect(receipt.objectsUnwrapped).toBeGreaterThan(0);

    const bytes = await fs.readFile(output);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // GLB magic, so we know an actual container was written rather than a stub.
    expect(bytes.subarray(0, 4).toString('utf8')).toBe('glTF');

    // Cleanup must not have eaten the model.
    const before = receipt.trianglesBefore ?? 0;
    const after = receipt.trianglesAfter ?? 0;
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(before * 0.5);
  }, 300_000);

  it('does not overwrite an existing UV layout', async () => {
    const dir = await tmpDir();
    const first = path.join(dir, 'pass1.glb');
    const second = path.join(dir, 'pass2.glb');
    const options = {
      unwrapMissingUVs: true,
      cleanGeometry: true,
      mergeDistance: 0.0001,
      normalizeMaterials: true,
      angleLimitDegrees: 66,
      islandMargin: 0.002,
    };

    await runBlenderScript(
      packagedScript('blender_normalize.py'),
      { ...options, input: uvlessMesh as string, output: first },
      { timeoutMs: 300_000 },
    );
    const again = await runBlenderScript(
      packagedScript('blender_normalize.py'),
      { ...options, input: first, output: second },
      { timeoutMs: 300_000 },
    );

    // The second pass sees UVs already present, so it must unwrap nothing —
    // re-unwrapping would silently discard an authored layout.
    const receipt = again.receipt as Record<string, number>;
    expect(receipt.objectsMissingUVsBefore).toBe(0);
    expect(receipt.objectsUnwrapped).toBe(0);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// Where normalize_mesh writes.
//
// An explicit outputPath was once written verbatim with no check: passing the
// input mesh as the output replaced the caller's own file in place and reported
// success, and an existing file at that path was destroyed silently — while the
// derived-name branch beside it went through an exclusive reservation. Both
// guards lived inside the tool handler, unreachable from any test, and mutants
// removing them passed the whole suite.
// ---------------------------------------------------------------------------
describe('choosing the output path', () => {
  const SOURCE = '/art/crate.glb';
  const deps = (existing: string[] = []) => {
    const taken = new Set(existing);
    const reserved: string[] = [];
    return {
      reserved,
      deps: {
        exists: async (target: string) => taken.has(target),
        reserve: async (dir: string, fileName: string) => {
          const target = pathModule.join(dir, fileName);
          reserved.push(target);
          return target;
        },
      },
    };
  };

  it('refuses to write over the input mesh, with no opt-out', async () => {
    const d = deps();
    await expect(
      resolveNormalizeTarget(
        { source: SOURCE, sourceExtension: '.glb', outputDir: '/art', outputPath: SOURCE },
        d.deps,
      ),
    ).rejects.toThrow(/destroy the original/);
  });

  it('still refuses in place even when overwrite is requested', async () => {
    const d = deps();
    // overwrite:true means "replace that other file", never "shred my input".
    await expect(
      resolveNormalizeTarget(
        { source: SOURCE, sourceExtension: '.glb', outputDir: '/art', outputPath: SOURCE, overwrite: true },
        d.deps,
      ),
    ).rejects.toThrow(/destroy the original/);
  });

  it('refuses to silently replace an existing file', async () => {
    const d = deps(['/art/reviewed.glb']);
    await expect(
      resolveNormalizeTarget(
        { source: SOURCE, sourceExtension: '.glb', outputDir: '/art', outputPath: '/art/reviewed.glb' },
        d.deps,
      ),
    ).rejects.toThrow(/refusing to overwrite/);
  });

  it('replaces an existing file when overwrite is explicit', async () => {
    const d = deps(['/art/reviewed.glb']);
    await expect(
      resolveNormalizeTarget(
        { source: SOURCE, sourceExtension: '.glb', outputDir: '/art', outputPath: '/art/reviewed.glb', overwrite: true },
        d.deps,
      ),
    ).resolves.toBe('/art/reviewed.glb');
  });

  it('accepts a free explicit path without reserving anything', async () => {
    const d = deps();
    await expect(
      resolveNormalizeTarget(
        { source: SOURCE, sourceExtension: '.glb', outputDir: '/art', outputPath: '/art/out.glb' },
        d.deps,
      ),
    ).resolves.toBe('/art/out.glb');
    expect(d.reserved).toHaveLength(0);
  });

  it('reserves a derived name when no outputPath is given', async () => {
    const d = deps();
    await expect(
      resolveNormalizeTarget(
        { source: SOURCE, sourceExtension: '.glb', outputDir: '/art' },
        d.deps,
      ),
    ).resolves.toBe(pathModule.join('/art', 'crate_normalized.glb'));
    expect(d.reserved).toHaveLength(1);
  });

  it('strips an uppercase extension rather than embedding it', async () => {
    const d = deps();
    await expect(
      resolveNormalizeTarget(
        { source: '/art/BARREL.GLB', sourceExtension: '.GLB', outputDir: '/art' },
        d.deps,
      ),
    ).resolves.toBe(pathModule.join('/art', 'BARREL_normalized.glb'));
  });
});
