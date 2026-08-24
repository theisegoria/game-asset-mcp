/**
 * An empty `destination` must be refused, not treated as "unset".
 *
 * `z.string().optional()` accepts `""`. Every one of these tools then resolved
 * it against the SERVER's working directory — which an MCP client chooses, not
 * the user, and which is commonly `/`. So a caller passing an empty string got
 * files written somewhere they never named, reported as success.
 *
 * 0.3.4 fixed this with `.min(1)` on three tools and shipped it with no test of
 * any kind: a round-11 grep found nothing in the suite that passed `destination`
 * or `outputDir` to a tool at all.
 *
 * ⚠ THE FIRST VERSION OF THIS FILE PASSED FOR THE WRONG REASON. It asserted
 * only `isError === true` against a nonexistent model, a nonexistent job and an
 * unconfigured provider — all of which refuse anyway. Reverting `.min(1)` left
 * it fully green. So each test below must be able to fail: the model is REAL and
 * valid, and the two tools whose other arguments cannot cheaply be made valid
 * assert that the refusal actually NAMES the destination constraint.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Document, NodeIO } from '@gltf-transform/core';
import { registerPbrTools } from '../src/tools/pbr.js';
import { registerDownloadTools } from '../src/tools/downloads.js';
import { registerAudioTools } from '../src/tools/audio.js';
import { encodePNG } from '../src/inspection/image.js';
import { connectTools, type ToolClient } from './helpers/tool-harness.js';

let work: string;
const open: ToolClient[] = [];

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'destination-'));
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
  await fs.rm(work, { recursive: true, force: true });
});

async function client(register: Parameters<typeof connectTools>[0]): Promise<ToolClient> {
  const c = await connectTools(register, work);
  open.push(c);
  return c;
}

/** A model extract_pbr_trio can genuinely process, so only `destination` is wrong. */
async function realModel(file: string): Promise<string> {
  const doc = new Document();
  doc.createBuffer();
  const pixels = new Uint8Array(8 * 8 * 4).fill(200);
  const texture = doc
    .createTexture('base')
    .setImage(encodePNG({ width: 8, height: 8, data: pixels }))
    .setMimeType('image/png');
  const material = doc.createMaterial('m').setBaseColorTexture(texture);
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const uv = doc
    .createAccessor()
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]));
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('TEXCOORD_0', uv)
    .setMaterial(material);
  doc.createScene('s').addChild(doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(prim)));
  await new NodeIO().write(file, doc);
  return file;
}

describe('an empty destination is refused by every tool that writes', () => {
  it('extract_pbr_trio refuses a VALID model when destination is empty', async () => {
    // The model is real and processable: without the constraint this call
    // succeeds and writes five PNGs into the client's working directory. That
    // is what makes this test able to fail.
    const model = await realModel(path.join(work, 'real.glb'));
    const tools = await client(registerPbrTools);
    const { isError, text } = await tools.call('extract_pbr_trio', {
      modelPath: model,
      destination: '',
    });
    expect(isError, `expected a refusal, got: ${text}`).toBe(true);
    expect(text).toMatch(/destination/i);
  });

  it('extract_pbr_trio writes nothing when it refuses', async () => {
    // The refusal is the point, but so is its timing: the original defect was
    // that the path was resolved and the tree built BEFORE validation, so a
    // rejected call had already created directories.
    const model = await realModel(path.join(work, 'real2.glb'));
    const tools = await client(registerPbrTools);
    const before = await fs.readdir(work);
    await tools.call('extract_pbr_trio', { modelPath: model, destination: '' });
    expect((await fs.readdir(work)).sort()).toEqual(before.sort());
  });

  it('download_asset names the destination constraint', async () => {
    const tools = await client(registerDownloadTools);
    const { isError, text } = await tools.call('download_asset', {
      assetJobId: 'asset_00000000-0000-0000-0000-000000000000',
      destination: '',
    });
    expect(isError).toBe(true);
    // Asserting the constraint is NAMED, because this job does not exist and so
    // the call refuses either way — the message is the only thing that
    // distinguishes "rejected your destination" from "no such job".
    expect(text).toMatch(/at least 1 character[\s\S]*destination|destination[\s\S]*at least 1 character/i);
  });

  it('generate_sound_effect names the destination constraint', async () => {
    const tools = await client(registerAudioTools);
    const { isError, text } = await tools.call('generate_sound_effect', {
      prompt: 'a door closing',
      destination: '',
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/at least 1 character[\s\S]*destination|destination[\s\S]*at least 1 character/i);
  });
});
