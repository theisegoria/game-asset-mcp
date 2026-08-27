import * as fs from 'node:fs/promises';
import path from 'node:path';
import { decodeImage, encodePNG, type RasterImage } from '../inspection/image.js';
import { canonicalJson } from '../packages/format.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { validateCaptureManifest } from './capture.js';
import { GAME_DEV_VISUAL_COMPARISON_SCHEMA, type CaptureAttachment, type CaptureManifest } from './contracts.js';
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

export interface CaptureAnalysis {
  schema: 'game_dev.visual_analysis.v1';
  runId: string;
  runPath: string;
  adapterId: string;
  scenarioId: string;
  rasters: RasterAnalysis[];
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
    semanticRegions?: Array<{
      objectId: string;
      pixels: number;
      meanAbsoluteError: number;
      changedPixelRatio: number;
    }>;
    heatmapPath?: string;
    reason?: string;
  }>;
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
  for (const frame of loaded.manifest.frames) {
    for (const attachment of frame.attachments) {
      if (attachment.encoding !== 'png') continue;
      const absolute = path.resolve(loaded.runPath, attachment.path);
      rasters.push(analyzeRaster(decodeImage(await fs.readFile(absolute)), frame, attachment, absolute));
    }
  }
  return {
    schema: 'game_dev.visual_analysis.v1',
    runId: loaded.runId,
    runPath: loaded.runPath,
    adapterId: loaded.adapterId,
    scenarioId: loaded.scenarioId,
    rasters,
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

function luminanceAt(image: RasterImage, x: number, y: number): number {
  const offset = (y * image.width + x) * 4;
  return 0.2126 * (image.data[offset] ?? 0) +
    0.7152 * (image.data[offset + 1] ?? 0) +
    0.0722 * (image.data[offset + 2] ?? 0);
}

function edgeMagnitude(image: RasterImage, x: number, y: number): number {
  const gx = -luminanceAt(image, x - 1, y - 1) + luminanceAt(image, x + 1, y - 1) -
    2 * luminanceAt(image, x - 1, y) + 2 * luminanceAt(image, x + 1, y) -
    luminanceAt(image, x - 1, y + 1) + luminanceAt(image, x + 1, y + 1);
  const gy = -luminanceAt(image, x - 1, y - 1) - 2 * luminanceAt(image, x, y - 1) -
    luminanceAt(image, x + 1, y - 1) + luminanceAt(image, x - 1, y + 1) +
    2 * luminanceAt(image, x, y + 1) + luminanceAt(image, x + 1, y + 1);
  return Math.hypot(gx, gy) / 1_442.5;
}

function semanticBreakdown(
  baseline: RasterImage,
  candidate: RasterImage,
  objectIds: RasterImage | undefined,
  threshold: number,
): VisualComparison['pairs'][number]['semanticRegions'] {
  if (!objectIds || objectIds.width !== baseline.width || objectIds.height !== baseline.height) return undefined;
  const regions = new Map<number, { pixels: number; absolute: number; changed: number }>();
  for (let pixel = 0; pixel < baseline.width * baseline.height; pixel += 1) {
    const offset = pixel * 4;
    const objectId = ((objectIds.data[offset] ?? 0) << 16) |
      ((objectIds.data[offset + 1] ?? 0) << 8) |
      (objectIds.data[offset + 2] ?? 0);
    if (objectId === 0) continue;
    let absolute = 0;
    let maximum = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs((candidate.data[offset + channel] ?? 0) - (baseline.data[offset + channel] ?? 0));
      absolute += delta;
      maximum = Math.max(maximum, delta);
    }
    const region = regions.get(objectId) ?? { pixels: 0, absolute: 0, changed: 0 };
    region.pixels += 1;
    region.absolute += absolute / (3 * 255);
    if (maximum > threshold) region.changed += 1;
    regions.set(objectId, region);
  }
  return [...regions.entries()]
    .map(([objectId, region]) => ({
      objectId: `0x${objectId.toString(16).padStart(6, '0')}`,
      pixels: region.pixels,
      meanAbsoluteError: region.absolute / region.pixels,
      changedPixelRatio: region.changed / region.pixels,
    }))
    .sort((left, right) => right.meanAbsoluteError - left.meanAbsoluteError || right.pixels - left.pixels)
    .slice(0, 128);
}

function diffRasters(
  baseline: RasterImage,
  candidate: RasterImage,
  threshold: number,
  objectIds?: RasterImage,
): {
  meanAbsoluteError: number;
  rootMeanSquaredError: number;
  maximumChannelDelta: number;
  changedPixelRatio: number;
  meanLuminanceDelta: number;
  meanAbsoluteEdgeDelta: number;
  semanticRegions?: NonNullable<VisualComparison['pairs'][number]['semanticRegions']>;
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
    if (pixelMaximum > threshold) changed += 1;
    heatmap[offset] = pixelMaximum;
    heatmap[offset + 1] = Math.round(pixelMaximum * 0.15);
    heatmap[offset + 2] = 0;
    heatmap[offset + 3] = 255;
  }
  let edgeDelta = 0;
  let edgePixels = 0;
  for (let y = 1; y < baseline.height - 1; y += 1) {
    for (let x = 1; x < baseline.width - 1; x += 1) {
      edgeDelta += Math.abs(edgeMagnitude(candidate, x, y) - edgeMagnitude(baseline, x, y));
      edgePixels += 1;
    }
  }
  const semanticRegions = semanticBreakdown(baseline, candidate, objectIds, threshold);
  return {
    meanAbsoluteError: absolute / (pixels * 4 * 255),
    rootMeanSquaredError: Math.sqrt(squared / (pixels * 4)) / 255,
    maximumChannelDelta: maximum / 255,
    changedPixelRatio: changed / pixels,
    meanLuminanceDelta: luminanceDelta / pixels / 255,
    meanAbsoluteEdgeDelta: edgePixels > 0 ? edgeDelta / edgePixels : 0,
    ...(semanticRegions ? { semanticRegions } : {}),
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
}): Promise<VisualComparison> {
  const threshold = options.threshold ?? 0;
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
    const objectEntry = baseline.manifest.frames
      .find((frame) => frame.index === baselineEntry.frame.index)
      ?.attachments.find((attachment) => attachment.kind === 'object_id' && attachment.encoding === 'png');
    const objectIds = objectEntry
      ? decodeImage(await fs.readFile(path.resolve(baseline.runPath, objectEntry.path)))
      : undefined;
    const diff = diffRasters(baselineImage, candidateImage, threshold, objectIds);
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
      ...(diff.semanticRegions ? { semanticRegions: diff.semanticRegions } : {}),
      ...(heatmapPath ? { heatmapPath } : {}),
    });
  }
  const comparison: VisualComparison = {
    schema: GAME_DEV_VISUAL_COMPARISON_SCHEMA,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    threshold,
    pairs,
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
      'The comparison proves byte-decoded raster statistics, edge deltas, heatmaps, and optional object-ID-region grouping. It does not diagnose artistic intent, establish causality, or count as human visual review.',
  };
  if (outputPath) {
    await fs.writeFile(path.join(outputPath, 'comparison.json'), canonicalJson(comparison), { flag: 'wx', mode: 0o600 });
  }
  if (pairs.length === 0) throw invalidState('runs have no matching PNG capture attachment identities');
  return comparison;
}
