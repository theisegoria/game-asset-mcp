/**
 * Depth was the attachment kind that could not say anything useful.
 *
 * `decodeImage` normalises every PNG to 8-bit RGBA, 16-bit sources included --
 * the source comment says so plainly and tells callers who care to read the
 * source depth themselves. Nothing did. Binary attachments were skipped by
 * analysis outright, so a float depth buffer was sealed, hashed, and never
 * looked at, while an 8-bit PNG of the same buffer cannot show depth fighting
 * or near/far-plane error at all: the two bugs depth exists to reveal.
 */

import { describe, expect, it } from 'vitest';
import { analyzeFloatRaster } from '../src/harness/raster-float.js';
import { captureAttachmentSchema } from '../src/harness/contracts.js';

function r32f(values: number[], width: number, height: number, rowStride?: number): Uint8Array {
  const stride = rowStride ?? width * 4;
  const bytes = new Uint8Array(stride * height);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      view.setFloat32(y * stride + x * 4, values[y * width + x] ?? 0, true);
    }
  }
  return bytes;
}

describe('reading a float buffer at the precision it was captured at', () => {
  it('resolves differences an 8-bit round trip would erase', () => {
    // Two depths a hair apart: the classic z-fighting signature. Quantised to
    // 8 bits these are the same value and the defect disappears.
    const near = 0.99999404;
    const far = 0.99999410;
    const stats = analyzeFloatRaster(r32f([near, far, near, far], 2, 2), {
      pixelFormat: 'r32f', width: 2, height: 2, rowStride: 8,
    });

    expect(stats.minimum).toBeCloseTo(near, 8);
    expect(stats.maximum).toBeCloseTo(far, 8);
    expect(stats.maximum).toBeGreaterThan(stats.minimum);
    expect(Math.round(stats.minimum * 255)).toBe(Math.round(stats.maximum * 255));
  });

  it('honours a padded row stride, because real APIs pad', () => {
    // wgpu aligns copy rows to 256 bytes. Reading width*bpp would walk into
    // padding and report garbage that looks like data.
    const stats = analyzeFloatRaster(r32f([1, 2, 3, 4], 2, 2, 256), {
      pixelFormat: 'r32f', width: 2, height: 2, rowStride: 256,
    });

    expect(stats.minimum).toBe(1);
    expect(stats.maximum).toBe(4);
    expect(stats.mean).toBe(2.5);
  });

  it('counts non-finite samples rather than quietly skipping them', () => {
    // A NaN in a depth buffer is a real defect -- an uninitialised clear, a
    // divide by a zero w. Dropping it would report a clean range for a broken
    // frame.
    const bytes = r32f([1, Number.NaN, 3, Number.POSITIVE_INFINITY], 2, 2);
    const stats = analyzeFloatRaster(bytes, {
      pixelFormat: 'r32f', width: 2, height: 2, rowStride: 8,
    });

    expect(stats.nonFiniteSamples).toBe(2);
    expect(stats.samples).toBe(4);
    expect(stats.minimum).toBe(1);
    expect(stats.maximum).toBe(3);
  });

  it('decodes half precision, which node cannot read natively', () => {
    // 0x3c00 is 1.0, 0xc000 is -2.0 in IEEE 754 binary16.
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint16(0, 0x3c00, true);
    new DataView(bytes.buffer).setUint16(2, 0xc000, true);
    const stats = analyzeFloatRaster(bytes, {
      pixelFormat: 'r16f', width: 2, height: 1, rowStride: 4,
    });

    expect(stats.minimum).toBe(-2);
    expect(stats.maximum).toBe(1);
  });

  it('refuses a buffer shorter than its declared dimensions', () => {
    expect(() => analyzeFloatRaster(new Uint8Array(8), {
      pixelFormat: 'r32f', width: 4, height: 4, rowStride: 16,
    })).toThrow(/shorter than its declared dimensions/);
  });
});

describe('the contract refuses unreadable binary attachments', () => {
  it('rejects binary bytes with no declared format', () => {
    const parsed = captureAttachmentSchema.safeParse({
      kind: 'depth', path: 'depth.bin', encoding: 'binary',
    });

    // Sealed, hashed and unreadable is the worst of both worlds.
    expect(parsed.success).toBe(false);
  });

  it('rejects a format on a PNG, which would be a contradiction', () => {
    const parsed = captureAttachmentSchema.safeParse({
      kind: 'depth', path: 'depth.png', encoding: 'png',
      format: { pixelFormat: 'r32f', width: 4, height: 4, rowStride: 16 },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects a rowStride too small for the declared width', () => {
    const parsed = captureAttachmentSchema.safeParse({
      kind: 'depth', path: 'depth.bin', encoding: 'binary',
      format: { pixelFormat: 'rgba32f', width: 4, height: 4, rowStride: 16 },
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts a well-formed float depth attachment linked to its preview', () => {
    const parsed = captureAttachmentSchema.safeParse({
      kind: 'depth', path: 'depth.bin', encoding: 'binary',
      format: { pixelFormat: 'd32f', width: 8, height: 8, rowStride: 32 },
      previewOf: 'depth-preview.png',
    });

    expect(parsed.success).toBe(true);
  });
});
