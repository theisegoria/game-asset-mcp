/**
 * A strict pixel diff cries wolf on a correct render.
 *
 * Anti-aliasing, a sub-pixel camera nudge and a driver's rasterisation rule all
 * move colour by a pixel without changing what is drawn. Compared strictly,
 * every edge in the frame reports as changed -- and a harness that reports a
 * correct render as broken is one somebody switches off, which costs more than
 * the false positives did.
 *
 * Tolerance is opt-in and bounded: it asks whether the same value exists
 * nearby, not whether the images are roughly similar.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAdapter, planScenarioRun } from '../src/harness/adapter.js';
import { executeScenarioRun } from '../src/harness/run-bundle.js';
import { compareRunVisuals } from '../src/harness/visual.js';
import { encodePNG } from '../src/inspection/image.js';
import { writeHarnessProject } from './helpers/harness-fixture.js';

let root: string;
let project: Awaited<ReturnType<typeof writeHarnessProject>>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aa-tolerance-'));
  project = await writeHarnessProject(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A 4x4 frame with a vertical edge at `edgeX`: white left, black right. */
function edgeFrame(edgeX: number): Uint8Array {
  const size = 4;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const value = x < edgeX ? 255 : 0;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return encodePNG({ width: size, height: size, data });
}

async function run(sourceFile: string) {
  const adapter = await loadAdapter(project.projectRoot);
  const plan = await planScenarioRun({
    adapter,
    scenarioId: 'capture',
    runsRoot: path.join(root, 'runs'),
    parameters: {
      source: path.basename(sourceFile),
      objectIds: path.basename(project.objectIdPng),
      frameTime: 12,
      mode: 'normal',
    },
  });
  return executeScenarioRun({ adapter, plan, confirm: true, allowGpu: false, allowPerformance: false });
}

async function compare(tolerance: number, outputName: string) {
  const a = path.join(project.projectRoot, 'edge-a.png');
  const b = path.join(project.projectRoot, 'edge-b.png');
  await fs.writeFile(a, edgeFrame(2));
  await fs.writeFile(b, edgeFrame(3));

  const baseline = await run(a);
  const candidate = await run(b);
  const comparison = await compareRunVisuals({
    baselineRunPath: baseline.runPath,
    candidateRunPath: candidate.runPath,
    threshold: 0,
    antialiasTolerancePixels: tolerance,
    outputPath: path.join(root, outputName),
  });
  return comparison.pairs.find((pair) => pair.kind === 'color');
}

describe('an edge that moved one pixel', () => {
  it('reports as changed under a strict comparison', async () => {
    const color = await compare(0, 'strict');

    // Correct, and unhelpful: the content is the same, it just landed
    // differently.
    expect(color?.changedPixelRatio).toBeGreaterThan(0);
  }, 60_000);

  it('is tolerated at radius 1, because the same value exists next door', async () => {
    const color = await compare(1, 'tolerant');

    expect(color?.changedPixelRatio).toBe(0);
  }, 60_000);
});

describe('tolerance does not blind the diff', () => {
  it('still reports a frame where the content itself changed', async () => {
    // baseline.png and candidate.png differ in the red channel everywhere, so
    // no neighbour holds the missing value.
    const baseline = await run(project.baselinePng);
    const candidate = await run(project.candidatePng);
    const comparison = await compareRunVisuals({
      baselineRunPath: baseline.runPath,
      candidateRunPath: candidate.runPath,
      threshold: 0,
      antialiasTolerancePixels: 1,
      outputPath: path.join(root, 'real-change'),
    });
    const color = comparison.pairs.find((pair) => pair.kind === 'color');

    expect(color?.changedPixelRatio).toBe(1);
  }, 60_000);

  it('records the tolerance it used, so a result is interpretable later', async () => {
    const baseline = await run(project.baselinePng);
    const candidate = await run(project.candidatePng);
    const comparison = await compareRunVisuals({
      baselineRunPath: baseline.runPath,
      candidateRunPath: candidate.runPath,
      threshold: 0,
      antialiasTolerancePixels: 2,
      outputPath: path.join(root, 'recorded'),
    });

    expect(comparison.antialiasTolerancePixels).toBe(2);
  }, 60_000);

  it('refuses an out-of-range tolerance rather than clamping it', async () => {
    const baseline = await run(project.baselinePng);
    const candidate = await run(project.candidatePng);

    await expect(compareRunVisuals({
      baselineRunPath: baseline.runPath,
      candidateRunPath: candidate.runPath,
      antialiasTolerancePixels: 9,
    })).rejects.toThrow(/antialias tolerance/);
  }, 60_000);
});
