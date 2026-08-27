import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../packages/format.js';
import { sha256, writeFileAtomic } from '../storage/filesystem.js';
import { invalidInput, invalidState } from '../util/errors.js';
import {
  GAME_DEV_OPTIMIZATION_GOAL_SCHEMA,
  optimizationGoalSchema,
  relativePathSchema,
  type MetricStatistics,
  type OptimizationGoal,
} from './contracts.js';
import { summarizeRunPerformance, type PerformanceSummary } from './performance.js';

type GoalStatistic = OptimizationGoal['statistic'];

export interface OptimizationGoalResult {
  schema: 'game_dev.optimization_goal_result.v1';
  dryRun: boolean;
  goalPath: string;
  goal: OptimizationGoal;
  evidenceCeiling: string;
}

export interface OptimizationEvaluationResult {
  schema: 'game_dev.optimization_evaluation.v1';
  dryRun: boolean;
  goalPath: string;
  goalId: string;
  iteration: number;
  candidateRunId: string;
  baselineValue: number;
  candidateValue: number;
  target: number;
  targetMet: boolean;
  status: OptimizationGoal['state']['status'];
  remainingIterations: number;
  allowedPaths: string[];
  evidenceCeiling: string;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function goalMetric(summary: PerformanceSummary, metric: string, unit?: string): MetricStatistics {
  const matches = summary.metrics.filter((candidate) => candidate.metric === metric && (unit === undefined || candidate.unit === unit));
  if (matches.length === 0) throw invalidInput('performance metric is absent from the run', { metric, unit });
  if (matches.length > 1) {
    throw invalidInput('performance metric has more than one unit; specify the unit explicitly', {
      metric,
      units: matches.map((candidate) => candidate.unit),
    });
  }
  const match = matches[0];
  if (!match) throw invalidState('metric lookup became empty unexpectedly');
  return match;
}

function goalId(requested?: string): string {
  if (requested !== undefined) {
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(requested)) {
      throw invalidInput('goal id must be a lowercase portable identifier');
    }
    return requested;
  }
  return `goal_${randomUUID().replaceAll('-', '')}`;
}

async function validateAllowedPaths(projectRoot: string, allowedPaths: string[]): Promise<string[]> {
  if (allowedPaths.length === 0 || allowedPaths.length > 256) {
    throw invalidInput('an optimization goal requires 1 through 256 allowed paths');
  }
  const normalized = new Set<string>();
  for (const requested of allowedPaths) {
    const parsed = relativePathSchema.safeParse(requested);
    if (!parsed.success) throw invalidInput('optimization allowed path is not a safe project-relative path', { path: requested });
    const first = requested.split('/')[0]?.toLowerCase();
    if (first && ['.git', '.game-dev', 'node_modules', 'build', 'dist'].includes(first)) {
      throw invalidInput('optimization allowed paths may not include repository metadata, harness state, dependencies, or generated outputs', {
        path: requested,
      });
    }
    const candidate = path.resolve(projectRoot, requested);
    if (!isInside(projectRoot, candidate) || candidate === projectRoot) {
      throw invalidInput('optimization allowed path escapes or names the whole project', { path: requested });
    }
    const stats = await fs.lstat(candidate).catch(() => undefined);
    if (!stats || stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
      throw invalidInput('optimization allowed path must already exist and must not be a symlink', { path: requested });
    }
    const resolved = await fs.realpath(candidate);
    if (!isInside(projectRoot, resolved)) throw invalidInput('optimization allowed path resolves outside the project', { path: requested });
    normalized.add(path.relative(projectRoot, resolved).split(path.sep).join('/'));
  }
  return [...normalized].sort();
}

export async function createOptimizationGoal(options: {
  projectRoot: string;
  baselineRunPath: string;
  metric: string;
  statistic?: GoalStatistic;
  unit?: string;
  direction: OptimizationGoal['direction'];
  target: number;
  maximumIterations: number;
  allowedPaths: string[];
  id?: string;
  confirm: boolean;
}): Promise<OptimizationGoalResult> {
  if (!Number.isFinite(options.target)) throw invalidInput('optimization target must be finite');
  if (!Number.isInteger(options.maximumIterations) || options.maximumIterations < 1 || options.maximumIterations > 50) {
    throw invalidInput('maximumIterations must be an integer from 1 through 50');
  }
  const projectRoot = await fs.realpath(path.resolve(options.projectRoot)).catch(() => {
    throw invalidInput('optimization project root does not exist');
  });
  if (!(await fs.stat(projectRoot)).isDirectory()) throw invalidInput('optimization project root must be a directory');
  const allowedPaths = await validateAllowedPaths(projectRoot, options.allowedPaths);
  const baselineSummary = await summarizeRunPerformance(options.baselineRunPath);
  const metric = goalMetric(baselineSummary, options.metric, options.unit);
  const statistic = options.statistic ?? 'median';
  const id = goalId(options.id);
  const goal: OptimizationGoal = optimizationGoalSchema.parse({
    schema: GAME_DEV_OPTIMIZATION_GOAL_SCHEMA,
    id,
    projectRoot,
    adapterId: baselineSummary.adapterId,
    scenarioId: baselineSummary.scenarioId,
    metric: metric.metric,
    statistic,
    unit: metric.unit,
    direction: options.direction,
    target: options.target,
    maximumIterations: options.maximumIterations,
    allowedPaths,
    baseline: {
      runId: baselineSummary.runId,
      runPath: baselineSummary.runPath,
      value: metric[statistic],
    },
    createdAt: new Date().toISOString(),
    state: { status: 'active', iterations: [] },
  });
  const goalPath = path.join(projectRoot, '.game-dev', 'goals', `${id}.json`);
  if (options.confirm) {
    await fs.mkdir(path.dirname(goalPath), { recursive: true, mode: 0o700 });
    const handle = await fs.open(goalPath, 'wx', 0o600).catch((error) => {
      throw invalidState('optimization goal already exists or cannot be created', {
        goalPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    });
    try {
      await handle.writeFile(canonicalJson(goal));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return {
    schema: 'game_dev.optimization_goal_result.v1',
    dryRun: !options.confirm,
    goalPath,
    goal,
    evidenceCeiling:
      'The goal binds one metric, target, baseline, iteration ceiling, and patch allowlist. It authorizes neither capture execution nor edits outside the allowlist and does not prove that a future patch caused any measurement change.',
  };
}

async function readGoal(goalPathInput: string): Promise<{ path: string; bytes: Buffer; goal: OptimizationGoal }> {
  const candidate = path.resolve(goalPathInput);
  const stats = await fs.lstat(candidate).catch(() => undefined);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) throw invalidInput('goal path must identify a regular non-symlink file');
  const bytes = await fs.readFile(candidate);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalidState('optimization goal is not valid UTF-8 JSON');
  }
  const parsed = optimizationGoalSchema.safeParse(value);
  if (!parsed.success) throw invalidState('optimization goal violates game_dev.optimization_goal.v1', { issues: parsed.error.issues });
  if (canonicalJson(parsed.data) !== bytes.toString('utf8')) throw invalidState('optimization goal is not canonical JSON');
  const resolved = await fs.realpath(candidate);
  const expectedRoot = path.join(parsed.data.projectRoot, '.game-dev', 'goals');
  if (!isInside(expectedRoot, resolved)) throw invalidState('optimization goal is outside its bound project goal directory');
  return { path: resolved, bytes, goal: parsed.data };
}

export async function evaluateOptimizationGoal(options: {
  goalPath: string;
  candidateRunPath: string;
  confirm: boolean;
}): Promise<OptimizationEvaluationResult> {
  const loaded = await readGoal(options.goalPath);
  const goal = loaded.goal;
  if (goal.state.status !== 'active') throw invalidState(`optimization goal is already ${goal.state.status}`);
  if (goal.state.iterations.length >= goal.maximumIterations) throw invalidState('optimization goal iteration budget is exhausted');
  const candidate = await summarizeRunPerformance(options.candidateRunPath);
  if (candidate.adapterId !== goal.adapterId || candidate.scenarioId !== goal.scenarioId) {
    throw invalidInput('candidate run does not match the optimization goal adapter scenario');
  }
  if (candidate.runId === goal.baseline.runId || goal.state.iterations.some((iteration) => iteration.runId === candidate.runId)) {
    throw invalidInput('candidate run has already been used by this goal');
  }
  const metric = goalMetric(candidate, goal.metric, goal.unit);
  const candidateValue = metric[goal.statistic];
  const targetMet = goal.direction === 'lower' ? candidateValue <= goal.target : candidateValue >= goal.target;
  const iteration = goal.state.iterations.length + 1;
  const status: OptimizationGoal['state']['status'] = targetMet
    ? 'met'
    : iteration >= goal.maximumIterations
      ? 'exhausted'
      : 'active';
  const updated: OptimizationGoal = optimizationGoalSchema.parse({
    ...goal,
    state: {
      status,
      iterations: [...goal.state.iterations, {
        iteration,
        runId: candidate.runId,
        runPath: candidate.runPath,
        value: candidateValue,
        targetMet,
        evaluatedAt: new Date().toISOString(),
      }],
    },
  });
  if (options.confirm) {
    const current = await fs.readFile(loaded.path);
    if (sha256(current) !== sha256(loaded.bytes)) {
      throw invalidState('optimization goal changed concurrently; refusing to overwrite it');
    }
    await writeFileAtomic(loaded.path, Buffer.from(canonicalJson(updated)));
  }
  return {
    schema: 'game_dev.optimization_evaluation.v1',
    dryRun: !options.confirm,
    goalPath: loaded.path,
    goalId: goal.id,
    iteration,
    candidateRunId: candidate.runId,
    baselineValue: goal.baseline.value,
    candidateValue,
    target: goal.target,
    targetMet,
    status,
    remainingIterations: goal.maximumIterations - iteration,
    allowedPaths: goal.allowedPaths,
    evidenceCeiling:
      'Evaluation proves only that the sealed candidate metric meets or misses the declared numerical target. It does not prove causality, visual correctness, gameplay quality, or permission to edit outside allowedPaths.',
  };
}
