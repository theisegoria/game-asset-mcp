import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TRIPO_DEFAULT_BASE_URL,
  TripoProvider,
} from '../src/providers/model3d/tripo.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Tripo v2 OpenAPI contract', () => {
  it('uses the documented v2 task endpoint by default', async () => {
    vi.stubEnv('TRIPO_BASE_URL', '');
    let requestedUrl = '';
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        code: 0,
        data: { task_id: 'task_contract_1' },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new TripoProvider({ apiKey: 'tsk_test', timeoutMs: 1_000 });
    const result = await provider.generateFromText({ prompt: 'a brass astrolabe' });

    expect(TRIPO_DEFAULT_BASE_URL).toBe('https://api.tripo3d.ai/v2/openapi');
    expect(requestedUrl).toBe(`${TRIPO_DEFAULT_BASE_URL}/task`);
    expect(result.providerTaskId).toBe('task_contract_1');
  });

  it('maps consumed_credit without inventing the retired credits field', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        task_id: 'task_contract_2',
        status: 'success',
        progress: 100,
        consumed_credit: 37,
        output: { model: 'https://cdn.example/model.glb' },
      },
    }), { status: 200 })) as unknown as typeof fetch;

    const provider = new TripoProvider({
      apiKey: 'tsk_test',
      timeoutMs: 1_000,
      baseUrl: 'https://tripo.contract.test/v2/openapi',
    });
    const result = await provider.getTask('task_contract_2');

    expect(result.creditCost).toBe(37);
    expect(result.modelUrl).toBe('https://cdn.example/model.glb');
  });
});
