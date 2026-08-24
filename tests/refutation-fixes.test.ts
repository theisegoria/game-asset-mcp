/**
 * Regression tests for defects found by adversarial review.
 *
 * Each block names the defect it pins. These exist because the original code
 * stated these invariants in COMMENTS and violated every one of them — a rule
 * that is not executed is not a rule.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestJson, assertHttps, safeUrlForLogs } from '../src/util/http.js';
import { AssetPipelineError } from '../src/util/errors.js';
import { canTransition, fromTripoStatus, isTerminal } from '../src/domain/status.js';
import { sanitizeAssetName, gameAssetSpecSchema } from '../src/domain/asset-spec.js';
import { buildReconstructionPrompt } from '../src/prompts/reconstruction-prompt.js';
import { parseLogLevel } from '../src/util/logging.js';
import { loadConfig } from '../src/config.js';
import { uniqueFilePath, writeFileAtomic } from '../src/storage/filesystem.js';
import { JobStore } from '../src/storage/jobs.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gam-refute-'));
}

/** A fetch mock that behaves like the real one w.r.t. abort signals. */
function mockFetch(handler: (url: string, init: RequestInit) => Response): { calls: () => number } {
  let sent = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // Real fetch refuses an already-aborted signal without sending anything.
    if (init?.signal?.aborted) {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    }
    sent += 1;
    return handler(String(input), init ?? {});
  }) as unknown as typeof fetch;
  return { calls: () => sent };
}

describe('CRITICAL #1 — requestJson enforces https on the credential path', () => {
  it('refuses a plaintext http URL before any request is made', async () => {
    const probe = mockFetch(() => new Response('{}', { status: 200 }));
    await expect(
      requestJson('http://example.com/x', {
        timeoutMs: 1000,
        method: 'POST',
        headers: { authorization: 'Bearer SECRET' },
        body: { a: 1 },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PROTOCOL' });
    // The point of the fix: the credential never left the process.
    expect(probe.calls()).toBe(0);
  });
});

describe('CRITICAL #2 — https is re-checked on every redirect hop', () => {
  it('refuses an https -> http downgrade instead of following it', async () => {
    const probe = mockFetch((url) => {
      if (url.includes('/start')) {
        return new Response(null, { status: 302, headers: { location: 'http://evil.test/plain' } });
      }
      return new Response('{"leaked":true}', { status: 200 });
    });

    await expect(requestJson('https://example.com/start', { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROTOCOL',
    });
    // Exactly one hop happened; the cleartext hop was never attempted.
    expect(probe.calls()).toBe(1);
  });

  it('follows an https -> https redirect normally', async () => {
    mockFetch((url) =>
      url.includes('/start')
        ? new Response(null, { status: 302, headers: { location: 'https://example.com/final' } })
        : new Response('{"ok":true}', { status: 200 }),
    );
    const result = await requestJson<{ ok: boolean }>('https://example.com/start', { timeoutMs: 1000 });
    expect(result.data).toEqual({ ok: true });
  });
});

describe('CRITICAL #4 — a credit-consuming POST can never be auto-retried', () => {
  it('refuses retries > 0 on a non-GET method, sending nothing', async () => {
    const probe = mockFetch(() => new Response('boom', { status: 500 }));
    await expect(
      requestJson('https://example.com/charge', {
        method: 'POST',
        retries: 2,
        timeoutMs: 1000,
        body: { charge: true },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(probe.calls()).toBe(0);
  });

  it('a POST with no retries is attempted exactly once on a 500', async () => {
    const probe = mockFetch(() => new Response('boom', { status: 500 }));
    await expect(
      requestJson('https://example.com/charge', { method: 'POST', timeoutMs: 1000, body: {} }),
    ).rejects.toMatchObject({ code: 'PROVIDER_HTTP' });
    expect(probe.calls()).toBe(1);
  });

  it('still allows retries on an idempotent GET', async () => {
    const probe = mockFetch(() => new Response('boom', { status: 500 }));
    await expect(
      requestJson('https://example.com/poll', { retries: 2, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_HTTP' });
    expect(probe.calls()).toBe(3);
  });
});

describe('#12 — an invalid retry budget is refused, not silently zero-request', () => {
  it.each([Number.NaN, -1, 1.5])('rejects retries=%s', async (retries) => {
    const probe = mockFetch(() => new Response('{}', { status: 200 }));
    await expect(
      requestJson('https://example.com/x', { retries: retries as number, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(probe.calls()).toBe(0);
  });
});

describe('HIGH #5 — an already-aborted signal prevents the request', () => {
  it('does not send when the caller has already cancelled', async () => {
    const probe = mockFetch(() => new Response('{}', { status: 200 }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestJson('https://example.com/x', { timeoutMs: 1000, signal: controller.signal }),
    ).rejects.toBeInstanceOf(AssetPipelineError);
    expect(probe.calls()).toBe(0);
  });
});

describe('#13 — URLs in errors and logs carry no credentials or signed tokens', () => {
  it('strips userinfo and query string', () => {
    const scrubbed = safeUrlForLogs('https://user:tok3n@example.com/a/b?X-Amz-Signature=SECRET');
    expect(scrubbed).toBe('https://example.com/a/b');
    expect(scrubbed).not.toContain('tok3n');
    expect(scrubbed).not.toContain('SECRET');
  });

  it('assertHttps does not leak the query string into error details', () => {
    try {
      assertHttps('http://h/p?X-Amz-Signature=SECRET');
      throw new Error('should have thrown');
    } catch (err) {
      expect(JSON.stringify((err as AssetPipelineError).toJSON())).not.toContain('SECRET');
    }
  });
});

describe('CRITICAL #3 / #24 — the transition table is actually enforced', () => {
  it('rejects backwards and terminal-reopening transitions', () => {
    expect(canTransition('generating_3d', 'processing')).toBe(true);
    expect(canTransition('processing', 'generating_3d')).toBe(false);
    expect(canTransition('reference_ready', 'generating_reference')).toBe(false);
    expect(canTransition('ready', 'processing')).toBe(false);
    expect(canTransition('failed', 'ready')).toBe(false);
  });

  it('a terminal state cannot even re-enter itself', () => {
    for (const terminal of ['ready', 'failed', 'cancelled'] as const) {
      expect(isTerminal(terminal)).toBe(true);
      expect(canTransition(terminal, terminal)).toBe(false);
    }
  });
});

describe('HIGH #9 — an unrecognised provider status fails loud, never polls forever', () => {
  it.each(['expired', 'timeout', 'error', 'something_new', ''])('maps %s to failed', (raw) => {
    expect(fromTripoStatus(raw)).toBe('failed');
  });

  it('is case-insensitive so a provider recasing does not break it', () => {
    expect(fromTripoStatus('SUCCESS')).toBe('ready');
    expect(fromTripoStatus('Success')).toBe('ready');
    expect(fromTripoStatus(' running ')).toBe('processing');
  });
});

describe('HIGH #7 / #22 — asset names and prompts are well formed', () => {
  it('never emits a lone surrogate when truncating astral characters', () => {
    const name = `${'a'.repeat(63)}\u{10330}zzzz`;
    const slug = sanitizeAssetName(name);
    // A lone surrogate does not survive a UTF-8 round-trip.
    expect(Buffer.from(slug, 'utf8').toString('utf8')).toBe(slug);
    expect([...slug].length).toBeLessThanOrEqual(64);
  });

  it.each(['../../etc/passwd', '...', '..', '   ', ''])('sanitizes %s safely', (input) => {
    const slug = sanitizeAssetName(input);
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('..');
    expect(slug.length).toBeGreaterThan(0);
  });

  it('does not produce a double period for prose ending in a full stop', () => {
    const prompt = buildReconstructionPrompt({ name: 'x', description: 'A crate.' }).prompt;
    expect(prompt).not.toContain('..');
    expect(prompt.startsWith('A crate.')).toBe(true);
  });

  it('rejects a whitespace-only description rather than generating an arbitrary object', () => {
    expect(gameAssetSpecSchema.safeParse({ name: 'x', description: '   ' }).success).toBe(false);
  });

  it('returned directives cannot be mutated by a caller', () => {
    const first = buildReconstructionPrompt({ name: 'x', description: 'y' });
    expect(Object.isFrozen(first.directives)).toBe(true);
    expect(() => (first.directives as string[]).push('POISON')).toThrow();
    expect(buildReconstructionPrompt({ name: 'x', description: 'y' }).directives).toHaveLength(
      first.directives.length,
    );
  });
});

describe('#21 / #20 — configuration cannot be poisoned or silently mis-parsed', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'does not accept prototype key %s as a log level',
    (key) => {
      expect(parseLogLevel(key)).toBe('info');
    },
  );

  it.each(['1e9', '256MB', '-5', '1.5', 'abc'])('refuses malformed byte limit %s', (raw) => {
    expect(() => loadConfig({ ASSET_MAX_DOWNLOAD_BYTES: raw } as NodeJS.ProcessEnv)).toThrow();
  });

  it('accepts a plain integer', () => {
    expect(loadConfig({ ASSET_MAX_DOWNLOAD_BYTES: '1048576' } as NodeJS.ProcessEnv).maxDownloadBytes).toBe(
      1048576,
    );
  });
});

describe('HIGH #10 — concurrent writers never share a filename or a temp file', () => {
  it('gives two concurrent callers distinct paths', async () => {
    const dir = await tmpDir();
    const [a, b] = await Promise.all([
      uniqueFilePath(dir, 'model.glb'),
      uniqueFilePath(dir, 'model.glb'),
    ]);
    expect(a).not.toBe(b);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writeFileAtomic returns a digest matching the bytes actually on disk', async () => {
    const dir = await tmpDir();
    const target = path.join(dir, 'x.bin');
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const digest = await writeFileAtomic(target, payload);

    const { createHash } = await import('node:crypto');
    const onDisk = await fs.readFile(target);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(digest);

    expect((await fs.readdir(dir)).filter((f) => f.includes('.tmp-'))).toHaveLength(0);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('MEDIUM #8 / #18 — the job store neither hides jobs nor trusts unknown schemas', () => {
  it('refuses a record from a future schema version instead of crashing later', async () => {
    const dir = await tmpDir();
    const store = await JobStore.open(dir);
    const id = 'asset_11111111-1111-1111-1111-111111111111';
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ id, schemaVersion: 2 }), 'utf8');
    await expect(store.get(id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports corrupt records rather than silently dropping them from a listing', async () => {
    const dir = await tmpDir();
    const store = await JobStore.open(dir);
    await fs.writeFile(path.join(dir, 'asset_bad.json'), '{ not json', 'utf8');
    const jobs = await store.list();
    expect(jobs).toHaveLength(0);
    expect(store.lastListingSkipped()).toHaveLength(1);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects a traversal id without reading outside the store', async () => {
    const dir = await tmpDir();
    const store = await JobStore.open(dir);
    await expect(store.get('../../etc/passwd')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await fs.rm(dir, { recursive: true, force: true });
  });
});
