/**
 * references.ts opens by saying these tools hand the images to the calling
 * agent, "because the calling agent already has a capable vision model".
 *
 * They never did. They handed over provider HTTPS URLs, and no MCP client
 * fetches an arbitrary URL on a model's behalf, so the stated design has never
 * actually worked. The candidates are now cached locally and declared as
 * visuals -- free GETs against a generation already paid for, against URLs the
 * type comments describe as expiring.
 *
 * The property these tests protect is the failure path. The money is spent
 * before the images exist, so a thumbnail that will not download must never
 * cost the caller the paid result.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerReferenceTools } from '../src/tools/references.js';
import { connectTools, type ToolClient } from './helpers/tool-harness.js';
import type { ImageProvider } from '../src/providers/image/types.js';

let work: string;
let tools: ToolClient;

/** A provider that "succeeds" but whose image URLs will never resolve. */
function unreachableProvider(): ImageProvider {
  return {
    name: 'stub',
    defaultModelId: 'stub-model',
    generate: async () => ({ providerGenerationId: 'gen_1', rawStatus: 'PENDING' }),
    getGeneration: async () => ({
      providerGenerationId: 'gen_1',
      rawStatus: 'COMPLETE',
      images: [
        { providerImageId: 'a', url: 'https://localhost:1/a.png', width: 8, height: 8 },
        { providerImageId: 'b', url: 'https://localhost:1/b.png', width: 8, height: 8 },
      ],
      raw: {},
    }),
  };
}

async function connect(): Promise<ToolClient> {
  return connectTools(registerReferenceTools, work, { imageProvider: () => unreachableProvider() });
}

const spec = { name: 'crate', description: 'a small wooden crate' };

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'ref-thumbs-'));
  delete process.env.ASSET_REFERENCE_THUMBNAILS;
});

afterEach(async () => {
  delete process.env.ASSET_REFERENCE_THUMBNAILS;
  await tools?.close();
  await fs.rm(work, { recursive: true, force: true });
});

describe('caching reference candidates', () => {
  it('still returns the paid result when a thumbnail cannot be fetched', async () => {
    tools = await connect();

    const { isError, payload } = await tools.call('generate_asset_reference', {
      spec,
      numImages: 2,
      waitSeconds: 2,
    });

    // The generation succeeded and was charged. Losing that because an image
    // host was unreachable would be the worst available trade.
    expect(isError).toBe(false);
    expect(payload.assetJobId).toBeTruthy();
    expect((payload.candidates as unknown[]).length).toBe(2);
    // No visuals, because nothing could be cached -- but no failure either.
    expect(payload.visuals).toBeUndefined();
  }, 30_000);

  it('writes nothing when thumbnail caching is switched off', async () => {
    process.env.ASSET_REFERENCE_THUMBNAILS = 'off';
    tools = await connect();

    const { isError, payload } = await tools.call('generate_asset_reference', {
      spec,
      numImages: 2,
      waitSeconds: 2,
    });

    expect(isError).toBe(false);
    expect(payload.visuals).toBeUndefined();
    // The opt-out must not even create the directory.
    await expect(fs.access(path.join(work, '.thumbnails'))).rejects.toThrow();
  }, 30_000);
});
