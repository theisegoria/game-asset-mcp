/**
 * The entry-point guard, tested the only way it can fail.
 *
 * `dist/server.js` decides whether to start by comparing the module's own path
 * against argv[1]. Every development invocation passes the real path, so the
 * guard looks correct forever — while an npm install launches through
 * node_modules/.bin, a SYMLINK, where the two paths differ and the server
 * exits without a word.
 *
 * That failure cost a working publish once. It is cheap to catch and invisible
 * to every other test, so it gets its own: spawn through a symlink, speak MCP,
 * and require real tools back. Asserting the process merely started would not
 * do — a server that exits after printing a banner also "starts".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const built = path.resolve('dist/server.js');
let workspace: string | undefined;

beforeAll(() => {
  if (!existsSync(built)) return;
  // realpathSync matters: on macOS tmpdir() is /var/folders/…, and /var is
  // itself a symlink to /private/var. A relative link target computed from the
  // shallower logical path resolves from the deeper real one and dangles.
  workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'asset-mcp-bin-')));
  // npm writes a RELATIVE link into node_modules/.bin
  // (game-asset-mcp -> ../@theisegoria/game-asset-mcp/dist/server.js), so the
  // link target is relative here too. An absolute link also reproduces the
  // defect, but only the relative form is what an install actually creates.
  symlinkSync(path.relative(workspace, built), path.join(workspace, 'game-asset-mcp'));
});

afterAll(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

// Needs a build; `npm run verify` and CI both build first.
describe.skipIf(!existsSync(built))('launched through a symlinked bin', () => {
  it('starts, stays up, and serves its tools', async () => {
    const link = path.join(workspace as string, 'game-asset-mcp');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [link],
      env: { ...process.env, ASSET_LOG_LEVEL: 'error' },
    });
    const client = new Client({ name: 'entry-point-test', version: '1.0.0' });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      // A guard that fails closes the connection instead of answering.
      expect(tools.length).toBeGreaterThan(10);
      expect(tools.map((tool) => tool.name)).toContain('validate_game_asset');
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 60_000);
});
