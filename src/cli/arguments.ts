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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readRequest(parsed: ParsedArguments): Promise<Record<string, unknown>> {
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
