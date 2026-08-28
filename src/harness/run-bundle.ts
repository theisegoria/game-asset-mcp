import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { canonicalJson } from '../packages/format.js';
import { sha256 } from '../storage/filesystem.js';
import { describeError, invalidInput, invalidState, notFound } from '../util/errors.js';
import { redact } from '../util/logging.js';
import { registerOwnedProcessTerminator, type OwnedProcessSignal } from '../util/process-lifecycle.js';
import type { LoadedAdapter, ScenarioRunPlan } from './adapter.js';
import { serializableAdapterSnapshot } from './adapter.js';
import { normalizeGenomeHemeraCapture, validateCaptureManifest, type CaptureValidation } from './capture.js';
import {
  GAME_DEV_RUN_SCHEMA,
  runManifestSchema,
  type RunArtifact,
  type RunManifest,
} from './contracts.js';

const OUTPUT_LIMIT = 16 * 1024 * 1024;
const FILE_COUNT_LIMIT = 20_000;

function portableRelative(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidState('artifact path is not a child of its run directory', { root, target });
  }
  return relative.split(path.sep).join('/');
}

async function writeCanonicalExclusive(target: string, value: unknown): Promise<void> {
  const handle = await fs.open(target, 'wx', 0o600);
  try {
    await handle.writeFile(canonicalJson(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface OutputCollector {
  result: Promise<{ bytes: Buffer; truncated: boolean }>;
  stop(): void;
}

function collectOutput(stream: Readable | null): OutputCollector {
  if (!stream) {
    return {
      result: Promise.resolve({ bytes: Buffer.alloc(0), truncated: false }),
      stop() {},
    };
  }
  const chunks: Buffer[] = [];
  let retained = 0;
  let truncated = false;
  let settled = false;
  let finish: () => void = () => {};
  const result = new Promise<{ bytes: Buffer; truncated: boolean }>((resolve) => {
    finish = () => {
      if (settled) return;
      settled = true;
      resolve({ bytes: Buffer.concat(chunks), truncated });
    };
    stream.on('data', (raw: Buffer | Uint8Array) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const available = Math.max(0, OUTPUT_LIMIT - retained);
      if (available > 0) {
        const slice = chunk.length <= available ? chunk : chunk.subarray(0, available);
        chunks.push(slice);
        retained += slice.length;
      }
      if (chunk.length > available) truncated = true;
    });
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
  });
  return {
    result,
    stop() {
      stream.destroy();
      finish();
    },
  };
}

interface ProcessOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  spawnError?: Error;
}

function safeChildEnvironment(plan: ScenarioRunPlan): NodeJS.ProcessEnv {
  const inheritedNames = [
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DEVELOPER_DIR', 'SDKROOT',
    'TERM',
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.GAME_DEV_RUN_ID = plan.runId;
  environment.GAME_DEV_RUN_DIR = plan.runPath;
  environment.GAME_DEV_ADAPTER_ID = plan.adapterId;
  environment.GAME_DEV_SCENARIO_ID = plan.scenarioId;
  return environment;
}

async function runProcess(plan: ScenarioRunPlan, signal?: AbortSignal): Promise<ProcessOutcome> {
  let child;
  try {
    child = spawn(plan.executable, plan.arguments, {
      cwd: plan.workingDirectory,
      env: safeChildEnvironment(plan),
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutTruncated: false,
      stderrTruncated: false,
      spawnError: error instanceof Error ? error : new Error(String(error)),
    };
  }

  const stdoutCollector = collectOutput(child.stdout);
  const stderrCollector = collectOutput(child.stderr);
  let timedOut = false;
  let cancelled = false;
  let forceTimer: NodeJS.Timeout | undefined;
  const signalTree = (ownedSignal: OwnedProcessSignal): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, ownedSignal);
    } catch {
      try {
        child.kill(ownedSignal);
      } catch {
        // The process group is already gone.
      }
    }
  };
  const scheduleForceKill = (): void => {
    if (forceTimer) return;
    forceTimer = setTimeout(() => signalTree('SIGKILL'), 2_000);
    forceTimer.unref();
  };
  const requestStop = (): void => {
    signalTree('SIGTERM');
    scheduleForceKill();
  };
  const unregisterOwnedProcess = registerOwnedProcessTerminator(signalTree);
  const onAbort = (): void => {
    cancelled = true;
    requestStop();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    requestStop();
  }, plan.timeoutSeconds * 1_000);
  timeout.unref();

  const completion = await new Promise<{ exitCode: number | null; signal: string | null; error?: Error }>((resolve) => {
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, signal: null, error });
    });
    child.once('exit', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal });
    });
  });
  clearTimeout(timeout);
  // The direct group leader can exit while one of its descendants ignores
  // SIGTERM.  Once cancellation or timeout has been requested, the group must
  // receive the bounded escalation before we unregister its owner; otherwise a
  // surviving descendant would outlive a result that says the run stopped.
  if (cancelled || timedOut) signalTree('SIGKILL');
  if (forceTimer) clearTimeout(forceTimer);
  signal?.removeEventListener('abort', onAbort);
  unregisterOwnedProcess();
  const drainTimer = setTimeout(() => {
    stdoutCollector.stop();
    stderrCollector.stop();
  }, 100);
  const [stdout, stderr] = await Promise.all([stdoutCollector.result, stderrCollector.result]);
  clearTimeout(drainTimer);
  return {
    exitCode: completion.exitCode,
    signal: completion.signal,
    timedOut,
    cancelled,
    stdout: stdout.bytes,
    stderr: stderr.bytes,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    ...(completion.error ? { spawnError: completion.error } : {}),
  };
}

async function walkFiles(root: string, directory = root, files: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    const stats = await fs.lstat(candidate);
    if (stats.isSymbolicLink()) throw invalidState('run bundles may not contain symbolic links', { path: candidate });
    if (stats.isDirectory()) {
      await walkFiles(root, candidate, files);
      continue;
    }
    if (!stats.isFile()) throw invalidState('run bundles may contain only directories and regular files', { path: candidate });
    files.push(candidate);
    if (files.length > FILE_COUNT_LIMIT) throw invalidState('run bundle exceeds the artifact count ceiling');
  }
  return files;
}

async function removeUnsafeEntries(root: string, directory = root, rejected: Array<Record<string, unknown>> = []): Promise<Array<Record<string, unknown>>> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    const stats = await fs.lstat(candidate);
    if (stats.isSymbolicLink()) {
      rejected.push({
        path: portableRelative(root, candidate),
        type: 'symbolic_link',
        target: await fs.readlink(candidate).catch(() => '[unreadable]'),
      });
      await fs.rm(candidate, { force: true });
      continue;
    }
    if (stats.isDirectory()) {
      await removeUnsafeEntries(root, candidate, rejected);
      continue;
    }
    if (!stats.isFile()) {
      rejected.push({ path: portableRelative(root, candidate), type: 'special_file' });
      await fs.rm(candidate, { force: true });
    }
  }
  return rejected;
}

function artifactKinds(runPath: string, capture?: CaptureValidation): Map<string, RunArtifact['kind']> {
  const kinds = new Map<string, RunArtifact['kind']>([
    [path.join(runPath, 'adapter.json'), 'adapter'],
    [path.join(runPath, 'request.json'), 'request'],
    [path.join(runPath, 'plan.json'), 'plan'],
    [path.join(runPath, 'stdout.log'), 'stdout'],
    [path.join(runPath, 'stderr.log'), 'stderr'],
  ]);
  if (!capture) return kinds;
  kinds.set(capture.manifestPath, 'capture_manifest');
  for (const frame of capture.manifest.frames) {
    for (const attachment of frame.attachments) {
      const target = path.resolve(runPath, attachment.path);
      kinds.set(
        target,
        attachment.kind === 'color'
          ? 'capture_color'
          : attachment.kind === 'depth'
            ? 'capture_depth'
            : 'capture_semantic',
      );
    }
  }
  for (const target of capture.manifest.telemetry) kinds.set(path.resolve(runPath, target), 'telemetry');
  for (const target of capture.manifest.profiles) kinds.set(path.resolve(runPath, target), 'profile');
  return kinds;
}

async function roster(runPath: string, capture?: CaptureValidation): Promise<RunArtifact[]> {
  const kinds = artifactKinds(runPath, capture);
  const files = await walkFiles(runPath);
  const artifacts: RunArtifact[] = [];
  for (const file of files) {
    const bytes = await fs.readFile(file);
    const relative = portableRelative(runPath, file);
    artifacts.push({
      path: relative,
      kind: kinds.get(file) ?? (relative.startsWith('native/') ? 'native_evidence' : 'other'),
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

export interface RunExecutionResult {
  runPath: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: RunManifest;
}

export async function executeScenarioRun(options: {
  adapter: LoadedAdapter;
  plan: ScenarioRunPlan;
  request?: Record<string, unknown>;
  confirm: boolean;
  allowGpu: boolean;
  allowPerformance: boolean;
  signal?: AbortSignal;
}): Promise<RunExecutionResult> {
  if (!options.confirm) throw invalidInput('scenario execution requires explicit confirmation');
  if (options.plan.requiredAuthorizations.includes('gpu') && !options.allowGpu) {
    throw invalidInput('this scenario requires separate explicit GPU authorization');
  }
  if (options.plan.requiredAuthorizations.includes('performance') && !options.allowPerformance) {
    throw invalidInput('this scenario requires separate hardware-performance authorization');
  }
  if (options.plan.adapterManifestSha256 !== options.adapter.manifestSha256) {
    throw invalidState('scenario plan no longer matches the loaded adapter manifest');
  }

  await fs.mkdir(path.dirname(options.plan.runPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(options.plan.runPath, { mode: 0o700 });
  const runStats = await fs.lstat(options.plan.runPath);
  if (!runStats.isDirectory() || runStats.isSymbolicLink()) {
    throw invalidState('created run path is not a real directory');
  }
  const runPath = await fs.realpath(options.plan.runPath);
  const expectedRunPath = path.join(
    await fs.realpath(path.dirname(options.plan.runPath)),
    path.basename(options.plan.runPath),
  );
  if (runPath !== expectedRunPath) throw invalidState('created run directory identity changed unexpectedly');
  await writeCanonicalExclusive(path.join(runPath, 'adapter.json'), serializableAdapterSnapshot(options.adapter));
  await writeCanonicalExclusive(path.join(runPath, 'request.json'), redact(options.request ?? {}));
  await writeCanonicalExclusive(path.join(runPath, 'plan.json'), options.plan);

  const startedAt = new Date();
  const started = performance.now();
  const outcome = await runProcess(options.plan, options.signal);
  await fs.writeFile(path.join(runPath, 'stdout.log'), outcome.stdout, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(runPath, 'stderr.log'), outcome.stderr, { flag: 'wx', mode: 0o600 });

  let status: RunManifest['status'] = outcome.cancelled
    ? 'failed'
    : outcome.timedOut
      ? 'timed_out'
    : outcome.exitCode === 0 && outcome.spawnError === undefined
      ? 'completed'
      : 'failed';
  let failure: RunManifest['failure'];
  if (outcome.spawnError) failure = { code: 'SPAWN_FAILED', message: outcome.spawnError.message };
  else if (outcome.cancelled) failure = { code: 'CANCELLED', message: 'scenario execution was cancelled' };
  else if (outcome.timedOut) failure = { code: 'TIMEOUT', message: `scenario exceeded ${options.plan.timeoutSeconds} seconds` };
  else if (outcome.exitCode !== 0) {
    failure = {
      code: 'PROCESS_FAILED',
      message: `scenario process exited ${String(outcome.exitCode)}${outcome.signal ? ` (${outcome.signal})` : ''}`,
    };
  }

  let capture: CaptureValidation | undefined;
  if (status === 'completed' && options.plan.output.format !== 'none') {
    try {
      if (!options.plan.output.path) throw invalidState('capture scenario plan has no output path');
      const manifestPath = options.plan.output.format === 'genome-hemera-v1'
        ? await normalizeGenomeHemeraCapture({
          harnessRunPath: runPath,
          outputPath: options.plan.output.path,
          runId: options.plan.runId,
          adapterId: options.plan.adapterId,
          scenarioId: options.plan.scenarioId,
        })
        : options.plan.output.path;
      capture = await validateCaptureManifest(runPath, manifestPath, {
        runId: options.plan.runId,
        adapterId: options.plan.adapterId,
        scenarioId: options.plan.scenarioId,
      });
    } catch (error) {
      const described = describeError(error);
      status = 'failed';
      failure = {
        code: typeof described.error === 'string' ? described.error : 'CAPTURE_INVALID',
        message: typeof described.message === 'string' ? described.message : String(error),
      };
    }
  }

  const rejectedEntries = await removeUnsafeEntries(runPath);
  if (rejectedEntries.length > 0) {
    status = 'failed';
    failure ??= {
      code: 'UNSAFE_ARTIFACT',
      message: 'scenario emitted symbolic links or special files; they were recorded and removed before sealing',
    };
    await writeCanonicalExclusive(path.join(runPath, 'rejected-artifacts.json'), {
      schema: 'game_dev.rejected_artifacts.v1',
      artifacts: rejectedEntries,
    });
    capture = undefined;
  }
  const artifacts = await roster(runPath, capture);
  const completedAt = new Date();
  const adapterEvidence = capture?.manifest.adapterEvidence;
  const performanceAdmitted = Boolean(
    options.allowPerformance &&
    adapterEvidence?.hardwarePerformanceReported &&
    (capture?.manifest.measurements.length ?? 0) > 0,
  );
  const manifest = runManifestSchema.parse({
    schema: GAME_DEV_RUN_SCHEMA,
    runId: options.plan.runId,
    adapterId: options.plan.adapterId,
    adapterVersion: options.plan.adapterVersion,
    adapterManifestSha256: options.plan.adapterManifestSha256,
    scenarioId: options.plan.scenarioId,
    projectRoot: options.plan.projectRoot,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    status,
    process: {
      executable: options.plan.executable,
      arguments: options.plan.arguments,
      workingDirectory: options.plan.workingDirectory,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdoutTruncated: outcome.stdoutTruncated,
      stderrTruncated: outcome.stderrTruncated,
    },
    ...(failure ? { failure } : {}),
    ...(capture ? { captureManifest: portableRelative(runPath, capture.manifestPath) } : {}),
    artifacts,
    evidence: {
      commandExecuted: outcome.spawnError === undefined,
      processExitedSuccessfully: outcome.exitCode === 0 && !outcome.timedOut,
      artifactRosterClosedAndHashed: true,
      captureContractValidated: capture !== undefined,
      rasterBytesDecoded: capture?.rasterBytesDecoded ?? false,
      adapterReportedGpuExecution: adapterEvidence?.gpuExecutionReported ?? false,
      adapterReportedGpuCompletionIdentity: adapterEvidence?.gpuCompletionIdentityReported ?? false,
      adapterReportedHardwarePerformance: adapterEvidence?.hardwarePerformanceReported ?? false,
      hardwareGpuExecutionProvenByHarnessAlone: false,
      hardwarePerformanceEvidenceAdmitted: performanceAdmitted,
      hardwarePerformanceMeasuredByHarnessAlone: false,
      humanVisualReviewPerformed: false,
      evidenceCeiling:
        'The harness proves process status, schema validation, decoded raster bytes, and a closed SHA-256 artifact roster. GPU completion and hardware timing remain source-adapter claims unless separately joined to native evidence; no human visual review is inferred.',
    },
  });
  const manifestPath = path.join(runPath, 'run.json');
  await writeCanonicalExclusive(manifestPath, manifest);
  return { runPath, manifestPath, manifestSha256: sha256(Buffer.from(canonicalJson(manifest))), manifest };
}

export async function resolveRunPath(runsRoot: string, reference: string): Promise<string> {
  const candidate = /^run_[a-z0-9_]+$/.test(reference) && !reference.includes(path.sep)
    ? path.join(path.resolve(runsRoot), reference)
    : path.resolve(reference);
  const resolved = await fs.realpath(candidate).catch(() => {
    throw notFound('run bundle', reference);
  });
  if (!(await fs.stat(resolved)).isDirectory()) throw invalidInput('run reference must identify a directory', { reference });
  return resolved;
}

export async function verifyRunBundle(runPathInput: string): Promise<RunExecutionResult> {
  const runPath = await fs.realpath(runPathInput);
  const manifestPath = path.join(runPath, 'run.json');
  const stats = await fs.lstat(manifestPath).catch(() => undefined);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) throw invalidState('run bundle has no regular run.json manifest');
  const bytes = await fs.readFile(manifestPath);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalidState('run.json is not valid UTF-8 JSON');
  }
  const parsed = runManifestSchema.safeParse(value);
  if (!parsed.success) throw invalidState(`run.json violates ${GAME_DEV_RUN_SCHEMA}`, { issues: parsed.error.issues });
  const manifest = parsed.data;
  if (canonicalJson(manifest) !== bytes.toString('utf8')) throw invalidState('run.json is not canonical JSON');
  if (path.basename(runPath) !== manifest.runId) throw invalidState('run directory name does not match run identity');

  const expected = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  if (expected.size !== manifest.artifacts.length) throw invalidState('run artifact roster contains duplicate paths');
  const actualFiles = (await walkFiles(runPath)).filter((file) => file !== manifestPath);
  const actualPaths = actualFiles.map((file) => portableRelative(runPath, file)).sort();
  const expectedPaths = [...expected.keys()].sort();
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((item, index) => item !== expectedPaths[index])) {
    throw invalidState('run artifact roster is not closed over the run directory', {
      expected: expectedPaths.length,
      actual: actualPaths.length,
    });
  }
  for (const file of actualFiles) {
    const relative = portableRelative(runPath, file);
    const artifact = expected.get(relative);
    if (!artifact) throw invalidState('unrostered run artifact', { path: relative });
    const artifactBytes = await fs.readFile(file);
    if (artifact.bytes !== artifactBytes.length || artifact.sha256 !== sha256(artifactBytes)) {
      throw invalidState('run artifact bytes no longer match their seal', { path: relative });
    }
  }
  if (manifest.captureManifest) {
    const capture = await validateCaptureManifest(runPath, manifest.captureManifest, {
      runId: manifest.runId,
      adapterId: manifest.adapterId,
      scenarioId: manifest.scenarioId,
    });
    if (capture.rasterBytesDecoded !== manifest.evidence.rasterBytesDecoded) {
      throw invalidState('run raster evidence flag does not match the validated capture');
    }
  }
  return { runPath, manifestPath, manifestSha256: sha256(bytes), manifest };
}
