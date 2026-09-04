import * as fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeFloatRaster, type FloatRasterStatistics } from './raster-float.js';
import { decodeImage, encodePNG, type RasterImage } from '../inspection/image.js';
import { canonicalJson } from '../packages/format.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { validateCaptureManifest } from './capture.js';
import { GAME_DEV_VISUAL_COMPARISON_SCHEMA, type CaptureAttachment, type CaptureManifest } from './contracts.js';
import { describeComparison, type ComparisonVerdict } from './describe-comparison.js';
import { luminancePlane, structuralSimilarity } from './ssim.js';
import { verifyRunBundle } from './run-bundle.js';

export interface RasterAnalysis {
  frameIndex: number;
  frameLabel?: string;
  kind: CaptureAttachment['kind'];
  label?: string;
  path: string;
  width: number;
  height: number;
  channels: {
    minimum: [number, number, number, number];
    maximum: [number, number, number, number];
    mean: [number, number, number, number];
  };
  meanLuminance: number;
  alphaCoverage: number;
  uniqueSemanticIds?: number;
}

export interface FloatRasterAnalysis extends FloatRasterStatistics {
  frameIndex: number;
  frameLabel?: string;
  kind: CaptureAttachment['kind'];
  label?: string;
  path: string;
  /** The lossy PNG that visualises this buffer, when the adapter linked one. */
  previewPath?: string;
}

export interface CaptureAnalysis {
  schema: 'game_dev.visual_analysis.v1';
  runId: string;
  runPath: string;
  adapterId: string;
  scenarioId: string;
  rasters: RasterAnalysis[];
  /**
   * Binary attachments read at full precision.
   *
   * Previously skipped entirely: a float depth buffer was sealed, hashed, and
   * never looked at by anything.
   */
  floatRasters: FloatRasterAnalysis[];
  evidence: {
    sealedRunVerified: true;
    rasterBytesDecoded: true;
    deterministicStatisticsComputed: true;
    artisticDefectsDiagnosed: false;
    humanVisualReviewPerformed: false;
  };
  evidenceCeiling: string;
}

export interface VisualComparison {
  schema: typeof GAME_DEV_VISUAL_COMPARISON_SCHEMA;
  baselineRunId: string;
  candidateRunId: string;
  threshold: number;
  /**
   * Radius, in pixels, within which a difference is treated as the same content
   * landing elsewhere rather than as a change. 0 compares strictly.
   */
  antialiasTolerancePixels: number;
  pairs: Array<{
    identity: string;
    kind: CaptureAttachment['kind'];
    comparable: boolean;
    baselinePath: string;
    candidatePath: string;
    width?: number;
    height?: number;
    meanAbsoluteError?: number;
    rootMeanSquaredError?: number;
    maximumChannelDelta?: number;
    changedPixelRatio?: number;
    meanLuminanceDelta?: number;
    meanAbsoluteEdgeDelta?: number;
    /**
     * Structural similarity, 1.0 for identical. Unlike a mean error it can
     * separate a uniform brightness shift from one object becoming
     * unrecognisable, which can produce the same average.
     */
    meanSSIM?: number;
    /** Where structure differs most, so a caller has somewhere to look. */
    worstSSIMWindow?: { x: number; y: number; ssim: number };
    semanticRegions?: Array<{
      objectId: string;
      pixels: number;
      meanAbsoluteError: number;
      changedPixelRatio: number;
      /** Pixels this object still covers in the candidate. */
      pixelsRetained: number;
      /** Pixels it covered in the baseline and no longer does. */
      pixelsLost: number;
      /** Pixels it covers now and did not before. */
      pixelsGained: number;
    }>;
    /** Object ids present only in the candidate. */
    objectsAppeared?: string[];
    /** Object ids present only in the baseline: usually the actual finding. */
    objectsDisappeared?: string[];
    heatmapPath?: string;
    reason?: string;
  }>;
  /** Worst outcome across attachments. */
  verdict: ComparisonVerdict;
  /**
   * The same numbers, in sentences.
   *
   * Derived deterministically from the statistics -- no model, no network --
   * because a caller should not have to know that a low edge delta beside a
   * large luminance shift means shading rather than geometry.
   */
  summary: string[];
  unmatchedBaseline: string[];
  unmatchedCandidate: string[];
  outputPath?: string;
  evidence: {
    sealedRunsVerified: true;
    rasterBytesDecoded: true;
    deterministicComparisonComputed: true;
    semanticObjectRegionsCompared: boolean;
    heatmapsGenerated: boolean;
    artisticDefectsDiagnosed: false;
    causalAttributionEstablished: false;
    humanVisualReviewPerformed: false;
  };
  evidenceCeiling: string;
}

interface LoadedCapture {
  runId: string;
  runPath: string;
  adapterId: string;
  scenarioId: string;
  manifest: CaptureManifest;
}

function attachmentIdentity(frame: CaptureManifest['frames'][number], attachment: CaptureAttachment): string {
  return `${frame.index}:${frame.label ?? ''}:${attachment.kind}:${attachment.label ?? ''}`;
}

async function loadCapture(runPath: string): Promise<LoadedCapture> {
  const verified = await verifyRunBundle(runPath);
  if (!verified.manifest.captureManifest) throw invalidInput('run has no validated capture manifest', { runId: verified.manifest.runId });
  const capture = await validateCaptureManifest(verified.runPath, verified.manifest.captureManifest, {
    runId: verified.manifest.runId,
    adapterId: verified.manifest.adapterId,
    scenarioId: verified.manifest.scenarioId,
  });
  return {
    runId: verified.manifest.runId,
    runPath: verified.runPath,
    adapterId: verified.manifest.adapterId,
    scenarioId: verified.manifest.scenarioId,
    manifest: capture.manifest,
  };
}

function analyzeRaster(
  image: RasterImage,
  frame: CaptureManifest['frames'][number],
  attachment: CaptureAttachment,
  absolutePath: string,
): RasterAnalysis {
  const minimum: [number, number, number, number] = [255, 255, 255, 255];
  const maximum: [number, number, number, number] = [0, 0, 0, 0];
  const sums = [0, 0, 0, 0];
  let luminance = 0;
  let alphaPixels = 0;
  const semanticIds = attachment.kind === 'object_id' || attachment.kind === 'material_id' ? new Set<number>() : undefined;
  const pixels = image.width * image.height;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    const alpha = image.data[offset + 3] ?? 0;
    const values = [red, green, blue, alpha];
    for (let channel = 0; channel < 4; channel += 1) {
      const value = values[channel] ?? 0;
      minimum[channel] = Math.min(minimum[channel] ?? 255, value);
      maximum[channel] = Math.max(maximum[channel] ?? 0, value);
      sums[channel] = (sums[channel] ?? 0) + value;
    }
    luminance += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    if (alpha > 0) alphaPixels += 1;
    semanticIds?.add((red << 16) | (green << 8) | blue);
  }
  return {
    frameIndex: frame.index,
    ...(frame.label ? { frameLabel: frame.label } : {}),
    kind: attachment.kind,
    ...(attachment.label ? { label: attachment.label } : {}),
    path: absolutePath,
    width: image.width,
    height: image.height,
    channels: {
      minimum,
      maximum,
      mean: sums.map((sum) => sum / pixels) as [number, number, number, number],
    },
    meanLuminance: luminance / pixels / 255,
    alphaCoverage: alphaPixels / pixels,
    ...(semanticIds ? { uniqueSemanticIds: semanticIds.size } : {}),
  };
}

export async function analyzeRunCapture(runPath: string): Promise<CaptureAnalysis> {
  const loaded = await loadCapture(runPath);
  const rasters: RasterAnalysis[] = [];
  const floatRasters: FloatRasterAnalysis[] = [];
  for (const frame of loaded.manifest.frames) {
    for (const attachment of frame.attachments) {
      const absolute = path.resolve(loaded.runPath, attachment.path);
      if (attachment.encoding === 'png') {
        rasters.push(analyzeRaster(decodeImage(await fs.readFile(absolute)), frame, attachment, absolute));
        continue;
      }
      // The schema guarantees a binary attachment declares its format, so the
      // bytes are readable rather than sealed and opaque.
      if (attachment.encoding === 'binary' && attachment.format) {
        floatRasters.push({
          ...analyzeFloatRaster(await fs.readFile(absolute), attachment.format),
          frameIndex: frame.index,
          ...(frame.label !== undefined ? { frameLabel: frame.label } : {}),
          kind: attachment.kind,
          ...(attachment.label !== undefined ? { label: attachment.label } : {}),
          path: absolute,
          ...(attachment.previewOf !== undefined
            ? { previewPath: path.resolve(loaded.runPath, attachment.previewOf) }
            : {}),
        });
      }
    }
  }
  return {
    schema: 'game_dev.visual_analysis.v1',
    runId: loaded.runId,
    runPath: loaded.runPath,
    adapterId: loaded.adapterId,
    scenarioId: loaded.scenarioId,
    rasters,
    floatRasters,
    evidence: {
      sealedRunVerified: true,
      rasterBytesDecoded: true,
      deterministicStatisticsComputed: true,
      artisticDefectsDiagnosed: false,
      humanVisualReviewPerformed: false,
    },
    evidenceCeiling:
      'Analysis proves deterministic statistics over decoded sealed raster bytes. It does not identify artistic defects, prove visual quality, or substitute for human review.',
  };
}

/**
 * Sobel magnitude over a precomputed luminance plane.
 *
 * Previously each call recomputed luminance for its eight neighbours from RGBA,
 * twice per pixel pair -- sixteen luminance evaluations per pixel to produce
 * two numbers. On a 1080p frame that is roughly 33 million redundant
 * conversions, and it was the reason adding any further per-pixel metric felt
 * expensive.
 */
function edgeMagnitudeAt(plane: Float64Array, width: number, x: number, y: number): number {
  const at = (dx: number, dy: number): number => plane[(y + dy) * width + (x + dx)] ?? 0;
  const gx = -at(-1, -1) + at(1, -1) - 2 * at(-1, 0) + 2 * at(1, 0) - at(-1, 1) + at(1, 1);
  const gy = -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
  return Math.hypot(gx, gy) / 1_442.5;
}

function objectIdAt(buffer: RasterImage, offset: number): number {
  return ((buffer.data[offset] ?? 0) << 16)
    | ((buffer.data[offset + 1] ?? 0) << 8)
    | (buffer.data[offset + 2] ?? 0);
}

function formatObjectId(objectId: number): string {
  return `0x${objectId.toString(16).padStart(6, '0')}`;
}

/**
 * Attribute the diff to objects, reading BOTH id buffers.
 *
 * Reading only the baseline's was silently wrong exactly when the diff
 * mattered most: if an object moved or vanished, its pixels were attributed to
 * whatever the BASELINE said was there, so a deleted mesh showed up as
 * "the floor changed a lot" and the actual finding -- that an object is gone --
 * was not reported at all.
 *
 * Per region this now separates pixels the object still covers from those it
 * lost and gained, which is the difference between "this object was reshaded"
 * and "this object moved".
 */
function semanticBreakdown(
  baseline: RasterImage,
  candidate: RasterImage,
  baselineIds: RasterImage | undefined,
  candidateIds: RasterImage | undefined,
  threshold: number,
): {
  regions: VisualComparison['pairs'][number]['semanticRegions'];
  objectsAppeared: string[];
  objectsDisappeared: string[];
} {
  const usable = (buffer: RasterImage | undefined): buffer is RasterImage =>
    buffer !== undefined && buffer.width === baseline.width && buffer.height === baseline.height;
  if (!usable(baselineIds)) return { regions: undefined, objectsAppeared: [], objectsDisappeared: [] };

  const paired = usable(candidateIds) ? candidateIds : undefined;
  const regions = new Map<number, {
    pixels: number; absolute: number; changed: number; retained: number; lost: number; gained: number;
  }>();
  const emptyRegion = () =>
    ({ pixels: 0, absolute: 0, changed: 0, retained: 0, lost: 0, gained: 0 });
  const baselineSeen = new Set<number>();
  const candidateSeen = new Set<number>();

  for (let pixel = 0; pixel < baseline.width * baseline.height; pixel += 1) {
    const offset = pixel * 4;
    const before = objectIdAt(baselineIds, offset);
    const after = paired ? objectIdAt(paired, offset) : before;
    if (before !== 0) baselineSeen.add(before);
    if (after !== 0) candidateSeen.add(after);
    if (before === 0 && after === 0) continue;

    let absolute = 0;
    let maximum = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs((candidate.data[offset + channel] ?? 0) - (baseline.data[offset + channel] ?? 0));
      absolute += delta;
      maximum = Math.max(maximum, delta);
    }

    if (before !== 0) {
      const region = regions.get(before) ?? emptyRegion();
      region.pixels += 1;
      region.absolute += absolute / (3 * 255);
      if (maximum > threshold) region.changed += 1;
      if (after === before) region.retained += 1;
      else region.lost += 1;
      regions.set(before, region);
    }
    if (after !== 0 && after !== before) {
      const region = regions.get(after) ?? emptyRegion();
      region.gained += 1;
      regions.set(after, region);
    }
  }

  const ordered = [...regions.entries()]
    .map(([objectId, region]) => ({
      objectId: formatObjectId(objectId),
      pixels: region.pixels,
      meanAbsoluteError: region.pixels > 0 ? region.absolute / region.pixels : 0,
      changedPixelRatio: region.pixels > 0 ? region.changed / region.pixels : 0,
      pixelsRetained: region.retained,
      pixelsLost: region.lost,
      pixelsGained: region.gained,
    }))
    .sort((left, right) => right.meanAbsoluteError - left.meanAbsoluteError || right.pixels - left.pixels)
    .slice(0, 128);

  return {
    regions: ordered,
    // "This object is gone" is a finding in its own right, and the single most
    // common visual regression in a renderer under active development.
    objectsAppeared: paired
      ? [...candidateSeen].filter((id) => !baselineSeen.has(id)).sort().map(formatObjectId)
      : [],
    objectsDisappeared: paired
      ? [...baselineSeen].filter((id) => !candidateSeen.has(id)).sort().map(formatObjectId)
      : [],
  };
}

/**
 * Smallest channel difference between a pixel and any pixel within `radius` of
 * the same position in the other image.
 *
 * Anti-aliasing, a sub-pixel camera nudge and a driver's rasterisation rule all
 * move colour by one pixel without changing what is drawn. Compared strictly,
 * every edge in the frame reports as changed, the diff cries wolf on a
 * correct render, and a harness that cries wolf gets switched off. Requiring
 * the difference to hold against a whole neighbourhood keeps genuine structural
 * change while ignoring where an edge landed.
 */
function neighbourhoodDelta(
  from: RasterImage,
  to: RasterImage,
  x: number,
  y: number,
  radius: number,
): number {
  const offset = (y * from.width + x) * 4;
  let best = Number.POSITIVE_INFINITY;
  for (let dy = -radius; dy <= radius; dy += 1) {
    const ny = y + dy;
    if (ny < 0 || ny >= to.height) continue;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const nx = x + dx;
      if (nx < 0 || nx >= to.width) continue;
      const other = (ny * to.width + nx) * 4;
      let worst = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        worst = Math.max(worst, Math.abs((to.data[other + channel] ?? 0) - (from.data[offset + channel] ?? 0)));
        if (worst >= best) break;
      }
      if (worst < best) best = worst;
      if (best === 0) return 0;
    }
  }
  return best;
}

function diffRasters(
  baseline: RasterImage,
  candidate: RasterImage,
  threshold: number,
  baselineIds?: RasterImage,
  candidateIds?: RasterImage,
  antialiasTolerancePixels = 0,
): {
  meanAbsoluteError: number;
  rootMeanSquaredError: number;
  maximumChannelDelta: number;
  changedPixelRatio: number;
  meanLuminanceDelta: number;
  meanAbsoluteEdgeDelta: number;
  meanSSIM?: number;
  worstSSIMWindow?: { x: number; y: number; ssim: number };
  semanticRegions?: NonNullable<VisualComparison['pairs'][number]['semanticRegions']>;
  objectsAppeared?: string[];
  objectsDisappeared?: string[];
  heatmap: RasterImage;
} {
  const pixels = baseline.width * baseline.height;
  const heatmap = new Uint8Array(baseline.data.length);
  let absolute = 0;
  let squared = 0;
  let maximum = 0;
  let changed = 0;
  let luminanceDelta = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 4;
    let pixelMaximum = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs((candidate.data[offset + channel] ?? 0) - (baseline.data[offset + channel] ?? 0));
      absolute += delta;
      squared += delta * delta;
      maximum = Math.max(maximum, delta);
      pixelMaximum = Math.max(pixelMaximum, delta);
    }
    const baseLuminance = 0.2126 * (baseline.data[offset] ?? 0) +
      0.7152 * (baseline.data[offset + 1] ?? 0) + 0.0722 * (baseline.data[offset + 2] ?? 0);
    const candidateLuminance = 0.2126 * (candidate.data[offset] ?? 0) +
      0.7152 * (candidate.data[offset + 1] ?? 0) + 0.0722 * (candidate.data[offset + 2] ?? 0);
    luminanceDelta += candidateLuminance - baseLuminance;
    // Symmetric on purpose. A one-directional check calls a pixel unchanged if
    // it merely resembles SOMETHING nearby, which quietly hides an object
    // appearing next to a similar one.
    const tolerated = antialiasTolerancePixels > 0 && pixelMaximum > threshold
      ? Math.max(
        neighbourhoodDelta(baseline, candidate, pixel % baseline.width,
          Math.floor(pixel / baseline.width), antialiasTolerancePixels),
        neighbourhoodDelta(candidate, baseline, pixel % baseline.width,
          Math.floor(pixel / baseline.width), antialiasTolerancePixels),
      )
      : pixelMaximum;
    if (tolerated > threshold) changed += 1;
    heatmap[offset] = pixelMaximum;
    heatmap[offset + 1] = Math.round(pixelMaximum * 0.15);
    heatmap[offset + 2] = 0;
    heatmap[offset + 3] = 255;
  }
  const baselinePlane = luminancePlane(baseline);
  const candidatePlane = luminancePlane(candidate);
  let edgeDelta = 0;
  let edgePixels = 0;
  for (let y = 1; y < baseline.height - 1; y += 1) {
    for (let x = 1; x < baseline.width - 1; x += 1) {
      edgeDelta += Math.abs(
        edgeMagnitudeAt(candidatePlane, baseline.width, x, y)
        - edgeMagnitudeAt(baselinePlane, baseline.width, x, y),
      );
      edgePixels += 1;
    }
  }
  const semantic = semanticBreakdown(baseline, candidate, baselineIds, candidateIds, threshold);
  const ssim = structuralSimilarity(baseline, candidate);
  return {
    meanAbsoluteError: absolute / (pixels * 4 * 255),
    rootMeanSquaredError: Math.sqrt(squared / (pixels * 4)) / 255,
    maximumChannelDelta: maximum / 255,
    changedPixelRatio: changed / pixels,
    meanLuminanceDelta: luminanceDelta / pixels / 255,
    meanAbsoluteEdgeDelta: edgePixels > 0 ? edgeDelta / edgePixels : 0,
    ...(ssim ? { meanSSIM: ssim.meanSSIM, worstSSIMWindow: ssim.worstWindow } : {}),
    ...(semantic.regions ? { semanticRegions: semantic.regions } : {}),
    ...(semantic.objectsAppeared.length > 0 ? { objectsAppeared: semantic.objectsAppeared } : {}),
    ...(semantic.objectsDisappeared.length > 0
      ? { objectsDisappeared: semantic.objectsDisappeared }
      : {}),
    heatmap: { width: baseline.width, height: baseline.height, data: heatmap },
  };
}

function safeFileComponent(identity: string): string {
  return identity.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160);
}

export async function compareRunVisuals(options: {
  baselineRunPath: string;
  candidateRunPath: string;
  threshold?: number;
  outputPath?: string;
  antialiasTolerancePixels?: number;
}): Promise<VisualComparison> {
  const threshold = options.threshold ?? 0;
  const antialiasTolerancePixels = options.antialiasTolerancePixels ?? 0;
  if (!Number.isInteger(antialiasTolerancePixels)
    || antialiasTolerancePixels < 0 || antialiasTolerancePixels > 4) {
    throw invalidInput('antialias tolerance must be an integer from 0 through 4');
  }
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
    throw invalidInput('visual diff threshold must be an integer from 0 through 255');
  }
  const [baseline, candidate] = await Promise.all([
    loadCapture(options.baselineRunPath),
    loadCapture(options.candidateRunPath),
  ]);
  if (baseline.adapterId !== candidate.adapterId || baseline.scenarioId !== candidate.scenarioId) {
    throw invalidInput('visual comparison requires runs from the same adapter scenario');
  }

  let outputPath: string | undefined;
  if (options.outputPath) {
    outputPath = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    await fs.mkdir(outputPath, { recursive: false, mode: 0o700 });
  }
  const baselineAttachments = new Map<string, { frame: CaptureManifest['frames'][number]; attachment: CaptureAttachment }>();
  const candidateAttachments = new Map<string, { frame: CaptureManifest['frames'][number]; attachment: CaptureAttachment }>();
  for (const frame of baseline.manifest.frames) {
    for (const attachment of frame.attachments) {
      if (attachment.encoding === 'png') baselineAttachments.set(attachmentIdentity(frame, attachment), { frame, attachment });
    }
  }
  for (const frame of candidate.manifest.frames) {
    for (const attachment of frame.attachments) {
      if (attachment.encoding === 'png') candidateAttachments.set(attachmentIdentity(frame, attachment), { frame, attachment });
    }
  }

  const pairs: VisualComparison['pairs'] = [];
  for (const [identity, baselineEntry] of baselineAttachments) {
    const candidateEntry = candidateAttachments.get(identity);
    if (!candidateEntry) continue;
    const baselinePath = path.resolve(baseline.runPath, baselineEntry.attachment.path);
    const candidatePath = path.resolve(candidate.runPath, candidateEntry.attachment.path);
    const [baselineImage, candidateImage] = await Promise.all([
      fs.readFile(baselinePath).then(decodeImage),
      fs.readFile(candidatePath).then(decodeImage),
    ]);
    if (baselineImage.width !== candidateImage.width || baselineImage.height !== candidateImage.height) {
      pairs.push({
        identity,
        kind: baselineEntry.attachment.kind,
        comparable: false,
        baselinePath,
        candidatePath,
        reason: `extent mismatch ${baselineImage.width}x${baselineImage.height} versus ${candidateImage.width}x${candidateImage.height}`,
      });
      continue;
    }
    // Both id buffers, not just the baseline's. Attributing candidate pixels to
    // baseline ids reports a deleted mesh as "the floor changed a lot" and
    // never mentions the object that is gone.
    const findObjectIds = async (
      run: { manifest: { frames: Array<{ index: number; attachments: Array<{ kind: string; encoding: string; path: string }> }> }; runPath: string },
      frameIndex: number,
    ): Promise<RasterImage | undefined> => {
      const entry = run.manifest.frames
        .find((frame) => frame.index === frameIndex)
        ?.attachments.find((attachment) => attachment.kind === 'object_id' && attachment.encoding === 'png');
      return entry ? decodeImage(await fs.readFile(path.resolve(run.runPath, entry.path))) : undefined;
    };
    const [baselineIds, candidateIds] = await Promise.all([
      findObjectIds(baseline, baselineEntry.frame.index),
      findObjectIds(candidate, candidateEntry.frame.index),
    ]);
    const diff = diffRasters(
      baselineImage, candidateImage, threshold, baselineIds, candidateIds, antialiasTolerancePixels,
    );
    let heatmapPath: string | undefined;
    if (outputPath) {
      heatmapPath = path.join(outputPath, `${safeFileComponent(identity)}.heatmap.png`);
      await fs.writeFile(heatmapPath, encodePNG(diff.heatmap), { flag: 'wx', mode: 0o600 });
    }
    pairs.push({
      identity,
      kind: baselineEntry.attachment.kind,
      comparable: true,
      baselinePath,
      candidatePath,
      width: baselineImage.width,
      height: baselineImage.height,
      meanAbsoluteError: diff.meanAbsoluteError,
      rootMeanSquaredError: diff.rootMeanSquaredError,
      maximumChannelDelta: diff.maximumChannelDelta,
      changedPixelRatio: diff.changedPixelRatio,
      meanLuminanceDelta: diff.meanLuminanceDelta,
      meanAbsoluteEdgeDelta: diff.meanAbsoluteEdgeDelta,
      ...(diff.meanSSIM !== undefined ? { meanSSIM: diff.meanSSIM } : {}),
      ...(diff.worstSSIMWindow ? { worstSSIMWindow: diff.worstSSIMWindow } : {}),
      ...(diff.semanticRegions ? { semanticRegions: diff.semanticRegions } : {}),
      ...(diff.objectsAppeared ? { objectsAppeared: diff.objectsAppeared } : {}),
      ...(diff.objectsDisappeared ? { objectsDisappeared: diff.objectsDisappeared } : {}),
      ...(heatmapPath ? { heatmapPath } : {}),
    });
  }
  const comparison: VisualComparison = {
    schema: GAME_DEV_VISUAL_COMPARISON_SCHEMA,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    threshold,
    antialiasTolerancePixels,
    pairs,
    verdict: 'changed',
    summary: [],
    unmatchedBaseline: [...baselineAttachments.keys()].filter((key) => !candidateAttachments.has(key)).sort(),
    unmatchedCandidate: [...candidateAttachments.keys()].filter((key) => !baselineAttachments.has(key)).sort(),
    ...(outputPath ? { outputPath } : {}),
    evidence: {
      sealedRunsVerified: true,
      rasterBytesDecoded: true,
      deterministicComparisonComputed: true,
      semanticObjectRegionsCompared: pairs.some((pair) => (pair.semanticRegions?.length ?? 0) > 0),
      heatmapsGenerated: Boolean(outputPath),
      artisticDefectsDiagnosed: false,
      causalAttributionEstablished: false,
      humanVisualReviewPerformed: false,
    },
    evidenceCeiling:
      'The comparison proves byte-decoded raster statistics, edge deltas, heatmaps, and optional object-ID-region grouping. The prose summary is generated deterministically from those statistics and describes them; it does not diagnose artistic intent, establish causality, or count as human visual review.',
  };
  const narrative = describeComparison(comparison);
  comparison.verdict = narrative.verdict;
  comparison.summary = narrative.summary;

  if (outputPath) {
    await fs.writeFile(path.join(outputPath, 'comparison.json'), canonicalJson(comparison), { flag: 'wx', mode: 0o600 });
  }
  if (pairs.length === 0) throw invalidState('runs have no matching PNG capture attachment identities');
  return comparison;
}
