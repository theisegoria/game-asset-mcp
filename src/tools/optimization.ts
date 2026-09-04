/**
 * The bounded optimisation loop and self-diagnosis, on the registry.
 *
 * goal-create and goal-evaluate are the performance-optimisation feature: a
 * metric, a direction, a target, an iteration budget and a patch allowlist,
 * evaluated candidate by candidate until met or exhausted. They were CLI-only,
 * which meant the surface built for a model to optimise its own renderer was
 * the one surface a shell-less model could not reach.
 *
 * Both write into the project's .game-dev/goals directory, so they take the
 * project-write authority, with free plan_* twins that need none. doctor is
 * read-only and needs nothing: a model that can ask what is wrong with its
 * environment can fix it instead of guessing.
 */

import { z } from 'zod';
import type { ToolRegistrar } from '../commands/registry.js';
import { runDoctor } from '../cli/doctor.js';
import { createOptimizationGoal, evaluateOptimizationGoal } from '../harness/goals.js';
import { resolveRunPath } from '../harness/run-bundle.js';
import { guard, ok, type ToolContext } from './context.js';
import { assertProjectWriteAuthority } from './project-writes.js';

const statistic = z.enum(['min', 'max', 'mean', 'median', 'p95', 'p99']);

const goalShape = {
  project: z.string().min(1).describe('Path to the game project; the goal is stored under its .game-dev/goals.'),
  baseline: z.string().min(1).describe('A sealed run id or path to measure from.'),
  metric: z.string().min(1).describe('Metric name exactly as the summary reports it, e.g. performance.frame_time.'),
  statistic: statistic.default('median'),
  unit: z.string().min(1).optional().describe('Unit as reported; required only to disambiguate.'),
  direction: z.enum(['lower', 'higher']),
  target: z.number().finite(),
  maximumIterations: z.number().int().min(1).max(50)
    .describe('How many candidate runs may be evaluated before the goal is exhausted.'),
  allowedPaths: z.array(z.string().min(1)).min(1).max(32)
    .describe('Project subtrees a change may touch. Never .git, .game-dev, dependencies, build output or the root.'),
  id: z.string().min(1).optional(),
};

const evaluationShape = {
  goalPath: z.string().min(1).describe('Path to the goal file returned by create_optimization_goal.'),
  candidate: z.string().min(1).describe('A sealed run id or path to evaluate against the goal.'),
};

export function registerOptimizationTools(server: ToolRegistrar, ctx: ToolContext): void {
  const goalOptions = async (args: z.infer<z.ZodObject<typeof goalShape>>, confirm: boolean) => ({
    projectRoot: args.project,
    baselineRunPath: await resolveRunPath(ctx.config.runsDir, args.baseline),
    metric: args.metric,
    statistic: args.statistic,
    ...(args.unit !== undefined ? { unit: args.unit } : {}),
    direction: args.direction,
    target: args.target,
    maximumIterations: args.maximumIterations,
    allowedPaths: args.allowedPaths,
    ...(args.id !== undefined ? { id: args.id } : {}),
    confirm,
  });

  server.registerTool(
    'plan_optimization_goal',
    {
      title: 'Plan a bounded optimisation goal without creating it',
      description:
        'FREE, local, writes nothing. Validates the goal against the baseline run -- the metric ' +
        'exists, the allowed paths are real project subtrees and not forbidden ones -- and reports ' +
        'exactly what create_optimization_goal would write.',
      inputSchema: goalShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'plan_optimization_goal', async (args) =>
      ok(await createOptimizationGoal(await goalOptions(args, false)))),
  );

  server.registerTool(
    'create_optimization_goal',
    {
      title: 'Create a bounded optimisation goal',
      description:
        'Binds one metric, a direction, a target and an iteration budget to a baseline run, ' +
        'with an allowlist of project paths a change may touch. Writes the goal into the ' +
        'project\'s .game-dev/goals, so it requires GAME_DEV_MCP_ALLOW_PROJECT_WRITE=1 plus a ' +
        'confirmation; call plan_optimization_goal first. Then change ONE thing within the ' +
        'allowlist, capture, and call evaluate_optimization_goal.',
      inputSchema: goalShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(ctx.logger, 'create_optimization_goal', async (args) => {
      assertProjectWriteAuthority();
      return ok(await createOptimizationGoal(await goalOptions(args, true)));
    }),
  );

  server.registerTool(
    'plan_goal_evaluation',
    {
      title: 'Evaluate a candidate run against a goal without recording it',
      description:
        'FREE, local, writes nothing. Reports whether the candidate meets the goal, the delta from ' +
        'the baseline, and what state the goal would move to -- without consuming an iteration. ' +
        'The verdict is arithmetic over reported numbers; it establishes no cause.',
      inputSchema: evaluationShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'plan_goal_evaluation', async (args) => ok(await evaluateOptimizationGoal({
      goalPath: args.goalPath,
      candidateRunPath: await resolveRunPath(ctx.config.runsDir, args.candidate),
      confirm: false,
    }))),
  );

  server.registerTool(
    'evaluate_optimization_goal',
    {
      title: 'Record a candidate run against a goal',
      description:
        'Appends exactly one iteration to the goal and advances it to active, met or exhausted. ' +
        'A candidate run id can be used once. Writes into the project, so it requires ' +
        'GAME_DEV_MCP_ALLOW_PROJECT_WRITE=1 plus a confirmation; call plan_goal_evaluation first.',
      inputSchema: evaluationShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(ctx.logger, 'evaluate_optimization_goal', async (args) => {
      assertProjectWriteAuthority();
      return ok(await evaluateOptimizationGoal({
        goalPath: args.goalPath,
        candidateRunPath: await resolveRunPath(ctx.config.runsDir, args.candidate),
        confirm: true,
      }));
    }),
  );

  server.registerTool(
    'run_doctor',
    {
      title: 'Check what this environment can and cannot do',
      description:
        'FREE, local. Reports the platform, Node version, workspace directories, which provider ' +
        'credentials are configured (never their values), whether Blender and its scripts are ' +
        'reachable, and whether the packaged skills are installed. Ask this before assuming a ' +
        'capability is missing or a failure is yours.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'run_doctor', async () => ok(await runDoctor({ config: ctx.config }))),
  );
}
