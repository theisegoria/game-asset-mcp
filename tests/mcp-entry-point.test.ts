/**
 * The MCP entry point is exercised the way a client actually launches it:
 * through the relative symlink npm creates in node_modules/.bin, and from a
 * working directory the client chose rather than the user.
 *
 * Both details have bitten this project before. A symlinked bin leaves argv[1]
 * as the link while import.meta.url resolves to the real file, so a naive
 * direct-invocation guard never fires -- the server starts, exits instantly,
 * and the client reports only "connection closed". And Claude Desktop spawns
 * from `/`, where a relative ASSET_OUTPUT_DIR becomes /assets and mkdir fails
 * with a bare errno that reaches the client as, again, nothing at all.
 *
 * Development runs hit neither, because they use the real path and a sane cwd.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const built = fileURLToPath(new URL('../dist/mcp/server.js', import.meta.url));
let workspace: string;
let link: string;

beforeAll(() => {
  if (!existsSync(built)) {
    throw new Error(`${built} is missing. Run \`npm run build\` first.`);
  }
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'game-dev-mcp-bin-')));
  link = path.join(workspace, 'game-dev-mcp');
  symlinkSync(path.relative(workspace, built), link);
  mkdirSync(path.join(workspace, 'assets'), { recursive: true });
});

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe('launched through a symlinked npm-style bin, from the client\'s cwd', () => {
  it('completes a handshake and lists its tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [link],
      env: {
        ...process.env,
        ASSET_OUTPUT_DIR: path.join(workspace, 'assets'),
        ASSET_LOG_LEVEL: 'error',
      } as Record<string, string>,
      // The one detail that makes this test worth having.
      cwd: '/',
    });
    const client = new Client({ name: 'entry-point-test', version: '0' }, { capabilities: {} });

    await client.connect(transport);
    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(10);
    expect(tools.map((tool) => tool.name)).toContain('validate_game_asset');

    // A tool call proves stdout carried nothing but JSON-RPC: a stray write
    // would have desynchronised the framing before this resolved.
    const result = await client.callTool({
      name: 'preview_asset_prompt',
      arguments: { spec: { name: 'crate', description: 'a small wooden crate' } },
    });
    expect(result.isError).not.toBe(true);

    await client.close();
  }, 60_000);
});

describe('a relative ASSET_OUTPUT_DIR under a client-chosen cwd', () => {
  it('names the setting instead of dying with a bare errno', async () => {
    const stderr = await new Promise<string>((resolve) => {
      execFile(
        process.execPath,
        [link],
        {
          env: {
            ...process.env,
            // Resolved against cwd '/', so this becomes /assets and fails.
            ASSET_OUTPUT_DIR: 'assets/generated',
            ASSET_LOG_LEVEL: 'error',
          },
          cwd: '/',
          timeout: 30_000,
        },
        (_error, _stdout, errorOutput) => resolve(errorOutput),
      );
    });

    expect(stderr).toContain('ASSET_OUTPUT_DIR');
    expect(stderr).toContain('RELATIVE');
    expect(stderr).toContain('absolute path');
  }, 60_000);
});
