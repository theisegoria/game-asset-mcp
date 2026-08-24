/**
 * Tests for the optional Blender-backed normalize path.
 *
 * Blender is an optional dependency, so the discovery and refusal behaviour is
 * tested unconditionally while the tests that actually invoke it are gated with
 * `skipIf` — a machine without Blender reports them SKIPPED rather than passing
 * for work that never ran.
 */

import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import pathModule from 'node:path';
import { existsSync as existsSyncFs, linkSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveNormalizeTarget } from '../src/domain/normalize-target.js';
import os from 'node:os';
import { findBlender, packagedScript, requireBlender, runBlenderScript } from '../src/util/blender.js';

const blender = findBlender();
const haveBlender = Boolean(blender);

// A real mesh confirmed to carry NO UV coordinates — the case this tool exists
// for. Committed here rather than read from a sibling checkout: this test used
// to read the game repo's copy, and repairing that copy turned this red for a
// change that was correct. A test may not pin a fact about a file it does not own.
const uvlessMesh = fileURLToPath(new URL('./fixtures/real/uvless_alien_needler.glb', import.meta.url));
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
  // Real files, real symlinks, real hardlinks. A fake identity function would
  // prove nothing about aliasing: the whole defect was that a path is not a
  // file, and only the filesystem can settle which file a path names.
  let work: string;
  let source: string;

  const realDeps = {
    fileIdentity: async (target: string) => {
      try {
        const info = statSync(target);
        return { dev: info.dev, ino: info.ino };
      } catch {
        return null;
      }
    },
    reserve: async (dir: string, fileName: string) => {
      const target = pathModule.join(dir, fileName);
      writeFileSync(target, '');
      return target;
    },
    claimExclusive: async (target: string) => {
      try {
        writeFileSync(target, '', { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    },
  };

  beforeEach(() => {
    work = realpathSync(mkdtempSync(pathModule.join(tmpdir(), 'normalize-target-')));
    source = pathModule.join(work, 'crate.glb');
    writeFileSync(source, 'ORIGINAL-MESH');
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const resolve = async (outputPath?: string, overwrite?: boolean) =>
    (await resolveNormalizeTarget(
      {
        source,
        sourceExtension: '.glb',
        outputDir: work,
        ...(outputPath !== undefined ? { outputPath } : {}),
        ...(overwrite !== undefined ? { overwrite } : {}),
      },
      realDeps,
    )).target;

  it('refuses the literal input path', async () => {
    await expect(resolve(source)).rejects.toThrow(/destroy the original/);
  });

  it('refuses a SYMLINK that points at the input', async () => {
    const link = pathModule.join(work, 'link.glb');
    symlinkSync(source, link);
    await expect(resolve(link)).rejects.toThrow(/destroy the original/);
  });

  it('refuses a HARDLINK to the input', async () => {
    const hard = pathModule.join(work, 'hard.glb');
    linkSync(source, hard);
    await expect(resolve(hard)).rejects.toThrow(/destroy the original/);
  });

  it('refuses the input reached through a SYMLINKED PARENT directory', async () => {
    const linkedDir = pathModule.join(work, 'alias');
    symlinkSync(work, linkedDir);
    await expect(resolve(pathModule.join(linkedDir, 'crate.glb'))).rejects.toThrow(/destroy the original/);
  });

  // No symlink, no privilege — just a capital letter. On a case-insensitive
  // volume this is the same file, and capitalised asset names are ordinary.
  const caseInsensitive = (() => {
    try {
      const probe = mkdtempSync(pathModule.join(tmpdir(), 'case-probe-'));
      writeFileSync(pathModule.join(probe, 'a.txt'), 'x');
      const same = existsSyncFs(pathModule.join(probe, 'A.txt'));
      rmSync(probe, { recursive: true, force: true });
      return same;
    } catch {
      return false;
    }
  })();

  it.skipIf(!caseInsensitive)('refuses a path differing only by CASE', async () => {
    await expect(resolve(pathModule.join(work, 'Crate.glb'))).rejects.toThrow(/destroy the original/);
  });

  it('refuses in place even when overwrite is requested', async () => {
    const link = pathModule.join(work, 'link.glb');
    symlinkSync(source, link);
    // overwrite:true means "replace that OTHER file", never "shred my input".
    await expect(resolve(link, true)).rejects.toThrow(/destroy the original/);
  });

  it('does not recommend overwrite:true when the target aliases the source', async () => {
    const link = pathModule.join(work, 'link.glb');
    symlinkSync(source, link);
    // The old refusal fired the WRONG branch and told the caller to pass the
    // exact flag that destroys the mesh.
    await expect(resolve(link)).rejects.not.toThrow(/Pass overwrite:true/);
  });

  // Blender's exporter REWRITES the extension: given ".../crate" it writes
  // ".../crate.glb". Checking the literal argument therefore guarded a file
  // nobody was going to touch, while the write landed on the source and
  // destroyed it. These join the check to the writer's actual behaviour — the
  // seam no test crossed, which is exactly where the defect lived.
  it('refuses an extensionless outputPath that resolves onto the source', async () => {
    // "crate" becomes "crate.glb", which IS the source.
    await expect(resolve(pathModule.join(work, 'crate'))).rejects.toThrow(/destroy the original/);
  });

  it('refuses a .gltf outputPath rather than silently rewriting it to .glb', async () => {
    await expect(resolve(pathModule.join(work, 'crate.gltf'))).rejects.toThrow(/must end in \.glb/);
  });

  it('refuses any non-glb extension', async () => {
    await expect(resolve(pathModule.join(work, 'out.fbx'))).rejects.toThrow(/must end in \.glb/);
    await expect(resolve(pathModule.join(work, 'out.txt'))).rejects.toThrow(/must end in \.glb/);
  });

  it('appends .glb to an extensionless path and returns the real write target', async () => {
    // The returned path must be what Blender writes, or the read-back that
    // proves the file exists is looking at the wrong file.
    await expect(resolve(pathModule.join(work, 'fresh'))).resolves.toBe(pathModule.join(work, 'fresh.glb'));
  });

  it('protects an existing file reached only through the extension rewrite', async () => {
    const precious = pathModule.join(work, 'precious.glb');
    writeFileSync(precious, 'REVIEWED-RESULT');
    // overwrite defaults to false, and "precious" resolves onto precious.glb.
    await expect(resolve(pathModule.join(work, 'precious'))).rejects.toThrow(/refusing to overwrite/);
  });

  it('refuses to silently replace a genuinely different existing file', async () => {
    const other = pathModule.join(work, 'reviewed.glb');
    writeFileSync(other, 'REVIEWED');
    await expect(resolve(other)).rejects.toThrow(/refusing to overwrite/);
  });

  it('replaces a different existing file when overwrite is explicit', async () => {
    const other = pathModule.join(work, 'reviewed.glb');
    writeFileSync(other, 'REVIEWED');
    await expect(resolve(other, true)).resolves.toBe(other);
  });

  it('accepts a free explicit path', async () => {
    const free = pathModule.join(work, 'out.glb');
    await expect(resolve(free)).resolves.toBe(free);
  });

  // The explicit branch used an existence CHECK, which decides at t=0 about a
  // write that happens seconds later. Two concurrent calls both passed it and
  // one caller's output was silently destroyed, its receipt reporting a healthy
  // hash for bytes that no longer existed. These use a REAL exclusive create.
  it('admits only the first of two claims on the same explicit path', async () => {
    const free = pathModule.join(work, 'contested.glb');
    await expect(resolve(free)).resolves.toBe(free);
    // The first claim CREATED the file, so the second must lose.
    await expect(resolve(free)).rejects.toThrow(/refusing to overwrite/);
  });

  it('reports the explicit branch as reserved when it created the file', async () => {
    const free = pathModule.join(work, 'fresh-claim.glb');
    const result = await resolveNormalizeTarget(
      { source, sourceExtension: '.glb', outputDir: work, outputPath: free },
      realDeps,
    );
    // reserved drives cleanup on failure. Reporting false here leaked the file.
    expect(result.reserved).toBe(true);
    expect(existsSyncFs(free)).toBe(true);
  });

  it('reports NOT reserved when overwrite replaces someone else\'s file', async () => {
    const taken = pathModule.join(work, 'theirs.glb');
    writeFileSync(taken, 'SOMEONE-ELSES');
    const result = await resolveNormalizeTarget(
      { source, sourceExtension: '.glb', outputDir: work, outputPath: taken, overwrite: true },
      realDeps,
    );
    // We did not create it, so removing it on failure is not ours to do.
    expect(result.reserved).toBe(false);
  });

  it('treats an empty outputPath as absent, and still reports the reservation', async () => {
    // "" is falsy, so it takes the reserve branch and CREATES a file. The tool
    // used to recompute this as `outputPath === undefined`, believe it held
    // nothing, and leak it. One fact, one place.
    const result = await resolveNormalizeTarget(
      { source, sourceExtension: '.glb', outputDir: work, outputPath: '' },
      realDeps,
    );
    expect(result.reserved).toBe(true);
    expect(pathModule.basename(result.target)).toBe('crate_normalized.glb');
  });

  it('reserves a derived name when no outputPath is given', async () => {
    await expect(resolve()).resolves.toBe(pathModule.join(work, 'crate_normalized.glb'));
  });

  it('strips an uppercase extension rather than embedding it', async () => {
    const shouty = pathModule.join(work, 'BARREL.GLB');
    writeFileSync(shouty, 'x');
    await expect(
      resolveNormalizeTarget(
        { source: shouty, sourceExtension: '.GLB', outputDir: work },
        realDeps,
      ).then((r) => r.target),
    ).resolves.toBe(pathModule.join(work, 'BARREL_normalized.glb'));
  });
});

// Tool-level, because the defect lives in the tool: `reservationHeld` was
// recomputed there as `args.outputPath === undefined` while the resolver
// branched on `!request.outputPath`. For an explicit outputPath the resolver
// CREATES the file and the tool believed it held nothing, so a failure left an
// orphan. The domain tests cannot see this — the two disagreeing tests are on
// opposite sides of the call.
describe('the tool cleans up after itself', () => {
  it('leaves no orphan when an explicit outputPath fails', async () => {
    const dir = await tmpDir();
    const broken = path.join(dir, 'broken.glb');
    await fs.writeFile(broken, 'not a glb at all');
    const output = path.join(dir, 'explicit.glb');

    // A STUB Blender that always fails, rather than skipping without a real
    // one. The leak happens when Blender fails, so the test needs a failure,
    // not an installation — and gating it on real Blender meant CI, which has
    // none, never exercised a guard against a file leak.
    const stub = path.join(dir, 'blender-stub.sh');
    await fs.writeFile(stub, '#!/bin/sh\necho "stub blender failing on purpose" >&2\nexit 1\n');
    await fs.chmod(stub, 0o755);

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/server.js', import.meta.url))],
      env: {
        ...process.env,
        ASSET_LOG_LEVEL: 'error',
        ASSET_OUTPUT_DIR: path.join(dir, 'ws'),
        BLENDER_PATH: stub,
      },
    });
    const client = new Client({ name: 'orphan-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      await client.callTool({
        name: 'normalize_mesh',
        arguments: { modelPath: broken, outputPath: output },
      });
      // The reservation created explicit.glb to claim the name. Blender then
      // fails on the corrupt input, so nothing may remain at that path.
      await expect(fs.access(output)).rejects.toThrow();
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 120_000);
});
