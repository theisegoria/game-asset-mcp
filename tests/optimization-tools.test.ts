/**
 * The bounded optimisation loop is the performance-optimisation feature, and
 * it was CLI-only -- the surface built for a model to optimise its own
 * renderer was the one a shell-less model could not reach.
 *
 * Goal creation and evaluation write into the project, so they take the
 * project-write authority; the plan_* twins need nothing and write nothing.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAdapter, planScenarioRun } from '../src/harness/adapter.js';
import { executeScenarioRun } from '../src/harness/run-bundle.js';
import { registerOptimizationTools } from '../src/tools/optimization.js';
import { connectTools, type ToolClient } from './helpers/tool-harness.js';
import { writeHarnessProject } from './helpers/harness-fixture.js';

const ENV = 'GAME_DEV_MCP_ALLOW_PROJECT_WRITE';
let work: string;
let project: Awaited<ReturnType<typeof writeHarnessProject>>;
let tools: ToolClient;
let savedEnv: string | undefined;

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'optimization-tools-'));
  project = await writeHarnessProject(work);
  // The tool resolves run ids under the runtime's runsDir, so the fixture runs
  // must land there: the workspace IS the output dir the harness gets.
  tools = await connectTools(registerOptimizationTools, work);
  savedEnv = process.env[ENV];
  delete process.env[ENV];
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv;
  await tools.close();
  await fs.rm(work, { recursive: true, force: true });
});

async function capture(source: string, frameTime: number): Promise<string> {
  const adapter = await loadAdapter(project.projectRoot);
  const plan = await planScenarioRun({
    adapter,
    scenarioId: 'capture',
    runsRoot: path.join(work, '.game-dev', 'runs'),
    parameters: {
      source: path.basename(source),
      objectIds: path.basename(project.objectIdPng),
      frameTime,
      mode: 'normal',
    },
  });
  const result = await executeScenarioRun({ adapter, plan, confirm: true, allowGpu: false, allowPerformance: false });
  return result.runPath;
}

const goal = (baseline: string) => ({
  project: project.projectRoot,
  baseline,
  metric: 'render.frame_time',
  statistic: 'median',
  unit: 'ms',
  direction: 'lower',
  target: 10,
  maximumIterations: 3,
  allowedPaths: ['src'],
});

describe('planning a goal', () => {
  it('needs no authority and writes nothing', async () => {
    const baseline = await capture(project.baselinePng, 12);
    const { isError, payload } = await tools.call('plan_optimization_goal', goal(baseline));

    expect(isError).toBe(false);
    expect(payload.dryRun).toBe(true);
    await expect(fs.access(path.join(project.projectRoot, '.game-dev', 'goals'))).rejects.toThrow();
  }, 30_000);

  it('refuses a forbidden allowlist path, before anything is written', async () => {
    const baseline = await capture(project.baselinePng, 12);
    const { isError } = await tools.call('plan_optimization_goal', { ...goal(baseline), allowedPaths: ['.git'] });

    expect(isError).toBe(true);
  }, 30_000);
});

describe('creating and evaluating a goal', () => {
  it('is refused without project-write authority', async () => {
    const baseline = await capture(project.baselinePng, 12);
    const { isError, payload } = await tools.call('create_optimization_goal', goal(baseline));

    expect(isError).toBe(true);
    expect((payload.details as { grantBySetting: string[] }).grantBySetting).toEqual([`${ENV}=1`]);
  }, 30_000);

  it('runs the whole loop once authority is granted', async () => {
    process.env[ENV] = '1';
    const baseline = await capture(project.baselinePng, 12);
    const created = await tools.call('create_optimization_goal', goal(baseline));
    expect(created.isError).toBe(false);
    const goalPath = created.payload.goalPath as string;
    await expect(fs.access(goalPath)).resolves.toBeUndefined();

    // A candidate that meets the target (8ms < 10ms).
    const candidate = await capture(project.candidatePng, 8);

    // Plan first: same verdict, no iteration consumed.
    const planned = await tools.call('plan_goal_evaluation', { goalPath, candidate });
    expect(planned.isError).toBe(false);
    expect(planned.payload.dryRun).toBe(true);

    const evaluated = await tools.call('evaluate_optimization_goal', { goalPath, candidate });
    expect(evaluated.isError).toBe(false);
    expect(evaluated.payload.dryRun).toBe(false);
    // The fixture is deterministic: baseline 12ms, candidate 8ms, target 10ms.
    expect(evaluated.payload).toMatchObject({
      baselineValue: 12,
      candidateValue: 8,
      target: 10,
      targetMet: true,
      status: 'met',
      remainingIterations: 2,
    });
  }, 60_000);

  it('cannot reuse a candidate run, so an iteration cannot be replayed', async () => {
    process.env[ENV] = '1';
    const baseline = await capture(project.baselinePng, 12);
    const created = await tools.call('create_optimization_goal', { ...goal(baseline), target: 1 });
    const goalPath = created.payload.goalPath as string;
    const candidate = await capture(project.candidatePng, 11);

    const first = await tools.call('evaluate_optimization_goal', { goalPath, candidate });
    expect(first.isError).toBe(false);
    const second = await tools.call('evaluate_optimization_goal', { goalPath, candidate });
    expect(second.isError).toBe(true);
  }, 60_000);
});

describe('run_doctor', () => {
  it('reports checks without needing anything configured', async () => {
    const { isError, payload } = await tools.call('run_doctor', {});

    expect(isError).toBe(false);
    const checks = payload.checks as Array<{ id: string; status: string }>;
    expect(checks.length).toBeGreaterThan(5);
    expect(checks.map((check) => check.id)).toContain('codex-skills');
    // Credentials are reported as configured or not -- never as values.
    expect(JSON.stringify(payload)).not.toMatch(/api[_-]?key\s*[:=]\s*"[^"]{8,}/i);
  });
});
