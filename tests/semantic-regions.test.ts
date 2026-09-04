/**
 * The object-ID breakdown read only the BASELINE's id buffer.
 *
 * That is silently wrong exactly when the diff matters most. If an object moves
 * or vanishes, its pixels get attributed to whatever the baseline said was
 * there, so deleting a mesh reports as "the floor changed a lot" and the actual
 * finding -- an object is gone -- is never mentioned. Deleted geometry is the
 * single most common visual regression in a renderer under active development,
 * and it was the one case the breakdown could not name.
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-regions-'));
  project = await writeHarnessProject(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** An id buffer matching the fixture's geometry: left half id 1, right half id 2. */
function objectIdPng(includeSecondObject: boolean): Uint8Array {
  const width = 4;
  const height = 4;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const id = x < width / 2 ? 1 : (includeSecondObject ? 2 : 0);
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = id;
      data[offset + 3] = 255;
    }
  }
  return encodePNG({ width, height, data });
}

async function run(sourcePng: string, objectIdsFile: string, frameTime: number) {
  const adapter = await loadAdapter(project.projectRoot);
  const plan = await planScenarioRun({
    adapter,
    scenarioId: 'capture',
    runsRoot: path.join(root, 'runs'),
    parameters: {
      source: path.basename(sourcePng),
      objectIds: path.basename(objectIdsFile),
      frameTime,
      mode: 'normal',
    },
  });
  return executeScenarioRun({ adapter, plan, confirm: true, allowGpu: false, allowPerformance: false });
}

describe('an object that disappears between runs', () => {
  it('is named, rather than being reported as change on whatever was behind it', async () => {
    const both = path.join(project.projectRoot, 'ids-both.png');
    const onlyOne = path.join(project.projectRoot, 'ids-one.png');
    await fs.writeFile(both, objectIdPng(true));
    await fs.writeFile(onlyOne, objectIdPng(false));

    const baseline = await run(project.baselinePng, both, 12);
    const candidate = await run(project.candidatePng, onlyOne, 12);

    const comparison = await compareRunVisuals({
      baselineRunPath: baseline.runPath,
      candidateRunPath: candidate.runPath,
      threshold: 0,
      outputPath: path.join(root, 'diff'),
    });
    const color = comparison.pairs.find((pair) => pair.kind === 'color');

    // The finding. Previously unreportable: object 2's pixels were simply
    // attributed to object 2 and described as "changed".
    expect(color?.objectsDisappeared).toEqual(['0x000002']);
    expect(color?.objectsAppeared ?? []).toEqual([]);
  }, 60_000);

  it('separates coverage it lost from coverage it kept', async () => {
    const both = path.join(project.projectRoot, 'ids-both.png');
    const onlyOne = path.join(project.projectRoot, 'ids-one.png');
    await fs.writeFile(both, objectIdPng(true));
    await fs.writeFile(onlyOne, objectIdPng(false));

    const baseline = await run(project.baselinePng, both, 12);
    const candidate = await run(project.candidatePng, onlyOne, 12);

    const comparison = await compareRunVisuals({
      baselineRunPath: baseline.runPath,
      candidateRunPath: candidate.runPath,
      threshold: 0,
      outputPath: path.join(root, 'diff'),
    });
    const color = comparison.pairs.find((pair) => pair.kind === 'color');
    const vanished = color?.semanticRegions?.find((region) => region.objectId === '0x000002');
    const kept = color?.semanticRegions?.find((region) => region.objectId === '0x000001');

    // "Lost all of its pixels" and "was reshaded" are different diagnoses, and
    // a single changedPixelRatio cannot tell them apart.
    expect(vanished?.pixelsLost).toBe(vanished?.pixels);
    expect(vanished?.pixelsRetained).toBe(0);
    expect(kept?.pixelsRetained).toBe(kept?.pixels);
    expect(kept?.pixelsLost).toBe(0);
  }, 60_000);
});

describe('when nothing moves', () => {
  it('reports no appearances or disappearances', async () => {
    const both = path.join(project.projectRoot, 'ids-both.png');
    await fs.writeFile(both, objectIdPng(true));

    const baseline = await run(project.baselinePng, both, 12);
    const candidate = await run(project.candidatePng, both, 12);

    const comparison = await compareRunVisuals({
      baselineRunPath: baseline.runPath,
      candidateRunPath: candidate.runPath,
      threshold: 0,
      outputPath: path.join(root, 'diff'),
    });
    const color = comparison.pairs.find((pair) => pair.kind === 'color');

    expect(color?.objectsDisappeared ?? []).toEqual([]);
    expect(color?.objectsAppeared ?? []).toEqual([]);
    // Every region kept all of its coverage; only the shading differs.
    expect(color?.semanticRegions?.every((region) => region.pixelsLost === 0)).toBe(true);
  }, 60_000);
});
