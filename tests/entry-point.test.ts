/**
 * The installed-bin entry point is exercised through the same relative symlink
 * npm creates. Development runs use the real path, so only this shape catches
 * a broken direct-invocation guard.
 */

import { execFile } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const built = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let workspace: string | undefined;

beforeAll(() => {
  if (!existsSync(built)) {
    throw new Error(
      `${built} is missing, so the installed entry point cannot be verified. Run \`npm run build\` first.`,
    );
  }
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'game-dev-bin-')));
  symlinkSync(path.relative(workspace, built), path.join(workspace, 'game-dev'));
});

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function invoke(link: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [link, 'capabilities', '--json', '--output-dir', path.join(workspace as string, 'workspace')],
      { env: { ...process.env, ASSET_LOG_LEVEL: 'error' } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`game-dev failed: ${stderr}`, { cause: error }));
        else resolve({ stdout, stderr });
      },
    );
  });
}

describe('launched through a symlinked npm-style bin', () => {
  it('executes the CLI and returns the local capability contract', async () => {
    const link = path.join(workspace as string, 'game-dev');
    const result = await invoke(link);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { schema: string; transport: string; localOperations: Array<{ name: string }> };
    };

    expect(envelope.ok).toBe(true);
    expect(envelope.data.schema).toBe('game_dev.capabilities.v1');
    expect(envelope.data.transport).toBe('local-cli');
    expect(envelope.data.localOperations.length).toBeGreaterThan(10);
    expect(envelope.data.localOperations.map((operation) => operation.name)).toContain('validate_game_asset');
    expect(result.stderr).not.toContain('fatal');
  }, 60_000);
});
