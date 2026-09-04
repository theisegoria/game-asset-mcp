import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAdapter, planScenarioRun } from '../src/harness/adapter.js';
import { normalizeGenomeHemeraCapture, validateCaptureManifest } from '../src/harness/capture.js';
import { createOptimizationGoal, evaluateOptimizationGoal } from '../src/harness/goals.js';
import { compareRunPerformance, summarizeRunPerformance } from '../src/harness/performance.js';
import { executeScenarioRun, verifyRunBundle } from '../src/harness/run-bundle.js';
import { installAdapterTemplate, listAdapterTemplates } from '../src/harness/templates.js';
import { analyzeRunCapture, compareRunVisuals } from '../src/harness/visual.js';
import { encodePNG } from '../src/inspection/image.js';
import { canonicalJson } from '../src/packages/format.js';
import { sha256 } from '../src/storage/filesystem.js';
import { writeHarnessProject } from './helpers/harness-fixture.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-harness-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function executeFixture(
  project: Awaited<ReturnType<typeof writeHarnessProject>>,
  runsRoot: string,
  source: string,
  frameTime: number,
  mode = 'normal',
) {
  const adapter = await loadAdapter(project.projectRoot);
  const request = {
    source: path.basename(source),
    objectIds: path.basename(project.objectIdPng),
    frameTime,
    mode,
  };
  const plan = await planScenarioRun({
    adapter,
    scenarioId: 'capture',
    runsRoot,
    parameters: request,
  });
  return executeScenarioRun({
    adapter,
    plan,
    request,
    confirm: true,
    allowGpu: false,
    allowPerformance: false,
  });
}

describe('local game adapter and sealed run contract', () => {
  it('executes a command without a shell and seals capture, telemetry, and profile evidence', async () => {
    const root = await temporaryRoot();
    const project = await writeHarnessProject(root);
    const runsRoot = path.join(root, 'runs');
    const executed = await executeFixture(project, runsRoot, project.baselinePng, 12);

    expect(executed.manifest).toMatchObject({
      status: 'completed',
      adapterId: 'fixture-game',
      scenarioId: 'capture',
      evidence: {
        processExitedSuccessfully: true,
        captureContractValidated: true,
        rasterBytesDecoded: true,
        adapterReportedGpuExecution: false,
        hardwareGpuExecutionProvenByHarnessAlone: false,
        humanVisualReviewPerformed: false,
      },
    });
    expect(executed.manifest.artifacts.map((artifact) => artifact.path)).toEqual(expect.arrayContaining([
      'adapter.json',
      'capture.json',
      'captures/color.png',
      'captures/objects.png',
      'telemetry.jsonl',
      'profile.json',
      'stdout.log',
    ]));

    const verified = await verifyRunBundle(executed.runPath);
    expect(verified.manifestSha256).toBe(executed.manifestSha256);
    const analysis = await analyzeRunCapture(executed.runPath);
    expect(analysis.rasters).toHaveLength(2);
    expect(analysis.rasters.find((raster) => raster.kind === 'object_id')).toMatchObject({ uniqueSemanticIds: 2 });

    const performance = await summarizeRunPerformance(executed.runPath);
    expect(performance.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'render.frame_time', unit: 'ms', median: 12 }),
      expect.objectContaining({ metric: 'performance.frame_time', unit: 'ms', median: 12 }),
      expect.objectContaining({ metric: 'profile.renderer.gpu_frame_ns', unit: 'ns', median: 12_000_000 }),
    ]));
    expect(performance.hardwarePerformanceEvidenceAdmitted).toBe(false);
  });

  it('compares pixels by semantic object region and evaluates one bounded optimization goal', async () => {
    const root = await temporaryRoot();
    const project = await writeHarnessProject(root);
    const runsRoot = path.join(root, 'runs');
    const baseline = await executeFixture(project, runsRoot, project.baselinePng, 12);
    const candidate = await executeFixture(project, runsRoot, project.candidatePng, 8);

    const visual = await compareRunVisuals({
      baselineRunPath: baseline.runPath,
      candidateRunPath: candidate.runPath,
      threshold: 0,
      outputPath: path.join(root, 'comparisons', 'candidate'),
    });
    const color = visual.pairs.find((pair) => pair.kind === 'color');
    expect(color).toMatchObject({ comparable: true, changedPixelRatio: 1 });
    expect(color?.semanticRegions?.map((region) => region.objectId)).toEqual(['0x000001', '0x000002']);
    await expect(access(String(color?.heatmapPath))).resolves.toBeUndefined();

    const performance = await compareRunPerformance(baseline.runPath, candidate.runPath, 'median');
    const frameTime = performance.metrics.find((metric) => metric.metric === 'render.frame_time');
    expect(frameTime).toMatchObject({
      baseline: 12,
      candidate: 8,
      delta: -4,
    });
    expect(performance.hardwarePerformanceComparisonAdmitted).toBe(false);

    // The summaries always knew how many samples each side had and how they
    // were spread; the comparison dropped both. A caller reading only a delta
    // cannot tell six samples from six thousand, so "is this regression real?"
    // was unanswerable from the comparison alone.
    expect(frameTime?.baselineSamples).toBeGreaterThan(0);
    expect(frameTime?.candidateSamples).toBeGreaterThan(0);
    expect(typeof frameTime?.baselineStandardDeviation).toBe('number');
    expect(typeof frameTime?.candidateStandardDeviation).toBe('number');

    const baselineSummary = await summarizeRunPerformance(baseline.runPath);
    const baselineFrameTime = baselineSummary.metrics.find((m) => m.metric === 'render.frame_time');
    expect(frameTime?.baselineSamples).toBe(baselineFrameTime?.samples);
    expect(frameTime?.baselineStandardDeviation).toBe(baselineFrameTime?.standardDeviation);

    // This fixture reports a single measurement per run. The honest verdict for
    // a delta drawn from one sample is that the data cannot support one --
    // reporting "separable" here is exactly how a loop starts chasing noise.
    expect(frameTime?.separability).toBe('underpowered');
    expect(frameTime?.standardErrorOfDifference).toBeNull();
    expect(frameTime?.aggregation).toBe('sample');

    // And the ceiling must not let a caller mistake the screen for a test.
    expect(performance.evidenceCeiling).toContain('NOT a hypothesis test');
    expect(performance.evidenceCeiling).toContain('autocorrelated');

    const created = await createOptimizationGoal({
      projectRoot: project.projectRoot,
      baselineRunPath: baseline.runPath,
      metric: 'render.frame_time',
      statistic: 'median',
      unit: 'ms',
      direction: 'lower',
      target: 8,
      maximumIterations: 3,
      allowedPaths: ['src'],
      id: 'frame-time',
      confirm: true,
    });
    expect(created.goal.allowedPaths).toEqual(['src']);
    const evaluated = await evaluateOptimizationGoal({
      goalPath: created.goalPath,
      candidateRunPath: candidate.runPath,
      confirm: true,
    });
    expect(evaluated).toMatchObject({ targetMet: true, status: 'met', iteration: 1, remainingIterations: 2 });
    const persisted = JSON.parse(await readFile(created.goalPath, 'utf8')) as Record<string, any>;
    expect(persisted.state).toMatchObject({ status: 'met', iterations: [{ runId: candidate.manifest.runId }] });

    await expect(createOptimizationGoal({
      projectRoot: project.projectRoot,
      baselineRunPath: baseline.runPath,
      metric: 'render.frame_time',
      direction: 'lower',
      target: 7,
      maximumIterations: 1,
      allowedPaths: ['../outside'],
      confirm: false,
    })).rejects.toThrow(/allowed path/i);
  });

  it('keeps GPU authorization separate and removes child-created symlinks before sealing a failed run', async () => {
    const root = await temporaryRoot();
    const project = await writeHarnessProject(root);
    const runsRoot = path.join(root, 'runs');
    const adapter = await loadAdapter(project.projectRoot);
    const request = {
      source: 'baseline.png',
      objectIds: 'objects.png',
      frameTime: 12,
      mode: 'normal',
    };
    const gpuPlan = await planScenarioRun({ adapter, scenarioId: 'gpu-capture', runsRoot, parameters: request });
    expect(gpuPlan.requiredAuthorizations).toEqual(['confirm', 'gpu']);
    await expect(executeScenarioRun({
      adapter,
      plan: gpuPlan,
      request,
      confirm: true,
      allowGpu: false,
      allowPerformance: false,
    })).rejects.toThrow(/GPU authorization/i);
    await expect(access(gpuPlan.runPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const unsafe = await executeFixture(project, runsRoot, project.baselinePng, 12, 'symlink');
    expect(unsafe.manifest).toMatchObject({
      status: 'failed',
      failure: { code: 'UNSAFE_ARTIFACT' },
      evidence: { captureContractValidated: false },
    });
    await expect(access(path.join(unsafe.runPath, 'unsafe-link'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(path.join(unsafe.runPath, 'rejected-artifacts.json'), 'utf8'))).toMatchObject({
      artifacts: [{ path: 'unsafe-link', type: 'symbolic_link', target: '/etc/passwd' }],
    });
    await expect(verifyRunBundle(unsafe.runPath)).resolves.toMatchObject({ manifest: { status: 'failed' } });
  });

  it('detects post-seal byte tampering and refuses a symlinked executable', async () => {
    const root = await temporaryRoot();
    const project = await writeHarnessProject(root);
    const runsRoot = path.join(root, 'runs');
    const executed = await executeFixture(project, runsRoot, project.baselinePng, 12);
    const colorPath = path.join(executed.runPath, 'captures', 'color.png');
    const bytes = await readFile(colorPath);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    await writeFile(colorPath, bytes);
    await expect(verifyRunBundle(executed.runPath)).rejects.toThrow(/seal|match/i);

    const alias = path.join(project.projectRoot, 'runner-alias.mjs');
    await symlink('capture-runner.mjs', alias);
    const adapterPath = path.join(project.projectRoot, '.game-dev', 'adapter.json');
    const manifest = JSON.parse(await readFile(adapterPath, 'utf8')) as Record<string, any>;
    manifest.scenarios[0].command.executable = 'runner-alias.mjs';
    await writeFile(adapterPath, canonicalJson(manifest));
    const adapter = await loadAdapter(project.projectRoot);
    await expect(planScenarioRun({
      adapter,
      scenarioId: 'capture',
      runsRoot,
      parameters: { source: 'baseline.png', objectIds: 'objects.png', frameTime: 12, mode: 'normal' },
    })).rejects.toThrow(/symbolic link/i);
  });
});

describe('Genome Hemera normalization and packaged templates', () => {
  it('re-hashes a synthetic Genome evidence roster before exposing normalized capture frames', async () => {
    const root = await temporaryRoot();
    const harnessRun = path.join(root, 'run_1_fixture');
    const nativeParent = path.join(harnessRun, 'native');
    const nativeRun = path.join(nativeParent, 'run_20260828T000000Z_123');
    const shotDir = path.join(nativeRun, 'shots', 'shot');
    await mkdir(shotDir, { recursive: true });
    const pngPath = path.join(shotDir, 'capture.png');
    const profilePath = path.join(shotDir, 'profile.json');
    const sidecarPath = path.join(shotDir, 'sidecar.json');
    const pixel = new Uint8Array(4 * 4 * 4).fill(255);
    await writeFile(pngPath, encodePNG({ width: 4, height: 4, data: pixel }));
    await writeFile(profilePath, '{"renderer":{"gpu_frame_ns":1000}}\n');
    await writeFile(sidecarPath, '{"schema":"fixture.sidecar.v1"}\n');
    const seals = await Promise.all([pngPath, profilePath, sidecarPath].map(async (file) => {
      const bytes = await readFile(file);
      return { path: file, size_bytes: bytes.length, sha256: `sha256:${sha256(bytes)}` };
    }));
    const rosterPath = path.join(nativeRun, 'capture_evidence_roster.json');
    await writeFile(rosterPath, canonicalJson({
      schema: 'evo.capture_evidence_roster.v1',
      file_count: seals.length,
      files: seals,
    }));
    const rosterBytes = await readFile(rosterPath);
    const reportPath = path.join(nativeRun, 'renderer_acceptance_matrix.runtime.json');
    await writeFile(reportPath, canonicalJson({
      schema: 'evo.renderer_acceptance_capture_run.v1',
      run_directory: nativeRun,
      windowless: true,
      backend: 'metal',
      render_mode: 'raster',
      all_shots_passed: true,
      shot_count: 1,
      capture_evidence_roster_artifact: rosterPath,
      capture_evidence_roster_artifact_hash: `sha256:${sha256(rosterBytes)}`,
      capture_evidence_file_count: seals.length,
      proof_boundaries: ['Synthetic contract fixture; never hardware evidence.'],
      shots: [{
        order: 0,
        slug: 'dawn_mountain_ocean',
        passed: true,
        artifacts: {
          png: pngPath,
          png_hash: seals[0]?.sha256,
          profile: profilePath,
          profile_hash: seals[1]?.sha256,
          sidecar: sidecarPath,
          sidecar_hash: seals[2]?.sha256,
        },
      }],
    }));

    const normalizedPath = await normalizeGenomeHemeraCapture({
      harnessRunPath: harnessRun,
      outputPath: nativeParent,
      runId: 'run_1_fixture',
      adapterId: 'genome-game',
      scenarioId: 'trident-bay-diagnostic-shot',
    });
    const normalized = await validateCaptureManifest(harnessRun, normalizedPath, {
      runId: 'run_1_fixture',
      adapterId: 'genome-game',
      scenarioId: 'trident-bay-diagnostic-shot',
    });
    expect(normalized).toMatchObject({
      rasterBytesDecoded: true,
      manifest: {
        sourceFormat: 'genome-hemera-v1',
        frames: [{ label: 'dawn_mountain_ocean' }],
        adapterEvidence: {
          windowless: true,
          graphicsApi: 'metal',
          gpuExecutionReported: true,
          pixelVisualInspectionPerformed: false,
        },
      },
    });

    await writeFile(profilePath, '{"renderer":{"gpu_frame_ns":9999}}\n');
    await rm(normalizedPath);
    await expect(normalizeGenomeHemeraCapture({
      harnessRunPath: harnessRun,
      outputPath: nativeParent,
      runId: 'run_1_fixture',
      adapterId: 'genome-game',
      scenarioId: 'trident-bay-diagnostic-shot',
    })).rejects.toThrow(/sealed artifact bytes/i);
  });

  it('ships a dry-run-first Genome adapter installer and never overwrites a different manifest', async () => {
    const root = await temporaryRoot();
    const project = path.join(root, 'genome');
    await mkdir(project);
    const templates = await listAdapterTemplates();
    expect(templates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'genome-game', adapterId: 'genome-game' }),
    ]));
    const dryRun = await installAdapterTemplate({ templateId: 'genome-game', projectRoot: project, confirm: false });
    expect(dryRun).toMatchObject({ dryRun: true, reused: false });
    await expect(access(path.join(project, '.game-dev'))).rejects.toMatchObject({ code: 'ENOENT' });
    const installed = await installAdapterTemplate({ templateId: 'genome-game', projectRoot: project, confirm: true });
    expect(installed).toMatchObject({ dryRun: false, reused: false });
    expect((await loadAdapter(project)).manifest.scenarios).toHaveLength(4);
    const reused = await installAdapterTemplate({ templateId: 'genome-game', projectRoot: project, confirm: true });
    expect(reused).toMatchObject({ reused: true });
    await writeFile(path.join(project, '.game-dev', 'adapter.json'), '{}\n');
    await expect(installAdapterTemplate({ templateId: 'genome-game', projectRoot: project, confirm: true })).rejects.toThrow(/refusing to overwrite/i);
  });
});
