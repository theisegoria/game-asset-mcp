import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../packages/format.js';
import { sha256 } from '../storage/filesystem.js';
import { invalidInput, invalidState, notFound } from '../util/errors.js';
import { redact } from '../util/logging.js';
import {
  adapterManifestSchema,
  relativePathSchema,
  type AdapterManifest,
  type AdapterParameter,
  type AdapterScenario,
} from './contracts.js';

export interface LoadedAdapter {
  projectRoot: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: AdapterManifest;
}

export interface ScenarioRunPlan {
  schema: 'game_dev.scenario_plan.v1';
  runId: string;
  runPath: string;
  adapterId: string;
  adapterVersion: string;
  adapterManifestPath: string;
  adapterManifestSha256: string;
  scenarioId: string;
  title: string;
  projectRoot: string;
  executable: string;
  arguments: string[];
  workingDirectory: string;
  timeoutSeconds: number;
  capabilities: AdapterScenario['capabilities'];
  parameters: Record<string, unknown>;
  output: {
    format: AdapterScenario['outputs']['format'];
    path?: string;
  };
  requiredAuthorizations: Array<'confirm' | 'gpu' | 'performance'>;
  evidenceCeiling: string;
}

function pathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertRegularUnsymbolic(target: string, description: string): Promise<void> {
  const stats = await fs.lstat(target).catch(() => undefined);
  if (!stats) throw invalidState(`${description} does not exist`, { path: target });
  if (stats.isSymbolicLink()) throw invalidState(`${description} must not be a symbolic link`, { path: target });
  if (!stats.isFile()) throw invalidState(`${description} must be a regular file`, { path: target });
}

function describeSchemaFailure(error: { issues?: Array<{ path: Array<string | number>; message: string }> }): string {
  const issues = error.issues ?? [];
  return issues.slice(0, 12).map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${location}: ${issue.message}`;
  }).join('; ');
}

export async function loadAdapter(projectRootInput: string, manifestInput?: string): Promise<LoadedAdapter> {
  const projectRoot = await fs.realpath(path.resolve(projectRootInput)).catch(() => {
    throw invalidInput('adapter project root does not exist', { projectRoot: path.resolve(projectRootInput) });
  });
  const projectStats = await fs.lstat(projectRoot);
  if (!projectStats.isDirectory()) throw invalidInput('adapter project root must be a directory', { projectRoot });

  const manifestCandidate = manifestInput
    ? path.resolve(projectRoot, manifestInput)
    : path.join(projectRoot, '.game-dev', 'adapter.json');
  if (!pathInside(projectRoot, manifestCandidate)) {
    throw invalidInput('adapter manifest path escapes the project root', { projectRoot, manifestPath: manifestCandidate });
  }
  await assertRegularUnsymbolic(manifestCandidate, 'adapter manifest');
  const manifestPath = await fs.realpath(manifestCandidate);
  if (!pathInside(projectRoot, manifestPath)) {
    throw invalidInput('resolved adapter manifest escapes the project root', { projectRoot, manifestPath });
  }

  const bytes = await fs.readFile(manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw invalidInput('adapter manifest is not valid UTF-8 JSON', {
      manifestPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const result = adapterManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw invalidInput(`adapter manifest violates game_dev.adapter.v1: ${describeSchemaFailure(result.error)}`, {
      manifestPath,
    });
  }
  return {
    projectRoot,
    manifestPath,
    manifestSha256: sha256(bytes),
    manifest: result.data,
  };
}

function parameterValue(
  name: string,
  definition: AdapterParameter,
  provided: unknown,
  projectRoot: string,
): Promise<string | number> | string | number {
  const value = provided ?? definition.default;
  if (value === undefined) {
    if (definition.required) throw invalidInput(`scenario parameter ${name} is required`, { parameter: name });
    return '';
  }

  switch (definition.type) {
    case 'string': {
      if (typeof value !== 'string') throw invalidInput(`scenario parameter ${name} must be a string`);
      if (value.length > 4096 || value.includes('\0')) {
        throw invalidInput(`scenario parameter ${name} is too long or contains NUL`);
      }
      if (definition.pattern !== undefined) {
        let expression: RegExp;
        try {
          expression = new RegExp(definition.pattern, 'u');
        } catch {
          throw invalidInput(`scenario parameter ${name} declares an invalid pattern`);
        }
        if (!expression.test(value)) throw invalidInput(`scenario parameter ${name} does not match its pattern`);
      }
      return value;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw invalidInput(`scenario parameter ${name} must be a safe integer`);
      }
      if (definition.minimum !== undefined && value < definition.minimum) {
        throw invalidInput(`scenario parameter ${name} is below its minimum`, { minimum: definition.minimum });
      }
      if (definition.maximum !== undefined && value > definition.maximum) {
        throw invalidInput(`scenario parameter ${name} exceeds its maximum`, { maximum: definition.maximum });
      }
      return value;
    }
    case 'enum': {
      if (typeof value !== 'string' || !definition.values.includes(value)) {
        throw invalidInput(`scenario parameter ${name} must be one of its declared values`, {
          values: definition.values,
        });
      }
      return value;
    }
    case 'project_path': {
      if (typeof value !== 'string') throw invalidInput(`scenario parameter ${name} must be a project-relative path`);
      const parsed = relativePathSchema.safeParse(value);
      if (!parsed.success) throw invalidInput(`scenario parameter ${name} is not a safe project-relative path`);
      const candidate = path.resolve(projectRoot, value);
      if (!pathInside(projectRoot, candidate)) throw invalidInput(`scenario parameter ${name} escapes the project root`);
      return (async () => {
        if (!definition.mustExist) return candidate;
        const stats = await fs.lstat(candidate).catch(() => undefined);
        if (!stats || stats.isSymbolicLink()) {
          throw invalidInput(`scenario parameter ${name} must identify an existing non-symlink path`, { path: candidate });
        }
        const resolved = await fs.realpath(candidate);
        if (!pathInside(projectRoot, resolved)) throw invalidInput(`scenario parameter ${name} resolves outside the project`);
        if (definition.kind === 'file' && !stats.isFile()) {
          throw invalidInput(`scenario parameter ${name} must identify a regular file`, { path: resolved });
        }
        if (definition.kind === 'directory' && !stats.isDirectory()) {
          throw invalidInput(`scenario parameter ${name} must identify a directory`, { path: resolved });
        }
        return resolved;
      })();
    }
  }
  throw invalidState(`unsupported scenario parameter type for ${name}`);
}

function substitute(template: string, values: Record<string, string>, fixed: Record<string, string>): string {
  return template.replace(/\{(run_dir|run_id|project_root|param\.([A-Za-z][A-Za-z0-9_]*))\}/g, (_all, key: string, parameter?: string) => {
    if (parameter !== undefined) return values[parameter] ?? '';
    return fixed[key] ?? '';
  });
}

export function newRunId(now = Date.now()): string {
  return `run_${now}_${randomUUID().replaceAll('-', '')}`;
}

export async function planScenarioRun(options: {
  adapter: LoadedAdapter;
  scenarioId: string;
  runsRoot: string;
  parameters?: Record<string, unknown>;
  runId?: string;
}): Promise<ScenarioRunPlan> {
  const scenario = options.adapter.manifest.scenarios.find((candidate) => candidate.id === options.scenarioId);
  if (!scenario) throw notFound('adapter scenario', options.scenarioId);

  const provided = options.parameters ?? {};
  const unknown = Object.keys(provided).filter((name) => scenario.parameters[name] === undefined);
  if (unknown.length > 0) throw invalidInput('scenario request contains undeclared parameters', { unknown });

  const normalized: Record<string, string | number> = {};
  for (const [name, definition] of Object.entries(scenario.parameters)) {
    normalized[name] = await parameterValue(name, definition, provided[name], options.adapter.projectRoot);
  }
  const substitutions = Object.fromEntries(
    Object.entries(normalized).map(([name, value]) => [name, String(value)]),
  );
  const runId = options.runId ?? newRunId();
  const runsRoot = path.resolve(options.runsRoot);
  const runPath = path.join(runsRoot, runId);
  if (!pathInside(runsRoot, runPath)) throw invalidState('generated run path escaped the runs root');
  const fixed = { run_dir: runPath, run_id: runId, project_root: options.adapter.projectRoot };

  const executableCandidate = path.resolve(
    options.adapter.projectRoot,
    substitute(scenario.command.executable, substitutions, fixed),
  );
  if (!pathInside(options.adapter.projectRoot, executableCandidate)) {
    throw invalidInput('scenario executable escapes the project root', { executable: executableCandidate });
  }
  await assertRegularUnsymbolic(executableCandidate, 'scenario executable');
  const executable = await fs.realpath(executableCandidate);
  if (!pathInside(options.adapter.projectRoot, executable)) {
    throw invalidInput('scenario executable resolves outside the project root', { executable });
  }
  const executableStats = await fs.stat(executable);
  if ((executableStats.mode & 0o111) === 0) {
    throw invalidInput('scenario executable is not executable', { executable });
  }

  const workingCandidate = path.resolve(options.adapter.projectRoot, scenario.command.workingDirectory);
  if (!pathInside(options.adapter.projectRoot, workingCandidate)) {
    throw invalidInput('scenario working directory escapes the project root');
  }
  const workingDirectory = await fs.realpath(workingCandidate).catch(() => {
    throw invalidInput('scenario working directory does not exist', { workingDirectory: workingCandidate });
  });
  if (!pathInside(options.adapter.projectRoot, workingDirectory)) {
    throw invalidInput('scenario working directory resolves outside the project root');
  }
  if (!(await fs.stat(workingDirectory)).isDirectory()) {
    throw invalidInput('scenario working directory is not a directory', { workingDirectory });
  }

  const args = scenario.command.arguments.map((argument) => substitute(argument, substitutions, fixed));
  const outputTemplate = scenario.outputs.path;
  const outputPath = outputTemplate === undefined
    ? undefined
    : path.resolve(runPath, substitute(outputTemplate, substitutions, fixed));
  if (outputPath !== undefined && !pathInside(runPath, outputPath)) {
    throw invalidInput('scenario output path escapes the run directory', { outputPath });
  }

  const requiredAuthorizations: ScenarioRunPlan['requiredAuthorizations'] = ['confirm'];
  if (scenario.capabilities.includes('gpu') || scenario.capabilities.includes('metal')) {
    requiredAuthorizations.push('gpu');
  }
  if (scenario.capabilities.includes('performance')) requiredAuthorizations.push('performance');

  return {
    schema: 'game_dev.scenario_plan.v1',
    runId,
    runPath,
    adapterId: options.adapter.manifest.id,
    adapterVersion: options.adapter.manifest.version,
    adapterManifestPath: options.adapter.manifestPath,
    adapterManifestSha256: options.adapter.manifestSha256,
    scenarioId: scenario.id,
    title: scenario.title,
    projectRoot: options.adapter.projectRoot,
    executable,
    arguments: args,
    workingDirectory,
    timeoutSeconds: scenario.timeoutSeconds,
    capabilities: scenario.capabilities,
    parameters: redact(normalized) as Record<string, unknown>,
    output: {
      format: scenario.outputs.format,
      ...(outputPath ? { path: outputPath } : {}),
    },
    requiredAuthorizations,
    evidenceCeiling:
      'This plan proves only resolved local configuration. It executes nothing and proves no build, GPU, pixel, performance, signing, or human-review result.',
  };
}

export function serializableAdapterSnapshot(adapter: LoadedAdapter): Record<string, unknown> {
  return {
    manifestPath: adapter.manifestPath,
    manifestSha256: adapter.manifestSha256,
    manifest: JSON.parse(canonicalJson(adapter.manifest)),
  };
}
