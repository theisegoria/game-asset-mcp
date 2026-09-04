/**
 * Every heatmap, texture plane and capture frame this project produces was
 * described to the caller as numbers and written to disk. A model asked to
 * debug a render was reasoning about a picture it had never seen.
 *
 * Handlers still do not embed images: they DECLARE them, and each transport
 * decides delivery. That split is what these tests pin down -- the CLI must
 * keep getting exactly the JSON it got before, while MCP gets the pixels.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encode as encodeJpeg } from 'jpeg-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Document, NodeIO } from '@gltf-transform/core';
import { decodeImage, encodePNG, resizeImage } from '../src/inspection/image.js';
import { deliverVisuals, DEFAULT_VISUAL_BUDGET, type VisualBudget } from '../src/mcp/visuals.js';
import { ok, type ToolResult, type VisualAttachment } from '../src/tools/context.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createGameDevRuntime } from '../src/runtime.js';

let work: string;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-visuals-'));
});

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
  await fs.rm(work, { recursive: true, force: true });
});

function gradient(size: number): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      data[i] = (x * 255) / size;
      data[i + 1] = (y * 255) / size;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

async function writePng(name: string, size: number): Promise<string> {
  const file = path.join(work, name);
  await fs.writeFile(file, encodePNG(gradient(size)));
  return file;
}

function visual(file: string, overrides: Partial<VisualAttachment> = {}): VisualAttachment {
  return {
    path: file,
    mimeType: 'image/png',
    role: 'texture_plane',
    label: 'a plane',
    colorimetry: 'srgb',
    ...overrides,
  };
}

function blocks(result: ToolResult) {
  return {
    images: result.content.filter((block) => block.type === 'image'),
    links: result.content.filter((block) => block.type === 'resource_link'),
    head: result.content[0],
  };
}

describe('delivering declared visuals to a client that can see', () => {
  it('appends images after the canonical JSON, never replacing it', async () => {
    const file = await writePng('small.png', 8);
    const source = ok({ receipt: 'yes' }, [visual(file)]);

    const delivered = await deliverVisuals(source);
    const { images, head } = blocks(delivered);

    expect(head?.type).toBe('text');
    expect(images).toHaveLength(1);
    // Every existing reader parses content[0]; breaking that would break them all.
    const body = JSON.parse(head?.type === 'text' ? head.text : '{}');
    expect(body.receipt).toBe('yes');
    expect(body.visualDelivery.pixelsDeliveredToModel).toBe(true);
    expect(body.visualDelivery.fullResolutionDelivered).toBe(true);
    expect(body.visualDelivery.humanVisualReviewPerformed).toBe(false);
  });

  it('leaves a result with no visuals completely untouched', async () => {
    const source = ok({ plain: true });
    expect(await deliverVisuals(source)).toEqual(source);
  });

  it('sniffs the real format instead of trusting the extension', async () => {
    // A glTF can and does declare image/png over JPEG bytes. An inline block
    // with the wrong mimeType renders as a broken image and reports nothing.
    const file = path.join(work, 'actually-a-jpeg.png');
    const raw = gradient(16);
    await fs.writeFile(file, encodeJpeg({ width: raw.width, height: raw.height, data: Buffer.from(raw.data) }, 90).data);

    const delivered = await deliverVisuals(ok({}, [visual(file)]));
    const { images } = blocks(delivered);

    expect(images[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
  });

  it('downscales an oversized raster and refuses to imply it was full resolution', async () => {
    const file = await writePng('big.png', 512);
    const budget: VisualBudget = { ...DEFAULT_VISUAL_BUDGET, maxInlineBytes: 128, maxDimension: 64 };

    const delivered = await deliverVisuals(ok({}, [visual(file)]), budget);
    const { images, head } = blocks(delivered);
    const body = JSON.parse(head?.type === 'text' ? head.text : '{}');

    expect(images).toHaveLength(1);
    expect(body.visualDelivery.imagesDownscaledForTransport).toBe(1);
    expect(body.visualDelivery.fullResolutionDelivered).toBe(false);
  });

  it('averages a data plane in linear space, not through a gamma curve', async () => {
    // Averaging a normal or roughness map in gamma space bends the vectors and
    // darkens the surface: the thumbnail looks fine and misrepresents the exact
    // defect the caller is trying to diagnose. So this asserts bytes, not flags.
    const file = await writePng('normal.png', 256);
    const budget: VisualBudget = { ...DEFAULT_VISUAL_BUDGET, maxInlineBytes: 64, maxDimension: 32 };

    const delivered = await deliverVisuals(ok({}, [visual(file, { colorimetry: 'data' })]), budget);
    const image = blocks(delivered).images[0];
    const decoded = decodeImage(await fs.readFile(file));

    const expectedData = Buffer.from(
      encodePNG(resizeImage(decoded, 32, 32, { srgb: false })),
    ).toString('base64');
    const expectedSrgb = Buffer.from(
      encodePNG(resizeImage(decoded, 32, 32, { srgb: true })),
    ).toString('base64');

    expect(image?.type === 'image' && image.data).toBe(expectedData);
    expect(expectedData).not.toBe(expectedSrgb);
  });

  it('links a file it cannot decode rather than failing the whole call', async () => {
    const file = path.join(work, 'not-an-image.png');
    await fs.writeFile(file, 'this is not a raster');

    const delivered = await deliverVisuals(ok({ still: 'useful' }, [visual(file)]));
    const { images, links, head } = blocks(delivered);

    expect(images).toHaveLength(0);
    expect(links).toHaveLength(1);
    // The JSON body was correct without the picture and stays correct.
    expect(JSON.parse(head?.type === 'text' ? head.text : '{}').still).toBe('useful');
  });

  it('stops at the image count budget and says how many it dropped', async () => {
    const files = await Promise.all([1, 2, 3, 4].map((n) => writePng(`p${n}.png`, 8)));
    const budget: VisualBudget = { ...DEFAULT_VISUAL_BUDGET, maxImages: 2 };

    const delivered = await deliverVisuals(ok({}, files.map((f) => visual(f))), budget);
    const { images, head } = blocks(delivered);

    expect(images).toHaveLength(2);
    expect(JSON.parse(head?.type === 'text' ? head.text : '{}').visualDelivery.imagesOmitted).toBe(2);
  });
});

describe('extract_pbr_trio over the two transports', () => {
  async function modelWithTextures(): Promise<string> {
    const doc = new Document();
    doc.createBuffer();
    const png = encodePNG(gradient(8));
    const material = doc.createMaterial('mat');
    material.setBaseColorTexture(doc.createTexture('albedo').setImage(png).setMimeType('image/png'));
    material.setNormalTexture(doc.createTexture('normal').setImage(png).setMimeType('image/png'));
    material.setMetallicRoughnessTexture(
      doc.createTexture('mr').setImage(png).setMimeType('image/png'),
    );
    const position = doc.createAccessor().setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1]));
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', position).setAttribute('TEXCOORD_0', uv).setMaterial(material);
    doc.createScene('s').addChild(
      doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(prim)),
    );
    const file = path.join(work, 'textured.glb');
    await new NodeIO().write(file, doc);
    return file;
  }

  it('hands the model actual pixels, and the CLI the same JSON plus paths', async () => {
    const model = await modelWithTextures();
    const runtime = await createGameDevRuntime({ outputDir: work });
    const server = createMcpServer(runtime);
    const client = new Client({ name: 'visuals', version: '0' }, { capabilities: {} });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
    closers.push(async () => { await client.close(); });

    const viaMcp = await client.callTool({
      name: 'extract_pbr_trio',
      arguments: { modelPath: model },
    });
    const content = viaMcp.content as Array<{ type: string; text?: string; mimeType?: string }>;
    const body = JSON.parse(content[0]?.text ?? '{}');

    expect(viaMcp.isError).not.toBe(true);
    expect(content.filter((block) => block.type === 'image').length).toBeGreaterThan(0);

    // The same handler, read by the CLI, still reports the planes as paths.
    const viaRegistry = await runtime.registry.call('extract_pbr_trio', { modelPath: model });
    expect(viaRegistry.content.every((block) => block.type === 'text')).toBe(true);
    const cliBody = JSON.parse(
      viaRegistry.content[0]?.type === 'text' ? viaRegistry.content[0].text : '{}',
    );
    expect(cliBody.visuals.length).toBe(body.visuals.length);
    expect(cliBody.visuals[0].path).toMatch(/\.png$/);
  });
});
