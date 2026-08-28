import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAsset3DTools } from '../src/tools/assets3d.js';
import { connectTools } from './helpers/tool-harness.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('create_3d_asset side-effect boundary', () => {
  it('rejects a missing source before provider lookup, spend checks, or charging', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-assets3d-boundary-'));
    roots.push(root);
    let providerCalls = 0;
    let headroomCalls = 0;
    let chargeCalls = 0;
    const client = await connectTools(registerAsset3DTools, root, {
      model3dProvider: () => {
        providerCalls += 1;
        throw new Error('provider lookup must not occur');
      },
      assertHeadroom: () => {
        headroomCalls += 1;
      },
      charge: async () => {
        chargeCalls += 1;
        throw new Error('charge must not occur');
      },
    });

    const result = await client.call('create_3d_asset', {});

    expect(result.isError).toBe(true);
    expect(result.payload).toMatchObject({
      error: 'INVALID_INPUT',
      message: 'provide exactly one of assetJobId, imagePath, imageUrl or textPrompt',
      details: { provided: 0 },
    });
    expect(providerCalls).toBe(0);
    expect(headroomCalls).toBe(0);
    expect(chargeCalls).toBe(0);
  });
});
