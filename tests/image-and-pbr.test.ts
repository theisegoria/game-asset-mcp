/**
 * Tests for the raster primitives behind PBR plane extraction.
 *
 * The channel-mapping tests matter most: reading metallic where roughness was
 * meant produces a surface that renders, looks plausible, and is wrong. Nothing
 * downstream can detect that, so it has to be pinned here.
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  constantImage,
  decodeImage,
  encodePNG,
  extractChannel,
  resizeImage,
  sniffImageFormat,
  MAX_IMAGE_PIXELS,
  type RasterImage,
} from '../src/inspection/image.js';

/** An image whose four channels hold four distinct constants. */
function channelProbe(width = 4, height = 4): RasterImage {
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 4] = 10;
    data[pixel * 4 + 1] = 90;
    data[pixel * 4 + 2] = 200;
    data[pixel * 4 + 3] = 255;
  }
  return { width, height, data };
}

describe('format sniffing trusts bytes, not declarations', () => {
  it('identifies PNG and JPEG by magic', () => {
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe('png');
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
  });

  it('returns undefined for anything else rather than guessing', () => {
    expect(sniffImageFormat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined();
    expect(sniffImageFormat(new Uint8Array([]))).toBeUndefined();
  });

  it('refuses to decode a non-image', () => {
    expect(() => decodeImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });
});

describe('channel extraction — the glTF de-pack', () => {
  it('lifts the requested channel and only that channel', () => {
    const probe = channelProbe();
    // glTF packs roughness in G and metallic in B. Getting these backwards is
    // the single most consequential silent error in this module.
    const roughness = extractChannel(probe, 'g');
    const metallic = extractChannel(probe, 'b');
    expect(roughness.data[0]).toBe(90);
    expect(metallic.data[0]).toBe(200);
    expect(extractChannel(probe, 'r').data[0]).toBe(10);
  });

  it('produces an opaque greyscale image', () => {
    const roughness = extractChannel(channelProbe(), 'g');
    for (let pixel = 0; pixel < roughness.width * roughness.height; pixel += 1) {
      const at = pixel * 4;
      expect(roughness.data[at]).toBe(roughness.data[at + 1]);
      expect(roughness.data[at + 1]).toBe(roughness.data[at + 2]);
      expect(roughness.data[at + 3]).toBe(255);
    }
  });

  it('does not alias two channels onto the same output', () => {
    const probe = channelProbe();
    const g = extractChannel(probe, 'g');
    const b = extractChannel(probe, 'b');
    expect(Buffer.from(g.data).equals(Buffer.from(b.data))).toBe(false);
  });
});

describe('resampling', () => {
  it('hits the exact requested size', () => {
    const resized = resizeImage(channelProbe(64, 64), 32, 32, { srgb: false });
    expect(resized.width).toBe(32);
    expect(resized.height).toBe(32);
    expect(resized.data.length).toBe(32 * 32 * 4);
  });

  it('returns the input untouched when the size already matches', () => {
    const probe = channelProbe(8, 8);
    expect(resizeImage(probe, 8, 8, { srgb: false })).toBe(probe);
  });

  it('preserves a constant field exactly', () => {
    const flat = constantImage(16, 16, 137);
    const resized = resizeImage(flat, 4, 4, { srgb: false });
    for (let pixel = 0; pixel < 16; pixel += 1) {
      expect(resized.data[pixel * 4]).toBe(137);
    }
  });

  it('averages linear data arithmetically', () => {
    // Two columns, 0 and 255: a linear average must land on 128, not 188.
    const data = new Uint8Array(2 * 1 * 4);
    data[0] = 0; data[1] = 0; data[2] = 0; data[3] = 255;
    data[4] = 255; data[5] = 255; data[6] = 255; data[7] = 255;
    const resized = resizeImage({ width: 2, height: 1, data }, 1, 1, { srgb: false });
    expect(resized.data[0]).toBe(128);
  });

  it('averages colour in LINEAR LIGHT, which is brighter than a naive average', () => {
    const data = new Uint8Array(2 * 1 * 4);
    data[0] = 0; data[1] = 0; data[2] = 0; data[3] = 255;
    data[4] = 255; data[5] = 255; data[6] = 255; data[7] = 255;
    const resized = resizeImage({ width: 2, height: 1, data }, 1, 1, { srgb: true });
    // Correct sRGB midpoint of black and white is ~188, not 128. A result of
    // 128 would mean the gamma handling silently did nothing.
    expect(resized.data[0]).toBeGreaterThan(180);
    expect(resized.data[0]).toBeLessThan(195);
  });
});

describe('encode / decode round trip', () => {
  it('preserves pixels exactly through PNG', () => {
    const probe = channelProbe(8, 8);
    const decoded = decodeImage(encodePNG(probe));
    expect(decoded.width).toBe(8);
    expect(decoded.height).toBe(8);
    expect(Buffer.from(decoded.data).equals(Buffer.from(probe.data))).toBe(true);
  });

  it('refuses an image beyond the pixel budget', () => {
    const side = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
    expect(() => constantImage(side, side, 0)).toThrow();
  });
});

// The decisive case: a real packed texture from a shipped asset. Skips when the
// asset tree is absent so a bare checkout still runs green.
describe('a real packed metallicRoughness texture', () => {
  // COMMITTED, not read from a sibling checkout. This used to walk up four
  // directories hunting for a repository named "Genome Game" and read a 2K
  // hydrant material out of it. That made the outcome depend on the machine
  // AND on a file another project was actively editing: with the sibling
  // present the suite ran 279 tests, without it 278 and still exited 0 — the
  // case the README calls decisive silently not running for anyone else.
  //
  // The fixture is genuine data, downsampled from that shipped material rather
  // than synthesised: 168 distinct roughness values and 148 distinct metallic
  // values across 128x128. A synthetic fixture and the parser that reads it can
  // share the same mistake, which is exactly how a wrong glTF magic constant
  // once survived a whole suite. Byte-identical de-packing is a per-sample
  // property; it never needed two million of them to be decisive.
  const fixture = fileURLToPath(new URL('./fixtures/real/packed_metallic_roughness_128.png', import.meta.url));

  it('extracts roughness byte-identically to the source G channel', async () => {
    const packed = decodeImage(new Uint8Array(await fs.readFile(fixture)));
    const roughness = extractChannel(packed, 'g');

    let differing = 0;
    for (let i = 0; i < packed.data.length; i += 4) {
      if (roughness.data[i] !== packed.data[i + 1]) differing += 1;
    }
    // Not "close enough": a single perturbed sample makes every downstream
    // hash meaningless.
    expect(differing).toBe(0);
  });

  it('extracts metallic byte-identically to the source B channel', async () => {
    const packed = decodeImage(new Uint8Array(await fs.readFile(fixture)));
    const metallic = extractChannel(packed, 'b');

    let differing = 0;
    for (let i = 0; i < packed.data.length; i += 4) {
      if (metallic.data[i] !== packed.data[i + 2]) differing += 1;
    }
    expect(differing).toBe(0);
  });

  it('survives a PNG round trip without perturbing a sample', async () => {
    const packed = decodeImage(new Uint8Array(await fs.readFile(fixture)));
    const roughness = extractChannel(packed, 'g');
    const reread = decodeImage(encodePNG(roughness));

    let differing = 0;
    for (let i = 0; i < roughness.data.length; i += 4) {
      if (roughness.data[i] !== reread.data[i]) differing += 1;
    }
    expect(differing).toBe(0);
  });

  it('is real varying data, so the assertions above are not tautologies', async () => {
    const packed = decodeImage(new Uint8Array(await fs.readFile(fixture)));
    const roughness = extractChannel(packed, 'g');
    const metallic = extractChannel(packed, 'b');

    // Guards the fixture itself. A flat image would pass every byte-identity
    // check above while proving nothing about de-packing.
    const distinct = new Set<number>();
    for (let i = 0; i < roughness.data.length; i += 4) distinct.add(roughness.data[i] as number);
    expect(distinct.size).toBeGreaterThan(16);

    // A real material is not uniformly metallic and rough at once.
    let identical = 0;
    for (let i = 0; i < roughness.data.length; i += 4) {
      if (roughness.data[i] === metallic.data[i]) identical += 1;
    }
    expect(identical).toBeLessThan(roughness.width * roughness.height * 0.5);
  });
});

describe('temporary workspace hygiene', () => {
  it('writes and cleans a scratch directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pbr-'));
    const target = path.join(dir, 'plane.png');
    await fs.writeFile(target, encodePNG(constantImage(4, 4, 12)));
    const decoded = decodeImage(new Uint8Array(await fs.readFile(target)));
    expect(decoded.data[0]).toBe(12);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
