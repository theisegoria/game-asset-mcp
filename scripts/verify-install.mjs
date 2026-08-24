#!/usr/bin/env node
/**
 * Install verification.
 *
 * Starts the built server over stdio with a real MCP client, performs the
 * handshake, and lists the tools it advertises. This answers "is my install
 * actually working" with a protocol round-trip rather than a version string —
 * a server that fails to register its tools still starts perfectly happily.
 *
 * Spends nothing and contacts no provider. Run: node scripts/verify-install.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'server.js');

const EXPECTED_TOOLS = [
  'preview_asset_prompt',
  'create_game_prop',
  'generate_asset_reference',
  'generate_reference_variations',
  'select_reference',
  'create_3d_asset',
  'texture_existing_asset',
  'get_asset_job',
  'list_asset_jobs',
  'download_asset',
  'inspect_asset',
  'extract_pbr_trio',
  'generate_sound_effect',
  'normalize_mesh',
];

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    // Deliberately no API keys: the server must start and advertise its tools
    // without credentials, reporting CONFIG_MISSING only when one is called.
    env: { ...process.env, ASSET_LOG_LEVEL: 'error' },
  });

  const client = new Client({ name: 'verify-install', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const found = tools.map((tool) => tool.name).sort();
  const missing = EXPECTED_TOOLS.filter((name) => !found.includes(name));

  // Credit-spending is a distinct axis from read-only: select_reference writes
  // local state but costs nothing, so keying the marker off readOnlyHint alone
  // would mislabel it.
  const spendsCredits = new Set([
    'generate_asset_reference',
    'generate_reference_variations',
    'create_3d_asset',
    'texture_existing_asset',
    'create_game_prop',
    'generate_sound_effect',
  ]);

  console.log(`connected. ${found.length} tools advertised:\n`);
  for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${spendsCredits.has(tool.name) ? '$' : '·'} ${tool.name}`);
  }
  console.log('\n  $ = spends provider credits, · = free\n');

  await client.close();

  if (missing.length > 0) {
    console.error(`FAILED: ${missing.length} expected tool(s) missing: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('OK: all expected tools are registered.');
}

main().catch((err) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
