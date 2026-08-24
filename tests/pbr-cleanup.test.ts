/**
 * A failed extract_pbr_trio must not leave files nobody was told about.
 *
 * `uniqueFilePath` claims each plane name by creating a zero-byte file, and
 * this tool had NO cleanup at all — unlike normalize_mesh (`releaseReservation`)
 * and the batch (`discardReservation`), which are the same reservation pattern
 * with the same consequences written out in their comments. It was simply the
 * third call site the fix never reached.
 *
 * The failure is triggered deterministically by exhausting the 1000 candidate
 * names for ONE plane, which is a real state a long-lived output directory can
 * reach, and which fails partway through — after earlier planes are on disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Document, NodeIO } from '@gltf-transform/core';
import { registerPbrTools } from '../src/tools/pbr.js';
import { encodePNG } from '../src/inspection/image.js';
import { connectTools, type ToolClient } from './helpers/tool-harness.js';

let work: string;
let out: string;
let tools: ToolClient;

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'pbr-cleanup-'));
  out = path.join(work, 'planes');
  await fs.mkdir(out);
  tools = await connectTools(registerPbrTools, work);
});

afterEach(async () => {
  await tools.close();
  await fs.rm(work, { recursive: true, force: true });
});

function solid(r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return encodePNG({ width: 8, height: 8, data });
}

/** A material with base colour, normal and metallicRoughness, so several planes are written. */
async function model(file: string): Promise<string> {
  const doc = new Document();
  doc.createBuffer();
  const tex = (name: string, rgb: [number, number, number]) =>
    doc.createTexture(name).setImage(solid(...rgb)).setMimeType('image/png');
  const material = doc
    .createMaterial('m')
    .setBaseColorTexture(tex('base', [200, 200, 200]))
    .setNormalTexture(tex('nrm', [128, 128, 255]))
    .setMetallicRoughnessTexture(tex('mr', [0, 180, 90]));
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

describe('a failed plane extraction cleans up after itself', () => {
  it('leaves nothing of its own behind when a later plane cannot be named', async () => {
    const source = await model(path.join(work, 'leak.glb'));

    // Exhaust every candidate name for the METALLIC plane specifically. It is
    // emitted after albedo, normal and roughness, so the failure lands with
    // three planes already written — the partial state that used to persist.
    const blockers: string[] = [];
    for (let n = 1; n <= 1000; n += 1) {
      const name = n === 1 ? 'leak_metallic.png' : `leak_metallic_${n}.png`;
      blockers.push(name);
      await fs.writeFile(path.join(out, name), 'blocker');
    }

    const { isError } = await tools.call('extract_pbr_trio', {
      modelPath: source,
      destination: out,
    });
    expect(isError).toBe(true);

    // Only the blockers remain. Anything else is a file this call created and
    // then failed to mention — and a zero-byte `leak_metallic.png` would sort
    // FIRST in any glob over this directory.
    const remaining = (await fs.readdir(out)).sort();
    expect(remaining).toEqual(blockers.sort());
  }, 60_000);

  it('does not remove the blockers, which it does not own', async () => {
    // The other half of the guard: cleanup keyed on identity, not on name.
    // Removing a file merely because it sits at a path we wanted is the defect
    // round 9 found in the batch's release().
    const source = await model(path.join(work, 'leak.glb'));
    for (let n = 1; n <= 1000; n += 1) {
      const name = n === 1 ? 'leak_metallic.png' : `leak_metallic_${n}.png`;
      await fs.writeFile(path.join(out, name), 'blocker');
    }

    await tools.call('extract_pbr_trio', { modelPath: source, destination: out });

    expect(await fs.readFile(path.join(out, 'leak_metallic.png'), 'utf8')).toBe('blocker');
    expect(await fs.readFile(path.join(out, 'leak_metallic_1000.png'), 'utf8')).toBe('blocker');
  }, 60_000);
});
