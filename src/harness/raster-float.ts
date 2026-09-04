/**
 * Reading binary float attachments at the precision they were captured at.
 *
 * PNG cannot carry these. The decoder normalises every PNG to 8-bit RGBA,
 * 16-bit sources included, so a depth buffer round-tripped through PNG loses
 * exactly the precision that makes depth worth capturing: depth fighting and
 * near/far-plane error are both invisible at 8 bits, and those are the bugs a
 * depth attachment exists to show.
 *
 * Pure `DataView` arithmetic, no dependency. The pixel budget is enforced
 * before allocation, because a manifest is untrusted input and a declared
 * 16384x16384 rgba32f buffer is four gigabytes.
 */

import { BYTES_PER_PIXEL } from './contracts.js';
import { invalidInput } from '../util/errors.js';

export type FloatPixelFormat = 'r16f' | 'r32f' | 'rgba32f' | 'd32f' | 'r32u';

export interface FloatRasterFormat {
  pixelFormat: FloatPixelFormat;
  width: number;
  height: number;
  rowStride: number;
  colorSpace?: 'srgb' | 'linear';
}

export interface FloatRasterStatistics {
  pixelFormat: FloatPixelFormat;
  width: number;
  height: number;
  samples: number;
  minimum: number;
  maximum: number;
  mean: number;
  /**
   * Counted, not silently dropped. A NaN in a depth buffer is a real defect
   * -- an uninitialised clear, a divide by a zero w -- and a reader that
   * skipped them would report a clean range for a broken frame.
   */
  nonFiniteSamples: number;
}

/** IEEE 754 half precision. Node has no native reader for it. */
function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

const MAX_FLOAT_RASTER_SAMPLES = 8192 * 8192;

function readSample(view: DataView, offset: number, format: FloatPixelFormat): number {
  switch (format) {
    case 'r16f': return halfToFloat(view.getUint16(offset, true));
    case 'r32f':
    case 'd32f': return view.getFloat32(offset, true);
    case 'r32u': return view.getUint32(offset, true);
    // The first channel only: statistics over interleaved RGBA would describe
    // no single quantity, which is worse than describing one honestly.
    case 'rgba32f': return view.getFloat32(offset, true);
    default: return Number.NaN;
  }
}

/**
 * Summarise a binary attachment at full precision.
 *
 * Reports the first channel for multi-channel formats, which the caller can
 * see from `pixelFormat`.
 */
export function analyzeFloatRaster(
  bytes: Uint8Array,
  format: FloatRasterFormat,
): FloatRasterStatistics {
  const { pixelFormat, width, height, rowStride } = format;
  const perPixel = BYTES_PER_PIXEL[pixelFormat];

  if (width * height > MAX_FLOAT_RASTER_SAMPLES) {
    throw invalidInput('binary attachment exceeds the raster sample budget', {
      width, height, budget: MAX_FLOAT_RASTER_SAMPLES,
    });
  }
  if (rowStride < width * perPixel) {
    throw invalidInput('binary attachment rowStride cannot hold a row of its declared width', {
      rowStride, width, pixelFormat,
    });
  }
  const required = rowStride * (height - 1) + width * perPixel;
  if (bytes.byteLength < required) {
    throw invalidInput('binary attachment is shorter than its declared dimensions', {
      bytes: bytes.byteLength, required,
    });
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let total = 0;
  let finite = 0;
  let nonFinite = 0;

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowStride;
    for (let x = 0; x < width; x += 1) {
      const sample = readSample(view, rowStart + x * perPixel, pixelFormat);
      if (Number.isFinite(sample)) {
        if (sample < minimum) minimum = sample;
        if (sample > maximum) maximum = sample;
        total += sample;
        finite += 1;
      } else {
        nonFinite += 1;
      }
    }
  }

  return {
    pixelFormat,
    width,
    height,
    samples: width * height,
    minimum: finite > 0 ? minimum : Number.NaN,
    maximum: finite > 0 ? maximum : Number.NaN,
    mean: finite > 0 ? total / finite : Number.NaN,
    nonFiniteSamples: nonFinite,
  };
}
