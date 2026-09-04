/**
 * A hosted CI runner is not target hardware.
 *
 * Its timings are real numbers from a real machine -- a virtualised, shared,
 * unspecified one. Admitting them as hardware-performance evidence would let a
 * green build imply a claim about the player's device that nothing measured.
 * The harness refuses rather than annotates: a caveat on admitted evidence is
 * exactly the kind that gets stripped on the way to a dashboard.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAdapter, planScenarioRun } from '../src/harness/adapter.js';
import { executeScenarioRun } from '../src/harness/run-bundle.js';
import { writeHarnessProject } from './helpers/harness-fixture.js';

let root: string;
let project: Awaited<ReturnType<typeof writeHarnessProject>>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-perf-'));
  project = await writeHarnessProject(root);
  for (const name of ['CI', 'GAME_DEV_CI_HARDWARE_ATTESTED']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function attempt(allowPerformance: boolean) {
  const adapter = await loadAdapter(project.projectRoot);
  const plan = await planScenarioRun({
    adapter,
    scenarioId: 'capture',
    runsRoot: path.join(root, 'runs'),
    parameters: {
      source: path.basename(project.baselinePng),
      objectIds: path.basename(project.objectIdPng),
      frameTime: 12,
      mode: 'normal',
    },
  });
  return executeScenarioRun({ adapter, plan, confirm: true, allowGpu: false, allowPerformance });
}

describe('hardware-performance authority under CI', () => {
  it('is refused before anything runs', async () => {
    process.env.CI = 'true';
    await expect(attempt(true)).rejects.toThrow(/refused under CI/);
    // Refused BEFORE the process starts: no run directory was created.
    await expect(fs.readdir(path.join(root, 'runs'))).rejects.toThrow();
  });

  it('does not block the capture itself, only the timing claim', async () => {
    process.env.CI = 'true';
    const result = await attempt(false);

    expect(result.manifest.status).toBe('completed');
    expect(result.manifest.evidence.hardwarePerformanceEvidenceAdmitted).toBe(false);
  }, 30_000);

  it('treats CI=false as not CI, since some tools export it that way', async () => {
    process.env.CI = 'false';
    await expect(attempt(true)).resolves.toBeDefined();
  }, 30_000);

  it('admits a self-hosted runner that declares itself the target hardware', async () => {
    process.env.CI = 'true';
    process.env.GAME_DEV_CI_HARDWARE_ATTESTED = '1';
    await expect(attempt(true)).resolves.toBeDefined();
  }, 30_000);

  it('is not triggered outside CI at all', async () => {
    await expect(attempt(true)).resolves.toBeDefined();
  }, 30_000);
});
