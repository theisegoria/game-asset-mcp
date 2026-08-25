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
import { registerValidateTools } from '../src/tools/validate.js';
import { encodePNG } from '../src/inspection/image.js';
import { registerInspectionTools } from '../src/tools/inspection.js';
import { connectTools, type ToolClient } from './helpers/tool-harness.js';

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

/**
 * The fields must survive the hop this repo keeps losing them on.
 *
 * `weldSkipped`, `factorApplied`, `stdoutTruncated` and the undrawn counters
 * were every one of them computed correctly and lost between the interface and
 * the client. `ok(payload: unknown)` erases the type at that boundary, so the
 * compiler guards summarizer -> interface and nothing guards interface ->
 * client. Every other test in this file calls `inspectGltf` directly and would
 * stay green if the fields were dropped on the way out.
 *
 * So this one goes through a real MCP client, which is what the harness in
 * tests/helpers exists for — and which the release that needed it did not use.
 */
describe('the undrawn counters reach an actual client', () => {
  let tools: ToolClient;

  beforeEach(async () => {
    tools = await connectTools(registerInspectionTools, work);
  });
  afterEach(async () => {
    await tools.close();
  });

  it('includes every undrawn field in the inspect_asset response', async () => {
    const model = await writePlate(path.join(work, 'client.glb'), true);

    const { isError, payload, text } = await tools.call('inspect_asset', { modelPath: model });
    expect(isError, text).toBe(false);

    // Presence, not just value: an omitted optional field is not a type error,
    // and `undefined === undefined` is how three releases of this shipped.
    for (const field of [
      'undrawnMeshCount',
      'undrawnPrimitiveCount',
      'undrawnTriangleCount',
      'sceneGraphFallback',
    ]) {
      expect(Object.hasOwn(payload, field), `${field} missing from the client response`).toBe(true);
    }

    expect(payload.undrawnMeshCount).toBe(1);
    expect(payload.undrawnPrimitiveCount).toBe(1);
    expect(payload.undrawnTriangleCount).toBe(1);
    expect(payload.sceneGraphFallback).toBe(false);
    expect(payload.triangleCount).toBe(1);
  });
});

/**
 * A report must not state things about the file that are false.
 *
 * With an empty default scene, `hasUVs` is `primitiveCount > 0 && missingUv === 0`
 * — false because nothing is DRAWN, not because anything lacks UVs. The policy
 * then rendered that as "at least one primitive has no TEXCOORD_0" for a file
 * whose every primitive is fully unwrapped, and did the same for normals. Three
 * errors for one cause, two of them untrue.
 *
 * And the bounding box answered to a DIFFERENT predicate from
 * sceneGraphFallback, so one response carried `sceneGraphFallback: false`
 * beside the warning "no scene references the meshes" — the boolean and the
 * warning contradicting each other, with min_dimension (severity `error`)
 * judged against geometry the same report said was not drawn.
 */
describe('a draws-nothing file is described honestly', () => {
  async function emptyDefaultWithGoodMesh(file: string): Promise<string> {
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
    doc.createScene('offstage').addChild(
      doc.createNode('m').setMesh(doc.createMesh('m').addPrimitive(prim)),
    );
    doc.getRoot().setDefaultScene(doc.createScene('main').addChild(doc.createNode('camera')));
    await new NodeIO().write(file, doc);
    return file;
  }

  it('does not claim a primitive lacks UVs when none is drawn', async () => {
    const model = await emptyDefaultWithGoodMesh(path.join(work, 'honest.glb'));
    const tools = await connectTools(registerValidateTools, work);
    try {
      const { isError, payload, text } = await tools.call('validate_game_asset', { modelPath: model });
      expect(isError, text).toBe(false);
      const failed = (payload.failures as Array<Record<string, unknown>>).map((f) => f.id);

      // The real cause, named. `min_dimension` is also true of a file that
      // draws nothing, so it is allowed to stand.
      expect(failed).toContain('has_geometry');
      // NOT these — every primitive in this file carries both. Before the fix
      // they failed with "at least one primitive has no TEXCOORD_0", which is
      // simply untrue about the file.
      expect(failed).not.toContain('uvs_present');
      expect(failed).not.toContain('normals_present');
    } finally {
      await tools.close();
    }
  });

  it('does not claim there is no base colour texture either', async () => {
    // The THIRD site of the same gate, missed when the other two were fixed —
    // and it SURVIVED a mutation sweep because it is off by default, so nothing
    // in the suite ever reached it. The policy has to be switched on explicitly.
    const model = await emptyDefaultWithGoodMesh(path.join(work, 'basecolor.glb'));
    const tools = await connectTools(registerValidateTools, work);
    try {
      // ⚠ FLAT, not nested under `policy`. The first version of this test
      // passed `policy: { requireBaseColorTexture: true }`, which the schema
      // ignores — so the check never ran and the assertion was vacuous. The
      // mutant survived while the test reported green.
      const { isError, payload, text } = await tools.call('validate_game_asset', {
        modelPath: model,
        requireBaseColorTexture: true,
      });
      expect(isError, text).toBe(false);
      const failed = (payload.failures as Array<Record<string, unknown>>).map((f) => f.id);

      expect(failed).toContain('has_geometry');
      // Untrue about a file whose material binds one, at severity `error`.
      expect(failed).not.toContain('base_color_texture');
    } finally {
      await tools.close();
    }
  });

  it('does not contradict itself about whether a scene graph exists', async () => {
    const inspected = await inspectGltf(await emptyDefaultWithGoodMesh(path.join(work, 'nocontra.glb')));

    // The file HAS a scene graph, so no mesh-library fallback — and therefore
    // no local-space bounding box either. Previously these disagreed.
    expect(inspected.sceneGraphFallback).toBe(false);
    expect(inspected.warnings.join(' ')).not.toContain('local-space');
    expect(inspected.boundingBox.sizeMeters).toEqual([0, 0, 0]);
  });
});

/**
 * A texture bound through an extension is still a texture.
 *
 * Scoping textures to the drawn materials was done by ENUMERATING the five core
 * PBR slots, which cannot see a binding that lives in an extension —
 * KHR_materials_clearcoat, sheen, transmission, specular, volume, iridescence,
 * anisotropy — all routine in provider and marketplace exports. A real clearcoat
 * map vanished from `textureCount` and from both texture checks, and
 * `inspect_asset` and `download_asset` then reported different counts for the
 * same file.
 *
 * The distinction that fixes it: a texture bound by an UNDRAWN material is
 * genuinely excluded, but a texture whose binding this reader could not parse is
 * INDETERMINATE, and dropping it silently is the worse error.
 */
describe('an extension-bound texture is not silently dropped', () => {
  async function withClearcoat(dir: string): Promise<string> {
    const png = encodePNG({ width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(180) });
    const uri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
    const gltf = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
      materials: [
        {
          pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
          extensions: { KHR_materials_clearcoat: { clearcoatNormalTexture: { index: 1 } } },
        },
      ],
      extensionsUsed: ['KHR_materials_clearcoat'],
      textures: [{ source: 0 }, { source: 1 }],
      images: [
        { uri, mimeType: 'image/png' },
        { uri, mimeType: 'image/png' },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2', min: [0, 0], max: [1, 1] },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 24 },
      ],
      buffers: [
        {
          byteLength: 60,
          uri: `data:application/octet-stream;base64,${Buffer.alloc(60).toString('base64')}`,
        },
      ],
    };
    const file = path.join(dir, 'clearcoat.gltf');
    await fs.writeFile(file, JSON.stringify(gltf));
    return file;
  }

  it('counts a clearcoat map whose binding this reader cannot parse', async () => {
    const inspected = await inspectGltf(await withClearcoat(work));

    // Two textures in the file, both reachable from the one drawn material —
    // one through a core slot, one through an extension. Enumerating slots saw
    // only the first.
    expect(inspected.textureCount).toBe(2);
    expect(inspected.textureResolutions).toHaveLength(2);
  });
});

/**
 * An orphan texture is not an extension-bound one.
 *
 * Both have `Root` as their only parent, so the parsed document cannot tell
 * them apart, and counting them alike brought back exactly the
 * `texture_resolution` / `power_of_two_textures` warnings that scoping textures
 * to drawn materials exists to suppress. On one file it was worse than noisy:
 * `inspect_asset` reported ONLY the texture nothing samples.
 *
 * The reader's own log is the evidence — it says when it skipped an extension.
 */
describe('an unused leftover texture is not counted as drawn', () => {
  async function withOrphan(dir: string, declareExtension: boolean): Promise<string> {
    const big = encodePNG({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(200) });
    const odd = encodePNG({ width: 25, height: 25, data: new Uint8Array(25 * 25 * 4).fill(90) });
    const gltf: Record<string, unknown> = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }, { source: 1 }],
      images: [
        { uri: `data:image/png;base64,${Buffer.from(big).toString('base64')}`, mimeType: 'image/png' },
        { uri: `data:image/png;base64,${Buffer.from(odd).toString('base64')}`, mimeType: 'image/png' },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2', min: [0, 0], max: [1, 1] },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 24 },
      ],
      buffers: [
        {
          byteLength: 60,
          uri: `data:application/octet-stream;base64,${Buffer.alloc(60).toString('base64')}`,
        },
      ],
    };
    if (declareExtension) {
      // Same file, but texture 1 IS bound — through an extension this reader
      // does not register. Identical parent structure; different truth.
      (gltf.materials as Array<Record<string, unknown>>)[0]!.extensions = {
        KHR_materials_clearcoat: { clearcoatNormalTexture: { index: 1 } },
      };
      gltf.extensionsUsed = ['KHR_materials_clearcoat'];
    }
    const file = path.join(dir, declareExtension ? 'ext.gltf' : 'orphan.gltf');
    await fs.writeFile(file, JSON.stringify(gltf));
    return file;
  }

  it('excludes a texture that nothing references', async () => {
    const inspected = await inspectGltf(await withOrphan(work, false));

    // One drawn texture. The 25x25 leftover is unused: counting it produced a
    // non-power-of-two warning and a resolution warning about a texture no
    // renderer samples.
    expect(inspected.textureCount).toBe(1);
    expect(inspected.textureResolutions).toHaveLength(1);
    expect(inspected.textureResolutions[0]?.width).toBe(64);
  });

  it('still counts the same texture when an extension actually binds it', async () => {
    // The pair matters more than either half: identical parent structure in the
    // parsed document, opposite correct answers, decided by the reader's log.
    const inspected = await inspectGltf(await withOrphan(work, true));

    expect(inspected.textureCount).toBe(2);
  });
});

/**
 * A placeholder bounding box is not a measurement.
 *
 * `bounds.empty` was computed and reached no consumer — the fifth instance of
 * that class here. So `bounding_box_finite` PASSED while reporting
 * "0.000 x 0.000 x 0.000 m" for a file where no finite vertex was found, and
 * `min_dimension` failed at severity `error` for the same reason `has_geometry`
 * already had. Three errors, one cause, one of them describing a measurement
 * that never happened.
 */
describe('a file with nothing to measure says so', () => {
  it('reports boundingBoxEmpty to the client', async () => {
    // Presence at the boundary, not just internally — this is the hop where
    // four previous fields were lost.
    const doc = new Document();
    doc.createBuffer();
    doc.createScene('empty');
    const file = path.join(work, 'nothing.glb');
    await new NodeIO().write(file, doc);

    const tools = await connectTools(registerInspectionTools, work);
    try {
      const { payload } = await tools.call('inspect_asset', { modelPath: file });
      expect(Object.hasOwn(payload, 'boundingBoxEmpty')).toBe(true);
      expect(payload.boundingBoxEmpty).toBe(true);
    } finally {
      await tools.close();
    }
  });

  it('does not report a zero box as a passing measurement', async () => {
    const doc = new Document();
    doc.createBuffer();
    doc.createScene('empty');
    const file = path.join(work, 'nothing2.glb');
    await new NodeIO().write(file, doc);

    const tools = await connectTools(registerValidateTools, work);
    try {
      const { payload } = await tools.call('validate_game_asset', { modelPath: file });
      const failed = (payload.failures as Array<Record<string, unknown>>).map((f) => f.id);

      // The real cause, named.
      expect(failed).toContain('has_geometry');
      // NOT a dimension judgement on a box that was never measured.
      expect(failed).not.toContain('min_dimension');
      const finiteCheck = (payload.failures as Array<Record<string, unknown>>).find(
        (f) => f.id === 'bounding_box_finite',
      );
      // It must not silently PASS either — if it reports at all, it must say
      // there was nothing to measure rather than quote 0.000 x 0.000 x 0.000.
      if (finiteCheck) expect(String(finiteCheck.actual)).toMatch(/no finite vertex/);
    } finally {
      await tools.close();
    }
  });
});
