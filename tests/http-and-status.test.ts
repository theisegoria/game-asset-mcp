/**
 * Unit tests for the transport and lifecycle primitives.
 *
 * These three modules are the ones every provider sits on top of, so the tests
 * pin the *mechanisms* the source comments claim (no auto-retry of a
 * credit-consuming call, https on every redirect hop, a size cap enforced while
 * streaming) rather than just the happy paths. A regression in any of them is
 * silent at the call site and expensive at the provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertHttps, downloadFile, requestJson } from '../src/util/http.js';
import { AssetPipelineError } from '../src/util/errors.js';
import type { ErrorCode } from '../src/util/errors.js';
import { redact } from '../src/util/logging.js';
import {
  ASSET_JOB_STATUSES,
  canTransition,
  fromLeonardoStatus,
  fromTripoStatus,
  isTerminal,
} from '../src/domain/status.js';
import type { AssetJobStatus } from '../src/domain/status.js';

const URL_UNDER_TEST = 'https://provider.example/v1/task';

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Assert a rejection and hand back the typed error, so the code can be checked. */
async function rejectsWith(run: () => Promise<unknown>, code: ErrorCode): Promise<AssetPipelineError> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the call to reject, but it resolved').toBeInstanceOf(AssetPipelineError);
  const error = caught as AssetPipelineError;
  expect(error.code).toBe(code);
  return error;
}

function textResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('requestJson', () => {
  it('returns the parsed body on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ taskId: 'abc', progress: 42 }));

    const result = await requestJson<{ taskId: string; progress: number }>(URL_UNDER_TEST, {
      timeoutMs: 1_000,
    });

    expect(result.status).toBe(200);
    expect(result.data).toEqual({ taskId: 'abc', progress: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends a JSON body with the matching content-type on POST', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await requestJson(URL_UNDER_TEST, {
      method: 'POST',
      timeoutMs: 1_000,
      headers: { authorization: 'Bearer test' },
      body: { prompt: 'a mossy stone' },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers.authorization).toBe('Bearer test');
    expect(init.body).toBe(JSON.stringify({ prompt: 'a mossy stone' }));
    // Manual redirect handling is what makes the per-hop https check possible.
    expect(init.redirect).toBe('manual');
  });

  it('returns undefined data for an empty 200 body', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('', 200));

    const result = await requestJson(URL_UNDER_TEST, { timeoutMs: 1_000 });

    expect(result.status).toBe(200);
    expect(result.data).toBeUndefined();
  });

  it('throws PROVIDER_HTTP on 400 and does not retry, even with a retry budget', async () => {
    // A fresh Response per call: a body can only be read once, so reusing one
    // instance would fail as a TypeError and hide what the retry loop did.
    fetchMock.mockImplementation(() => Promise.resolve(textResponse('{"error":"bad prompt"}', 400)));

    const error = await rejectsWith(
      () => requestJson(URL_UNDER_TEST, { timeoutMs: 1_000, retries: 3 }),
      'PROVIDER_HTTP',
    );

    // 400 is the provider telling us the request itself is wrong; repeating it
    // burns the budget and cannot change the answer.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.retryable).toBe(false);
    expect(error.details.status).toBe(400);
  });

  it('throws RATE_LIMITED on 429', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(textResponse('slow down', 429)));

    const error = await rejectsWith(
      () => requestJson(URL_UNDER_TEST, { timeoutMs: 1_000 }),
      'RATE_LIMITED',
    );

    expect(error.retryable).toBe(true);
    // Marked retryable for the caller, but no budget was requested here, so the
    // transport must not have retried on its own.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 500 up to the budget and then throws', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(textResponse('upstream exploded', 500)));

    const error = await rejectsWith(
      () => requestJson(URL_UNDER_TEST, { timeoutMs: 1_000, retries: 2 }),
      'PROVIDER_HTTP',
    );

    // budget 2 == the initial attempt plus exactly 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error.details.status).toBe(500);
  });

  it('stops retrying as soon as an attempt succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('upstream exploded', 500))
      .mockResolvedValueOnce(jsonResponse({ taskId: 'recovered' }));

    const result = await requestJson<{ taskId: string }>(URL_UNDER_TEST, {
      timeoutMs: 1_000,
      retries: 3,
    });

    expect(result.data).toEqual({ taskId: 'recovered' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('CRITICAL: with retries omitted, a failing 500 is attempted exactly once', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(textResponse('upstream exploded', 500)));

    await rejectsWith(() => requestJson(URL_UNDER_TEST, { timeoutMs: 1_000 }), 'PROVIDER_HTTP');

    // The default budget is zero on purpose: callers that submit a
    // credit-consuming request must opt into retrying, never inherit it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a retry budget on a non-GET method before touching the network', async () => {
    await rejectsWith(
      () => requestJson(URL_UNDER_TEST, { method: 'POST', timeoutMs: 1_000, retries: 3 }),
      'INVALID_INPUT',
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws PROVIDER_MALFORMED_RESPONSE on a non-JSON body', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('<html>gateway timeout</html>', 200));

    const error = await rejectsWith(
      () => requestJson(URL_UNDER_TEST, { timeoutMs: 1_000 }),
      'PROVIDER_MALFORMED_RESPONSE',
    );

    expect(error.message).toContain('<html>');
  });

  it('refuses a redirect that downgrades the transport to http', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://cdn.example/asset.json' } }),
    );

    await rejectsWith(
      () => requestJson(URL_UNDER_TEST, { timeoutMs: 1_000 }),
      'UNSUPPORTED_PROTOCOL',
    );
  });
});

describe('assertHttps', () => {
  it('accepts an https URL and returns the parsed URL', () => {
    const parsed = assertHttps('https://provider.example/a/b?token=secret');
    expect(parsed.protocol).toBe('https:');
    expect(parsed.host).toBe('provider.example');
  });

  it.each([
    ['http://provider.example/a', 'cleartext http'],
    ['file:///etc/passwd', 'local file'],
    ['not a url at all', 'malformed'],
  ])('rejects %s (%s)', (candidate) => {
    let caught: unknown;
    try {
      assertHttps(candidate);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AssetPipelineError);
    expect((caught as AssetPipelineError).code).toBe('UNSUPPORTED_PROTOCOL');
  });

  it('keeps the query string out of the logged URL', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('nope', 404));
    const error = await rejectsWith(
      () => requestJson('https://provider.example/v1/x?signature=deadbeef', { timeoutMs: 1_000 }),
      'PROVIDER_HTTP',
    );
    expect(String(error.details.url)).toBe('https://provider.example/v1/x');
    expect(String(error.details.url)).not.toContain('deadbeef');
  });
});

/** A body that hands out `count` chunks of `size` bytes and counts what was pulled. */
function chunkedBody(count: number, size: number): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= count) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(pulled));
    },
  });
  return { stream, pulled: () => pulled };
}

describe('downloadFile', () => {
  const DOWNLOAD_URL = 'https://cdn.example/model.glb';

  it('returns the bytes and content type when the file is under the cap', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    fetchMock.mockResolvedValueOnce(
      new Response(payload, {
        status: 200,
        headers: {
          'content-type': 'model/gltf-binary',
          'content-length': String(payload.byteLength),
        },
      }),
    );

    const result = await downloadFile(DOWNLOAD_URL, { timeoutMs: 1_000, maxBytes: 1_024 });

    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.contentType).toBe('model/gltf-binary');
  });

  it('throws DOWNLOAD_TOO_LARGE from the declared content-length without reading the body', async () => {
    const { stream, pulled } = chunkedBody(4, 32);
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { status: 200, headers: { 'content-length': '5000' } }),
    );

    const error = await rejectsWith(
      () => downloadFile(DOWNLOAD_URL, { timeoutMs: 1_000, maxBytes: 100 }),
      'DOWNLOAD_TOO_LARGE',
    );

    // Only the declared-size path sets `declared`; the streaming path reports
    // just the limit, so this pins which of the two checks actually fired.
    expect(error.details.declared).toBe(5000);
    expect(error.message).toContain('declared size 5000 exceeds limit 100');
    // A ReadableStream eagerly pulls one chunk to fill its queue before anyone
    // reads it, so 1 is the floor here — the point is that it was not drained.
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it('throws DOWNLOAD_TOO_LARGE while streaming when content-length is absent', async () => {
    const CHUNKS = 10;
    const { stream, pulled } = chunkedBody(CHUNKS, 32);
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const error = await rejectsWith(
      () => downloadFile(DOWNLOAD_URL, { timeoutMs: 1_000, maxBytes: 100 }),
      'DOWNLOAD_TOO_LARGE',
    );

    expect(error.details.limit).toBe(100);
    // The cap must trip mid-stream, not after buffering 320 bytes into memory.
    expect(pulled()).toBeLessThan(CHUNKS);
  });

  it('throws DOWNLOAD_TOO_LARGE while streaming when content-length lies', async () => {
    const CHUNKS = 10;
    const { stream, pulled } = chunkedBody(CHUNKS, 64);
    fetchMock.mockResolvedValueOnce(
      // A declared 10 bytes sails under the cap; only the streamed count catches it.
      new Response(stream, { status: 200, headers: { 'content-length': '10' } }),
    );

    await rejectsWith(
      () => downloadFile(DOWNLOAD_URL, { timeoutMs: 1_000, maxBytes: 100 }),
      'DOWNLOAD_TOO_LARGE',
    );

    expect(pulled()).toBeLessThan(CHUNKS);
  });

  it('rejects a body that under-delivers against its declared content-length', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(8), { status: 200, headers: { 'content-length': '4096' } }),
    );

    await rejectsWith(
      () => downloadFile(DOWNLOAD_URL, { timeoutMs: 1_000, maxBytes: 1_048_576 }),
      'PROVIDER_MALFORMED_RESPONSE',
    );
  });

  it('surfaces a failing HTTP status as PROVIDER_HTTP', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('gone', 404));

    const error = await rejectsWith(
      () => downloadFile(DOWNLOAD_URL, { timeoutMs: 1_000, maxBytes: 1_024 }),
      'PROVIDER_HTTP',
    );

    expect(error.details.status).toBe(404);
  });
});

describe('redact', () => {
  it('masks every secret-bearing key name', () => {
    const masked = redact({
      apiKey: 'sk-live-1234',
      access_token: 'tok-abcd',
      clientSecret: 'shh',
      password: 'hunter2',
      Authorization: 'Bearer xyz',
    }) as Record<string, unknown>;

    expect(masked).toEqual({
      apiKey: '[redacted]',
      access_token: '[redacted]',
      clientSecret: '[redacted]',
      password: '[redacted]',
      Authorization: '[redacted]',
    });
  });

  it('leaves non-secret values untouched, including falsy ones', () => {
    const masked = redact({
      prompt: 'a mossy stone',
      faceLimit: 20_000,
      pbr: true,
      seed: 0,
      note: '',
      missing: null,
      absent: undefined,
    }) as Record<string, unknown>;

    expect(masked).toEqual({
      prompt: 'a mossy stone',
      faceLimit: 20_000,
      pbr: true,
      seed: 0,
      note: '',
      missing: null,
      absent: undefined,
    });
  });

  it('recurses into nested objects and arrays', () => {
    const masked = redact({
      provider: {
        name: 'example',
        connection: { apiKey: 'sk-live-1234', endpoint: 'https://provider.example' },
      },
      requests: [
        { id: 'r1', token: 'tok-1' },
        { id: 'r2', token: 'tok-2' },
      ],
      tags: ['stone', 'moss'],
      nestedArrays: [[{ secret: 'deep' }]],
    }) as Record<string, unknown>;

    expect(masked).toEqual({
      provider: {
        name: 'example',
        connection: { apiKey: '[redacted]', endpoint: 'https://provider.example' },
      },
      requests: [
        { id: 'r1', token: '[redacted]' },
        { id: 'r2', token: '[redacted]' },
      ],
      tags: ['stone', 'moss'],
      nestedArrays: [[{ secret: '[redacted]' }]],
    });
  });

  it('masks a whole subtree when the key holding it looks secret', () => {
    // Deliberately fail-safe rather than fail-informative: nothing under a
    // secret-looking key is inspected, so a nested endpoint URL is lost along
    // with the credential. Widen the value, not the test, if that hurts.
    const masked = redact({
      credentials: { apiKey: 'sk-live-1234', endpoint: 'https://provider.example' },
    }) as Record<string, unknown>;

    expect(masked).toEqual({ credentials: '[redacted]' });
  });

  it('over-approximates: any key merely containing a hint is masked', () => {
    // `key`, `auth` and `credential` are matched as substrings, so ordinary
    // fields get caught too. Pinned so a future narrowing of SECRET_HINTS is a
    // deliberate change with a visible diff, not an accident.
    const masked = redact({
      keywords: ['stone', 'moss'],
      author: 'someone',
      monkeyCount: 3,
    }) as Record<string, unknown>;

    expect(masked).toEqual({
      keywords: '[redacted]',
      author: '[redacted]',
      monkeyCount: '[redacted]',
    });
  });

  it('does not mutate the object it was given', () => {
    const fields = { apiKey: 'sk-live-1234', nested: { token: 'tok' } };
    redact(fields);
    expect(fields.apiKey).toBe('sk-live-1234');
    expect(fields.nested.token).toBe('tok');
  });

  it('passes primitives, null and undefined through unchanged', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact('plain')).toBe('plain');
    expect(redact(7)).toBe(7);
    expect(redact(false)).toBe(false);
  });

  it('bottoms out on a deep object instead of recursing without end', () => {
    let deep: Record<string, unknown> = { apiKey: 'sk-live-1234' };
    for (let i = 0; i < 12; i += 1) deep = { level: deep };

    let masked: unknown;
    expect(() => {
      masked = redact(deep);
    }).not.toThrow();

    const serialized = JSON.stringify(masked);
    expect(serialized).toContain('[depth-limit]');
    // Whatever the cut-off does, it must never emit the secret it stopped above.
    expect(serialized).not.toContain('sk-live-1234');
  });
});

describe('fromTripoStatus', () => {
  it.each<[string, AssetJobStatus]>([
    ['success', 'ready'],
    ['failed', 'failed'],
    ['banned', 'failed'],
    ['unknown', 'failed'],
    ['expired', 'failed'],
    ['timeout', 'failed'],
    ['error', 'failed'],
    ['cancelled', 'cancelled'],
    ['canceled', 'cancelled'],
    ['queued', 'generating_3d'],
    ['pending', 'generating_3d'],
    ['running', 'processing'],
    ['processing', 'processing'],
  ])('maps %s to %s', (raw, expected) => {
    expect(fromTripoStatus(raw)).toBe(expected);
  });

  it('is insensitive to case and surrounding whitespace', () => {
    expect(fromTripoStatus('  SUCCESS ')).toBe('ready');
    expect(fromTripoStatus('Running')).toBe('processing');
  });

  it('falls back to a terminal failure for an unrecognised status', () => {
    // A non-terminal fallback would turn an unknown status into an endless poll.
    expect(fromTripoStatus('reticulating_splines')).toBe('failed');
    expect(fromTripoStatus('')).toBe('failed');
    expect(isTerminal(fromTripoStatus('reticulating_splines'))).toBe(true);
  });
});

describe('fromLeonardoStatus', () => {
  it.each<[string, AssetJobStatus]>([
    ['COMPLETE', 'reference_ready'],
    ['FAILED', 'failed'],
    ['PENDING', 'generating_reference'],
  ])('maps %s to %s', (raw, expected) => {
    expect(fromLeonardoStatus(raw)).toBe(expected);
  });

  it('is insensitive to case', () => {
    expect(fromLeonardoStatus('complete')).toBe('reference_ready');
    expect(fromLeonardoStatus('failed')).toBe('failed');
  });

  it('treats an unrecognised status as still-in-progress', () => {
    // Leonardo only ever reports three states, so anything else is most likely a
    // new in-flight state; the caller's own timeout ends the poll.
    expect(fromLeonardoStatus('SOMETHING_NEW')).toBe('generating_reference');
    expect(isTerminal(fromLeonardoStatus('SOMETHING_NEW'))).toBe(false);
  });
});

describe('isTerminal', () => {
  it('is true for exactly ready, failed and cancelled', () => {
    const terminal = ASSET_JOB_STATUSES.filter((status) => isTerminal(status));
    expect(terminal).toEqual(['ready', 'failed', 'cancelled']);
  });
});

describe('canTransition', () => {
  it('allows the direct text-to-3D sequence', () => {
    expect(canTransition('queued', 'generating_3d')).toBe(true);
    expect(canTransition('generating_3d', 'processing')).toBe(true);
    expect(canTransition('processing', 'ready')).toBe(true);
  });

  it('allows the image-first sequence', () => {
    expect(canTransition('queued', 'generating_reference')).toBe(true);
    expect(canTransition('generating_reference', 'reference_ready')).toBe(true);
    expect(canTransition('reference_ready', 'generating_3d')).toBe(true);
    expect(canTransition('generating_3d', 'ready')).toBe(true);
  });

  it('allows failure and cancellation from every non-terminal state', () => {
    for (const status of ASSET_JOB_STATUSES) {
      if (isTerminal(status)) continue;
      expect(canTransition(status, 'failed'), `${status} -> failed`).toBe(true);
      expect(canTransition(status, 'cancelled'), `${status} -> cancelled`).toBe(true);
    }
  });

  it('rejects moving backwards out of a terminal state', () => {
    expect(canTransition('ready', 'processing')).toBe(false);
    expect(canTransition('failed', 'ready')).toBe(false);
    expect(canTransition('cancelled', 'generating_3d')).toBe(false);
  });

  it('rejects any transition at all out of a terminal state, including to itself', () => {
    for (const from of ASSET_JOB_STATUSES) {
      if (!isTerminal(from)) continue;
      for (const to of ASSET_JOB_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('allows a non-terminal state to re-poll itself', () => {
    expect(canTransition('processing', 'processing')).toBe(true);
    expect(canTransition('generating_3d', 'generating_3d')).toBe(true);
  });

  it('rejects skipping the reference step backwards', () => {
    expect(canTransition('generating_3d', 'generating_reference')).toBe(false);
    expect(canTransition('processing', 'generating_3d')).toBe(false);
    expect(canTransition('reference_ready', 'queued')).toBe(false);
  });
});
