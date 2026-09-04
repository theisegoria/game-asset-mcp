#!/usr/bin/env node

import path from 'node:path';
import { parseArguments, assertKnownFlags, booleanFlag, readRequest, stringFlag, type ParsedArguments } from './cli/arguments.js';
import { isDirectInvocation } from './util/entrypoint.js';
import { buildMcpConfig, isMcpClient, MCP_CLIENTS } from './mcp/config-templates.js';
import { runDoctor } from './cli/doctor.js';
import { EventStream } from './cli/events.js';
import { createGameDevRuntime, type GameDevRuntime } from './runtime.js';
import { refreshAssetJob } from './tools/jobs.js';
import { resultText, type ToolResult } from './tools/context.js';
import { describeError, invalidInput } from './util/errors.js';
import { isTerminal } from './domain/status.js';
import {
  GAME_DEV_CAPABILITIES_SCHEMA,
  GAME_DEV_NAME,
  GAME_DEV_RESULT_SCHEMA,
  GAME_DEV_VERSION,
} from './version.js';
import type { DurableArtifact, DurableJob } from './jobs/durable.js';
import { isSpendingTool } from './domain/spend.js';
import { buildAssetPackage, planAssetPackage, readAssetPackage, type AssetProvenanceInput } from './packages/format.js';
import { AssetCatalog } from './packages/catalog.js';
import { admitVendorPackage } from './packages/vendor.js';
import { executeLaunchPlan, planPackageLaunch, type LaunchApplication } from './packages/launcher.js';
import { migrateLegacyWorkspace } from './packages/migration.js';
import { generateUsdzPreview } from './packages/usdz.js';
import type { AssetCategory } from './domain/asset-spec.js';
import type { GameAssetPolicy } from './domain/asset-policy.js';
import { loadAdapter, planScenarioRun } from './harness/adapter.js';
import { executeScenarioRun, resolveRunPath, verifyRunBundle } from './harness/run-bundle.js';
import { installAdapterTemplate, listAdapterTemplates } from './harness/templates.js';
import { analyzeRunCapture, compareRunVisuals } from './harness/visual.js';
import { compareRunPerformance, summarizeRunPerformance } from './harness/performance.js';
import { createOptimizationGoal, evaluateOptimizationGoal } from './harness/goals.js';
import { installSkillBundle, listSkillBundle } from './skills/bundle.js';
import { installProcessSignalHandlers } from './util/process-lifecycle.js';

const HELP = `Game Development Studio local harness

Usage:
  game-dev capabilities [--json]
  game-dev doctor [--json]
  game-dev credentials status [--json]
  game-dev tool call <name> [--request FILE|- | --input JSON] [--json|--jsonl]
  game-dev provider tripo <generate|retexture|rig|retarget|retopologize> --request FILE
                    --approve-spend --spend-limit-cents N [--json|--jsonl]
  game-dev provider leonardo <image-generate|sound-generate> --request FILE
                    --approve-spend --spend-limit-cents N [--json|--jsonl]
  game-dev job list [--limit N] [--status STATUS] [--json]
  game-dev job show <job-id> [--detail] [--json]
  game-dev job follow <job-id> [--max-seconds N] [--jsonl]
  game-dev job resume <job-id> --confirm
                    [--approve-spend --spend-limit-cents N] [--json|--jsonl]
  game-dev job cancel <job-id> --confirm [--json]
  game-dev asset inspect <model.glb> [--json]
  game-dev asset validate <model.glb> [--request POLICY.json] [--json]
  game-dev asset normalize <model.glb> [--output PATH] [--request OPTIONS.json] [--jsonl]
  game-dev asset preview-usdz <model.glb> --output PATH [--jsonl]
  game-dev package build <model.glb> --name NAME [--version 1.0.0] [--license SPDX] [--request METADATA.json] [--dry-run]
  game-dev package show <package-id|path> [--json]
  game-dev package verify <package-id|path> [--json]
  game-dev catalog list [--query TEXT] [--category CATEGORY] [--valid|--invalid] [--json]
  game-dev catalog show <package-id> [--json]
  game-dev catalog admit <package-path> [--dry-run] [--jsonl]
  game-dev catalog rebuild --confirm [--jsonl]
  game-dev vendor admit <package-id|path> --project PATH [--destination RELATIVE] [--confirm]
  game-dev launch <package-id|path> --with finder|quicklook|blender [--confirm]
  game-dev migrate legacy --from OUTPUT_ROOT [--license SPDX] [--confirm]
  game-dev adapter templates [--json]
  game-dev adapter install <template-id> --project PATH [--confirm]
  game-dev adapter inspect --project PATH [--manifest RELATIVE] [--json]
  game-dev scenario list --project PATH [--json]
  game-dev scenario plan <scenario-id> --project PATH [--request PARAMS.json] [--json]
  game-dev scenario run <scenario-id> --project PATH [--request PARAMS.json] [--confirm]
                    [--allow-gpu] [--allow-performance] [--jsonl]
  game-dev capture verify <run-id|path> [--json]
  game-dev visual analyze <run-id|path> [--json]
  game-dev visual compare <baseline-run> <candidate-run> [--threshold 0..255]
                  [--output NEW_DIRECTORY] [--jsonl]
  game-dev performance summarize <run-id|path> [--json]
  game-dev performance compare <baseline-run> <candidate-run> [--stat median] [--json]
  game-dev performance goal-create <baseline-run> --project PATH --request GOAL.json [--confirm]
  game-dev performance goal-evaluate <goal.json> <candidate-run> [--confirm]
  game-dev skill list [--json]
  game-dev skill install <skill-id|all> [--target CODEX_SKILLS_DIR] [--confirm]

Global options:
  --output-dir PATH   Asset workspace for this invocation.
  --approve-spend     Explicitly authorize this paid provider invocation.
  --spend-limit-cents N
                      Refuse before a provider call would exceed N US cents.
  --json              Emit one game_dev.result.v1 object.
  --jsonl             Emit game_dev.event.v1 JSON Lines.
  --version           Print the helper version.
  --help              Show this help.

  game-dev mcp config --client claude-code|claude-desktop|codex|gemini|generic
                      [--spend-limit-cents N] [--json]
                      Print ready-to-paste MCP client configuration with the
                      absolute output directory already resolved. Paid tools
                      stay disabled unless a spend ceiling is supplied.

  game-dev mcp serve  Serve the same local operations over MCP on stdio, for
                      clients that cannot run a shell. Also installed as the
                      game-dev-mcp binary. stdout becomes the JSON-RPC channel,
                      so this command prints no result envelope.

Provider credentials are read lazily from the app-provided environment or the
documented development variables TRIPO_API_KEY and LEONARDO_API_KEY. Secrets
are never accepted as command-line arguments.`;

interface DispatchResult {
  operation: string;
  data: Record<string, unknown>;
  isError?: boolean;
  artifacts?: DurableArtifact[];
}

function requirePositional(parsed: ParsedArguments, index: number, label: string): string {
  const value = parsed.positionals[index];
  if (!value) throw invalidInput(`missing ${label}`);
  return value;
}

function requireFlag(parsed: ParsedArguments, name: string): string {
  const value = stringFlag(parsed, name);
  if (!value) throw invalidInput(`missing --${name}`);
  return value;
}

function positiveIntegerFlag(parsed: ParsedArguments, name: string, fallback: number): number {
  const raw = stringFlag(parsed, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw invalidInput(`--${name} must be a positive integer`);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidInput(`--${name} must be a positive integer`);
  }
  return value;
}

function optionalPositiveIntegerFlag(parsed: ParsedArguments, name: string): number | undefined {
  if (!parsed.flags.has(name)) return undefined;
  return positiveIntegerFlag(parsed, name, 1);
}

function nonNegativeIntegerFlag(parsed: ParsedArguments, name: string, fallback: number): number {
  const raw = stringFlag(parsed, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw invalidInput(`--${name} must be a non-negative integer`);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) throw invalidInput(`--${name} must be a non-negative safe integer`);
  return value;
}

function requestString(request: Record<string, unknown>, name: string): string {
  const value = request[name];
  if (typeof value !== 'string' || value.length === 0) throw invalidInput(`request.${name} must be a non-empty string`);
  return value;
}

function requestFiniteNumber(request: Record<string, unknown>, name: string): number {
  const value = request[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidInput(`request.${name} must be a finite number`);
  return value;
}

function requestStringArray(request: Record<string, unknown>, name: string): string[] {
  const value = request[name];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw invalidInput(`request.${name} must be an array of strings`);
  }
  return value;
}

function approvalRequired(tool: string, parsed: ParsedArguments): DispatchResult | undefined {
  const spendLimitCents = optionalPositiveIntegerFlag(parsed, 'spend-limit-cents');
  if (booleanFlag(parsed, 'approve-spend') && spendLimitCents !== undefined) return undefined;
  return {
    operation: `approval.${tool}`,
    isError: true,
    data: {
      error: 'APPROVAL_REQUIRED',
      message: 'Paid provider work requires an explicit per-invocation approval and spend ceiling.',
      tool,
      approval: {
        requiredFlags: ['--approve-spend', '--spend-limit-cents N'],
        estimatedOnly: true,
        note: 'The ceiling is a refusal guard based on published or pessimistic estimated prices; it is not an invoice.',
      },
    },
  };
}

function payloadFromResult(result: ToolResult): Record<string, unknown> {
  const text = resultText(result);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The raw text is retained below. A malformed local result is a structured
    // failure, not a reason for the CLI to lose all diagnostics.
  }
  return {
    error: 'INVALID_STATE',
    message: 'local command returned a non-object result',
    raw: text,
  };
}

async function callLocal(
  runtime: GameDevRuntime,
  operation: string,
  name: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const result = await runtime.registry.call(name, args);
  return {
    operation,
    data: payloadFromResult(result),
    ...(result.isError === true ? { isError: true } : {}),
  };
}

async function withCatalog<T>(
  runtime: GameDevRuntime,
  body: (catalog: AssetCatalog) => Promise<T> | T,
): Promise<T> {
  const catalog = await AssetCatalog.open(runtime.config.catalogPath);
  try {
    return await body(catalog);
  } finally {
    catalog.close();
  }
}

async function resolvePackagePath(runtime: GameDevRuntime, reference: string): Promise<string> {
  if (reference.startsWith('pkg_')) {
    return withCatalog(runtime, (catalog) => catalog.get(reference).packagePath);
  }
  return path.resolve(reference);
}

function capabilities(runtime: GameDevRuntime): Record<string, unknown> {
  return {
    schema: GAME_DEV_CAPABILITIES_SCHEMA,
    name: GAME_DEV_NAME,
    version: GAME_DEV_VERSION,
    transport: 'local-cli',
    protocols: {
      result: GAME_DEV_RESULT_SCHEMA,
      event: 'game_dev.event.v1',
    },
    providers: {
      tripo: {
        configured: runtime.config.tripoApiKey !== undefined,
        operations: ['generate', 'retexture', 'rig', 'retarget', 'retopologize'],
      },
      leonardo: {
        configured: runtime.config.leonardoApiKey !== undefined,
        operations: ['image-generate', 'sound-generate'],
      },
    },
    commandFamilies: [
      'capabilities',
      'mcp',
      'doctor',
      'credentials',
      'adapter',
      'provider',
      'job',
      'catalog',
      'asset',
      'vendor',
      'package',
      'scenario',
      'capture',
      'visual',
      'performance',
      'skill',
      'migrate',
      'launch',
      'tool',
    ],
    localOperations: runtime.registry.capabilities(),
    approval: {
      paidProviderCalls: 'caller must set an explicit spend ceiling and authorize the invocation',
      projectWrites: 'dry-run or explicit confirmation required',
      metalTrace: 'separate explicit authorization required',
      patchLoops: 'goal allowlist and bounded iterations required',
    },
    evidenceCeiling:
      'Capability discovery proves command availability only; it performs no provider, Blender, GPU, pixel, signing, notarization, or human-review work.',
  };
}

async function followJob(
  runtime: GameDevRuntime,
  jobId: string,
  parsed: ParsedArguments,
  events: EventStream,
): Promise<DispatchResult> {
  const maximumSeconds = positiveIntegerFlag(parsed, 'max-seconds', 120);
  const deadline = Date.now() + maximumSeconds * 1_000;

  if (jobId.startsWith('job_')) {
    let afterSequence = -1;
    let job = await runtime.durableJobs.get(jobId);
    const stopped = (status: DurableJob['status']): boolean =>
      ['approval_required', 'completed', 'failed', 'cancelled'].includes(status);
    while (true) {
      const persisted = await runtime.durableJobs.readEvents(jobId, { afterSequence });
      for (const event of persisted) {
        events.replay(event);
        if (typeof event.sequence === 'number') afterSequence = Math.max(afterSequence, event.sequence);
      }
      job = await runtime.durableJobs.get(jobId);
      if (stopped(job.status) || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    }
    return {
      operation: 'job.follow',
      data: {
        jobId: job.id,
        status: job.status,
        terminal: ['completed', 'failed', 'cancelled'].includes(job.status),
        waitingForApproval: job.status === 'approval_required',
        timedOut: !stopped(job.status),
        eventCount: job.eventCount,
        updatedAt: job.updatedAt,
        ...(job.receiptPath ? { receiptPath: job.receiptPath } : {}),
        ...(job.error ? { error: job.error } : {}),
      },
      ...(job.status === 'failed' ? { isError: true } : {}),
    };
  }

  let job = await runtime.context.store.get(jobId);

  while (!isTerminal(job.status) && Date.now() < deadline) {
    job = await refreshAssetJob(runtime.context, job);
    events.emit('progress', {
      assetJobId: job.id,
      status: job.status,
      ...(job.providerStatus ? { providerStatus: job.providerStatus } : {}),
      updatedAt: job.updatedAt,
    });
    if (isTerminal(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(3_000, deadline - Date.now())));
  }

  return {
    operation: 'job.follow',
    data: {
      assetJobId: job.id,
      status: job.status,
      terminal: isTerminal(job.status),
      timedOut: !isTerminal(job.status),
      updatedAt: job.updatedAt,
      ...(job.error ? { error: job.error } : {}),
    },
    ...(job.status === 'failed' ? { isError: true } : {}),
  };
}

async function dispatch(
  runtime: GameDevRuntime,
  parsed: ParsedArguments,
  events: EventStream,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  const [family, action] = parsed.positionals;

  if (family === 'capabilities') {
    return { operation: 'capabilities', data: capabilities(runtime) };
  }

  if (family === 'mcp' && action === 'config') {
    const client = stringFlag(parsed, 'client') ?? 'generic';
    if (!isMcpClient(client)) {
      throw invalidInput(`--client must be one of: ${MCP_CLIENTS.join(', ')}`);
    }
    // Generated rather than shipped as a static file, because the value that
    // has to be right is the ABSOLUTE output directory, and only this process
    // knows what it resolved to.
    const template = buildMcpConfig({
      client,
      outputDir: runtime.config.outputDir,
      spendLimitCents: optionalPositiveIntegerFlag(parsed, 'spend-limit-cents'),
    });
    return {
      operation: 'mcp.config',
      data: {
        schema: 'game_dev.mcp_config.v1',
        ...template,
        outputDir: runtime.config.outputDir,
      },
    };
  }
  if (family === 'doctor') {
    return { operation: 'doctor', data: await runDoctor(runtime) };
  }
  if (family === 'credentials' && action === 'status') {
    return {
      operation: 'credentials.status',
      data: {
        schema: 'game_dev.credentials_status.v1',
        tripo: runtime.config.tripoApiKey ? 'configured' : 'missing',
        leonardo: runtime.config.leonardoApiKey ? 'configured' : 'missing',
        values: 'redacted',
        note: 'The native app stores production credentials in Keychain. Development CLI calls may use environment variables.',
      },
    };
  }
  if (family === 'credentials') {
    throw invalidInput('credential mutation is available through the native app so secrets never enter shell history');
  }

  if (family === 'skill' && action === 'list') {
    return {
      operation: 'skill.list',
      data: await listSkillBundle() as unknown as Record<string, unknown>,
    };
  }
  if (family === 'skill' && action === 'install') {
    const result = await installSkillBundle({
      selection: requirePositional(parsed, 2, 'skill id or all'),
      ...(stringFlag(parsed, 'target') ? { targetRoot: path.resolve(requireFlag(parsed, 'target')) } : {}),
      confirm: booleanFlag(parsed, 'confirm'),
    });
    return {
      operation: 'skill.install',
      data: result,
      ...(booleanFlag(parsed, 'confirm')
        ? {
            artifacts: (result.installations as Array<{ destination: string }>).map((installation) => ({
              path: installation.destination,
              kind: 'codex_skill',
            })),
          }
        : {}),
    };
  }

  if (family === 'adapter' && action === 'templates') {
    return {
      operation: 'adapter.templates',
      data: {
        schema: 'game_dev.adapter_templates.v1',
        templates: await listAdapterTemplates(),
      },
    };
  }
  if (family === 'adapter' && action === 'install') {
    const result = await installAdapterTemplate({
      templateId: requirePositional(parsed, 2, 'adapter template id'),
      projectRoot: path.resolve(requireFlag(parsed, 'project')),
      confirm: booleanFlag(parsed, 'confirm'),
    });
    return { operation: 'adapter.install', data: result };
  }
  if (family === 'adapter' && action === 'inspect') {
    const adapter = await loadAdapter(
      path.resolve(requireFlag(parsed, 'project')),
      stringFlag(parsed, 'manifest'),
    );
    return {
      operation: 'adapter.inspect',
      data: {
        schema: 'game_dev.adapter_inspection.v1',
        projectRoot: adapter.projectRoot,
        manifestPath: adapter.manifestPath,
        manifestSha256: adapter.manifestSha256,
        adapter: adapter.manifest,
        evidenceCeiling: 'Inspection validates a declarative adapter only; it executes no project command.',
      },
    };
  }

  if (family === 'scenario' && ['list', 'plan', 'run'].includes(action ?? '')) {
    const adapter = await loadAdapter(
      path.resolve(requireFlag(parsed, 'project')),
      stringFlag(parsed, 'manifest'),
    );
    if (action === 'list') {
      return {
        operation: 'scenario.list',
        data: {
          schema: 'game_dev.scenario_list.v1',
          adapterId: adapter.manifest.id,
          adapterVersion: adapter.manifest.version,
          scenarios: adapter.manifest.scenarios.map((scenario) => ({
            id: scenario.id,
            title: scenario.title,
            description: scenario.description,
            capabilities: scenario.capabilities,
            parameters: scenario.parameters,
            outputFormat: scenario.outputs.format,
          })),
        },
      };
    }
    const scenarioId = requirePositional(parsed, 2, 'scenario id');
    const request = await readRequest(parsed);
    const plan = await planScenarioRun({
      adapter,
      scenarioId,
      runsRoot: runtime.config.runsDir,
      parameters: request,
    });
    if (action === 'plan') return { operation: 'scenario.plan', data: plan as unknown as Record<string, unknown> };

    const missing: string[] = [];
    if (!booleanFlag(parsed, 'confirm')) missing.push('--confirm');
    if (plan.requiredAuthorizations.includes('gpu') && !booleanFlag(parsed, 'allow-gpu')) missing.push('--allow-gpu');
    if (plan.requiredAuthorizations.includes('performance') && !booleanFlag(parsed, 'allow-performance')) {
      missing.push('--allow-performance');
    }
    if (missing.length > 0) {
      return {
        operation: 'scenario.run',
        isError: true,
        data: {
          error: 'APPROVAL_REQUIRED',
          message: 'Scenario execution requires every capability-specific authorization listed below.',
          requiredFlags: missing,
          plan,
        },
      };
    }
    events.emit('progress', {
      phase: 'scenario_process',
      runId: plan.runId,
      scenarioId,
      capabilities: plan.capabilities,
    });
    const executed = await executeScenarioRun({
      adapter,
      plan,
      request,
      confirm: true,
      allowGpu: booleanFlag(parsed, 'allow-gpu'),
      allowPerformance: booleanFlag(parsed, 'allow-performance'),
      signal,
    });
    events.emit('artifact', {
      kind: 'run_bundle',
      path: executed.runPath,
      runId: executed.manifest.runId,
      manifestSha256: executed.manifestSha256,
    });
    return {
      operation: 'scenario.run',
      data: {
        schema: 'game_dev.scenario_run_result.v1',
        runPath: executed.runPath,
        manifestPath: executed.manifestPath,
        manifestSha256: executed.manifestSha256,
        run: executed.manifest,
      },
      ...(executed.manifest.status === 'completed' ? {} : { isError: true }),
      artifacts: [
        { path: executed.runPath, kind: 'run_bundle' },
        { path: executed.manifestPath, kind: 'run_manifest', sha256: executed.manifestSha256 },
      ],
    };
  }

  if (family === 'tool' && action === 'call') {
    const name = requirePositional(parsed, 2, 'local command name');
    if (isSpendingTool(name)) {
      const approval = approvalRequired(name, parsed);
      if (approval) return approval;
    }
    return callLocal(runtime, `tool.${name}`, name, await readRequest(parsed));
  }

  if (family === 'provider' && action === 'tripo') {
    const operation = requirePositional(parsed, 2, 'Tripo operation');
    const mapping: Record<string, string> = {
      generate: 'create_3d_asset',
      retexture: 'texture_existing_asset',
      rig: 'rig_asset',
      retarget: 'animate_asset',
      retopologize: 'retopologize_asset',
    };
    const command = mapping[operation];
    if (!command) throw invalidInput(`unsupported Tripo operation: ${operation}`);
    const approval = approvalRequired(command, parsed);
    if (approval) return approval;
    return callLocal(runtime, `provider.tripo.${operation}`, command, await readRequest(parsed));
  }

  if (family === 'provider' && action === 'leonardo') {
    const operation = requirePositional(parsed, 2, 'Leonardo operation');
    const mapping: Record<string, string> = {
      'image-generate': 'generate_asset_reference',
      'sound-generate': 'generate_sound_effect',
    };
    const command = mapping[operation];
    if (!command) throw invalidInput(`unsupported Leonardo operation: ${operation}`);
    const approval = approvalRequired(command, parsed);
    if (approval) return approval;
    return callLocal(runtime, `provider.leonardo.${operation}`, command, await readRequest(parsed));
  }

  if (family === 'job' && action === 'list') {
    const args: Record<string, unknown> = { limit: positiveIntegerFlag(parsed, 'limit', 25) };
    const status = stringFlag(parsed, 'status');
    if (status) args.status = status;
    const assetResult = await callLocal(runtime, 'job.list', 'list_asset_jobs', args);
    const durable = await runtime.durableJobs.list(positiveIntegerFlag(parsed, 'limit', 25));
    return {
      operation: 'job.list',
      data: {
        schema: 'game_dev.job_list.v1',
        durable,
        assets: assetResult.data,
      },
    };
  }
  if (family === 'job' && action === 'show') {
    const jobId = requirePositional(parsed, 2, 'job id');
    if (jobId.startsWith('job_')) {
      return { operation: 'job.show', data: await runtime.durableJobs.get(jobId) as unknown as Record<string, unknown> };
    }
    return callLocal(runtime, 'job.show', 'get_asset_job', {
      assetJobId: jobId,
      detail: booleanFlag(parsed, 'detail'),
    });
  }
  if (family === 'job' && action === 'follow') {
    return followJob(runtime, requirePositional(parsed, 2, 'job id'), parsed, events);
  }
  if (family === 'job' && action === 'resume') {
    const jobId = requirePositional(parsed, 2, 'job id');
    if (jobId.startsWith('job_')) {
      return resumeDurableJob(runtime, jobId, parsed);
    }
    return callLocal(runtime, 'job.resume', 'get_asset_job', {
      assetJobId: jobId,
      detail: true,
    });
  }
  if (family === 'job' && action === 'cancel') {
    const jobId = requirePositional(parsed, 2, 'job id');
    if (!booleanFlag(parsed, 'confirm')) {
      return {
        operation: 'job.cancel',
        isError: true,
        data: {
          error: 'APPROVAL_REQUIRED',
          message: 'cancelling marks the local job cancelled but may not stop provider-side paid work',
          approval: { flag: '--confirm', assetJobId: jobId },
        },
      };
    }
    if (jobId.startsWith('job_')) {
      const durable = await runtime.durableJobs.cancel(jobId);
      return {
        operation: 'job.cancel',
        data: { jobId: durable.id, status: durable.status, externalCancellationProved: false },
      };
    }
    const job = await runtime.context.store.get(jobId);
    if (!isTerminal(job.status)) {
      job.status = 'cancelled';
      job.updatedAt = new Date().toISOString();
      job.error = {
        code: 'LOCALLY_CANCELLED',
        message: 'Local tracking was cancelled. Provider-side work may continue.',
      };
      await runtime.context.store.save(job);
    }
    return {
      operation: 'job.cancel',
      data: { assetJobId: job.id, status: job.status, providerCancellationProved: false },
    };
  }

  if (family === 'asset' && action === 'inspect') {
    return callLocal(runtime, 'asset.inspect', 'inspect_asset', {
      modelPath: path.resolve(requirePositional(parsed, 2, 'model path')),
    });
  }
  if (family === 'asset' && action === 'validate') {
    return callLocal(runtime, 'asset.validate', 'validate_game_asset', {
      ...await readRequest(parsed),
      modelPath: path.resolve(requirePositional(parsed, 2, 'model path')),
    });
  }
  if (family === 'asset' && action === 'normalize') {
    const output = stringFlag(parsed, 'output');
    return callLocal(runtime, 'asset.normalize', 'normalize_mesh', {
      ...await readRequest(parsed),
      modelPath: path.resolve(requirePositional(parsed, 2, 'model path')),
      ...(output ? { outputPath: path.resolve(output) } : {}),
    });
  }

  if (family === 'asset' && action === 'preview-usdz') {
    const result = await generateUsdzPreview(
      path.resolve(requirePositional(parsed, 2, 'model path')),
      path.resolve(requireFlag(parsed, 'output')),
      {
        ...(process.env.BLENDER_PATH?.trim() ? { blenderPath: process.env.BLENDER_PATH.trim() } : {}),
      },
    );
    events.emit('artifact', { kind: 'usdz_preview', path: result.outputPath, sha256: result.sha256 });
    return { operation: 'asset.preview-usdz', data: result as unknown as Record<string, unknown> };
  }

  if (family === 'package' && action === 'build') {
    const sourcePath = path.resolve(requirePositional(parsed, 2, 'model path'));
    const request = await readRequest(parsed);
    const requestedName = stringFlag(parsed, 'name') ?? request.name;
    if (typeof requestedName !== 'string' || requestedName.trim().length === 0) {
      throw invalidInput('package build requires --name or request.name');
    }
    const description = stringFlag(parsed, 'description') ?? request.description;
    const version = stringFlag(parsed, 'package-version') ?? stringFlag(parsed, 'version') ?? request.version;
    const license = stringFlag(parsed, 'license') ?? request.license;
    const category = stringFlag(parsed, 'category') ?? request.category;
    const previewPath = stringFlag(parsed, 'preview') ?? request.previewPath;
    const provenance = request.provenance;
    const policy = request.policy;
    const buildOptions = {
      packagesRoot: runtime.config.packagesDir,
      sourcePath,
      name: requestedName,
      ...(typeof description === 'string' ? { description } : {}),
      ...(typeof version === 'string' ? { version } : {}),
      ...(typeof license === 'string' ? { license } : {}),
      ...(typeof category === 'string' ? { category: category as AssetCategory } : {}),
      ...(typeof previewPath === 'string' ? { previewPath: path.resolve(previewPath) } : {}),
      ...(provenance && typeof provenance === 'object' && !Array.isArray(provenance)
        ? { provenance: provenance as AssetProvenanceInput }
        : {}),
      ...(policy && typeof policy === 'object' && !Array.isArray(policy)
        ? { policy: policy as Partial<GameAssetPolicy> }
        : {}),
      maximumBytes: runtime.config.maxDownloadBytes,
    };

    // `package build` writes without --confirm, unlike every other write path.
    // Gating it now would break the README, docs/asset-packages.md and a skill
    // reference that all invoke it bare -- and it only ever writes inside the
    // tool's own workspace, content-addressed and idempotent. So it gets a plan
    // step instead of a gate: the rule is that confirmation is required for
    // writes OUTSIDE the workspace, and this states it accurately rather than
    // enforcing it by breaking callers.
    if (booleanFlag(parsed, 'dry-run')) {
      const plan = await planAssetPackage(buildOptions);
      return {
        operation: 'package.build',
        data: {
          schema: 'game_dev.package_build_plan.v1',
          dryRun: true,
          sourcePath: plan.sourcePath,
          sourceSha256: plan.sourceIdentity.sha256,
          sourceBytes: plan.sourceIdentity.bytes,
          assetId: plan.assetId,
          version: plan.version,
          license: plan.license,
          destination: plan.destination,
          destinationExists: plan.destinationExists,
          validation: plan.validation,
          wouldWrite: !plan.destinationExists,
          evidence: {
            staticInspectionCompleted: true,
            policyValidationCompleted: true,
            packageIdComputed: false,
            nothingWritten: true,
          },
          evidenceCeiling:
            'A plan reports what the build would validate and where it would land. The packageId ' +
            'hashes the staged file set, so it cannot be computed without performing the write ' +
            'this plan exists to avoid. When the destination already holds a package, the build ' +
            'reuses it if identical and refuses if not.',
        },
      };
    }

    const built = await buildAssetPackage(buildOptions);
    const catalogAsset = await withCatalog(runtime, (catalog) => catalog.admit(built.packagePath));
    events.emit('artifact', {
      kind: 'asset_package',
      path: built.packagePath,
      packageId: built.manifest.packageId,
      manifestSha256: built.manifestSha256,
    });
    return {
      operation: 'package.build',
      data: {
        schema: 'game_dev.package_build_result.v1',
        packageId: built.manifest.packageId,
        packagePath: built.packagePath,
        manifestPath: built.manifestPath,
        receiptPath: built.receiptPath,
        manifestSha256: built.manifestSha256,
        reused: built.reused,
        validation: built.manifest.validation,
        catalog: catalogAsset,
        evidence: {
          portableGlbCopiedAndHashed: true,
          staticInspectionCompleted: true,
          policyValidationCompleted: true,
          blenderNormalizationPerformed: false,
          gpuImportTestPerformed: false,
          humanVisualReviewPerformed: false,
        },
      },
      artifacts: [
        { path: built.packagePath, kind: 'asset_package' },
        { path: built.manifestPath, kind: 'manifest', sha256: built.manifestSha256 },
        { path: built.receiptPath, kind: 'receipt' },
      ],
    };
  }

  if (family === 'package' && ['show', 'verify'].includes(action ?? '')) {
    const reference = requirePositional(parsed, 2, 'package id or path');
    const packagePath = await resolvePackagePath(runtime, reference);
    const manifest = await readAssetPackage(packagePath);
    return {
      operation: `package.${action}`,
      data: {
        schema: 'game_dev.package_verification.v1',
        packagePath,
        manifest,
        hashesVerified: true,
        evidence: {
          packageBytesVerified: true,
          gpuImportTestPerformed: false,
          humanVisualReviewPerformed: false,
        },
      },
    };
  }

  if (family === 'catalog' && action === 'list') {
    if (booleanFlag(parsed, 'valid') && booleanFlag(parsed, 'invalid')) {
      throw invalidInput('--valid and --invalid are mutually exclusive');
    }
    const assets = await withCatalog(runtime, (catalog) => catalog.list({
      ...(stringFlag(parsed, 'query') ? { query: stringFlag(parsed, 'query') } : {}),
      ...(stringFlag(parsed, 'category') ? { category: stringFlag(parsed, 'category') } : {}),
      ...(booleanFlag(parsed, 'valid') ? { validationPassed: true } : {}),
      ...(booleanFlag(parsed, 'invalid') ? { validationPassed: false } : {}),
      limit: positiveIntegerFlag(parsed, 'limit', 100),
    }));
    return {
      operation: 'catalog.list',
      data: { schema: 'game_dev.catalog_list.v1', total: assets.length, assets },
    };
  }

  if (family === 'catalog' && action === 'show') {
    const packageId = requirePositional(parsed, 2, 'package id');
    const asset = await withCatalog(runtime, (catalog) => catalog.get(packageId));
    return { operation: 'catalog.show', data: asset as unknown as Record<string, unknown> };
  }

  if (family === 'catalog' && action === 'admit') {
    const packagePath = path.resolve(requirePositional(parsed, 2, 'package path'));
    if (booleanFlag(parsed, 'dry-run')) {
      const plan = await withCatalog(runtime, (catalog) => catalog.planAdmission(packagePath));
      return {
        operation: 'catalog.admit',
        data: {
          schema: 'game_dev.catalog_admission_plan.v1',
          dryRun: true,
          packagePath,
          alreadyIndexed: plan.alreadyIndexed,
          asset: plan.asset,
          evidence: { manifestRead: true, nothingWritten: true },
        },
      };
    }
    const asset = await withCatalog(runtime, (catalog) => catalog.admit(packagePath));
    return { operation: 'catalog.admit', data: asset as unknown as Record<string, unknown> };
  }

  if (family === 'catalog' && action === 'rebuild') {
    if (!booleanFlag(parsed, 'confirm')) {
      return {
        operation: 'catalog.rebuild',
        isError: true,
        data: {
          error: 'APPROVAL_REQUIRED',
          message: 'Catalog rebuild replaces the derived SQLite index after preserving a backup.',
          approval: { flag: '--confirm' },
        },
      };
    }
    const rebuilt = await AssetCatalog.rebuild(runtime.config.catalogPath, runtime.config.packagesDir);
    return {
      operation: 'catalog.rebuild',
      data: {
        schema: 'game_dev.catalog_rebuild.v1',
        databasePath: rebuilt.databasePath,
        indexed: rebuilt.indexed.length,
        ...(rebuilt.backupPath ? { backupPath: rebuilt.backupPath } : {}),
      },
    };
  }

  if (family === 'vendor' && action === 'admit') {
    const packageReference = requirePositional(parsed, 2, 'package id or path');
    const packagePath = await resolvePackagePath(runtime, packageReference);
    const result = await admitVendorPackage({
      packagePath,
      projectRoot: path.resolve(requireFlag(parsed, 'project')),
      ...(stringFlag(parsed, 'destination') ? { destinationRelative: stringFlag(parsed, 'destination') } : {}),
      confirm: booleanFlag(parsed, 'confirm'),
      allowUnknownLicense: booleanFlag(parsed, 'allow-unknown-license'),
      allowInvalid: booleanFlag(parsed, 'allow-invalid'),
    });
    return {
      operation: 'vendor.admit',
      data: result as unknown as Record<string, unknown>,
      ...(result.blockers.length > 0 ? { isError: true } : {}),
    };
  }

  if (family === 'launch') {
    const packageReference = requirePositional(parsed, 1, 'package id or path');
    const application = requireFlag(parsed, 'with');
    if (!['finder', 'quicklook', 'blender'].includes(application)) {
      throw invalidInput('--with must be finder, quicklook, or blender');
    }
    const packagePath = await resolvePackagePath(runtime, packageReference);
    const launchPlan = await planPackageLaunch(packagePath, application as LaunchApplication);
    if (!booleanFlag(parsed, 'confirm')) {
      return {
        operation: 'launch.plan',
        data: { ...launchPlan, dryRun: true },
      };
    }
    const launched = await executeLaunchPlan(launchPlan);
    return {
      operation: 'launch.execute',
      data: { ...launchPlan, ...launched, dryRun: false },
    };
  }

  if (family === 'capture' && action === 'verify') {
    const runPath = await resolveRunPath(runtime.config.runsDir, requirePositional(parsed, 2, 'run id or path'));
    const verified = await verifyRunBundle(runPath);
    return {
      operation: 'capture.verify',
      data: {
        schema: 'game_dev.run_verification.v1',
        runPath: verified.runPath,
        manifestPath: verified.manifestPath,
        manifestSha256: verified.manifestSha256,
        run: verified.manifest,
        hashesVerified: true,
        closedArtifactRosterVerified: true,
      },
    };
  }

  if (family === 'visual' && action === 'analyze') {
    const runPath = await resolveRunPath(runtime.config.runsDir, requirePositional(parsed, 2, 'run id or path'));
    return {
      operation: 'visual.analyze',
      data: await analyzeRunCapture(runPath) as unknown as Record<string, unknown>,
    };
  }

  if (family === 'visual' && action === 'compare') {
    const baseline = await resolveRunPath(runtime.config.runsDir, requirePositional(parsed, 2, 'baseline run id or path'));
    const candidate = await resolveRunPath(runtime.config.runsDir, requirePositional(parsed, 3, 'candidate run id or path'));
    const output = stringFlag(parsed, 'output');
    const comparison = await compareRunVisuals({
      baselineRunPath: baseline,
      candidateRunPath: candidate,
      threshold: nonNegativeIntegerFlag(parsed, 'threshold', 0),
      ...(output ? { outputPath: path.resolve(output) } : {}),
    });
    if (comparison.outputPath) events.emit('artifact', { kind: 'visual_comparison', path: comparison.outputPath });
    return {
      operation: 'visual.compare',
      data: comparison as unknown as Record<string, unknown>,
      ...(comparison.outputPath
        ? { artifacts: [{ path: comparison.outputPath, kind: 'visual_comparison' }] }
        : {}),
    };
  }

  if (family === 'performance' && action === 'summarize') {
    const runPath = await resolveRunPath(runtime.config.runsDir, requirePositional(parsed, 2, 'run id or path'));
    return {
      operation: 'performance.summarize',
      data: await summarizeRunPerformance(runPath) as unknown as Record<string, unknown>,
    };
  }

  if (family === 'performance' && action === 'compare') {
    const baseline = await resolveRunPath(runtime.config.runsDir, requirePositional(parsed, 2, 'baseline run id or path'));
    const candidate = await resolveRunPath(runtime.config.runsDir, requirePositional(parsed, 3, 'candidate run id or path'));
    const statistic = stringFlag(parsed, 'stat') ?? 'median';
    if (!['min', 'max', 'mean', 'median', 'p95', 'p99'].includes(statistic)) {
      throw invalidInput('--stat must be min, max, mean, median, p95, or p99');
    }
    return {
      operation: 'performance.compare',
      data: await compareRunPerformance(
        baseline,
        candidate,
        statistic as 'min' | 'max' | 'mean' | 'median' | 'p95' | 'p99',
      ) as unknown as Record<string, unknown>,
    };
  }

  if (family === 'performance' && action === 'goal-create') {
    const baseline = await resolveRunPath(runtime.config.runsDir, requirePositional(parsed, 2, 'baseline run id or path'));
    const request = await readRequest(parsed);
    const statistic = request.statistic ?? 'median';
    if (typeof statistic !== 'string' || !['min', 'max', 'mean', 'median', 'p95', 'p99'].includes(statistic)) {
      throw invalidInput('request.statistic must be min, max, mean, median, p95, or p99');
    }
    const direction = requestString(request, 'direction');
    if (!['lower', 'higher'].includes(direction)) throw invalidInput('request.direction must be lower or higher');
    const maximumIterations = request.maximumIterations;
    if (typeof maximumIterations !== 'number' || !Number.isInteger(maximumIterations)) {
      throw invalidInput('request.maximumIterations must be an integer');
    }
    const result = await createOptimizationGoal({
      projectRoot: path.resolve(requireFlag(parsed, 'project')),
      baselineRunPath: baseline,
      metric: requestString(request, 'metric'),
      statistic: statistic as 'min' | 'max' | 'mean' | 'median' | 'p95' | 'p99',
      ...(typeof request.unit === 'string' ? { unit: request.unit } : {}),
      direction: direction as 'lower' | 'higher',
      target: requestFiniteNumber(request, 'target'),
      maximumIterations,
      allowedPaths: requestStringArray(request, 'allowedPaths'),
      ...(typeof request.id === 'string' ? { id: request.id } : {}),
      confirm: booleanFlag(parsed, 'confirm'),
    });
    return {
      operation: 'performance.goal-create',
      data: result as unknown as Record<string, unknown>,
      ...(result.dryRun ? {} : { artifacts: [{ path: result.goalPath, kind: 'optimization_goal' }] }),
    };
  }

  if (family === 'performance' && action === 'goal-evaluate') {
    const candidate = await resolveRunPath(runtime.config.runsDir, requirePositional(parsed, 3, 'candidate run id or path'));
    const result = await evaluateOptimizationGoal({
      goalPath: path.resolve(requirePositional(parsed, 2, 'goal path')),
      candidateRunPath: candidate,
      confirm: booleanFlag(parsed, 'confirm'),
    });
    return {
      operation: 'performance.goal-evaluate',
      data: result as unknown as Record<string, unknown>,
      ...(result.dryRun ? {} : { artifacts: [{ path: result.goalPath, kind: 'optimization_goal' }] }),
    };
  }

  if (family === 'migrate' && action === 'legacy') {
    const result = await migrateLegacyWorkspace({
      outputRoot: path.resolve(stringFlag(parsed, 'from') ?? runtime.config.outputDir),
      packagesRoot: runtime.config.packagesDir,
      catalogPath: runtime.config.catalogPath,
      confirm: booleanFlag(parsed, 'confirm'),
      ...(stringFlag(parsed, 'license') ? { defaultLicense: stringFlag(parsed, 'license') } : {}),
    });
    return {
      operation: 'migrate.legacy',
      data: result as unknown as Record<string, unknown>,
      ...(result.failed > 0 ? { isError: true } : {}),
    };
  }

  throw invalidInput(`unknown command: ${parsed.positionals.join(' ') || '(none)'}`);
}

function parsedFromDurableRequest(
  job: DurableJob,
  current: ParsedArguments,
): ParsedArguments {
  const positionals = job.request.positionals;
  const persistedFlags = job.request.flags;
  if (!Array.isArray(positionals) || !positionals.every((value) => typeof value === 'string')) {
    throw invalidInput(`durable job ${job.id} does not contain resumable positionals`);
  }
  if (!persistedFlags || typeof persistedFlags !== 'object' || Array.isArray(persistedFlags)) {
    throw invalidInput(`durable job ${job.id} does not contain resumable flags`);
  }
  const flags = new Map<string, string | boolean>();
  for (const [name, value] of Object.entries(persistedFlags)) {
    if (['approve-spend', 'spend-limit-cents', 'output-dir', 'confirm', 'allow-gpu', 'allow-performance'].includes(name)) continue;
    if (typeof value === 'string' || typeof value === 'boolean') flags.set(name, value);
  }
  const input = job.request.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    flags.set('input', JSON.stringify(input));
  }
  for (const name of ['approve-spend', 'spend-limit-cents', 'output-dir', 'confirm', 'allow-gpu', 'allow-performance']) {
    const value = current.flags.get(name);
    if (value !== undefined) flags.set(name, value);
  }
  return { positionals: [...positionals], flags };
}

async function resumeDurableJob(
  runtime: GameDevRuntime,
  jobId: string,
  parsed: ParsedArguments,
): Promise<DispatchResult> {
  const source = await runtime.durableJobs.get(jobId);
  if (!booleanFlag(parsed, 'confirm')) {
    return {
      operation: 'job.resume',
      isError: true,
      data: {
        error: 'APPROVAL_REQUIRED',
        message: 'Retrying can repeat project writes or paid provider work. Re-run with --confirm.',
        approval: { flag: '--confirm', jobId },
      },
    };
  }
  if (source.status === 'running') {
    return {
      operation: 'job.resume',
      isError: true,
      data: {
        error: 'INVALID_STATE',
        message: 'A running job cannot be retried because this process cannot prove the original worker stopped.',
        jobId,
      },
    };
  }
  if (['completed', 'cancelled'].includes(source.status)) {
    return {
      operation: 'job.resume',
      isError: true,
      data: {
        error: 'INVALID_STATE',
        message: `${source.status} jobs are immutable and cannot be retried`,
        jobId,
      },
    };
  }

  const retryParsed = parsedFromDurableRequest(source, parsed);
  const retry = await runtime.durableJobs.create(source.operation, source.request, { parentJobId: source.id });
  await runtime.durableJobs.markRunning(retry.id);
  const retryEvents = new EventStream(
    source.operation,
    false,
    retry.id,
    (event) => runtime.durableJobs.appendEvent(retry.id, event as unknown as Record<string, unknown>),
  );
  retryEvents.emit('started', { resumedFromJobId: source.id, version: GAME_DEV_VERSION });
  try {
    const result = await dispatch(runtime, retryParsed, retryEvents);
    if (result.data.error === 'APPROVAL_REQUIRED') {
      retryEvents.emit('approval_required', result.data);
      await runtime.durableJobs.markApprovalRequired(retry.id, result.data);
    } else if (result.isError) {
      retryEvents.emit('failed', result.data);
      await runtime.durableJobs.fail(retry.id, result.data);
    } else {
      retryEvents.emit('completed', result.data);
      await runtime.durableJobs.complete(retry.id, {
        schema: 'game_dev.receipt.v1',
        operation: result.operation,
        resumedFromJobId: source.id,
        result: result.data,
        completedAt: new Date().toISOString(),
      }, result.artifacts ?? []);
    }
    return {
      operation: 'job.resume',
      data: {
        resumedFromJobId: source.id,
        retryJobId: retry.id,
        result: result.data,
      },
      ...(result.isError ? { isError: true } : {}),
    };
  } catch (error) {
    const described = describeError(error);
    const failure = {
      error: described.error,
      message: described.message,
      retryable: described.retryable,
      ...(described.details ? { details: described.details } : {}),
    };
    retryEvents.emit('failed', failure);
    await runtime.durableJobs.fail(retry.id, failure);
    return {
      operation: 'job.resume',
      data: { resumedFromJobId: source.id, retryJobId: retry.id, result: failure },
      isError: true,
    };
  }
}

function needsDurableJob(runtime: GameDevRuntime, parsed: ParsedArguments): boolean {
  const [family, action, name] = parsed.positionals;
  if (family === 'provider') return true;
  if (family === 'asset' && ['normalize', 'preview-usdz'].includes(action ?? '')) return true;
  if (['vendor', 'package', 'migrate'].includes(family ?? '')) return true;
  if (family === 'adapter' && action === 'install' && booleanFlag(parsed, 'confirm')) return true;
  if (family === 'skill' && action === 'install' && booleanFlag(parsed, 'confirm')) return true;
  if (family === 'scenario' && action === 'run') return true;
  if (family === 'visual' && action === 'compare' && stringFlag(parsed, 'output') !== undefined) return true;
  if (family === 'performance' && ['goal-create', 'goal-evaluate'].includes(action ?? '') && booleanFlag(parsed, 'confirm')) {
    return true;
  }
  if (family === 'catalog' && ['admit', 'rebuild'].includes(action ?? '')) return true;
  if (family === 'launch' && booleanFlag(parsed, 'confirm')) return true;
  if (family === 'tool' && action === 'call' && name) {
    return runtime.registry.capabilities().find((capability) => capability.name === name)?.readOnly === false;
  }
  return false;
}

async function durableRequest(parsed: ParsedArguments): Promise<Record<string, unknown>> {
  const flags = Object.fromEntries(
    [...parsed.flags.entries()].filter(([name]) => ![
      'json',
      'jsonl',
      'request',
      'input',
      'approve-spend',
      'confirm',
      'allow-gpu',
      'allow-performance',
    ].includes(name)),
  );
  const hasInput = parsed.flags.has('request') || parsed.flags.has('input');
  return {
    positionals: parsed.positionals,
    flags,
    ...(hasInput ? { input: await readRequest(parsed) } : {}),
  };
}

function outputResult(
  operation: string,
  result: DispatchResult,
  jsonLines: boolean,
  events: EventStream,
): void {
  if (jsonLines) {
    events.emit(
      result.data.error === 'APPROVAL_REQUIRED'
        ? 'approval_required'
        : result.isError
          ? 'failed'
          : 'completed',
      result.data,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify({
    schema: GAME_DEV_RESULT_SCHEMA,
    operation,
    ok: result.isError !== true,
    ...(result.isError ? { error: result.data } : { data: result.data }),
  }, null, 2)}\n`);
}

function requestedOperation(parsed: ParsedArguments): string {
  const family = parsed.positionals[0];
  const segmentCount = family === 'provider' || family === 'tool' ? 3 : 2;
  const segments = parsed.positionals.slice(0, segmentCount).map((segment) =>
    segment.toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''),
  ).filter(Boolean);
  return segments.join('.') || 'unknown';
}

export async function main(
  argv: string[] = process.argv.slice(2),
  signal?: AbortSignal,
): Promise<number> {
  const parsed = parseArguments(argv);
  if (booleanFlag(parsed, 'help') || parsed.positionals[0] === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (booleanFlag(parsed, 'version')) {
    process.stdout.write(`${GAME_DEV_VERSION}\n`);
    return 0;
  }

  // stdout is the result protocol for every other command, but an MCP server
  // must own it outright for JSON-RPC. Handled here, beside --help and
  // --version, because those are the only other paths that bypass the envelope.
  if (parsed.positionals[0] === 'mcp' && parsed.positionals[1] === 'serve') {
    const { main: serveMcp } = await import('./mcp/server.js');
    await serveMcp();
    return 0;
  }

  const jsonLines = booleanFlag(parsed, 'jsonl');
  if (jsonLines && booleanFlag(parsed, 'json')) {
    process.stderr.write('game-dev: --json and --jsonl are mutually exclusive\n');
    return 2;
  }

  const operation = requestedOperation(parsed);
  let events: EventStream | undefined;
  let runtime: GameDevRuntime | undefined;
  let durable: DurableJob | undefined;

  try {
    signal?.throwIfAborted();
    assertKnownFlags(parsed);
    const spendLimitCents = optionalPositiveIntegerFlag(parsed, 'spend-limit-cents');
    runtime = await createGameDevRuntime({
      outputDir: stringFlag(parsed, 'output-dir'),
      ...(spendLimitCents !== undefined
        ? { env: { ASSET_SPEND_LIMIT_CENTS: String(spendLimitCents) } }
        : {}),
    });
    if (needsDurableJob(runtime, parsed)) {
      durable = await runtime.durableJobs.create(operation, await durableRequest(parsed));
      durable = await runtime.durableJobs.markRunning(durable.id);
    }
    events = new EventStream(
      operation,
      jsonLines,
      durable?.id,
      durable && runtime
        ? (event) => runtime?.durableJobs.appendEvent(durable?.id ?? '', event as unknown as Record<string, unknown>)
        : undefined,
    );
    events.emit('started', { version: GAME_DEV_VERSION });
    const result = await dispatch(runtime, parsed, events, signal);
    signal?.throwIfAborted();
    outputResult(result.operation, result, jsonLines, events);
    if (durable) {
      if (result.data.error === 'APPROVAL_REQUIRED') {
        await runtime.durableJobs.markApprovalRequired(durable.id, result.data);
      } else if (result.isError) await runtime.durableJobs.fail(durable.id, result.data);
      else await runtime.durableJobs.complete(durable.id, {
        schema: 'game_dev.receipt.v1',
        operation: result.operation,
        result: result.data,
        completedAt: new Date().toISOString(),
      }, result.artifacts ?? []);
    }
    return result.isError ? 1 : 0;
  } catch (error) {
    const described = signal?.aborted
      ? { error: 'CANCELLED', message: 'game-dev was cancelled', retryable: false }
      : describeError(error);
    const failure = {
      error: described.error,
      message: described.message,
      retryable: described.retryable,
      ...(described.details ? { details: described.details } : {}),
    };
    events ??= new EventStream(operation, jsonLines, durable?.id);
    outputResult(operation, { operation, data: failure, isError: true }, jsonLines, events);
    if (runtime && durable) await runtime.durableJobs.fail(durable.id, failure);
    return described.error === 'INVALID_INPUT' ? 2 : 1;
  }
}

if (isDirectInvocation(import.meta.url)) {
  const controller = new AbortController();
  const signalHandlers = installProcessSignalHandlers(controller);
  main(process.argv.slice(2), controller.signal).then((code) => {
    const requestedExitCode = signalHandlers.requestedExitCode();
    signalHandlers.dispose();
    process.exitCode = requestedExitCode ?? code;
  }).catch((error: unknown) => {
    const requestedExitCode = signalHandlers.requestedExitCode();
    signalHandlers.dispose();
    process.stderr.write(`${JSON.stringify({
      level: 'error',
      msg: 'fatal',
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = requestedExitCode ?? 1;
  });
}
