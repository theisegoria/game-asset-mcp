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

/** A mesh with no node referencing it — a "mesh library", which is valid glTF. */
async function writeOrphanLibrary(file: string): Promise<string> {
  const doc = new Document();
  doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1]));
  const normal = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]));
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('TEXCOORD_0', uv)
    .setAttribute('NORMAL', normal);
  doc.createMesh('library_part').addPrimitive(prim);
  // Deliberately NO scene and NO node.
  await new NodeIO().write(file, doc);
  return file;
}

describe('a mesh library is geometry, not an empty file', () => {
  it('counts meshes that no node draws, rather than reporting zero', async () => {
    // REGRESSION GUARD. Narrowing every count to the drawn scene turned this
    // valid file into "0 triangles", which validate_game_asset refuses at
    // severity error — and the report contradicted itself, claiming nothing
    // renders while carrying a real bounding box, because computeBoundingBox
    // has this fallback and the triangle counter did not.
    const inspected = await inspectGltf(await writeOrphanLibrary(path.join(work, 'library.glb')));

    expect(inspected.triangleCount).toBe(1);
    expect(inspected.vertexCount).toBe(3);
    expect(inspected.sceneGraphFallback).toBe(true);
    // And it must not ALSO be counted as undrawn: one mesh, one answer.
    expect(inspected.undrawnMeshCount).toBe(0);
    expect(inspected.warnings.join(' ')).not.toContain('zero triangles');
  });

  it('reports the undrawn counts it claims to report', async () => {
    // The fields existed, were computed, were documented as "reported", and
    // appeared in NO response — they were never added to the output interface,
    // so the compiler had nothing to object to. Asserting they are PRESENT is
    // the only thing that catches that.
    const inspected = await inspectGltf(await writePlate(path.join(work, 'counts.glb'), true));

    expect(inspected.undrawnMeshCount).toBe(1);
    expect(inspected.undrawnPrimitiveCount).toBe(1);
    expect(inspected.undrawnTriangleCount).toBe(1);
    expect(inspected.sceneGraphFallback).toBe(false);
  });
});

describe('an undrawn scene cannot fail a model that is fine', () => {
  it('does not let an unwrapped proxy in a second scene flip uvs_present', async () => {
    // The mirror image of the bounding-box defect, in the same function, left
    // half-done: triangleCount and the bbox were narrowed to the drawn scene
    // while primitiveCount and missingUv still counted EVERY primitive — and
    // hasUVs derives from missingUv, at severity `error`.
    const doc = new Document();
    doc.createBuffer();
    const position = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1]));
    const normal = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]));
    // Drawn mesh: fully unwrapped.
    const good = doc
      .createPrimitive()
      .setAttribute('POSITION', position)
      .setAttribute('TEXCOORD_0', uv)
      .setAttribute('NORMAL', normal);
    const drawn = doc.createScene('drawn').addChild(
      doc.createNode('good').setMesh(doc.createMesh('good').addPrimitive(good)),
    );
    // Never drawn: a collision proxy with no UVs at all.
    const proxy = doc.createPrimitive().setAttribute('POSITION', position);
    doc.createScene('proxy').addChild(
      doc.createNode('proxy').setMesh(doc.createMesh('proxy').addPrimitive(proxy)),
    );
    doc.getRoot().setDefaultScene(drawn);
    const file = path.join(work, 'proxy.glb');
    await new NodeIO().write(file, doc);

    const inspected = await inspectGltf(file);
    // hasUVs is what uvs_present reads, and uvs_present is severity `error`.
    expect(inspected.hasUVs).toBe(true);
    expect(inspected.undrawnPrimitiveCount).toBe(1);
  });
});
