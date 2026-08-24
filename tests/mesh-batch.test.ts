/**
 * Tests for the batch preparation loop.
 *
 * Two halves, deliberately.
 *
 * The FAKE half covers behaviour under partial failure — an unattended
 * forty-item run must not stop at item three, must not skip the rest, and must
 * not rewrite meshes that were already fine. Those fakes count their calls,
 * because "did not normalize" is a claim about work NOT done.
 *
 * The REAL-FILESYSTEM half exists because the fake half was not enough. An
 * adversarial mutation run put five mutants past it, including one that wrote
 * every normalized mesh OVER ITS OWN SOURCE FILE and one that redirected all
 * output to /tmp. Both passed, because a fake normalizer that writes nothing
 * leaves no destination to assert on: the tests checked the bookkeeping and
 * never checked where a byte landed. So these use real files in a real temp
 * directory and assert on what is actually on disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync } from 'node:fs';

const FIXTURE_MESH = fileURLToPath(new URL('./fixtures/real/uvless_alien_needler.glb', import.meta.url));
import type { AssetInspection } from '../src/inspection/gltf.js';
import { runMeshBatch, type MeshBatchDeps, type MeshBatchOptions } from '../src/domain/mesh-batch.js';
import { createMeshBatchDeps } from '../src/tools/batch.js';

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
  mkdirCalls: string[];
  discarded: string[];
}

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
  const reserved = new Set<string>();
  const normalizeCalls: string[] = [];
  const inspectCalls: string[] = [];
  const mkdirCalls: string[] = [];
  const discarded: string[] = [];

  return {
    normalizeCalls,
    inspectCalls,
    mkdirCalls,
    discarded,
    deps: {
      blenderAvailable: opts.blenderAvailable ?? true,
      async access(file) {
        if (missing.has(file)) throw new Error(`ENOENT: no such file, access '${file}'`);
      },
      async mkdir(dir) {
        mkdirCalls.push(dir);
      },
      async isDirectory() {
        return true;
      },
      async fileIdentity() {
        return { dev: 1, ino: 1 };
      },
      async isSameFile() {
        return true;
      },
      async discardReservation(target) {
        discarded.push(target);
        reserved.delete(target);
      },
      async reserveOutputPath(dir, fileName) {
        const ext = path.extname(fileName);
        const stem = path.basename(fileName, ext);
        for (let attempt = 1; attempt <= 100; attempt += 1) {
          const candidate = path.join(dir, attempt === 1 ? fileName : `${stem}_${attempt}${ext}`);
          if (!reserved.has(candidate)) {
            reserved.add(candidate);
            return candidate;
          }
        }
        throw new Error('no free name');
      },
      async inspect(file) {
        inspectCalls.push(file);
        if (normalized.has(file)) return inspection({ hasUVs: !opts.repairFails });
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

  it('survives a non-string element without discarding the verdicts before it', async () => {
    const h = harness();
    // The MCP schema rejects this, but losing forty results to one bad element
    // is wrong no matter who calls the function.
    const result = await runMeshBatch(
      ['/a/one.glb', 42 as unknown as string, '/a/three.glb'],
      OPTIONS,
      h.deps,
    );

    expect(result.total).toBe(3);
    expect(result.items[0]?.status).toBe('already_valid');
    expect(result.items[1]?.status).toBe('failed');
    expect(result.items[2]?.status).toBe('already_valid');
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

  it('inspects a repaired mesh a second time, and a passing one only once', async () => {
    const h = harness({ broken: ['/a/two.glb'] });
    await runMeshBatch(['/a/one.glb', '/a/two.glb'], OPTIONS, h.deps);

    // The re-inspection is what makes "prepared" mean repaired rather than attempted.
    expect(h.inspectCalls.filter((f) => f === '/a/one.glb')).toHaveLength(1);
    expect(h.inspectCalls.filter((f) => f === '/a/two.glb')).toHaveLength(1);
    expect(h.inspectCalls.some((f) => f.endsWith('two_normalized.glb'))).toBe(true);
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

    expect(h.normalizeCalls).toEqual(['/a/one.glb']);
    expect(result.items[0]?.status).toBe('failed');
    expect(result.items[0]?.failures).toContain('uvs_present');
    expect(result.prepared).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Real files, real directories. These assert on bytes, not bookkeeping.
// ---------------------------------------------------------------------------

describe('where the bytes actually land', () => {
  let work: string;
  let outDir: string;

  const SOURCE_MARKER = 'ORIGINAL-SOURCE-CONTENT';

  /** Deps whose normalizer really writes, so a destination can be observed. */
  function realDeps(broken: Set<string>): MeshBatchDeps {
    const normalized = new Set<string>();
    return {
      blenderAvailable: true,
      access: async (file) => {
        if (!existsSync(file)) throw new Error(`ENOENT: ${file}`);
      },
      mkdir: async (dir) => {
        mkdirSync(dir, { recursive: true });
      },
      isDirectory: async (dir) => existsSync(dir),
      fileIdentity: async () => ({ dev: 1, ino: 1 }),
      isSameFile: async () => true,
      discardReservation: async (target) => {
        rmSync(target, { force: true });
      },
      reserveOutputPath: async (dir, fileName) => {
        const ext = path.extname(fileName);
        const stem = path.basename(fileName, ext);
        for (let attempt = 1; attempt <= 100; attempt += 1) {
          const candidate = path.join(dir, attempt === 1 ? fileName : `${stem}_${attempt}${ext}`);
          if (!existsSync(candidate)) {
            writeFileSync(candidate, ''); // exclusive-create stand-in
            return candidate;
          }
        }
        throw new Error('no free name');
      },
      inspect: async (file) => inspection({ hasUVs: normalized.has(file) || !broken.has(file) }),
      normalize: async (source, target) => {
        writeFileSync(target, `NORMALIZED from ${source}`);
        normalized.add(target);
        return { objectsUnwrapped: 1, trianglesBefore: 10, trianglesAfter: 8 };
      },
    };
  }

  function makeMesh(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    writeFileSync(file, SOURCE_MARKER);
    return file;
  }

  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'mesh-batch-'));
    outDir = path.join(work, 'out');
    // A caller-named outputDir must exist: the batch no longer creates one,
    // because mkdir -p on an unvalidated path built directory trees anywhere.
    mkdirSync(outDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('writes into the requested outputDir and nowhere else', async () => {
    const a = makeMesh(path.join(work, 'src'), 'crate.glb');
    const result = await runMeshBatch([a], { ...OPTIONS, outputDir: outDir }, realDeps(new Set([a])));

    expect(result.items[0]?.status).toBe('prepared');
    expect(result.items[0]?.normalizedPath).toBeDefined();
    // The output is IN the requested directory — not beside the source, not /tmp.
    expect(path.dirname(result.items[0]!.normalizedPath as string)).toBe(outDir);
    expect(readdirSync(outDir)).toHaveLength(1);
    expect(readdirSync(path.join(work, 'src'))).toEqual(['crate.glb']);
  });

  it('never modifies the source mesh', async () => {
    const a = makeMesh(path.join(work, 'src'), 'crate.glb');
    await runMeshBatch([a], { ...OPTIONS, outputDir: outDir }, realDeps(new Set([a])));

    // A normalizer that writes over its own input destroys the user's asset
    // while reporting success. Bookkeeping assertions cannot see that.
    expect(readFileSync(a, 'utf8')).toBe(SOURCE_MARKER);
  });

  it('gives two sources that share a basename two distinct outputs', async () => {
    const a = makeMesh(path.join(work, 'a'), 'crate.glb');
    const b = makeMesh(path.join(work, 'b'), 'crate.glb');
    const result = await runMeshBatch([a, b], { ...OPTIONS, outputDir: outDir }, realDeps(new Set([a, b])));

    expect(result.prepared).toBe(2);
    const paths = result.items.map((item) => item.normalizedPath);
    expect(paths[0]).not.toBe(paths[1]);
    // prepared must equal files on disk, or a success describes bytes that a
    // later item already overwrote.
    expect(readdirSync(outDir)).toHaveLength(result.outputsWritten);
    expect(readFileSync(paths[0] as string, 'utf8')).toContain(path.join('a', 'crate.glb'));
    expect(readFileSync(paths[1] as string, 'utf8')).toContain(path.join('b', 'crate.glb'));
  });

  it('does not collide a .glb and .gltf pair emitted side by side', async () => {
    const dir = path.join(work, 'pair');
    const a = makeMesh(dir, 'hydrant.glb');
    const b = makeMesh(dir, 'hydrant.gltf');
    const result = await runMeshBatch([a, b], { ...OPTIONS, outputDir: outDir }, realDeps(new Set([a, b])));

    expect(result.prepared).toBe(2);
    expect(new Set(result.items.map((i) => i.normalizedPath)).size).toBe(2);
    expect(readdirSync(outDir)).toHaveLength(2);
  });

  it('strips an uppercase extension instead of embedding it in the name', async () => {
    const a = makeMesh(path.join(work, 'src'), 'BARREL.GLB');
    const result = await runMeshBatch([a], { ...OPTIONS, outputDir: outDir }, realDeps(new Set([a])));

    expect(path.basename(result.items[0]!.normalizedPath as string)).toBe('BARREL_normalized.glb');
  });

  it('writes beside the source when no outputDir is given', async () => {
    const srcDir = path.join(work, 'src');
    const a = makeMesh(srcDir, 'crate.glb');
    const result = await runMeshBatch([a], OPTIONS, realDeps(new Set([a])));

    expect(path.dirname(result.items[0]!.normalizedPath as string)).toBe(srcDir);
    expect(readdirSync(srcDir).sort()).toEqual(['crate.glb', 'crate_normalized.glb']);
  });
});

describe('a failed item leaves nothing behind', () => {
  it('releases the reserved name when the normalizer fails', async () => {
    const h = harness({ broken: ['/a/one.glb'], normalizeThrows: ['/a/one.glb'] });
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, h.deps);

    // The reservation CREATES the file to claim the name. Left behind, it is a
    // zero-byte .glb nobody was told about, and it steals the canonical name
    // from the successful re-run that follows.
    expect(result.items[0]?.status).toBe('failed');
    expect(h.discarded).toHaveLength(1);
    expect(h.discarded[0]).toContain('one_normalized.glb');
  });

  it('does not report a normalizedPath for a mesh that was never produced', async () => {
    const h = harness({ broken: ['/a/one.glb'], normalizeThrows: ['/a/one.glb'] });
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, h.deps);

    expect(result.items[0]?.normalizedPath).toBeUndefined();
  });

  it('frees the name so a later item can take it', async () => {
    const h = harness({ broken: ['/a/one.glb', '/b/one.glb'], normalizeThrows: ['/a/one.glb'] });
    const result = await runMeshBatch(['/a/one.glb', '/b/one.glb'], OPTIONS, h.deps);

    // Without the release the survivor is pushed to _2 while an empty file
    // keeps the canonical name and sorts first in any glob.
    expect(result.items[1]?.status).toBe('prepared');
    expect(path.basename(result.items[1]!.normalizedPath as string)).toBe('one_normalized.glb');
  });
});

describe('the production wiring, not just the loop', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'mesh-batch-wiring-'));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  // These call the REAL dependencies the tool uses. A mutant that swapped the
  // name reservation for a plain path join passed lint, typecheck and every
  // other test in this file while restoring the silent-overwrite defect in
  // full, because nothing exercised the wiring itself.
  it('reserves distinct names for the same requested filename', async () => {
    const deps = createMeshBatchDeps({ blenderAvailable: true, timeoutMs: 1000 });
    const first = await deps.reserveOutputPath(work, 'crate_normalized.glb');
    const second = await deps.reserveOutputPath(work, 'crate_normalized.glb');

    expect(first).not.toBe(second);
    expect(readdirSync(work).sort()).toEqual(['crate_normalized.glb', 'crate_normalized_2.glb']);
  });

  it('reserves exclusively against a file that already exists', async () => {
    const taken = path.join(work, 'crate_normalized.glb');
    writeFileSync(taken, 'REVIEWED-RESULT');
    const deps = createMeshBatchDeps({ blenderAvailable: true, timeoutMs: 1000 });
    const reserved = await deps.reserveOutputPath(work, 'crate_normalized.glb');

    expect(reserved).not.toBe(taken);
    expect(readFileSync(taken, 'utf8')).toBe('REVIEWED-RESULT');
  });

  it('really deletes a released reservation', async () => {
    const deps = createMeshBatchDeps({ blenderAvailable: true, timeoutMs: 1000 });
    const reserved = await deps.reserveOutputPath(work, 'crate_normalized.glb');
    expect(existsSync(reserved)).toBe(true);
    await deps.discardReservation(reserved);

    expect(existsSync(reserved)).toBe(false);
    expect(readdirSync(work)).toHaveLength(0);
  });
});

describe('a cleanup failure never displaces the real cause', () => {
  it('reports the normalizer error, not the discard error', async () => {
    const h = harness({ broken: ['/a/one.glb'], normalizeThrows: ['/a/one.glb'] });
    const exploding: MeshBatchDeps = {
      ...h.deps,
      discardReservation: async () => {
        throw new Error('EPERM_cleanup_failed');
      },
    };
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, exploding);

    // The discard used to throw first, so the caller learned only that tidying
    // up failed and never why the work did.
    expect(result.items[0]?.error).toContain('Blender exited non-zero');
    expect(result.items[0]?.error).not.toContain('EPERM_cleanup_failed');
  });
});

describe('a normalized mesh that fails policy is kept, and counted', () => {
  it('keeps the file, names it, and marks it kept', async () => {
    const h = harness({ broken: ['/a/one.glb'], repairFails: true });
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, h.deps);

    // Normalization SUCCEEDED and produced a real mesh; it just did not clear
    // the policy. Deleting it would destroy work worth inspecting — but a kept
    // file must never be a silent write.
    expect(result.items[0]?.status).toBe('failed');
    expect(result.items[0]?.normalizedPath).toBeDefined();
    expect(result.items[0]?.outputKept).toBe(true);
    expect(h.discarded).toHaveLength(0);
  });

  it('counts outputs separately from verdicts', async () => {
    const h = harness({ broken: ['/a/one.glb', '/a/two.glb'], repairFails: true });
    const result = await runMeshBatch(['/a/one.glb', '/a/two.glb'], OPTIONS, h.deps);

    // prepared is a VERDICT. Conflating it with the file count made a
    // deliberate keep look like a leak.
    expect(result.prepared).toBe(0);
    expect(result.outputsWritten).toBe(2);
  });

  it('counts nothing written when the normalizer itself failed', async () => {
    const h = harness({ broken: ['/a/one.glb'], normalizeThrows: ['/a/one.glb'] });
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, h.deps);

    expect(result.outputsWritten).toBe(0);
  });
});

describe('a cleanup that FAILS is still accounted for', () => {
  it('counts the orphan in outputsWritten and names it on the item', async () => {
    const h = harness({ broken: ['/a/one.glb'], normalizeThrows: ['/a/one.glb'] });
    const cannotClean: MeshBatchDeps = {
      ...h.deps,
      discardReservation: async () => {
        throw new Error('EACCES: read-only output directory');
      },
    };
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, cannotClean);

    // The reservation created the file; the unlink failed; the file is on disk.
    // Swallowing the cleanup error keeps the real cause visible — but the count
    // must not then disagree with the filesystem.
    expect(result.items[0]?.status).toBe('failed');
    expect(result.items[0]?.error).toContain('Blender exited non-zero');
    expect(result.items[0]?.orphanedOutput).toContain('one_normalized.glb');
    expect(result.outputsWritten).toBe(1);
  });

  it('reports no orphan when the cleanup succeeds', async () => {
    const h = harness({ broken: ['/a/one.glb'], normalizeThrows: ['/a/one.glb'] });
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, h.deps);

    expect(result.items[0]?.orphanedOutput).toBeUndefined();
    expect(result.outputsWritten).toBe(0);
  });
});

// The rule that fixed normalize_mesh, applied here. batch_prepare_meshes runs
// Blender with `output: <the reserved path>` — writing DIRECTLY to its target,
// exactly what normalize_mesh had to stop doing because the read-back could not
// tell a fresh write from the file that was already there.
//
// It is safe for a reason worth pinning rather than assuming: the batch has no
// overwrite path, so its target is ALWAYS a freshly reserved empty file. There
// is never a pre-existing valid mesh to mistake for output. If that ever
// changes, these fail.
describe('a lying Blender cannot make the batch report success', () => {
  const RECEIPT =
    'echo \'NORMALIZE_RECEIPT={"input":"x","output":"y","meshObjects":3,' +
    '"trianglesBefore":100,"trianglesAfter":80,"objectsMissingUVsBefore":3,' +
    '"objectsMissingUVsAfter":0,"objectsUnwrapped":3,"objectsCleaned":0,' +
    '"objectsDecimated":0,"materialsRenamed":0,"materialsForcedOpaque":0,' +
    '"blenderVersion":"stub"}\'\nexit 0';

  async function runBatch(body: string) {
    const work = mkdtempSync(path.join(tmpdir(), 'batch-liar-'));
    const source = path.join(work, 'a.glb');
    copyFileSync(FIXTURE_MESH, source);
    const outDir = path.join(work, 'out');
    mkdirSync(outDir, { recursive: true });
    const stub = path.join(work, 'blender.sh');
    writeFileSync(stub, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/server.js', import.meta.url))],
      env: {
        ...process.env,
        ASSET_LOG_LEVEL: 'error',
        ASSET_OUTPUT_DIR: path.join(work, 'ws'),
        BLENDER_PATH: stub,
      },
    });
    const client = new Client({ name: 'batch-liar', version: '1.0.0' });
    try {
      await client.connect(transport);
      const raw = await client.callTool({
        name: 'batch_prepare_meshes',
        arguments: { modelPaths: [source], outputDir: outDir },
      });
      const parsed = JSON.parse((raw.content as { text: string }[])[0]!.text);
      return { batch: parsed, files: readdirSync(outDir), work };
    } finally {
      await client.close().catch(() => undefined);
      rmSync(work, { recursive: true, force: true });
    }
  }

  it('refuses when Blender claims success and writes nothing', async () => {
    const { batch, files } = await runBatch(RECEIPT);
    expect(batch.prepared).toBe(0);
    expect(batch.failed).toBe(1);
    expect(batch.outputsWritten).toBe(0);
    expect(files).toEqual([]);
  }, 120_000);

  it('refuses when Blender writes convincing non-GLB bytes', async () => {
    const { batch, files } = await runBatch(
      `out=$(printf '%s' "$*" | sed -n 's/.*"output": *"\\([^"]*\\)".*/\\1/p')\n` +
      `printf 'THIS IS NOT A GLB' > "$out"\n${RECEIPT}`,
    );
    expect(batch.prepared).toBe(0);
    expect(batch.outputsWritten).toBe(0);
    expect(files).toEqual([]);
  }, 120_000);
});

describe('the batch never builds directory trees either', () => {
  it('refuses an outputDir that does not exist, creating nothing', async () => {
    // A mesh that NEEDS repair: one that already passes is skipped before any
    // output directory is consulted, which is correct — the check only matters
    // when something is about to be written.
    const h = harness({ broken: ['/a/one.glb'] });
    const missing: MeshBatchDeps = { ...h.deps, isDirectory: async () => false };
    const result = await runMeshBatch(
      ['/a/one.glb'],
      { ...OPTIONS, outputDir: '/nowhere/nested/deep' },
      missing,
    );

    // normalize_mesh stopped doing this; the sibling tool kept doing it, and
    // an unexpanded ~ built a literal "~" tree wherever the server was running.
    expect(result.items[0]?.status).toBe('failed');
    expect(result.items[0]?.error).toMatch(/outputDir does not exist/);
    expect(h.mkdirCalls).toEqual([]);
  });

  it('still creates nothing but writes beside the source when outputDir is omitted', async () => {
    const h = harness({ broken: ['/a/one.glb'] });
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, h.deps);

    expect(result.items[0]?.status).toBe('prepared');
    expect(h.mkdirCalls).toEqual(['/a']);
  });
});

describe('the receipt is a claim; the bytes are the evidence', () => {
  it('flags a normalizer whose receipt contradicts the produced file', async () => {
    // The receipt said unwrapped:3 while the tool's own inspection of the same
    // bytes reported no UVs, and both were reported without ever being
    // compared — a verdict of "game-ready" resting on the claim.
    const h = harness({ broken: ['/a/one.glb'], repairFails: true });
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, h.deps);

    expect(result.items[0]?.receiptDisagreed).toBe(true);
    expect(result.items[0]?.status).toBe('failed');
  });

  it('reports the MEASURED triangle count beside the claimed one', async () => {
    const h = harness({ broken: ['/a/one.glb'] });
    const result = await runMeshBatch(['/a/one.glb'], OPTIONS, h.deps);

    // The fake receipt claims 1750; the fake inspection reports 100.
    expect(result.items[0]?.trianglesAfter).toBe(1750);
    expect(result.items[0]?.trianglesAfterMeasured).toBe(100);
    expect(result.items[0]?.receiptDisagreed).toBe(true);
  });
});
