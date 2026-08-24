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
import os from 'node:os';
import { findBlender, packagedScript, requireBlender, runBlenderScript } from '../src/util/blender.js';

const blender = findBlender();
const haveBlender = Boolean(blender);

function repositoryRoot(): string | undefined {
  let candidate = path.resolve('..');
  for (let depth = 0; depth < 4; depth += 1) {
    const guess = path.join(candidate, 'Genome Game');
    if (existsSync(path.join(guess, 'assets'))) return guess;
    candidate = path.resolve(candidate, '..');
  }
  return undefined;
}

const root = repositoryRoot();
// A mesh confirmed to carry NO UV coordinates — the case this tool exists for.
const uvlessMesh = root
  ? path.join(root, 'assets/vendored/models/mp_weapons/alien_needler.glb')
  : undefined;
const haveFixture = Boolean(uvlessMesh && existsSync(uvlessMesh));

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
