/**
 * Structural similarity, for when a mean error does not describe what happened.
 *
 * Mean absolute error treats every pixel independently, so it cannot separate
 * "the whole frame is 2% brighter" from "one object is unrecognisable" -- both
 * can produce the same average. SSIM compares local structure instead: means,
 * variances and covariance over a sliding window, which is much closer to what
 * someone means when they say two renders look the same.
 *
 * Computed over summed-area tables so each window is O(1) regardless of size.
 * The naive form re-reads w*w pixels per window and turns a 1080p comparison
 * into tens of seconds of pure JavaScript, which is the difference between a
 * check people run and one they skip.
 */

import type { RasterImage } from '../inspection/image.js';

/** Stabilisers from the original SSIM paper, for 8-bit dynamic range. */
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

export interface SsimResult {
  meanSSIM: number;
  /** The single worst window, so a caller has somewhere to look. */
  worstWindow: { x: number; y: number; ssim: number };
  windowSize: number;
}

/** Rec. 709 luminance, one value per pixel. Shared so callers compute it once. */
export function luminancePlane(image: RasterImage): Float64Array {
  const plane = new Float64Array(image.width * image.height);
  for (let pixel = 0; pixel < plane.length; pixel += 1) {
    const offset = pixel * 4;
    plane[pixel] = 0.2126 * (image.data[offset] ?? 0)
      + 0.7152 * (image.data[offset + 1] ?? 0)
      + 0.0722 * (image.data[offset + 2] ?? 0);
  }
  return plane;
}

/** Summed-area table with a zero row and column, so window sums need no bounds tests. */
function integral(values: Float64Array, width: number, height: number): Float64Array {
  const table = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowTotal = 0;
    for (let x = 0; x < width; x += 1) {
      rowTotal += values[y * width + x] ?? 0;
      table[(y + 1) * (width + 1) + (x + 1)] = (table[y * (width + 1) + (x + 1)] ?? 0) + rowTotal;
    }
  }
  return table;
}

function windowSum(table: Float64Array, width: number, x: number, y: number, size: number): number {
  const stride = width + 1;
  return (table[(y + size) * stride + (x + size)] ?? 0)
    - (table[y * stride + (x + size)] ?? 0)
    - (table[(y + size) * stride + x] ?? 0)
    + (table[y * stride + x] ?? 0);
}

/**
 * Mean SSIM over every full window, plus the worst one.
 *
 * Returns undefined when either image is smaller than one window: a single
 * partial window is not a structural comparison, and inventing a number for it
 * would be worse than saying nothing.
 */
export function structuralSimilarity(
  baseline: RasterImage,
  candidate: RasterImage,
  windowSize = 8,
): SsimResult | undefined {
  const { width, height } = baseline;
  if (candidate.width !== width || candidate.height !== height) return undefined;
  if (width < windowSize || height < windowSize) return undefined;

  const left = luminancePlane(baseline);
  const right = luminancePlane(candidate);
  const cross = new Float64Array(left.length);
  const leftSquared = new Float64Array(left.length);
  const rightSquared = new Float64Array(left.length);
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    cross[index] = a * b;
    leftSquared[index] = a * a;
    rightSquared[index] = b * b;
  }

  const sumLeft = integral(left, width, height);
  const sumRight = integral(right, width, height);
  const sumLeftSquared = integral(leftSquared, width, height);
  const sumRightSquared = integral(rightSquared, width, height);
  const sumCross = integral(cross, width, height);

  const area = windowSize * windowSize;
  let total = 0;
  let windows = 0;
  let worst = { x: 0, y: 0, ssim: 1 };

  for (let y = 0; y + windowSize <= height; y += 1) {
    for (let x = 0; x + windowSize <= width; x += 1) {
      const meanLeft = windowSum(sumLeft, width, x, y, windowSize) / area;
      const meanRight = windowSum(sumRight, width, x, y, windowSize) / area;
      // Population moments over the window, matching the reference formulation.
      const varianceLeft = windowSum(sumLeftSquared, width, x, y, windowSize) / area - meanLeft * meanLeft;
      const varianceRight = windowSum(sumRightSquared, width, x, y, windowSize) / area - meanRight * meanRight;
      const covariance = windowSum(sumCross, width, x, y, windowSize) / area - meanLeft * meanRight;

      const numerator = (2 * meanLeft * meanRight + C1) * (2 * covariance + C2);
      const denominator = (meanLeft * meanLeft + meanRight * meanRight + C1)
        * (varianceLeft + varianceRight + C2);
      // Floating-point error can push a variance slightly negative on a flat
      // window; clamping keeps a perfect match reporting exactly 1.
      const ssim = denominator === 0 ? 1 : Math.min(1, Math.max(-1, numerator / denominator));

      total += ssim;
      windows += 1;
      if (ssim < worst.ssim) worst = { x, y, ssim };
    }
  }

  if (windows === 0) return undefined;
  return { meanSSIM: total / windows, worstWindow: worst, windowSize };
}
