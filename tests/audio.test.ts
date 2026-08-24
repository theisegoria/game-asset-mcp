/**
 * Tests for Leonardo sound-effect generation.
 *
 * Two properties matter most here. First, credit safety: the create call must
 * reach the network exactly once. Second, the response parser must not report
 * success when it found nothing — the v2 response shape is undocumented, so a
 * parser that quietly returns an empty array would look like a slow generation
 * forever.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeonardoAudioProvider } from '../src/providers/audio/leonardo.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

interface Captured {
  url: string;
  body: Record<string, unknown> | undefined;
}

function mockFetch(handler: (url: string, init: RequestInit) => Response): {
  calls: () => number;
  captured: () => Captured[];
} {
  let sent = 0;
  const captured: Captured[] = [];
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    sent += 1;
    captured.push({
      url: String(input),
      body: typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined,
    });
    return handler(String(input), init ?? {});
  }) as unknown as typeof fetch;
  return { calls: () => sent, captured: () => captured };
}

const provider = (): LeonardoAudioProvider =>
  new LeonardoAudioProvider({ apiKey: 'test-key', timeoutMs: 2000 });

describe('request validation refuses rather than clamps', () => {
  it.each([0, 23, 2.5, -1])('rejects duration %s without contacting the provider', async (duration) => {
    const probe = mockFetch(() => new Response('{}', { status: 200 }));
    await expect(
      provider().generateSoundEffect({ prompt: 'a door', durationSeconds: duration }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // Silently clamping 60s to 22s would ship the wrong asset; so would billing
    // for a request we knew was invalid.
    expect(probe.calls()).toBe(0);
  });

  it('rejects an out-of-range quantity and prompt influence', async () => {
    const probe = mockFetch(() => new Response('{}', { status: 200 }));
    await expect(
      provider().generateSoundEffect({ prompt: 'a door', quantity: 5 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      provider().generateSoundEffect({ prompt: 'a door', promptInfluence: 1.5 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(probe.calls()).toBe(0);
  });

  it('rejects an empty or over-long prompt', async () => {
    const probe = mockFetch(() => new Response('{}', { status: 200 }));
    await expect(provider().generateSoundEffect({ prompt: '   ' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      provider().generateSoundEffect({ prompt: 'x'.repeat(10_000) }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(probe.calls()).toBe(0);
  });
});

describe('credit safety', () => {
  it('attempts the paid create call exactly once on a 500', async () => {
    const probe = mockFetch(() => new Response('boom', { status: 500 }));
    await expect(provider().generateSoundEffect({ prompt: 'a door' })).rejects.toMatchObject({
      code: 'PROVIDER_HTTP',
    });
    expect(probe.calls()).toBe(1);
  });

  it('posts the documented contract to the v2 endpoint', async () => {
    const probe = mockFetch(() => new Response(JSON.stringify({ id: 'gen-1' }), { status: 200 }));
    await provider().generateSoundEffect({
      prompt: 'heavy steel door slam',
      durationSeconds: 5,
      loop: true,
      quantity: 2,
      promptInfluence: 0.4,
    });
    const call = probe.captured()[0];
    expect(call?.url).toContain('/v2/generations');
    expect(call?.body?.model).toBe('sound-effects-v2');
    expect(call?.body?.duration).toBe(5);
    expect(call?.body?.loop).toBe(true);
    expect(call?.body?.quantity).toBe(2);
    expect(call?.body?.prompt_influence).toBe(0.4);
    // Never publish a user's asset by default.
    expect(call?.body?.public).toBe(false);
  });
});

describe('undocumented response shapes', () => {
  it.each([
    ['sdGenerationJob', { sdGenerationJob: { generationId: 'a1' } }],
    ['flat generationId', { generationId: 'a1' }],
    ['bare id', { id: 'a1' }],
    ['nested data.id', { data: { id: 'a1' } }],
  ])('recovers the generation id from a %s payload', async (_label, payload) => {
    mockFetch(() => new Response(JSON.stringify(payload), { status: 200 }));
    const handle = await provider().generateSoundEffect({ prompt: 'a door' });
    expect(handle.providerGenerationId).toBe('a1');
  });

  it('refuses loudly when no generation id can be found', async () => {
    mockFetch(() => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
    // Returning a fabricated id would make every later poll fail confusingly.
    await expect(provider().generateSoundEffect({ prompt: 'a door' })).rejects.toMatchObject({
      code: 'PROVIDER_MALFORMED_RESPONSE',
    });
  });
});

describe('audio collection', () => {
  it('finds nested audio URLs regardless of the wrapper shape', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          generations_by_pk: {
            status: 'COMPLETE',
            generated: [{ id: 'clip-1', url: 'https://cdn.test/a.wav', duration: 3 }],
          },
        }),
        { status: 200 },
      ),
    );
    const result = await provider().getGeneration('gen-1');
    expect(result.audio).toHaveLength(1);
    expect(result.audio[0]?.url).toBe('https://cdn.test/a.wav');
    expect(result.audio[0]?.providerAudioId).toBe('clip-1');
    expect(result.audio[0]?.durationSeconds).toBe(3);
    expect(result.rawStatus).toBe('COMPLETE');
  });

  it('ignores URLs that are not audio', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          generations_by_pk: {
            status: 'COMPLETE',
            generated_images: [{ url: 'https://cdn.test/preview.png' }],
          },
        }),
        { status: 200 },
      ),
    );
    const result = await provider().getGeneration('gen-1');
    // A preview image must never be handed back as the sound effect.
    expect(result.audio).toHaveLength(0);
  });

  it('does not duplicate the same URL found twice', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          a: { url: 'https://cdn.test/x.mp3' },
          b: { url: 'https://cdn.test/x.mp3' },
        }),
        { status: 200 },
      ),
    );
    const result = await provider().getGeneration('gen-1');
    expect(result.audio).toHaveLength(1);
  });

  it('reports a provider failure as a result, not an exception', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ generations_by_pk: { status: 'FAILED' } }), { status: 200 }),
    );
    const result = await provider().getGeneration('gen-1');
    expect(result.rawStatus).toBe('FAILED');
    expect(result.errorMessage).toBeTruthy();
    expect(result.audio).toHaveLength(0);
  });

  it('treats a still-empty response as pending rather than complete', async () => {
    mockFetch(() => new Response(JSON.stringify({ generations_by_pk: null }), { status: 200 }));
    const result = await provider().getGeneration('gen-1');
    expect(result.rawStatus).toBe('PENDING');
    expect(result.errorMessage).toBeUndefined();
  });
});

describe('URL recognition without relying on file extensions', () => {
  it('accepts a signed CDN URL with no extension when the KEY names audio', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({ status: 'COMPLETE', audioUrl: 'https://cdn.test/abc123?sig=xyz' }),
        { status: 200 },
      ),
    );
    // Extension-only matching would reject this and look like an eternal pending.
    const result = await provider().getGeneration('gen-1');
    expect(result.audio).toHaveLength(1);
    expect(result.audio[0]?.url).toBe('https://cdn.test/abc123?sig=xyz');
  });

  it('accepts a bare url nested inside an audio container', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({ status: 'COMPLETE', generated_audio: [{ url: 'https://cdn.test/x9' }] }),
        { status: 200 },
      ),
    );
    const result = await provider().getGeneration('gen-1');
    expect(result.audio).toHaveLength(1);
  });

  it('still rejects an image even under an audio-named key', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({ status: 'COMPLETE', audioUrl: 'https://cdn.test/preview.png' }),
        { status: 200 },
      ),
    );
    const result = await provider().getGeneration('gen-1');
    expect(result.audio).toHaveLength(0);
  });

  it('rejects a bare url in a non-audio container', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({ status: 'COMPLETE', generated_images: [{ url: 'https://cdn.test/z1' }] }),
        { status: 200 },
      ),
    );
    const result = await provider().getGeneration('gen-1');
    expect(result.audio).toHaveLength(0);
  });
});

describe('retrieval endpoint discovery', () => {
  it('prefers v2 and falls back to v1 on 404', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/v2/generations/')) return new Response('nope', { status: 404 });
      return new Response(
        JSON.stringify({ generations_by_pk: { status: 'COMPLETE', generated_audio: [{ url: 'https://cdn.test/a.wav' }] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await provider().getGeneration('gen-1');
    expect(seen.some((u) => u.includes('/v2/generations/'))).toBe(true);
    expect(seen.some((u) => u.includes('/v1/generations/'))).toBe(true);
    expect(result.audio).toHaveLength(1);
  });

  it('reports the payload shape when COMPLETE yields no recognisable audio', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ status: 'COMPLETE', somethingNew: { blob: 'x' } }), { status: 200 }),
    );
    const result = await provider().getGeneration('gen-1');
    // Silence here would read as an eternal pending; the caller must be told.
    expect(result.errorMessage).toContain('no audio URL was recognised');
    expect(result.errorMessage).toContain('somethingNew');
  });
});
