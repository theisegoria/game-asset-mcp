/**
 * The generator exists because ASSET_OUTPUT_DIR must be absolute, and a
 * relative one resolves against a working directory the CLIENT chose. Several
 * clients spawn from `/`, where "assets/generated" becomes "/assets" and the
 * server cannot start -- historically surfacing as nothing but "connection
 * closed". A static example file cannot fix that; only something that resolves
 * the path at generation time can.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMcpConfig, MCP_CLIENTS } from '../src/mcp/config-templates.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  roots.push(root);
  return root;
}

async function run(args: string[]): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], {
      env: { ...process.env, ASSET_LOG_LEVEL: 'error' },
      maxBuffer: 16 * 1024 * 1024,
    }, (_error, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout) as Record<string, any>);
      } catch (parseError) {
        reject(new Error(`game-dev returned non-JSON: ${stdout}\n${stderr}`, { cause: parseError }));
      }
    });
  });
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('generated client configuration', () => {
  it('resolves an absolute output directory for every client', async () => {
    const root = await workspace();
    for (const client of MCP_CLIENTS) {
      const payload = await run(['mcp', 'config', '--client', client, '--output-dir', root, '--json']);

      expect(payload.ok, `${client} failed`).toBe(true);
      expect(path.isAbsolute(payload.data.outputDir as string)).toBe(true);
      expect(payload.data.snippet).toContain(payload.data.outputDir);
    }
  });

  it('leaves paid tools disabled unless a ceiling is supplied', async () => {
    const root = await workspace();
    const payload = await run(['mcp', 'config', '--client', 'claude-desktop', '--output-dir', root, '--json']);

    expect(payload.data.paidToolsEnabled).toBe(false);
    expect(payload.data.snippet).not.toContain('ASSET_SPEND_LIMIT_CENTS');
    expect(payload.data.snippet).not.toContain('GAME_DEV_MCP_SPEND');
    expect((payload.data.notes as string[]).join(' ')).toContain('--spend-limit-cents');
  });

  it('enables them, with both settings, only when a ceiling is supplied', async () => {
    const root = await workspace();
    const payload = await run([
      'mcp', 'config', '--client', 'claude-desktop', '--output-dir', root,
      '--spend-limit-cents', '500', '--json',
    ]);

    expect(payload.data.paidToolsEnabled).toBe(true);
    // A ceiling without elicit mode would silently do nothing, so both must be
    // emitted together or neither.
    expect(payload.data.snippet).toContain('"ASSET_SPEND_LIMIT_CENTS": "500"');
    expect(payload.data.snippet).toContain('"GAME_DEV_MCP_SPEND": "elicit"');
    expect((payload.data.notes as string[]).join(' ')).toContain('always-allow');
  });

  it('refuses an unknown client rather than emitting something unusable', async () => {
    const payload = await run(['mcp', 'config', '--client', 'emacs', '--json']);

    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain('--client must be one of');
  });

  it('emits parseable JSON for the JSON clients', async () => {
    for (const client of ['claude-desktop', 'gemini', 'generic'] as const) {
      const template = buildMcpConfig({ client, outputDir: '/tmp/abs' });
      expect(template.format).toBe('json');
      expect(() => JSON.parse(template.snippet)).not.toThrow();
    }
  });
});
