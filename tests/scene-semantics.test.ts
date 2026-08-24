/**
 * glTF `scenes` are ALTERNATIVES, not parts of one model.
 *
 * A renderer draws `scene` and ignores the rest — they are variants, LODs, or
 * authoring leftovers. Two separate readers here disagreed about that, a
 * hundred lines apart in the same file and with contradicting doc comments:
 * the triangle counter walked one scene while the bounding box unioned all of
 * them.
 *
 * That is not cosmetic. `boundingBox.sizeMeters` feeds `min_dimension`, whose
 * severity is `error` — so an undrawn scene could enlarge the reported size of
 * the drawn model and turn a refusal into a pass.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Document, NodeIO } from '@gltf-transform/core';
import { inspectGltf } from '../src/inspection/gltf.js';

let work: string;

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-semantics-'));
});

afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

/**
 * A GLB whose DEFAULT scene holds a completely flat plate (zero Y extent), plus
 * optionally a second scene, never drawn, holding a tall box.
 */
async function writePlate(file: string, withSecondScene: boolean): Promise<string> {
  const doc = new Document();
  doc.createBuffer();

  const flat = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const platePrim = doc.createPrimitive().setAttribute('POSITION', flat);
  const plate = doc.createMesh('plate').addPrimitive(platePrim);
  const plateNode = doc.createNode('plate').setMesh(plate);
  const drawn = doc.createScene('drawn').addChild(plateNode);

  if (withSecondScene) {
    const tall = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 5, 5, 0, 0, 5, 5]));
    const boxPrim = doc.createPrimitive().setAttribute('POSITION', tall);
    const box = doc.createMesh('variant').addPrimitive(boxPrim);
    doc.createScene('variant').addChild(doc.createNode('variant').setMesh(box));
  }

  // Explicit: `drawn` is the scene a renderer picks.
  doc.getRoot().setDefaultScene(drawn);
  await new NodeIO().write(file, doc);
  return file;
}

describe('an undrawn scene cannot change what the drawn one measures', () => {
  it('reports the same bounding box with and without a second scene', async () => {
    const [alone, withVariant] = await Promise.all([
      inspectGltf(await writePlate(path.join(work, 'alone.glb'), false)),
      inspectGltf(await writePlate(path.join(work, 'variant.glb'), true)),
    ]);

    // The reconciling equation: adding a scene nobody draws changes nothing
    // about the drawn model. Measured before the fix: [1, 0, 1] alone versus
    // [5, 5, 1] with the variant — and the flat plate, correctly refused on its
    // own for zero thickness, was reported SHIPPABLE once the variant existed.
    expect(withVariant.boundingBox.sizeMeters).toEqual(alone.boundingBox.sizeMeters);
    // And it really is flat, so the min_dimension gate has something to catch.
    expect(alone.boundingBox.sizeMeters[1]).toBe(0);
  });

  it('counts triangles from the drawn scene only, and reports the rest separately', async () => {
    const withVariant = await inspectGltf(await writePlate(path.join(work, 'count.glb'), true));

    // One triangle is drawn. The variant's triangle is present in the file and
    // is reported as such, rather than being folded into the budget a renderer
    // is checked against — a three-LOD file used to report 3x what it submits.
    expect(withVariant.triangleCount).toBe(1);
    expect(withVariant.meshCount).toBe(2);
  });
});
