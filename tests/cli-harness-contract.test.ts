import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { writeHarnessProject } from './helpers/harness-fixture.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const roots: string[] = [];

interface Invocation {
  code: number;
  payload: Record<string, any>;
  stderr: string;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-cli-harness-'));
  roots.push(root);
  return root;
}

async function run(args: string[]): Promise<Invocation> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        TRIPO_API_KEY: '',
        LEONARDO_API_KEY: '',
        ASSET_LOG_LEVEL: 'error',
      },
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      try {
        resolve({
          code: typeof error?.code === 'number' ? error.code : 0,
          payload: JSON.parse(stdout) as Record<string, any>,
          stderr,
        });
      } catch (parseError) {
        reject(new Error(`game-dev returned non-JSON: ${stdout}\n${stderr}`, { cause: parseError }));
      }
    });
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('game-dev adapter, capture, visual, and performance CLI', () => {
  it('plans without execution, enforces capability authorization, and exposes sealed evidence through stable envelopes', async () => {
    const root = await temporaryRoot();
    const project = await writeHarnessProject(root);
    const outputDir = path.join(root, 'workspace');
    const parameters = JSON.stringify({
      source: 'baseline.png',
      objectIds: 'objects.png',
      frameTime: 12,
      mode: 'normal',
    });
    const common = ['--project', project.projectRoot, '--output-dir', outputDir, '--json'];

    const templates = await run(['adapter', 'templates', '--output-dir', outputDir, '--json']);
    expect(templates).toMatchObject({
      code: 0,
      payload: {
        schema: 'game_dev.result.v1',
        operation: 'adapter.templates',
        ok: true,
        data: { schema: 'game_dev.adapter_templates.v1' },
      },
    });
    expect(templates.payload.data.templates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'genome-game', manifestRelativePath: 'adapters/genome-game/adapter.json' }),
    ]));

    const inspected = await run(['adapter', 'inspect', ...common]);
    expect(inspected.payload).toMatchObject({
      operation: 'adapter.inspect',
      ok: true,
      data: {
        schema: 'game_dev.adapter_inspection.v1',
        adapter: { id: 'fixture-game', version: '1.0.0' },
      },
    });

    const planned = await run(['scenario', 'plan', 'capture', '--input', parameters, ...common]);
    expect(planned.payload).toMatchObject({
      operation: 'scenario.plan',
      ok: true,
      data: {
        schema: 'game_dev.scenario_plan.v1',
        adapterId: 'fixture-game',
        scenarioId: 'capture',
        requiredAuthorizations: ['confirm'],
      },
    });
    await expect(access(String(planned.payload.data.runPath))).rejects.toMatchObject({ code: 'ENOENT' });

    const unconfirmed = await run(['scenario', 'run', 'capture', '--input', parameters, ...common]);
    expect(unconfirmed).toMatchObject({
      code: 1,
      payload: {
        operation: 'scenario.run',
        ok: false,
        error: { error: 'APPROVAL_REQUIRED', requiredFlags: ['--confirm'] },
      },
    });
    await expect(access(String(unconfirmed.payload.error.plan.runPath))).rejects.toMatchObject({ code: 'ENOENT' });

    const gpuBlocked = await run([
      'scenario', 'run', 'gpu-capture',
      '--input', parameters,
      '--confirm',
      ...common,
    ]);
    expect(gpuBlocked).toMatchObject({
      code: 1,
      payload: {
        operation: 'scenario.run',
        ok: false,
        error: { error: 'APPROVAL_REQUIRED', requiredFlags: ['--allow-gpu'] },
      },
    });
    await expect(access(String(gpuBlocked.payload.error.plan.runPath))).rejects.toMatchObject({ code: 'ENOENT' });

    const executed = await run([
      'scenario', 'run', 'capture',
      '--input', parameters,
      '--confirm',
      ...common,
    ]);
    expect(executed).toMatchObject({
      code: 0,
      payload: {
        operation: 'scenario.run',
        ok: true,
        data: {
          schema: 'game_dev.scenario_run_result.v1',
          run: {
            schema: 'game_dev.run.v1',
            status: 'completed',
            evidence: {
              captureContractValidated: true,
              rasterBytesDecoded: true,
              hardwareGpuExecutionProvenByHarnessAlone: false,
              humanVisualReviewPerformed: false,
            },
          },
        },
      },
    });
    const runPath = String(executed.payload.data.runPath);

    const verified = await run(['capture', 'verify', runPath, '--output-dir', outputDir, '--json']);
    expect(verified.payload).toMatchObject({
      operation: 'capture.verify',
      ok: true,
      data: { hashesVerified: true, closedArtifactRosterVerified: true },
    });

    const visual = await run(['visual', 'analyze', runPath, '--output-dir', outputDir, '--json']);
    expect(visual.payload).toMatchObject({
      operation: 'visual.analyze',
      ok: true,
      data: {
        schema: 'game_dev.visual_analysis.v1',
        evidence: {
          sealedRunVerified: true,
          rasterBytesDecoded: true,
          deterministicStatisticsComputed: true,
          artisticDefectsDiagnosed: false,
          humanVisualReviewPerformed: false,
        },
      },
    });
    expect(visual.payload.data.rasters).toHaveLength(2);

    const performance = await run(['performance', 'summarize', runPath, '--output-dir', outputDir, '--json']);
    expect(performance.payload).toMatchObject({
      operation: 'performance.summarize',
      ok: true,
      data: {
        schema: 'game_dev.performance_summary.v1',
        hardwarePerformanceEvidenceAdmitted: false,
      },
    });
    expect(performance.payload.data.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'render.frame_time', median: 12, unit: 'ms' }),
    ]));
    expect(executed.stderr).not.toContain('TRIPO_API_KEY');
  });
});
