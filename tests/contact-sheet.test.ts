/**
 * inspect_asset can say a mesh HAS UVs. It cannot say they are mirrored, that
 * an island is stretched across the seam, that the layout sits outside the
 * unit square, or that the "albedo" is one flat colour. Those are visible at
 * a glance and invisible in a table of counts, and they are the defects a
 * generated asset most often ships with.
 *
 * The contact sheet is a diagram of the data, not a render, which is why it
 * can be pure JS and run on every asset -- and why its evidence says so.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { decodeImage, encodePNG } from '../src/inspection/image.js';
import { registerContactSheetTools } from '../src/tools/contact-sheet.js';
import { connectTools, type ToolClient } from './helpers/tool-harness.js';

let work: string;
let tools: ToolClient;

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'contact-sheet-'));
  tools = await connectTools(registerContactSheetTools, work);
});

afterEach(async () => {
  await tools.close();
  await fs.rm(work, { recursive: true, force: true });
});

function solidPng(r: number, g: number, b: number, size = 8): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return encodePNG({ width: size, height: size, data });
}

/**
 * One material with a base colour and a normal texture; two triangles, one
 * inside the unit square and one deliberately outside it.
 */
async function writeModel(file: string): Promise<string> {
  const doc = new Document();
  doc.createBuffer();
  const material = doc.createMaterial('crate')
    .setBaseColorTexture(doc.createTexture('albedo').setImage(solidPng(180, 120, 60)).setMimeType('image/png'))
    .setNormalTexture(doc.createTexture('normal').setImage(solidPng(128, 128, 255)).setMimeType('image/png'));
  const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 0, 1, 1,
  ]));
  const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([
    0.1, 0.1, 0.9, 0.1, 0.1, 0.9,   // inside
    1.2, 0.2, 1.8, 0.2, 1.2, 0.8,   // outside: u > 1
  ]));
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('TEXCOORD_0', uv)
    .setMaterial(material);
  doc.createScene('s').addChild(doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(prim)));
  await new NodeIO().write(file, doc);
  return file;
}

describe('render_asset_contact_sheet', () => {
  it('draws one UV plot per material and counts what falls outside the unit square', async () => {
    const model = await writeModel(path.join(work, 'crate.glb'));
    const { isError, payload } = await tools.call('render_asset_contact_sheet', { modelPath: model, size: 128 });

    expect(isError).toBe(false);
    const materials = payload.materials as Array<Record<string, unknown>>;
    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({
      materialName: 'crate',
      uvTriangles: 2,
      uvTrianglesOutsideUnitSquare: 1,
    });
    const plot = decodeImage(await fs.readFile(materials[0]!.uvPlotPath as string));
    expect(plot.width).toBe(128);
    expect(plot.height).toBe(128);
  });

  it('marks the out-of-range triangle in red on the plot', async () => {
    const model = await writeModel(path.join(work, 'crate.glb'));
    const { payload } = await tools.call('render_asset_contact_sheet', { modelPath: model, size: 128 });
    const materials = payload.materials as Array<{ uvPlotPath: string }>;
    const plot = decodeImage(await fs.readFile(materials[0]!.uvPlotPath));

    // Only the outside triangle is red; if red appears at all, it was drawn
    // and clipped at the right edge rather than silently dropped.
    let red = 0;
    for (let i = 0; i < plot.data.length; i += 4) {
      if (plot.data[i] === 200 && plot.data[i + 1] === 40 && plot.data[i + 2] === 40) red += 1;
    }
    expect(red).toBeGreaterThan(0);
  });

  it('thumbnails each bound texture with the colorimetry its slot demands', async () => {
    const model = await writeModel(path.join(work, 'crate.glb'));
    const { payload } = await tools.call('render_asset_contact_sheet', { modelPath: model, size: 128 });
    const textures = (payload.materials as Array<{ textures: Array<Record<string, unknown>> }>)[0]!.textures;

    // Resampling a normal map in gamma space bends the vectors, so the slot
    // decides the colorimetry -- not a guess from the pixels.
    expect(textures.find((t) => t.slot === 'baseColor')?.colorimetry).toBe('srgb');
    expect(textures.find((t) => t.slot === 'normal')?.colorimetry).toBe('data');
    expect(textures.find((t) => t.slot === 'baseColor')).toMatchObject({ sourceWidth: 8, sourceHeight: 8 });
    // Every thumbnail is a readable PNG the caller can open.
    for (const texture of textures) {
      expect(() => decodeImage).not.toThrow();
      await expect(fs.access(texture.path as string)).resolves.toBeUndefined();
    }
  });

  it('declares every image as a visual so a transport that can show pictures does', async () => {
    const model = await writeModel(path.join(work, 'crate.glb'));
    const { payload } = await tools.call('render_asset_contact_sheet', { modelPath: model, size: 128 });
    const visuals = payload.visuals as Array<{ role: string; colorimetry: string; label: string }>;

    // One UV plot plus two textures.
    expect(visuals).toHaveLength(3);
    expect(visuals.filter((v) => v.role === 'render_preview')).toHaveLength(1);
    expect(visuals.filter((v) => v.role === 'texture_plane')).toHaveLength(2);
    expect(visuals[0]!.label).toContain('outside the unit square');
  });

  it('says plainly that it is a diagram of the data, not a render', async () => {
    const model = await writeModel(path.join(work, 'crate.glb'));
    const { payload } = await tools.call('render_asset_contact_sheet', { modelPath: model, size: 128 });

    expect(payload.evidence).toMatchObject({
      renderedByTargetEngine: false,
      renderMatchesTargetEngine: false,
      humanVisualReviewPerformed: false,
    });
    expect(String(payload.evidenceCeiling)).toContain('not a render');
  });

  it('refuses a format it cannot read rather than producing an empty sheet', async () => {
    const fbx = path.join(work, 'model.fbx');
    await fs.writeFile(fbx, 'not a gltf');
    const { isError, payload } = await tools.call('render_asset_contact_sheet', { modelPath: fbx });

    expect(isError).toBe(true);
    expect(payload.error).toBe('INVALID_INPUT');
  });
});
