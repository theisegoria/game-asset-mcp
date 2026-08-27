#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { parseArguments, booleanFlag, readRequest, stringFlag, type ParsedArguments } from './cli/arguments.js';
import { runDoctor } from './cli/doctor.js';
import { EventStream } from './cli/events.js';
import { createGameDevRuntime, type GameDevRuntime } from './runtime.js';
import { refreshAssetJob } from './tools/jobs.js';
import type { ToolResult } from './tools/context.js';
import { describeError, invalidInput } from './util/errors.js';
import { isTerminal } from './domain/status.js';
import {
  GAME_DEV_CAPABILITIES_SCHEMA,
  GAME_DEV_NAME,
  GAME_DEV_RESULT_SCHEMA,
  GAME_DEV_VERSION,
} from './version.js';
import type { DurableJob } from './jobs/durable.js';
import { isSpendingTool } from './domain/spend.js';

const HELP = `Game Development Studio local harness

Usage:
  game-dev capabilities [--json]
  game-dev doctor [--json]
  game-dev tool call <name> [--request FILE|- | --input JSON] [--json|--jsonl]
  game-dev provider tripo generate --request FILE [--json|--jsonl]
  game-dev provider leonardo sound-generate --request FILE [--json|--jsonl]
  game-dev job list [--limit N] [--status STATUS] [--json]
  game-dev job show <job-id> [--detail] [--json]
  game-dev job follow <job-id> [--max-seconds N] [--jsonl]
  game-dev job resume <job-id> [--json|--jsonl]
  game-dev job cancel <job-id> --confirm [--json]
  game-dev asset inspect <model.glb> [--json]
  game-dev asset validate <model.glb> [--request POLICY.json] [--json]
  game-dev asset normalize <model.glb> [--output PATH] [--request OPTIONS.json] [--jsonl]

Global options:
  --output-dir PATH   Asset workspace for this invocation.
  --json              Emit one game_dev.result.v1 object.
  --jsonl             Emit game_dev.event.v1 JSON Lines.
  --version           Print the helper version.
  --help              Show this help.

Provider credentials are read lazily from the app-provided environment or the
documented development variables TRIPO_API_KEY and LEONARDO_API_KEY. Secrets
are never accepted as command-line arguments.`;

interface DispatchResult {
  operation: string;
  data: Record<string, unknown>;
  isError?: boolean;
}

function requirePositional(parsed: ParsedArguments, index: number, label: string): string {
  const value = parsed.positionals[index];
  if (!value) throw invalidInput(`missing ${label}`);
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
  const text = result.content[0]?.text ?? '{}';
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
      'doctor',
      'credentials',
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
    while (true) {
      const persisted = await runtime.durableJobs.readEvents(jobId, { afterSequence });
      for (const event of persisted) {
        events.replay(event);
        if (typeof event.sequence === 'number') afterSequence = Math.max(afterSequence, event.sequence);
      }
      job = await runtime.durableJobs.get(jobId);
      if (['completed', 'failed', 'cancelled'].includes(job.status) || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    }
    return {
      operation: 'job.follow',
      data: {
        jobId: job.id,
        status: job.status,
        terminal: ['completed', 'failed', 'cancelled'].includes(job.status),
        timedOut: !['completed', 'failed', 'cancelled'].includes(job.status),
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
): Promise<DispatchResult> {
  const [family, action] = parsed.positionals;

  if (family === 'capabilities') {
    return { operation: 'capabilities', data: capabilities(runtime) };
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
      const job = await runtime.durableJobs.get(jobId);
      return {
        operation: 'job.resume',
        data: {
          ...job,
          resumable: job.status === 'queued' || job.status === 'approval_required',
          note: 'Resume the original command using this job request; completed, failed, and cancelled jobs are immutable evidence.',
        },
      };
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

  throw invalidInput(`unknown command: ${parsed.positionals.join(' ') || '(none)'}`);
}

function needsDurableJob(runtime: GameDevRuntime, parsed: ParsedArguments): boolean {
  const [family, action, name] = parsed.positionals;
  if (family === 'provider') return true;
  if (family === 'asset' && action === 'normalize') return true;
  if (['vendor', 'package', 'scenario', 'capture', 'visual', 'performance', 'migrate'].includes(family ?? '')) {
    return true;
  }
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArguments(argv);
  if (booleanFlag(parsed, 'help') || parsed.positionals[0] === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (booleanFlag(parsed, 'version')) {
    process.stdout.write(`${GAME_DEV_VERSION}\n`);
    return 0;
  }

  const jsonLines = booleanFlag(parsed, 'jsonl');
  if (jsonLines && booleanFlag(parsed, 'json')) {
    process.stderr.write('game-dev: --json and --jsonl are mutually exclusive\n');
    return 2;
  }

  const operation = parsed.positionals.slice(0, 3).join('.') || 'unknown';
  let events: EventStream | undefined;
  let runtime: GameDevRuntime | undefined;
  let durable: DurableJob | undefined;

  try {
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
    const result = await dispatch(runtime, parsed, events);
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
      });
    }
    return result.isError ? 1 : 0;
  } catch (error) {
    const described = describeError(error);
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

function canonical(target: string): string {
  try {
    return realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

const invokedPath = process.argv[1] ? canonical(process.argv[1]) : undefined;
if (invokedPath && canonical(fileURLToPath(import.meta.url)) === invokedPath) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      level: 'error',
      msg: 'fatal',
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
