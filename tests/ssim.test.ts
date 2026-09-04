/**
 * A mean error treats every pixel independently, so it cannot separate "the
 * whole frame is slightly brighter" from "one object is unrecognisable" --
 * both can produce the same average, and only one of them is a bug.
 *
 * SSIM compares local structure instead. These tests pin the property that
 * makes it worth the arithmetic: agreement with a mean error where they should
 * agree, and disagreement precisely where a mean error is misleading.
 */

import { describe, expect, it } from 'vitest';
import { structuralSimilarity } from '../src/harness/ssim.js';
import type { RasterImage } from '../src/inspection/image.js';

function image(width: number, height: number, fill: (x: number, y: number) => number): RasterImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = Math.max(0, Math.min(255, Math.round(fill(x, y))));
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

const checker = (x: number, y: number): number => ((x >> 2) + (y >> 2)) % 2 === 0 ? 220 : 30;

describe('structural similarity', () => {
  it('is exactly 1 for identical images', () => {
    const frame = image(32, 32, checker);

    expect(structuralSimilarity(frame, frame)?.meanSSIM).toBe(1);
  });

  it('stays high for a uniform brightness shift', () => {
    // Every pixel moved, so a mean error reports a large change. Nothing about
    // the structure changed, and that is the distinction worth having.
    const base = image(32, 32, checker);
    const brighter = image(32, 32, (x, y) => checker(x, y) + 12);

    const result = structuralSimilarity(base, brighter);
    expect(result?.meanSSIM).toBeGreaterThan(0.9);
  });

  it('collapses when structure is destroyed, even at similar mean brightness', () => {
    // Same average luminance, no structure left. A mean-brightness check would
    // call these a close match.
    const structured = image(32, 32, checker);
    const flat = image(32, 32, () => 125);

    const result = structuralSimilarity(structured, flat);
    expect(result?.meanSSIM).toBeLessThan(0.5);
  });

  it('points at the worst window rather than only scoring the frame', () => {
    // One corner destroyed, the rest untouched: the mean stays high and the
    // location is the useful part.
    const base = image(32, 32, checker);
    const damaged = image(32, 32, (x, y) => (x < 8 && y < 8 ? 0 : checker(x, y)));

    const result = structuralSimilarity(base, damaged);
    expect(result?.meanSSIM).toBeGreaterThan(0.5);
    expect(result?.worstWindow.x).toBeLessThan(8);
    expect(result?.worstWindow.y).toBeLessThan(8);
    expect(result?.worstWindow.ssim).toBeLessThan(0.5);
  });

  it('declines to score an image smaller than one window', () => {
    // A single partial window is not a structural comparison, and a number
    // invented for it would read as though it were.
    const tiny = image(4, 4, checker);

    expect(structuralSimilarity(tiny, tiny, 8)).toBeUndefined();
  });

  it('declines to compare mismatched extents', () => {
    expect(structuralSimilarity(image(32, 32, checker), image(16, 16, checker))).toBeUndefined();
  });

  it('reports 1 for two identical flat regions rather than dividing by zero', () => {
    const flat = image(16, 16, () => 200);

    expect(structuralSimilarity(flat, flat)?.meanSSIM).toBe(1);
  });
});
