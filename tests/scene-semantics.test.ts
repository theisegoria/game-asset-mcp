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
import { encodePNG } from '../src/inspection/image.js';

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

/**
 * An EMPTY default scene is not the same file as NO scene graph.
 *
 * The first version of the mesh-library fallback asked "does the default scene
 * draw nothing?" instead of "does any scene reference a mesh?". A Blender export
 * whose default scene holds only a camera and a light, with the geometry in a
 * second scene, is entirely ordinary — and it took the fallback, counting every
 * mesh in the undrawn scene as drawn. That restored BOTH defects the drawn-scene
 * narrowing exists to prevent.
 */
describe('an empty default scene does not resurrect undrawn geometry', () => {
  /** Default scene holds only a camera; a second scene holds the meshes. */
  async function writeEmptyDefault(file: string, uvs: boolean): Promise<string> {
    const doc = new Document();
    doc.createBuffer();
    const position = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1]));
    const prim = doc.createPrimitive().setAttribute('POSITION', position);
    if (uvs) prim.setAttribute('TEXCOORD_0', uv);
    doc.createScene('offstage').addChild(
      doc.createNode('mesh').setMesh(doc.createMesh('mesh').addPrimitive(prim)),
    );
    // The default scene: a camera and nothing drawable.
    const empty = doc.createScene('main').addChild(doc.createNode('camera'));
    doc.getRoot().setDefaultScene(empty);
    await new NodeIO().write(file, doc);
    return file;
  }

  it('counts geometry in a non-default scene as UNDRAWN, not as a mesh library', async () => {
    const inspected = await inspectGltf(await writeEmptyDefault(path.join(work, 'offstage.glb'), true));

    // A renderer drawing `scene` draws nothing here. Reporting 1 triangle would
    // fail a triangle budget for geometry that is never submitted.
    expect(inspected.sceneGraphFallback).toBe(false);
    expect(inspected.triangleCount).toBe(0);
    expect(inspected.undrawnMeshCount).toBe(1);
    expect(inspected.undrawnTriangleCount).toBe(1);
  });

  it('does not let an unwrapped mesh in a non-default scene flip hasUVs', async () => {
    // Same shape as the collision-proxy case, but with an EMPTY default scene —
    // the variant the original fix could not see.
    const inspected = await inspectGltf(await writeEmptyDefault(path.join(work, 'nouv.glb'), false));

    // ⚠ The first draft of this assertion read `inspected.missingUvDrawn ?? 0`.
    // That field does not exist, so it was `undefined ?? 0` — a test that
    // passes forever, in both the fixed and broken code. tsc caught it; the
    // suite would not have.
    expect(inspected.sceneGraphFallback).toBe(false);
    // The mesh is UNDRAWN, so its missing UVs are not attributed to drawn
    // geometry. Under the old predicate it took the fallback, counted as drawn,
    // and its absent UVs flipped hasUVs — failing uvs_present at severity
    // `error` on the strength of a mesh no renderer submits.
    expect(inspected.undrawnMeshCount).toBe(1);
    expect(inspected.undrawnPrimitiveCount).toBe(1);
    expect(inspected.primitiveCount).toBe(0);
  });
});

/**
 * Materials and textures follow the geometry, or the report describes two files.
 *
 * The drawn-scene narrowing reached `triangleCount`, the bounding box and the
 * attribute counters, and stopped before materials, textures and the PBR channel
 * summary. Both consequences are wrong VERDICTS at severity `error`.
 */
describe('an undrawn material cannot change the verdict on a drawn one', () => {
  /** Drawn mesh with `drawnBinds`; a second, never-drawn scene with `proxyBinds`. */
  async function twoScenes(
    file: string,
    drawnBinds: 'none' | 'baseColor',
    proxyBinds: 'none' | 'normal' | 'baseColor',
  ): Promise<string> {
    const doc = new Document();
    doc.createBuffer();
    const pixels = new Uint8Array(8 * 8 * 4).fill(180);
    const tex = (name: string) =>
      doc.createTexture(name).setImage(encodePNG({ width: 8, height: 8, data: pixels })).setMimeType('image/png');
    const position = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1]));

    const drawnMat = doc.createMaterial('drawn');
    if (drawnBinds === 'baseColor') drawnMat.setBaseColorTexture(tex('drawnBase'));
    const drawnPrim = doc
      .createPrimitive()
      .setAttribute('POSITION', position)
      .setAttribute('TEXCOORD_0', uv)
      .setMaterial(drawnMat);
    const drawn = doc.createScene('drawn').addChild(
      doc.createNode('drawn').setMesh(doc.createMesh('drawn').addPrimitive(drawnPrim)),
    );

    const proxyMat = doc.createMaterial('proxy');
    if (proxyBinds === 'normal') proxyMat.setNormalTexture(tex('proxyNormal'));
    if (proxyBinds === 'baseColor') proxyMat.setBaseColorTexture(tex('proxyBase'));
    const proxyPrim = doc
      .createPrimitive()
      .setAttribute('POSITION', position)
      .setAttribute('TEXCOORD_0', uv)
      .setMaterial(proxyMat);
    doc.createScene('proxy').addChild(
      doc.createNode('proxy').setMesh(doc.createMesh('proxy').addPrimitive(proxyPrim)),
    );

    doc.getRoot().setDefaultScene(drawn);
    await new NodeIO().write(file, doc);
    return file;
  }

  it('does not report a normal map bound only by an undrawn proxy', async () => {
    // FALSE FAIL. The drawn mesh has no normal map and correctly no TANGENT.
    // File-scoped pbr reported hasNormalTexture true, and
    // `tangents_for_normal_map` refused a perfectly good model at severity error.
    const inspected = await inspectGltf(
      await twoScenes(path.join(work, 'proxynormal.glb'), 'baseColor', 'normal'),
    );

    expect(inspected.pbr.hasNormalTexture).toBe(false);
  });

  it('does not credit a base-colour texture bound only by an undrawn LOD', async () => {
    // FALSE PASS, the more dangerous direction. The drawn mesh is untextured;
    // an undrawn scene's texture made `base_color_texture` pass and the model
    // was reported shippable.
    const inspected = await inspectGltf(
      await twoScenes(path.join(work, 'proxybase.glb'), 'none', 'baseColor'),
    );

    expect(inspected.pbr.hasBaseColorTexture).toBe(false);
    expect(inspected.materialCount).toBe(1);
    expect(inspected.textureCount).toBe(0);
  });
});
