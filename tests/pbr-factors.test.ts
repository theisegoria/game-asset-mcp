/**
 * glTF factors, applied through the real tool and read back as PIXELS.
 *
 * The effective value of a PBR channel is `texture x factor`. Every one of
 * these factors was dropped whenever a texture was present, and the shape of
 * the bug is always the same: the untextured branch got the fix and the
 * textured branch beside it did not.
 *
 * These assert on the decoded output image, not on a receipt field, because a
 * receipt saying `factorApplied: 0` proves only that a number was copied — the
 * question is whether the exported PNG is actually black.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Document, NodeIO } from '@gltf-transform/core';
import { registerPbrTools } from '../src/tools/pbr.js';
import { decodeImage, encodePNG } from '../src/inspection/image.js';
import { connectTools, type ToolClient } from './helpers/tool-harness.js';

let work: string;
let tools: ToolClient;

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'pbr-factors-'));
  tools = await connectTools(registerPbrTools, work);
});

afterEach(async () => {
  await tools.close();
  await fs.rm(work, { recursive: true, force: true });
});

/** A solid RGBA image as PNG bytes. */
function solidPng(r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return encodePNG({ width: 8, height: 8, data });
}

/**
 * A GLB whose single material carries the given textures and factors.
 * Real glTF written by the real writer — not a hand-rolled container.
 */
async function writeModel(
  file: string,
  configure: (doc: Document, material: ReturnType<Document['createMaterial']>) => void,
): Promise<string> {
  const doc = new Document();
  doc.createBuffer();
  const material = doc.createMaterial('mat');
  configure(doc, material);
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
  const mesh = doc.createMesh('m').addPrimitive(prim);
  const node = doc.createNode('n').setMesh(mesh);
  doc.createScene('s').addChild(node);
  await new NodeIO().write(file, doc);
  return file;
}

/** The first pixel of a written plane, by name. */
async function planePixel(
  payload: Record<string, unknown>,
  plane: string,
): Promise<{ r: number; g: number; b: number } | undefined> {
  const planes = payload.planes as Array<Record<string, unknown>> | undefined;
  const found = planes?.find((p) => p.plane === plane);
  if (!found || typeof found.path !== 'string') return undefined;
  const image = decodeImage(await fs.readFile(found.path));
  return { r: image.data[0] ?? 0, g: image.data[1] ?? 0, b: image.data[2] ?? 0 };
}

function planeField(
  payload: Record<string, unknown>,
  plane: string,
  field: string,
): unknown {
  const planes = payload.planes as Array<Record<string, unknown>> | undefined;
  return planes?.find((p) => p.plane === plane)?.[field];
}

describe('a factor is applied even when a texture is present', () => {
  it('tints a base-colour texture by baseColorFactor', async () => {
    // A WHITE texture with a RED factor. If the factor is dropped the plane
    // stays white, which is precisely what shipped: a material tinting a shared
    // atlas exported the untinted atlas and reported "real texture data".
    const model = await writeModel(path.join(work, 'tinted.glb'), (doc, material) => {
      const texture = doc.createTexture('base').setImage(solidPng(255, 255, 255)).setMimeType('image/png');
      material.setBaseColorTexture(texture);
      material.setBaseColorFactor([1, 0, 0, 1]);
    });

    const { isError, payload, text } = await tools.call('extract_pbr_trio', { modelPath: model });
    expect(isError, text).toBe(false);

    const albedo = await planePixel(payload, 'albedo');
    expect(albedo).toBeDefined();
    expect(albedo?.r).toBeGreaterThan(200);
    // The tint is the assertion. Dropped factor => 255 here.
    expect(albedo?.g).toBeLessThan(20);
    expect(albedo?.b).toBeLessThan(20);
  });

  it('reports the factor it applied, rather than silently dropping the field', async () => {
    // `factorApplied` was declared, passed, and never written into the receipt.
    // Asserting a field is PRESENT catches a whole class that type-checking
    // cannot: an optional property that nobody assigns is not a type error.
    const model = await writeModel(path.join(work, 'rough.glb'), (doc, material) => {
      const texture = doc
        .createTexture('mr')
        .setImage(solidPng(0, 255, 255))
        .setMimeType('image/png');
      material.setMetallicRoughnessTexture(texture);
      material.setRoughnessFactor(0.5);
      material.setMetallicFactor(0);
    });

    const { isError, payload, text } = await tools.call('extract_pbr_trio', { modelPath: model });
    expect(isError, text).toBe(false);

    expect(planeField(payload, 'roughness', 'factorApplied')).toBe(0.5);
    expect(planeField(payload, 'metallic', 'factorApplied')).toBe(0);

    // And the pixels agree with the reported number: metallicFactor 0 must be
    // black however bright the packed texture channel was.
    const metallic = await planePixel(payload, 'metallic');
    expect(metallic?.r).toBe(0);
    const roughness = await planePixel(payload, 'roughness');
    expect(roughness?.r).toBeGreaterThan(100);
    expect(roughness?.r).toBeLessThan(160);
  });

  it('fades occlusion toward WHITE as strength falls, never toward black', async () => {
    // glTF occlusion is `1 + strength * (sampled - 1)`, not a multiply. At
    // strength 0 a multiply gives black — fully occluded, the exact opposite of
    // the intended "no occlusion".
    const model = await writeModel(path.join(work, 'occ.glb'), (doc, material) => {
      const texture = doc.createTexture('occ').setImage(solidPng(0, 0, 0)).setMimeType('image/png');
      material.setOcclusionTexture(texture);
      material.setOcclusionStrength(0);
    });

    const { isError, payload, text } = await tools.call('extract_pbr_trio', { modelPath: model });
    expect(isError, text).toBe(false);

    const occlusion = await planePixel(payload, 'occlusion');
    expect(occlusion?.r).toBe(255);
    expect(planeField(payload, 'occlusion', 'factorApplied')).toBe(0);
  });

  it('bakes normalScale into the exported normal plane', async () => {
    // A flat-ish normal leaning in +X. Halving the scale must move it back
    // toward flat (128), because the plane is consumed on its own and would
    // otherwise shade differently from the source material.
    const model = await writeModel(path.join(work, 'nrm.glb'), (doc, material) => {
      const texture = doc.createTexture('n').setImage(solidPng(230, 128, 200)).setMimeType('image/png');
      material.setNormalTexture(texture);
      material.setNormalScale(0.25);
    });

    const { isError, payload, text } = await tools.call('extract_pbr_trio', { modelPath: model });
    expect(isError, text).toBe(false);

    const normal = await planePixel(payload, 'normal');
    expect(normal).toBeDefined();
    // Source X is 230; scaled down it must land well below that but stay above
    // the flat midpoint, since the lean is reduced rather than reversed.
    expect(normal!.r).toBeLessThan(200);
    expect(normal!.r).toBeGreaterThan(128);
    expect(planeField(payload, 'normal', 'factorApplied')).toBe(0.25);
  });
});

describe('the summary describes what is actually on disk', () => {
  it('says a missing normal plane is ABSENT, not a flat constant', async () => {
    // The normal plane has no factor fallback: when a material declares no
    // normal texture it is simply not emitted. The summary nevertheless said
    // "the rest are flat constants derived from material factors", naming a
    // file that does not exist. Absent and constant are different answers.
    const model = await writeModel(path.join(work, 'nonormal.glb'), (doc, material) => {
      material.setBaseColorTexture(
        doc.createTexture('base').setImage(solidPng(200, 200, 200)).setMimeType('image/png'),
      );
    });

    const { isError, payload, text } = await tools.call('extract_pbr_trio', { modelPath: model });
    expect(isError, text).toBe(false);

    expect(payload.missingPlanes).toEqual(['normal']);
    const planes = payload.planes as Array<Record<string, unknown>>;
    expect(planes.some((p) => p.plane === 'normal')).toBe(false);
    expect(String(payload.nextStep)).toMatch(/not written at all/);
  });
});
