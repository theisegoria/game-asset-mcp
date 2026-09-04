/**
 * Nothing validated the flag key set, so a misspelled flag was silently
 * dropped and the command ran with its default. `visual compare A B
 * --treshold 20` returned ok with threshold 0 — "every pixel changed" — which
 * is exactly the kind of confidently wrong output an agent acts on.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_FLAGS } from '../src/cli/arguments.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));

const ACCESSORS = [
  'stringFlag',
  'booleanFlag',
  'requireFlag',
  'positiveIntegerFlag',
  'optionalPositiveIntegerFlag',
  'nonNegativeIntegerFlag',
].join('|');
const CALL_SITE = new RegExp(`(?:${ACCESSORS})\\(\\s*(?:parsed|current)\\s*,\\s*'([a-z0-9-]+)'`, 'g');

async function typescriptSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await typescriptSources(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** Re-derive, from the accessor call sites, every flag the CLI actually reads. */
async function flagsReadByCli(): Promise<Set<string>> {
  const found = new Set<string>();
  for (const file of await typescriptSources(sourceRoot)) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(CALL_SITE)) {
      const name = match[1];
      if (name) found.add(name);
    }
  }
  return found;
}

async function run(args: string[]): Promise<{ code: number; payload: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], {
      env: { ...process.env, ASSET_LOG_LEVEL: 'error' },
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      try {
        resolve({
          code: typeof error?.code === 'number' ? error.code : 0,
          payload: JSON.parse(stdout) as Record<string, any>,
        });
      } catch (parseError) {
        reject(new Error(`game-dev returned non-JSON: ${stdout}\n${stderr}`, { cause: parseError }));
      }
    });
  });
}

describe('the known-flag set matches the flags the CLI reads', () => {
  it('accepts every flag some command actually consumes', async () => {
    const read = await flagsReadByCli();
    const missing = [...read].filter((name) => !KNOWN_FLAGS.has(name)).sort();

    // A flag that a command reads but the validator rejects would make a valid
    // invocation fail outright — strictly worse than the bug being fixed.
    expect(missing).toEqual([]);
  });

  it('lists no flag that nothing reads', async () => {
    const read = await flagsReadByCli();
    const stale = [...KNOWN_FLAGS].filter((name) => !read.has(name)).sort();

    expect(stale).toEqual([]);
  });
});

describe('unknown flags are refused', () => {
  it('names the flag and suggests the near miss', async () => {
    const { payload } = await run(['visual', 'compare', 'run_a', 'run_b', '--treshold', '20', '--json']);

    expect(payload.ok).toBe(false);
    expect(payload.error.error).toBe('INVALID_INPUT');
    expect(payload.error.message).toContain('--treshold');
    expect(payload.error.message).toContain('did you mean --threshold?');
    expect(payload.error.details.unknown).toEqual(['treshold']);
  });

  it('reports every unknown flag at once, not just the first', async () => {
    const { payload } = await run(['doctor', '--nope', '--alsonope', '--json']);

    expect(payload.ok).toBe(false);
    expect(payload.error.details.unknown).toEqual(['nope', 'alsonope']);
  });

  it('offers no suggestion when nothing is close', async () => {
    const { payload } = await run(['doctor', '--zzzzzzzzzz', '--json']);

    expect(payload.error.message).toContain('--zzzzzzzzzz');
    expect(payload.error.message).not.toContain('did you mean');
  });

  it('leaves a valid invocation alone', async () => {
    const { payload } = await run(['doctor', '--json']);

    expect(payload.ok).toBe(true);
  });
});
