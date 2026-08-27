import * as fs from 'node:fs/promises';
import path from 'node:path';
import { decodeImage } from '../inspection/image.js';
import { canonicalJson } from '../packages/format.js';
import { sha256 } from '../storage/filesystem.js';
import { invalidInput, invalidState } from '../util/errors.js';
import {
  GAME_DEV_CAPTURE_SCHEMA,
  captureManifestSchema,
  type CaptureManifest,
} from './contracts.js';

const MAX_JSON_BYTES = 64 * 1024 * 1024;

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function regularFileInside(root: string, target: string, description: string): Promise<string> {
  const candidate = path.resolve(root, target);
  // Relative artifact paths must be lexically contained before touching the
  // filesystem. Absolute paths from a trusted native report may use an OS
  // alias such as macOS /var -> /private/var, so their identity is checked
  // after realpath instead of rejecting the spelling here.
  if (!path.isAbsolute(target) && !isInside(root, candidate)) {
    throw invalidInput(`${description} escapes the run directory`, { path: candidate });
  }
  const stats = await fs.lstat(candidate).catch(() => undefined);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
    throw invalidState(`${description} must be an existing non-symlink regular file`, { path: candidate });
  }
  const resolved = await fs.realpath(candidate);
  if (!isInside(root, resolved)) throw invalidInput(`${description} resolves outside the run directory`, { path: resolved });
  return resolved;
}

async function readJson(root: string, target: string, description: string): Promise<{ path: string; bytes: Buffer; value: unknown }> {
  const filePath = await regularFileInside(root, target, description);
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_JSON_BYTES) throw invalidInput(`${description} exceeds the JSON size ceiling`, { bytes: stats.size });
  const bytes = await fs.readFile(filePath);
  try {
    return { path: filePath, bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    throw invalidInput(`${description} is not valid UTF-8 JSON`, {
      path: filePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function schemaIssues(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  return error.issues.slice(0, 12).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

export interface CaptureValidation {
  manifestPath: string;
  manifest: CaptureManifest;
  rasterBytesDecoded: boolean;
  validatedFiles: string[];
}

export async function validateCaptureManifest(
  runPathInput: string,
  manifestPathInput: string,
  expected?: { runId?: string; adapterId?: string; scenarioId?: string },
): Promise<CaptureValidation> {
  const runPath = await fs.realpath(runPathInput);
  const document = await readJson(runPath, manifestPathInput, 'capture manifest');
  const parsed = captureManifestSchema.safeParse(document.value);
  if (!parsed.success) {
    throw invalidInput(`capture manifest violates ${GAME_DEV_CAPTURE_SCHEMA}: ${schemaIssues(parsed.error)}`, {
      path: document.path,
    });
  }
  const manifest = parsed.data;
  if (expected?.runId !== undefined && manifest.runId !== expected.runId) {
    throw invalidState('capture manifest run identity does not match the harness run', {
      expected: expected.runId,
      actual: manifest.runId,
    });
  }
  if (expected?.adapterId !== undefined && manifest.adapterId !== expected.adapterId) {
    throw invalidState('capture manifest adapter identity does not match the run plan');
  }
  if (expected?.scenarioId !== undefined && manifest.scenarioId !== expected.scenarioId) {
    throw invalidState('capture manifest scenario identity does not match the run plan');
  }

  let rasterBytesDecoded = false;
  const validated = new Set<string>([document.path]);
  for (const frame of manifest.frames) {
    for (const attachment of frame.attachments) {
      const artifact = await regularFileInside(runPath, attachment.path, `frame ${frame.index} ${attachment.kind} attachment`);
      validated.add(artifact);
      if (attachment.encoding === 'png') {
        const image = decodeImage(await fs.readFile(artifact));
        if (image.width < 1 || image.height < 1) throw invalidState('decoded capture raster has an empty extent');
        rasterBytesDecoded = true;
      }
    }
  }
  for (const telemetry of manifest.telemetry) {
    validated.add(await regularFileInside(runPath, telemetry, 'telemetry artifact'));
  }
  for (const profile of manifest.profiles) {
    validated.add(await regularFileInside(runPath, profile, 'profile artifact'));
  }
  return {
    manifestPath: document.path,
    manifest,
    rasterBytesDecoded,
    validatedFiles: [...validated].sort(),
  };
}

function digestMatches(actual: string, expected: unknown): boolean {
  if (typeof expected !== 'string') return false;
  return expected.replace(/^sha256:/, '').toLowerCase() === actual;
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidInput(`${description} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, description: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) throw invalidInput(`${description}.${key} must be a non-empty string`);
  return field;
}

async function locateGenomeRun(outputPath: string): Promise<string> {
  const output = await fs.realpath(outputPath).catch(() => {
    throw invalidState('Genome capture output directory does not exist', { outputPath });
  });
  const directReport = path.join(output, 'renderer_acceptance_matrix.runtime.json');
  if (await fs.lstat(directReport).then((stats) => stats.isFile()).catch(() => false)) return output;
  const entries = await fs.readdir(output, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory() && /^run_\d{8}T\d{6}Z_\d+$/.test(entry.name));
  if (candidates.length !== 1) {
    throw invalidState('Genome adapter must produce exactly one fresh native run directory', {
      outputPath: output,
      candidates: candidates.map((entry) => entry.name),
    });
  }
  const candidateName = candidates[0]?.name;
  if (!candidateName) throw invalidState('Genome adapter did not produce a native run directory');
  const candidate = path.join(output, candidateName);
  const stats = await fs.lstat(candidate);
  if (stats.isSymbolicLink()) throw invalidState('Genome native run directory must not be a symlink');
  return fs.realpath(candidate);
}

/**
 * Normalize Genome's existing, stricter Hemera evidence contract. This does
 * not mint new GPU authority: source claims remain explicitly adapter-reported
 * and the source report plus closed roster are retained byte-for-byte.
 */
export async function normalizeGenomeHemeraCapture(options: {
  harnessRunPath: string;
  outputPath: string;
  runId: string;
  adapterId: string;
  scenarioId: string;
}): Promise<string> {
  const harnessRunPath = await fs.realpath(options.harnessRunPath);
  const nativeRunPath = await locateGenomeRun(options.outputPath);
  if (!isInside(harnessRunPath, nativeRunPath)) {
    throw invalidInput('Genome native capture output is outside the harness run directory', { nativeRunPath });
  }

  const reportDocument = await readJson(nativeRunPath, 'renderer_acceptance_matrix.runtime.json', 'Genome final capture report');
  const report = record(reportDocument.value, 'Genome final capture report');
  const reportedRunDirectory = stringField(report, 'run_directory', 'Genome final capture report');
  if (!path.isAbsolute(reportedRunDirectory)) {
    throw invalidState('Genome final capture report has a non-absolute run_directory');
  }
  let reportedRunIdentity: string;
  try {
    reportedRunIdentity = await fs.realpath(reportedRunDirectory);
  } catch {
    throw invalidState('Genome final capture report run_directory cannot be resolved');
  }
  if (reportedRunIdentity !== nativeRunPath) {
    throw invalidState('Genome final capture report has an inadmissible run_directory', {
      expected: nativeRunPath,
      actual: reportedRunDirectory,
    });
  }
  const exactFields: Array<[string, unknown]> = [
    ['schema', 'evo.renderer_acceptance_capture_run.v1'],
    ['windowless', true],
    ['backend', 'metal'],
    ['render_mode', 'raster'],
    ['all_shots_passed', true],
  ];
  for (const [key, expected] of exactFields) {
    if (report[key] !== expected) {
      throw invalidState(`Genome final capture report has an inadmissible ${key}`, {
        expected,
        actual: report[key],
      });
    }
  }

  const rosterPathRaw = stringField(report, 'capture_evidence_roster_artifact', 'Genome final capture report');
  const rosterPath = await regularFileInside(nativeRunPath, rosterPathRaw, 'Genome evidence roster');
  if (!digestMatches(sha256(await fs.readFile(rosterPath)), report.capture_evidence_roster_artifact_hash)) {
    throw invalidState('Genome evidence roster hash does not match the final report');
  }
  const rosterDocument = await readJson(nativeRunPath, rosterPath, 'Genome evidence roster');
  const roster = record(rosterDocument.value, 'Genome evidence roster');
  if (roster.schema !== 'evo.capture_evidence_roster.v1' || !Array.isArray(roster.files)) {
    throw invalidState('Genome evidence roster schema or file list is invalid');
  }
  if (roster.file_count !== roster.files.length || report.capture_evidence_file_count !== roster.files.length) {
    throw invalidState('Genome evidence roster count does not join the final report');
  }

  const sealed = new Map<string, { sha256: string; bytes: number }>();
  const identities = new Set<string>();
  for (const [index, raw] of roster.files.entries()) {
    const seal = record(raw, `Genome evidence seal ${index}`);
    const sealedPath = await regularFileInside(nativeRunPath, stringField(seal, 'path', `Genome evidence seal ${index}`), `Genome evidence seal ${index}`);
    if (sealed.has(sealedPath)) throw invalidState('Genome evidence roster repeats a file path', { path: sealedPath });
    const stats = await fs.stat(sealedPath);
    const identity = `${stats.dev}:${stats.ino}`;
    if (identities.has(identity)) throw invalidState('Genome evidence roster aliases one inode through multiple paths');
    identities.add(identity);
    const bytes = await fs.readFile(sealedPath);
    const digest = sha256(bytes);
    if (!digestMatches(digest, seal.sha256) || seal.size_bytes !== bytes.length) {
      throw invalidState('Genome sealed artifact bytes do not match the evidence roster', { path: sealedPath });
    }
    sealed.set(sealedPath, { sha256: digest, bytes: bytes.length });
  }

  const shots = report.shots;
  if (!Array.isArray(shots) || shots.length === 0 || report.shot_count !== shots.length) {
    throw invalidState('Genome final capture report has an invalid shot roster');
  }
  const frames: CaptureManifest['frames'] = [];
  const profiles = new Set<string>();
  const telemetry = new Set<string>();
  for (const [index, rawShot] of shots.entries()) {
    const shot = record(rawShot, `Genome shot ${index}`);
    if (shot.passed !== true || shot.order !== index) throw invalidState(`Genome shot ${index} is not a passed ordered shot`);
    const artifacts = record(shot.artifacts, `Genome shot ${index} artifacts`);
    const png = await regularFileInside(nativeRunPath, stringField(artifacts, 'png', `Genome shot ${index} artifacts`), `Genome shot ${index} PNG`);
    const pngSeal = sealed.get(png);
    if (!pngSeal || !digestMatches(pngSeal.sha256, artifacts.png_hash)) {
      throw invalidState(`Genome shot ${index} PNG is not joined to the sealed roster`);
    }
    const relativePng = path.relative(harnessRunPath, png).split(path.sep).join('/');
    const slug = typeof shot.slug === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(shot.slug)
      ? shot.slug
      : `shot-${index}`;
    frames.push({
      index,
      label: slug,
      attachments: [{ kind: 'color', path: relativePng, encoding: 'png' }],
    });
    for (const key of ['profile', 'sidecar']) {
      const rawPath = artifacts[key];
      if (typeof rawPath !== 'string') continue;
      const profile = await regularFileInside(nativeRunPath, rawPath, `Genome shot ${index} ${key}`);
      if (!sealed.has(profile)) throw invalidState(`Genome shot ${index} ${key} is not sealed`);
      profiles.add(path.relative(harnessRunPath, profile).split(path.sep).join('/'));
    }
  }

  for (const sealedPath of sealed.keys()) {
    if (/\.jsonl$/i.test(sealedPath) && /telemetry/i.test(path.basename(sealedPath))) {
      telemetry.add(path.relative(harnessRunPath, sealedPath).split(path.sep).join('/'));
    }
  }
  profiles.add(path.relative(harnessRunPath, reportDocument.path).split(path.sep).join('/'));

  const proofBoundaries = Array.isArray(report.proof_boundaries)
    ? report.proof_boundaries.filter((value): value is string => typeof value === 'string').slice(0, 60)
    : [];
  const normalized: CaptureManifest = captureManifestSchema.parse({
    schema: GAME_DEV_CAPTURE_SCHEMA,
    runId: options.runId,
    adapterId: options.adapterId,
    scenarioId: options.scenarioId,
    sourceFormat: 'genome-hemera-v1',
    frames,
    telemetry: [...telemetry].sort(),
    profiles: [...profiles].sort(),
    adapterEvidence: {
      windowless: true,
      graphicsApi: 'metal',
      gpuExecutionReported: true,
      gpuCompletionIdentityReported: true,
      hardwarePerformanceReported: false,
      pixelVisualInspectionPerformed: false,
      notes: [
        'Normalized from Genome evo.renderer_acceptance_capture_run.v1 after re-hashing its declared evidence roster.',
        ...proofBoundaries,
      ],
    },
  });
  const normalizedPath = path.join(harnessRunPath, 'capture.normalized.json');
  await fs.writeFile(normalizedPath, canonicalJson(normalized), { flag: 'wx', mode: 0o600 });
  return normalizedPath;
}
