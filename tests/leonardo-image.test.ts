/**
 * No-network tests for Leonardo's paid V1 image-generation create endpoint.
 *
 * The provider account's community-feed default is not an acceptable product
 * policy: each request must explicitly set public visibility to false.
 * Likewise, a transport retry after the remote service accepted a create can
 * charge twice, so a failed create must reach the mocked transport exactly
 * once.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerateImageOptions } from '../src/providers/image/types.js';
import { LeonardoProvider } from '../src/providers/image/leonardo.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

interface CapturedRequest {
  url: string;
  body: Record<string, unknown> | undefined;
}

function mockFetch(handler: (url: string, init: RequestInit) => Response): {
  calls: () => number;
  captured: () => CapturedRequest[];
} {
  let sent = 0;
  const captured: CapturedRequest[] = [];
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.signal?.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
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

function provider(): LeonardoProvider {
  return new LeonardoProvider({ apiKey: 'test-key', timeoutMs: 2_000 });
}

describe('Leonardo V1 image create visibility', () => {
  it('posts public false without relying on an account default', async () => {
    const probe = mockFetch(() => new Response(
      JSON.stringify({ sdGenerationJob: { generationId: 'image-1' } }),
      { status: 200 },
    ));

    const handle = await provider().generate({
      prompt: 'weathered brass game prop on a neutral background',
      negativePrompt: 'people',
      modelId: 'test-model',
      width: 640,
      height: 768,
      numImages: 2,
      seed: 42,
      guidanceScale: 6.5,
      initImageId: 'uploaded-reference',
      initStrength: 0.75,
    });

    expect(handle).toEqual({ providerGenerationId: 'image-1' });
    expect(probe.calls()).toBe(1);
    const call = probe.captured()[0];
    expect(call?.url).toBe('https://cloud.leonardo.ai/api/rest/v1/generations');
    expect(call?.body).toEqual({
      public: false,
      prompt: 'weathered brass game prop on a neutral background',
      modelId: 'test-model',
      width: 640,
      height: 768,
      num_images: 2,
      negative_prompt: 'people',
      guidance_scale: 6.5,
      seed: 42,
      init_image_id: 'uploaded-reference',
      init_strength: 0.75,
    });
  });
});

describe('Leonardo V1 paid image-create safety', () => {
  it('does not retry a failed paid create request', async () => {
    const probe = mockFetch(() => new Response('upstream error', { status: 500 }));

    await expect(provider().generate({ prompt: 'a game prop' })).rejects.toMatchObject({
      code: 'PROVIDER_HTTP',
    });

    expect(probe.calls()).toBe(1);
  });

  it.each<[string, GenerateImageOptions]>([
    ['an empty prompt', { prompt: '   ' }],
    ['a zero image count', { prompt: 'a game prop', numImages: 0 }],
    ['an excessive image count', { prompt: 'a game prop', numImages: 9 }],
    ['a negative seed', { prompt: 'a game prop', seed: -1 }],
    ['init strength without an uploaded image', { prompt: 'a game prop', initStrength: 0.5 }],
  ])('rejects %s before contacting the provider', async (_label, options) => {
    const probe = mockFetch(() => new Response('{}', { status: 200 }));

    await expect(provider().generate(options)).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(probe.calls()).toBe(0);
  });
});
