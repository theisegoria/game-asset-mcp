import { promises as fs } from 'node:fs';
import { invalidInput } from '../util/errors.js';

export interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export function parseArguments(argv: string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf('=');
    if (equals > 2) {
      flags.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }

  return { positionals, flags };
}

export function stringFlag(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidInput(`--${name} requires a value`);
  }
  return value;
}

export function booleanFlag(parsed: ParsedArguments, name: string): boolean {
  return parsed.flags.get(name) === true;
}

/**
 * Every flag any command reads. Nothing validated the flag key set before, so
 * `visual compare A B --treshold 20` returned ok with threshold 0 — "everything
 * changed" — and a caller acting on that output had no signal at all that it
 * had misspelled anything.
 *
 * This is a single set rather than a per-command table, so a flag valid on one
 * command is still accepted (and ignored) on another, exactly as before. It
 * closes the typo case, which is the one that silently produces a wrong answer.
 * A per-command table belongs with the command table that also generates HELP.
 *
 * `flagsReadByCli` in the CLI test suite re-derives this set from the accessor
 * call sites and fails if the two drift apart.
 */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  'aa-tolerance', 'allow-gpu', 'allow-invalid', 'allow-performance', 'allow-unknown-license',
  'approve-spend', 'category', 'client', 'confirm', 'description', 'destination', 'detail',
  'dry-run', 'from', 'help', 'input', 'invalid', 'json', 'jsonl', 'license', 'limit',
  'manifest', 'max-seconds', 'name', 'output', 'output-dir', 'package-version',
  'preview', 'project', 'query', 'request', 'spend-limit-cents', 'stat',
  'status', 'target', 'threshold', 'valid', 'version', 'warmup-frames', 'with',
]);

/** Edit distance, capped: we only care whether it is 1 or 2. */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function nearestKnownFlag(name: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of KNOWN_FLAGS) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function assertKnownFlags(parsed: ParsedArguments): void {
  const unknown = [...parsed.flags.keys()].filter((name) => !KNOWN_FLAGS.has(name));
  if (unknown.length === 0) return;
  const details = unknown.map((name) => {
    const suggestion = nearestKnownFlag(name);
    return suggestion ? `--${name} (did you mean --${suggestion}?)` : `--${name}`;
  });
  throw invalidInput(
    `unknown ${unknown.length === 1 ? 'flag' : 'flags'}: ${details.join(', ')}`,
    { unknown },
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const requestReads = new WeakMap<ParsedArguments, Promise<Record<string, unknown>>>();

export function readRequest(parsed: ParsedArguments): Promise<Record<string, unknown>> {
  let request = requestReads.get(parsed);
  if (request === undefined) {
    request = readRequestUncached(parsed);
    requestReads.set(parsed, request);
  }
  return request;
}

async function readRequestUncached(parsed: ParsedArguments): Promise<Record<string, unknown>> {
  const requestPath = stringFlag(parsed, 'request');
  const inline = stringFlag(parsed, 'input');
  if (requestPath !== undefined && inline !== undefined) {
    throw invalidInput('provide --request or --input, not both');
  }

  let raw: string | undefined;
  if (requestPath === '-') raw = await readStdin();
  else if (requestPath !== undefined) raw = await fs.readFile(requestPath, 'utf8');
  else if (inline !== undefined) raw = inline;
  if (raw === undefined || raw.trim().length === 0) return {};

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw invalidInput('request is not valid JSON', {
      source: requestPath ?? '--input',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (parsedJson === null || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    throw invalidInput('request JSON must be an object');
  }
  return parsedJson as Record<string, unknown>;
}
