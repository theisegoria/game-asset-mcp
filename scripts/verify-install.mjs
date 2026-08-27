#!/usr/bin/env node
/**
 * Verify the built local helper through its public JSON protocol. This spends
 * nothing, contacts no provider, and does not require credentials.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, '..', 'dist', 'cli.js');

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
  'get_spend_report',
  'validate_game_asset',
  'rig_asset',
  'animate_asset',
  'retopologize_asset',
  'batch_prepare_meshes',
];

const EXPECTED_FAMILIES = [
  'capabilities', 'doctor', 'provider', 'job', 'asset', 'package',
  'scenario', 'capture', 'visual', 'performance', 'skill', 'migrate',
];

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliEntry, ...args],
      { env: { ...process.env, ASSET_LOG_LEVEL: 'error', ...env }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`game-dev exited ${String(error.code)}: ${stderr || stdout}`));
        else resolve({ stdout, stderr });
      },
    );
  });
}

async function main() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'game-dev-verify-'));
  try {
    const capabilityRun = await run(['capabilities', '--json', '--output-dir', workspace]);
    const envelope = JSON.parse(capabilityRun.stdout);
    if (envelope.ok !== true || envelope.data?.schema !== 'game_dev.capabilities.v1') {
      throw new Error('capabilities did not return game_dev.capabilities.v1');
    }
    if (envelope.data.transport !== 'local-cli') {
      throw new Error(`unexpected transport: ${String(envelope.data.transport)}`);
    }

    const tools = envelope.data.localOperations ?? [];
    const found = tools.map((tool) => tool.name).sort();
    const missingTools = EXPECTED_TOOLS.filter((name) => !found.includes(name));
    const families = envelope.data.commandFamilies ?? [];
    const missingFamilies = EXPECTED_FAMILIES.filter((name) => !families.includes(name));
    if (missingTools.length > 0 || missingFamilies.length > 0) {
      throw new Error(
        `missing operations=[${missingTools.join(', ')}] families=[${missingFamilies.join(', ')}]`,
      );
    }

    const promptRequest = JSON.stringify({
      spec: { name: 'verify_probe', description: 'A small inert test prop.' },
    });
    const commandRun = await run([
      'tool', 'call', 'preview_asset_prompt', '--input', promptRequest,
      '--json', '--output-dir', workspace,
    ]);
    const command = JSON.parse(commandRun.stdout);
    if (command.ok !== true || typeof command.data?.prompt !== 'string') {
      throw new Error('a registered local operation could not be executed');
    }

    console.log(`game-dev ${envelope.data.version}: ${found.length} local operations available`);
    console.log(`command families: ${families.join(', ')}`);
    console.log('OK: capability discovery and a free local command completed without MCP.');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
