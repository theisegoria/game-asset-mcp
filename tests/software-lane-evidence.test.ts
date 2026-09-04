/**
 * A software rasterizer is not a GPU, and an adapter must not be able to say
 * otherwise.
 *
 * lavapipe, llvmpipe and SwiftShader all produce correct-looking pixels on the
 * CPU. An adapter that reported GPU execution for such a lane -- by mistake, or
 * by copy-paste from a hardware lane -- would mint authority it never earned,
 * and every downstream claim would inherit it. So the harness does not trust
 * and flag the declaration; it overwrites it.
 *
 * What the lane IS good for is the reason to keep it: a CPU rasterizer is
 * bit-deterministic where a real GPU is not, which makes it the only honest way
 * to run a zero-threshold visual regression gate in CI.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAdapter, planScenarioRun } from '../src/harness/adapter.js';
import { executeScenarioRun } from '../src/harness/run-bundle.js';
import { writeHarnessProject } from './helpers/harness-fixture.js';

let root: string;
let projectRoot: string;
let source: string;
let objectIds: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'software-lane-'));
  const project = await writeHarnessProject(root);
  projectRoot = project.projectRoot;
  source = path.relative(projectRoot, project.baselinePng);
  objectIds = path.relative(projectRoot, project.objectIdPng);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function run(mode: string) {
  const adapter = await loadAdapter(projectRoot);
  const plan = await planScenarioRun({
    adapter,
    scenarioId: 'gpu-capture',
    runsRoot: path.join(root, 'runs'),
    parameters: { source, objectIds, frameTime: 12, mode },
  });
  return executeScenarioRun({
    adapter,
    plan,
    confirm: true,
    allowGpu: true,
    // Granted deliberately: the point is that granting it is not enough.
    allowPerformance: true,
  });
}

describe('an adapter claiming hardware it does not have', () => {
  it('has every GPU and timing claim refused, not merely recorded', async () => {
    const result = await run('lying-software');
    const { evidence } = result.manifest;

    expect(evidence.rendererClass).toBe('software');
    expect(evidence.softwareRasterizedLane).toBe(true);

    // The capture manifest said true to all three.
    expect(evidence.adapterReportedGpuExecution).toBe(false);
    expect(evidence.adapterReportedGpuCompletionIdentity).toBe(false);
    // --allow-performance was passed AND the adapter reported it AND
    // measurements exist. It is still inadmissible, because the numbers came
    // off a CPU.
    expect(evidence.hardwarePerformanceEvidenceAdmitted).toBe(false);

    // Refused, not silently dropped. An adapter asserting hardware execution
    // from a CPU renderer is a defect in the adapter, and discarding the claim
    // means whoever could fix it never learns it was made.
    expect(evidence.refusedAdapterClaims).toEqual([
      'gpu execution',
      'gpu completion identity',
      'hardware performance',
    ]);
  }, 30_000);

  it('says so in the ceiling, where a reader will actually meet it', async () => {
    const result = await run('lying-software');

    expect(result.manifest.evidence.evidenceCeiling).toContain('software-rasterized');
    expect(result.manifest.evidence.evidenceCeiling).toContain('inadmissible');
    expect(result.manifest.evidence.evidenceCeiling).toContain('has been refused');
  }, 30_000);
});

describe('an ordinary lane is left alone', () => {
  it('does not get downgraded, and reports an unknown renderer class honestly', async () => {
    const result = await run('normal');
    const { evidence } = result.manifest;

    // The fixture declares no rendererClass, and "unknown" is the truthful
    // answer -- not "hardware", which would be a claim nobody made.
    expect(evidence.rendererClass).toBe('unknown');
    expect(evidence.softwareRasterizedLane).toBe(false);
    expect(evidence.refusedAdapterClaims).toEqual([]);
    expect(result.manifest.evidence.evidenceCeiling).not.toContain('software-rasterized');
  }, 30_000);
});
