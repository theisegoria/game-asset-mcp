/**
 * A partial texture extraction must still report what it wrote.
 *
 * `extractTextures` wrote inside a loop while the caller's `catch` wrapped the
 * WHOLE loop. So a failure on texture 3 of 5 threw away the record of textures
 * 1 and 2 — which were already on disk, written atomically. `job.files` never
 * received them and `asset.json`, the provenance document, denied their
 * existence. The response then reported `textureCount: 0`, indistinguishable
 * from "this model has no embedded textures", and the only trace was a warning
 * on stderr that no caller can read.
 *
 * The guard is now per-texture, so one unwritable image costs exactly itself.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Document, NodeIO } from '@gltf-transform/core';
import { extractTextures } from '../src/tools/downloads.js';
import { encodePNG } from '../src/inspection/image.js';

let work: string;
let textures: string;

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'texture-extract-'));
  textures = path.join(work, 'textures');
  await fs.mkdir(textures);
});

afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

function solid(value: number): Uint8Array {
  const data = new Uint8Array(8 * 8 * 4).fill(value);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return encodePNG({ width: 8, height: 8, data });
}

/** A GLB carrying three separately named embedded textures. */
async function threeTextures(file: string): Promise<string> {
  const doc = new Document();
  doc.createBuffer();
  const material = doc
    .createMaterial('m')
    .setBaseColorTexture(doc.createTexture('t1').setImage(solid(10)).setMimeType('image/png'))
    .setNormalTexture(doc.createTexture('t2').setImage(solid(20)).setMimeType('image/png'))
    .setMetallicRoughnessTexture(
      doc.createTexture('t3').setImage(solid(30)).setMimeType('image/png'),
    );
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setMaterial(material);
  doc.createScene('s').addChild(doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(prim)));
  await new NodeIO().write(file, doc);
  return file;
}

describe('one unwritable texture costs exactly itself', () => {
  it('still reports the textures that were written, and names the one that was not', async () => {
    const model = await threeTextures(path.join(work, 'three.glb'));

    // Exhaust every candidate name for t2 only, so the middle texture fails
    // while the ones on either side succeed.
    for (let n = 1; n <= 1000; n += 1) {
      await fs.writeFile(path.join(textures, n === 1 ? 't2.png' : `t2_${n}.png`), 'blocker');
    }

    const result = await extractTextures(model, textures);

    // The whole point: two textures are on disk, so two must be REPORTED.
    // Before the fix this call threw and the caller recorded zero.
    expect(result.written).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('t2');

    // And what it reports is genuinely on disk with the bytes it claims.
    for (const file of result.written) {
      const bytes = await fs.readFile(file.path);
      expect(bytes.byteLength).toBe(file.bytes);
    }
  }, 60_000);

  it('reports no failures when every texture writes', async () => {
    // The negative case: a `failures` array that is never empty would satisfy
    // the test above while telling every caller something went wrong.
    const model = await threeTextures(path.join(work, 'clean.glb'));
    const result = await extractTextures(model, textures);

    expect(result.written).toHaveLength(3);
    expect(result.failures).toEqual([]);
  }, 60_000);
});
