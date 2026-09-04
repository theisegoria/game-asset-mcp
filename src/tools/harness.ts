/**
 * Capture, visual-analysis and performance operations as registry commands.
 *
 * These existed only as branches inside the CLI dispatch tree, which meant the
 * MCP transport -- the one a GUI client can reach -- exposed asset generation
 * and none of the visual debugging. The underlying harness functions were
 * already pure and argument-shaped, so this wraps rather than reimplements
 * them: one registration, both transports.
 *
 * Everything here is read-only over sealed evidence except the heatmap write in
 * compare_capture_visuals, which is annotated accordingly.
 */

import path from 'node:path';
import { z } from 'zod';
import { analyzeRunCapture, compareRunVisuals, type RasterAnalysis } from '../harness/visual.js';
import { loadAdapter, planScenarioRun, serializableAdapterSnapshot } from '../harness/adapter.js';
import { executeScenarioRun } from '../harness/run-bundle.js';
import { invalidInput } from '../util/errors.js';
import { compareRunPerformance, summarizeRunPerformance } from '../harness/performance.js';
import { resolveRunPath, verifyRunBundle } from '../harness/run-bundle.js';
import type { ToolRegistrar } from '../commands/registry.js';
import { guard, ok, type ToolContext, type VisualAttachment } from './context.js';

const runReference = z
  .string()
  .min(1)
  .describe('A sealed run id, or a path to a run bundle directory.');

const statistic = z.enum(['min', 'max', 'mean', 'median', 'p95', 'p99']);

/**
 * Colour buffers are colour; every other attachment kind is data whose values
 * mean something numerically. Resampling the second group in gamma space
 * corrupts exactly the signal it was captured to show.
 */
function colorimetryFor(kind: RasterAnalysis['kind']): VisualAttachment['colorimetry'] {
  return kind === 'color' ? 'srgb' : 'data';
}

type Authority = 'execution' | 'gpu' | 'performance';

const AUTHORITY_ENV: Record<Authority, string> = {
  execution: 'GAME_DEV_MCP_ALLOW_EXECUTION',
  gpu: 'GAME_DEV_MCP_ALLOW_GPU',
  performance: 'GAME_DEV_MCP_ALLOW_PERFORMANCE',
};

function granted(authority: Authority, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AUTHORITY_ENV[authority]]?.trim() === '1';
}

/**
 * Refuse to run a project executable unless a human granted the authority.
 *
 * The CLI asks for --confirm on every invocation, plus --allow-gpu and
 * --allow-performance on top when the scenario declares those capabilities.
 * This is the equivalent for a caller that types nothing: the authority lives
 * in the launch environment, which a human writes and a model cannot reach.
 *
 * It is enforced HERE, in the handler, rather than only in the MCP transport,
 * because registering the tool also exposes it through `game-dev tool call` --
 * and a gate that one entry point walks around is not a gate.
 */
function assertExecutionAuthority(required: readonly string[]): void {
  const missing: Authority[] = [];
  if (!granted('execution')) missing.push('execution');
  if (required.includes('gpu') && !granted('gpu')) missing.push('gpu');
  if (required.includes('performance') && !granted('performance')) missing.push('performance');
  if (missing.length === 0) return;

  throw invalidInput(
    'running a project scenario requires authority this process was not given',
    {
      // Named `missingGrants`, not `missingAuthorities`: the log redactor
      // scrubs any key containing "auth", which is correct of it and would
      // have blanked the one field that tells an operator what to do.
      missingGrants: missing,
      grantBySetting: missing.map((authority) => `${AUTHORITY_ENV[authority]}=1`),
      note:
        'Set these in the server configuration a human controls, then restart. They are ' +
        'deliberately not tool arguments: an argument the caller writes cannot authorize the ' +
        'caller. Hardware-performance authority additionally means you accept that timings from ' +
        'this host are being recorded as evidence.',
    },
  );
}

export function registerHarnessTools(server: ToolRegistrar, ctx: ToolContext): void {
  const resolve = (reference: string): Promise<string> =>
    resolveRunPath(ctx.config.runsDir, reference);

  const projectPath = z.string().min(1).describe('Path to the game project holding .game-dev/adapter.json.');
  const scenarioParameters = z.record(z.unknown()).default({})
    .describe('Values for the parameters the scenario declares. Undeclared names are refused.');

  server.registerTool(
    'plan_scenario_run',
    {
      title: 'Plan a capture scenario without running it',
      description:
        'FREE, local, executes nothing. Resolves a scenario from the project adapter into the ' +
        'exact executable, arguments, working directory and run directory that would be used, ' +
        'and reports which authorities the run would require. Call this first: it is the only ' +
        'way to see what would execute before anything does.',
      inputSchema: { project: projectPath, scenario: z.string().min(1), parameters: scenarioParameters },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'plan_scenario_run', async (args) => {
      const adapter = await loadAdapter(args.project);
      const plan = await planScenarioRun({
        adapter,
        scenarioId: args.scenario,
        runsRoot: ctx.config.runsDir,
        parameters: args.parameters,
      });
      return ok({
        schema: 'game_dev.scenario_plan.v1',
        plan,
        adapter: serializableAdapterSnapshot(adapter),
        authoritiesRequired: plan.requiredAuthorizations,
        authoritiesGranted: {
          execution: granted('execution'),
          gpu: granted('gpu'),
          performance: granted('performance'),
        },
      });
    }),
  );

  server.registerTool(
    'run_scenario',
    {
      title: 'Run a capture scenario the project owns',
      description:
        'Executes the project\'s OWN capture executable and seals the result into a run bundle. ' +
        'Requires authority granted in the server environment, not in these arguments: ' +
        'GAME_DEV_MCP_ALLOW_EXECUTION, plus GAME_DEV_MCP_ALLOW_GPU or ' +
        'GAME_DEV_MCP_ALLOW_PERFORMANCE when the scenario declares those capabilities. Call ' +
        'plan_scenario_run first to see what would run. The harness owns containment and sealing; ' +
        'the game owns its renderer, its GPU synchronization and what it captures.',
      inputSchema: { project: projectPath, scenario: z.string().min(1), parameters: scenarioParameters },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(ctx.logger, 'run_scenario', async (args) => {
      // Baseline authority is checked before the project is touched at all, so
      // an unauthorized caller does no work and learns nothing about the
      // project's adapter. The capability-specific authorities need the
      // resolved plan, so they are checked once it exists.
      assertExecutionAuthority([]);
      const adapter = await loadAdapter(args.project);
      const plan = await planScenarioRun({
        adapter,
        scenarioId: args.scenario,
        runsRoot: ctx.config.runsDir,
        parameters: args.parameters,
      });

      // Checked against the resolved plan, so authority is demanded for what
      // this scenario actually declares rather than for a name.
      assertExecutionAuthority(plan.requiredAuthorizations);

      const result = await executeScenarioRun({
        adapter,
        plan,
        request: args.parameters,
        confirm: true,
        allowGpu: granted('gpu'),
        allowPerformance: granted('performance'),
      });
      return ok(result as unknown as Record<string, unknown>);
    }),
  );

  server.registerTool(
    'verify_capture_run',
    {
      title: 'Verify a sealed capture run',
      description:
        'FREE, local. Re-checks that a sealed run bundle is intact: the artifact roster is ' +
        'closed over the directory, every hash still matches, and no unsafe entry was added. ' +
        'Run this before trusting any analysis of the run.',
      inputSchema: { run: runReference },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'verify_capture_run', async (args) => {
      const verified = await verifyRunBundle(await resolve(args.run));
      return ok({
        schema: 'game_dev.run_verification.v1',
        runPath: verified.runPath,
        manifestPath: verified.manifestPath,
        manifestSha256: verified.manifestSha256,
        run: verified.manifest,
        hashesVerified: true,
        closedArtifactRosterVerified: true,
      });
    }),
  );

  server.registerTool(
    'analyze_capture_run',
    {
      title: 'Analyze the rasters in a sealed capture run',
      description:
        'FREE, local. Decodes every raster attachment in a sealed run and reports deterministic ' +
        'per-channel statistics, mean luminance, alpha coverage and semantic id counts. Returns ' +
        'the frames themselves so you can look at them. Statistics describe the pixels; they do ' +
        'not diagnose artistic intent and are not a human visual review.',
      inputSchema: { run: runReference },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'analyze_capture_run', async (args) => {
      const analysis = await analyzeRunCapture(await resolve(args.run));
      const visuals: VisualAttachment[] = analysis.rasters.map((raster) => ({
        path: raster.path,
        mimeType: 'image/png',
        role: 'capture_frame',
        label: `frame ${raster.frameIndex} ${raster.kind}${raster.label ? ` (${raster.label})` : ''}`,
        colorimetry: colorimetryFor(raster.kind),
        width: raster.width,
        height: raster.height,
      }));
      return ok(analysis, visuals);
    }),
  );

  server.registerTool(
    'compare_capture_visuals',
    {
      title: 'Compare two sealed capture runs',
      description:
        'FREE, local. Diffs matched attachments between a baseline and a candidate run and ' +
        'reports mean absolute error, RMSE, maximum channel delta, changed-pixel ratio, ' +
        'luminance delta, edge delta, and per-object regions from the object-id buffer. Writes ' +
        'deterministic heatmaps and returns them so you can see WHERE it changed. Compare only ' +
        'runs from the same scenario, camera, seed and resolution; otherwise the result is ' +
        'exploratory rather than a regression verdict.',
      inputSchema: {
        baseline: runReference,
        candidate: runReference,
        threshold: z.number().int().min(0).max(255).default(0)
          .describe('A channel delta at or below this counts as unchanged.'),
        antialiasTolerancePixels: z.number().int().min(0).max(4).default(0)
          .describe(
            'Treat a difference as the same content landing elsewhere if a matching pixel exists '
            + 'within this radius. Use 1 for a real renderer: anti-aliasing and sub-pixel camera '
            + 'jitter otherwise make every edge in the frame report as changed. 0 compares strictly.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(ctx.logger, 'compare_capture_visuals', async (args) => {
      const [baselineRunPath, candidateRunPath] = await Promise.all([
        resolve(args.baseline),
        resolve(args.candidate),
      ]);
      // The output directory is derived, never taken from the caller: over MCP
      // the caller is a model, and a model-supplied write path is an injection
      // surface for no benefit. compareRunVisuals requires it to be new.
      const outputPath = path.join(
        ctx.config.dataRoot,
        'comparisons',
        `${path.basename(baselineRunPath)}__${path.basename(candidateRunPath)}__${Date.now()}`,
      );
      const comparison = await compareRunVisuals({
        baselineRunPath,
        candidateRunPath,
        threshold: args.threshold,
        antialiasTolerancePixels: args.antialiasTolerancePixels,
        outputPath,
      });
      const visuals: VisualAttachment[] = comparison.pairs
        .filter((pair) => pair.heatmapPath !== undefined)
        .map((pair) => ({
          path: pair.heatmapPath as string,
          mimeType: 'image/png',
          role: 'diff_heatmap',
          // False colour over a delta magnitude, so it is a picture, not data.
          colorimetry: 'srgb',
          label:
            `${pair.identity} (${pair.kind}) heatmap` +
            (pair.changedPixelRatio !== undefined
              ? ` — ${(pair.changedPixelRatio * 100).toFixed(2)}% of pixels changed`
              : ''),
        }));
      return ok(comparison, visuals);
    }),
  );

  server.registerTool(
    'summarize_run_performance',
    {
      title: 'Summarize the measurements in a sealed capture run',
      description:
        'FREE, local. Aggregates capture measurements, telemetry and profile files from a sealed ' +
        'run into per-metric statistics. Arithmetic over what the game reported; the harness ' +
        'does not measure hardware performance itself and says so in the result.',
      inputSchema: { run: runReference },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'summarize_run_performance', async (args) =>
      ok(await summarizeRunPerformance(await resolve(args.run)))),
  );

  server.registerTool(
    'compare_run_performance',
    {
      title: 'Compare measurements between two sealed capture runs',
      description:
        'FREE, local. Reports per-metric deltas between a baseline and a candidate run for one ' +
        'statistic. An arithmetic difference is not evidence that a change CAUSED it, and a ' +
        'delta from few samples may be indistinguishable from run-to-run noise.',
      inputSchema: {
        baseline: runReference,
        candidate: runReference,
        statistic: statistic.default('median'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'compare_run_performance', async (args) => {
      const [baseline, candidate] = await Promise.all([
        resolve(args.baseline),
        resolve(args.candidate),
      ]);
      return ok(await compareRunPerformance(baseline, candidate, args.statistic));
    }),
  );
}
