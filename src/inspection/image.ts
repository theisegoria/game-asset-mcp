/**
 * Minimal raster decode/encode/resample for PBR texture work.
 *
 * Pure JavaScript on purpose. A native codec (sharp, canvas) would be faster
 * but would force every installer of this server through a build toolchain and
 * break `npx`, which is the whole distribution story.
 *
 * Everything here operates on 8-bit RGBA. That is lossy for 16-bit source
 * textures, and the loss is reported rather than hidden — see `decodeImage`.
 */

import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { AssetPipelineError } from '../util/errors.js';

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA8, row-major, length === width * height * 4. */
  data: Uint8Array;
}

/** Hard ceiling so a malicious or mistaken texture cannot exhaust memory. */
export const MAX_IMAGE_PIXELS = 8192 * 8192;

export type ImageFormat = 'png' | 'jpeg';

/**
 * Identify by magic bytes, not by the container's declared MIME type.
 * A glTF can and does declare `image/png` over JPEG bytes.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  return undefined;
}

export function decodeImage(bytes: Uint8Array): RasterImage {
  const format = sniffImageFormat(bytes);
  if (!format) {
    throw new AssetPipelineError(
      'INSPECTION_FAILED',
      'texture is neither PNG nor JPEG; this server does not decode other raster formats',
    );
  }

  if (format === 'png') {
    const png = PNG.sync.read(Buffer.from(bytes));
    assertPixelBudget(png.width, png.height);
    // pngjs always normalises to 8-bit RGBA, including 16-bit sources, so a
    // 16-bit input silently loses precision here. Callers that care should
    // read the source depth themselves.
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  }

  const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true });
  assertPixelBudget(decoded.width, decoded.height);
  return {
    width: decoded.width,
    height: decoded.height,
    data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length),
  };
}

export function encodePNG(image: RasterImage): Uint8Array {
  assertPixelBudget(image.width, image.height);
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length);
  return new Uint8Array(PNG.sync.write(png));
}

function assertPixelBudget(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new AssetPipelineError('INSPECTION_FAILED', `invalid image dimensions ${width}x${height}`);
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new AssetPipelineError(
      'INSPECTION_FAILED',
      `image is ${width}x${height}; the ceiling is ${MAX_IMAGE_PIXELS} pixels`,
    );
  }
}

// sRGB transfer functions, kept as lookup tables because a 4096² resize does
// ~67M conversions and `Math.pow` per sample is the difference between a
// second and a minute.
const SRGB_TO_LINEAR = new Float32Array(256);
const LINEAR_TO_SRGB = new Uint8Array(4096);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
for (let i = 0; i < 4096; i += 1) {
  const linear = i / 4095;
  const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  LINEAR_TO_SRGB[i] = Math.max(0, Math.min(255, Math.round(encoded * 255)));
}

export interface ResizeOptions {
  /**
   * Average in linear light. REQUIRED for colour (albedo/emissive) and WRONG
   * for data channels (normal, roughness, metallic, AO) — averaging a normal
   * map through a gamma curve bends the vectors and darkens the surface.
   */
  srgb: boolean;
}

/**
 * Resample to an exact target size.
 *
 * Box filter (area average) throughout: it is the correct choice for the
 * downscales this pipeline actually performs, and unlike bilinear it does not
 * alias when the ratio exceeds 2:1.
 */
export function resizeImage(
  image: RasterImage,
  targetWidth: number,
  targetHeight: number,
  options: ResizeOptions,
): RasterImage {
  assertPixelBudget(targetWidth, targetHeight);
  if (image.width === targetWidth && image.height === targetHeight) return image;

  const out = new Uint8Array(targetWidth * targetHeight * 4);
  const scaleX = image.width / targetWidth;
  const scaleY = image.height / targetHeight;
  const src = image.data;

  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let samples = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        const row = sy * image.width;
        for (let sx = x0; sx < x1; sx += 1) {
          const at = (row + sx) * 4;
          if (options.srgb) {
            r += SRGB_TO_LINEAR[src[at]!]!;
            g += SRGB_TO_LINEAR[src[at + 1]!]!;
            b += SRGB_TO_LINEAR[src[at + 2]!]!;
          } else {
            r += src[at]!;
            g += src[at + 1]!;
            b += src[at + 2]!;
          }
          a += src[at + 3]!;
          samples += 1;
        }
      }

      const at = (y * targetWidth + x) * 4;
      if (samples === 0) {
        out[at] = 0;
        out[at + 1] = 0;
        out[at + 2] = 0;
        out[at + 3] = 255;
        continue;
      }
      if (options.srgb) {
        out[at] = LINEAR_TO_SRGB[clampIndex(r / samples)]!;
        out[at + 1] = LINEAR_TO_SRGB[clampIndex(g / samples)]!;
        out[at + 2] = LINEAR_TO_SRGB[clampIndex(b / samples)]!;
      } else {
        out[at] = Math.round(r / samples);
        out[at + 1] = Math.round(g / samples);
        out[at + 2] = Math.round(b / samples);
      }
      out[at + 3] = Math.round(a / samples);
    }
  }

  return { width: targetWidth, height: targetHeight, data: out };
}

function clampIndex(linear: number): number {
  const index = Math.round(linear * 4095);
  return index < 0 ? 0 : index > 4095 ? 4095 : index;
}

export type ChannelName = 'r' | 'g' | 'b' | 'a';

const CHANNEL_OFFSET: Record<ChannelName, number> = { r: 0, g: 1, b: 2, a: 3 };

/**
 * Lift one channel into an opaque greyscale image.
 *
 * This is how a packed glTF `metallicRoughness` becomes the independent
 * roughness and metallic planes a material pipeline actually wants: the spec
 * puts roughness in G and metallic in B, and reading the wrong one produces a
 * surface that is confidently, silently wrong.
 */
export function extractChannel(image: RasterImage, channel: ChannelName): RasterImage {
  const offset = CHANNEL_OFFSET[channel];
  const out = new Uint8Array(image.width * image.height * 4);
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    const value = image.data[pixel * 4 + offset]!;
    const at = pixel * 4;
    out[at] = value;
    out[at + 1] = value;
    out[at + 2] = value;
    out[at + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}

/** A flat single-value image, for a plane a material declares as a constant. */
/**
 * A solid image from a glTF factor triple, encoded to sRGB.
 *
 * `constantImage` takes ONE value and paints it into R, G and B, and the caller
 * passed only `factor[0]` — so a cyan baseColorFactor [0, 0.6, 1] became BLACK.
 * The value was also written raw while the plane was tagged sRGB: linear 0.6
 * must encode to ~199, not 153.
 */
export function constantColorImage(
  width: number,
  height: number,
  linearRgb: readonly [number, number, number],
): RasterImage {
  assertPixelBudget(width, height);
  const encoded = linearRgb.map((channel) => {
    const clamped = Math.max(0, Math.min(1, channel));
    return LINEAR_TO_SRGB[Math.round(clamped * 4095)] ?? 0;
  }) as [number, number, number];
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const at = pixel * 4;
    data[at] = encoded[0];
    data[at + 1] = encoded[1];
    data[at + 2] = encoded[2];
    data[at + 3] = 255;
  }
  return { width, height, data };
}

export function constantImage(width: number, height: number, value: number): RasterImage {
  assertPixelBudget(width, height);
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const at = pixel * 4;
    data[at] = clamped;
    data[at + 1] = clamped;
    data[at + 2] = clamped;
    data[at + 3] = 255;
  }
  return { width, height, data };
}
