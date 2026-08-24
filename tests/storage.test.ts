/**
 * Storage unit tests.
 *
 * Every case runs against a real filesystem in a fresh temp directory rather
 * than a mocked `fs`: the properties under test here — atomic rename, "never
 * overwrite", path escape refusal — are properties of the filesystem calls
 * themselves, and a mock would happily certify an implementation that does not
 * actually survive contact with one.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssetJob } from '../src/domain/asset-job.js';
import type { AssetJob } from '../src/domain/asset-job.js';
import { gameAssetSpecSchema } from '../src/domain/asset-spec.js';
import {
  ASSET_SUBDIRS,
  reserveWorkspace,
  safeJoin,
  sanitizeFileName,
  uniqueFilePath,
  writeFileAtomic,
} from '../src/storage/filesystem.js';
import { JobStore } from '../src/storage/jobs.js';
import { AssetPipelineError } from '../src/util/errors.js';
import type { ErrorCode } from '../src/util/errors.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'game-asset-mcp-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * Asserts the thrown value is an AssetPipelineError with `code` and returns it.
 * A plain `expect(...).toThrow()` would pass on a TypeError from a broken
 * implementation, which is the failure this suite exists to catch.
 */
async function expectPipelineError(
  fn: () => unknown | Promise<unknown>,
  code: ErrorCode,
): Promise<AssetPipelineError> {
  let thrown: unknown;
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    thrown = err;
  }
  expect(threw, `expected a throw with code ${code}`).toBe(true);
  expect(thrown).toBeInstanceOf(AssetPipelineError);
  const err = thrown as AssetPipelineError;
  expect(err.code).toBe(code);
  return err;
}

function makeJob(overrides: { name?: string; slug?: string; now?: string } = {}): AssetJob {
  const spec = gameAssetSpecSchema.parse({
    name: overrides.name ?? 'crate',
    description: 'a weathered wooden supply crate',
    category: 'environment_prop',
  });
  return createAssetJob({
    spec,
    slug: overrides.slug ?? 'crate',
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });
}

async function listDir(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

describe('safeJoin', () => {
  it('joins a normal nested path under the root', () => {
    const joined = safeJoin(root, 'model', 'asset.glb');
    expect(joined).toBe(path.join(path.resolve(root), 'model', 'asset.glb'));
  });

  it('refuses a bare parent traversal', async () => {
    const err = await expectPipelineError(() => safeJoin(root, '..'), 'PATH_ESCAPE');
    expect(err.details['root']).toBe(path.resolve(root));
  });

  it('refuses a multi-level traversal', async () => {
    await expectPipelineError(() => safeJoin(root, '../../etc/passwd'), 'PATH_ESCAPE');
  });

  it('refuses an absolute segment', async () => {
    await expectPipelineError(() => safeJoin(root, '/etc/passwd'), 'PATH_ESCAPE');
  });

  it('refuses a traversal hidden mid-path', async () => {
    await expectPipelineError(() => safeJoin(root, 'a/../../b'), 'PATH_ESCAPE');
  });
});

describe('sanitizeFileName', () => {
  it('strips directory components from a provider-supplied name', () => {
    expect(sanitizeFileName('../../x.png', 'fallback.png')).toBe('x.png');
  });

  it('strips leading dots so nothing lands as a hidden file', () => {
    expect(sanitizeFileName('...hidden.png', 'fallback.png')).toBe('hidden.png');
  });

  it('falls back when the name sanitizes away to nothing', () => {
    expect(sanitizeFileName('....', 'fallback.png')).toBe('fallback.png');
    expect(sanitizeFileName('/', 'fallback.png')).toBe('fallback.png');
  });

  it('caps the length at 128 characters', () => {
    const result = sanitizeFileName(`${'a'.repeat(200)}.png`, 'fallback.png');
    expect(result).toHaveLength(128);
    expect(result).toBe('a'.repeat(128));
  });
});

describe('reserveWorkspace', () => {
  it('creates all five asset subdirectories', async () => {
    const reserved = await reserveWorkspace(root, 'crate');
    expect(reserved.slug).toBe('crate');
    expect(await listDir(reserved.dir)).toEqual([...ASSET_SUBDIRS].sort());
    for (const sub of ASSET_SUBDIRS) {
      const stat = await fs.stat(path.join(reserved.dir, sub));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('never overwrites: the same slug twice yields two distinct directories', async () => {
    const first = await reserveWorkspace(root, 'crate');
    // A marker in the first workspace proves the second reservation did not
    // reuse or clear it, which a directory-name check alone would not show.
    await fs.writeFile(path.join(first.dir, 'metadata', 'marker.txt'), 'first', 'utf8');

    const second = await reserveWorkspace(root, 'crate');

    expect(first.slug).toBe('crate');
    expect(second.slug).toBe('crate_2');
    expect(second.dir).not.toBe(first.dir);
    expect(path.basename(second.dir)).toBe('crate_2');
    expect((await fs.stat(first.dir)).isDirectory()).toBe(true);
    expect((await fs.stat(second.dir)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(first.dir, 'metadata', 'marker.txt'), 'utf8')).toBe('first');
    expect(await listDir(second.dir)).toEqual([...ASSET_SUBDIRS].sort());
  });
});

describe('uniqueFilePath', () => {
  it('returns the plain name while it is free, then suffixes before the extension', async () => {
    const first = await uniqueFilePath(root, 'model.glb');
    expect(first).toBe(path.join(path.resolve(root), 'model.glb'));

    await fs.writeFile(first, 'taken', 'utf8');
    const second = await uniqueFilePath(root, 'model.glb');
    expect(second).toBe(path.join(path.resolve(root), 'model_2.glb'));

    await fs.writeFile(second, 'taken', 'utf8');
    expect(await uniqueFilePath(root, 'model.glb')).toBe(
      path.join(path.resolve(root), 'model_3.glb'),
    );
  });
});

describe('writeFileAtomic', () => {
  it('writes the bytes, returns their sha256, and leaves no temp files', async () => {
    const data = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
    const target = path.join(root, 'model.glb');

    const digest = await writeFileAtomic(target, data);

    expect(digest).toBe(createHash('sha256').update(data).digest('hex'));
    expect(new Uint8Array(await fs.readFile(target))).toEqual(data);
    expect((await listDir(root)).filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(await listDir(root)).toEqual(['model.glb']);
  });
});

describe('JobStore', () => {
  let storeDir: string;
  let store: JobStore;

  beforeEach(async () => {
    storeDir = path.join(root, 'jobs');
    store = await JobStore.open(storeDir);
  });

  it('round-trips a saved job deeply-equal', async () => {
    const job = makeJob();
    job.status = 'ready';
    job.providerStatus = 'SUCCESS';
    job.candidates = [{ id: 'cand_1', url: 'https://example.invalid/a.png', seed: 42 }];
    job.selectedCandidateId = 'cand_1';
    job.files = [
      { path: 'model/asset.glb', bytes: 8, sha256: 'a'.repeat(64), kind: 'model' },
    ];
    job.model3d = {
      provider: 'example',
      taskType: 'image_to_model',
      parameters: { pbr: true, nested: { quad: false } },
      requestedAt: '2026-01-01T00:00:00.000Z',
      providerTaskId: 'task-abc',
    };

    await store.save(job);
    expect(await store.get(job.id)).toEqual(job);
  });

  it('get() of a missing id throws NOT_FOUND while find() returns undefined', async () => {
    const missing = `asset_${randomUUID()}`;
    await expectPipelineError(() => store.get(missing), 'NOT_FOUND');
    expect(await store.find(missing)).toBeUndefined();
  });

  it('list() returns jobs newest-first by createdAt', async () => {
    const oldest = makeJob({ name: 'oldest', now: '2026-01-01T00:00:00.000Z' });
    const newest = makeJob({ name: 'newest', now: '2026-03-01T00:00:00.000Z' });
    const middle = makeJob({ name: 'middle', now: '2026-02-01T00:00:00.000Z' });
    // Saved out of order so a pass cannot come from readdir happening to
    // return insertion order.
    await store.save(middle);
    await store.save(oldest);
    await store.save(newest);

    const listed = await store.list();
    expect(listed.map((job) => job.name)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('save() twice with the same id overwrites cleanly and leaves no temp files', async () => {
    const job = makeJob();
    await store.save(job);

    const updated: AssetJob = { ...job, status: 'ready', updatedAt: '2026-04-01T00:00:00.000Z' };
    await store.save(updated);

    expect(await listDir(storeDir)).toEqual([`${job.id}.json`]);
    expect(await store.get(job.id)).toEqual(updated);
    expect(await store.list()).toHaveLength(1);
  });

  it('refuses a malformed id and never reads outside the store', async () => {
    // A real, reachable escape target: `<storeDir>/../outside.json` exists, so
    // if fileFor merely joined the id the store would return this sentinel.
    const sentinel = makeJob({ name: 'sentinel' });
    await fs.writeFile(path.join(root, 'outside.json'), JSON.stringify(sentinel), 'utf8');
    const readFile = vi.spyOn(fs, 'readFile');

    await expectPipelineError(() => store.get('../../etc/passwd'), 'INVALID_INPUT');
    await expectPipelineError(() => store.get('../outside'), 'INVALID_INPUT');
    await expectPipelineError(() => store.find('../outside'), 'INVALID_INPUT');
    await expectPipelineError(() => store.save({ ...sentinel, id: '../outside' }), 'INVALID_INPUT');

    expect(readFile).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, 'outside.json'), 'utf8')).toBe(
      JSON.stringify(sentinel),
    );
    expect(await listDir(storeDir)).toEqual([]);
  });

  it('findByProviderTaskId maps a provider task back to our job', async () => {
    const withTask = makeJob({ name: 'with-task' });
    withTask.model3d = {
      provider: 'example',
      taskType: 'image_to_model',
      parameters: {},
      requestedAt: '2026-01-01T00:00:00.000Z',
      providerTaskId: 'task-xyz',
    };
    const withoutTask = makeJob({ name: 'without-task' });
    await store.save(withTask);
    await store.save(withoutTask);

    const found = await store.findByProviderTaskId('task-xyz');
    expect(found?.id).toBe(withTask.id);
    expect(await store.findByProviderTaskId('task-nope')).toBeUndefined();
  });

  it('delete() removes the job and is safe to call twice', async () => {
    const job = makeJob();
    await store.save(job);

    await store.delete(job.id);
    expect(await store.find(job.id)).toBeUndefined();
    expect(await listDir(storeDir)).toEqual([]);

    await expect(store.delete(job.id)).resolves.toBeUndefined();
  });
});
