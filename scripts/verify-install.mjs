#!/usr/bin/env node
/**
 * Verify the artifact users actually receive. The verifier packs this source
 * tree, installs the tarball into an empty disposable consumer, and exercises
 * only that installed copy. It spends nothing and contacts no provider.
 */

import { execFile, spawn } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';
import { access, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '..');
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPM_INSTALL_FETCH_TIMEOUT_MS = 20_000;
const NPM_INSTALL_TIMEOUT_MS = 60_000;

const EXPECTED_TOOLS = [
  'analyze_capture_run',
  'compare_capture_visuals',
  'install_adapter_template',
  'install_probe_sdk',
  'list_adapter_templates',
  'plan_adapter_install',
  'plan_probe_install',
  'plan_scenario_run',
  'render_asset_contact_sheet',
  'run_scenario',
  'compare_run_performance',
  'summarize_run_performance',
  'verify_capture_run',
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
  'capabilities', 'doctor', 'credentials', 'adapter', 'provider', 'job', 'catalog',
  'asset', 'vendor', 'package', 'scenario', 'capture', 'visual',
  'performance', 'skill', 'migrate', 'launch', 'tool',
];

const EXPECTED_SKILLS = [
  'game-asset-production',
  'game-asset-vendoring',
  'game-development-studio',
  'game-performance-optimization',
  'game-visual-debugging',
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 0;
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd ?? sourceRoot,
        env: { ...process.env, ...options.env },
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          const failureContext = options.failureContext ? `${options.failureContext}: ` : '';
          if (error.killed && timeoutMs > 0) {
            reject(new Error(
              `${failureContext}${command} ${args.join(' ')} timed out after ${timeoutMs}ms. ${options.timeoutHint ?? 'The child process exceeded its explicit verifier bound.'}`,
              { cause: error },
            ));
            return;
          }
          reject(new Error(
            `${failureContext}${command} ${args.join(' ')} exited ${String(error.code)}:\n${stderr || stdout}`,
            { cause: error },
          ));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/**
 * Speak MCP to the installed server over stdio, framed the way the protocol
 * actually frames it: newline-delimited JSON, one message per line.
 *
 * Hand-rolled rather than driven through the SDK client on purpose. This check
 * exists to prove the PUBLISHED artefact answers a real client, so borrowing
 * the SDK's own framing would let a packaging mistake hide behind the same
 * library the server uses.
 *
 * Returns the tool list and every line stdout produced, so the caller can
 * assert nothing but JSON-RPC was written -- a single stray console.log
 * desynchronises the channel and is invisible until a client hangs.
 */
function probeMcpOverStdio(entry, env, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: '/',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = [];
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error(`the installed MCP server did not answer within ${timeoutMs}ms: ${stderr}`)),
      timeoutMs,
    );

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      let index = stdout.indexOf('\n');
      while (index >= 0) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (line.length > 0) {
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            finish(new Error(`the installed MCP server wrote non-JSON to stdout: ${line.slice(0, 200)}`));
            return;
          }
          lines.push(parsed);
          if (parsed.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          }
          if (parsed.id === 2) finish(undefined, { result: parsed.result, lines, stderr });
        }
        index = stdout.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => finish(new Error(
      `the installed MCP server exited early with code ${code}. stderr: ${stderr.slice(0, 500)}`,
    )));

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'verify-install', version: '0' },
      },
    });
  });
}

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'game-dev-published-install-'));
  const packRoot = path.join(temporaryRoot, 'pack');
  const consumerRoot = path.join(temporaryRoot, 'consumer');
  const npmCache = path.join(temporaryRoot, 'npm-cache');
  const outputRoot = path.join(temporaryRoot, 'workspace');
  const installedSkillsRoot = path.join(temporaryRoot, 'installed-skills');
  const exportedRepository = path.join(temporaryRoot, 'exported-skills-repository');

  try {
    const sourcePackage = await readJson(path.join(sourceRoot, 'package.json'));
    await Promise.all([mkdir(packRoot), mkdir(consumerRoot)]);
    const npmEnvironment = { npm_config_cache: npmCache };
    const packed = await run(npmExecutable, [
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination', packRoot,
    ], { cwd: sourceRoot, env: npmEnvironment });
    const packRecords = JSON.parse(packed.stdout);
    invariant(Array.isArray(packRecords) && packRecords.length === 1, 'npm pack returned an unexpected record count');
    const packRecord = packRecords[0];
    invariant(packRecord?.name === '@theisegoria/game-development-studio', 'npm pack returned the wrong package');
    invariant(packRecord?.version === sourcePackage.version, 'packed version differs from package.json');
    const tarballPath = path.join(packRoot, packRecord.filename);
    invariant(await exists(tarballPath), 'npm pack did not create the reported tarball');

    console.log(
      `verifying fresh npm install (fetch timeout ${NPM_INSTALL_FETCH_TIMEOUT_MS}ms, process timeout ${NPM_INSTALL_TIMEOUT_MS}ms, retries disabled)`,
    );
    await run(npmExecutable, [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--fetch-retries=0',
      `--fetch-timeout=${NPM_INSTALL_FETCH_TIMEOUT_MS}`,
      tarballPath,
    ], {
      cwd: consumerRoot,
      env: npmEnvironment,
      timeoutMs: NPM_INSTALL_TIMEOUT_MS,
      failureContext: 'fresh package install',
      timeoutHint: 'The verifier uses an empty npm cache and requires registry access for runtime dependencies; npm retries are disabled.',
    });

    const packageRoot = path.join(
      consumerRoot,
      'node_modules',
      '@theisegoria',
      'game-development-studio',
    );
    const installedPackage = await readJson(path.join(packageRoot, 'package.json'));
    invariant(installedPackage.version === packRecord.version, 'installed version differs from the packed version');

    const requiredPublishedFiles = [
      'dist/mcp/server.js',
      'README.md',
      'LICENSE',
      'PRIVACY.md',
      'SECURITY.md',
      'SUPPORT.md',
      'TERMS.md',
      'assets/icon.png',
      'assets/icon-provenance.json',
      'assets/screenshots/01-skill-suite.png',
      'assets/screenshots/02-cli-contract.png',
      'assets/screenshots/03-visual-debugging.png',
      'assets/screenshots/provenance.json',
      '.codex-plugin/plugin.json',
      'marketing/COPY.md',
      'marketing/STORE_SUBMISSION.md',
      'distribution/skills-repo/README.md',
      'distribution/skills-repo/CHANGELOG.md',
      'distribution/skills-repo/PLUGIN_README.md',
      'distribution/skills-repo/gitignore.template',
      'distribution/skills-repo/.agents/plugins/marketplace.json',
      'distribution/skills-repo/.github/workflows/validate.yml',
      'distribution/skills-repo/scripts/build_release.py',
      'distribution/skills-repo/scripts/verify.py',
      'scripts/build-skills-repository.mjs',
    ];
    const missingPublishedFiles = [];
    for (const relative of requiredPublishedFiles) {
      if (!await exists(path.join(packageRoot, relative))) missingPublishedFiles.push(relative);
    }
    invariant(
      missingPublishedFiles.length === 0,
      `published package is missing required files: ${missingPublishedFiles.join(', ')}`,
    );

    // The v0.4.0 entry point stays retired: its module layout, tool surface and
    // bin name are all different, and a stale copy alongside dist/mcp/server.js
    // would give clients two servers claiming the same package. A client MCP
    // config in the package root stays banned too -- config is generated per
    // client, never shipped. This is NOT a ban on serving MCP; see the positive
    // contract below, which is what actually keeps this honest now that a
    // server ships again.
    const retiredV04EntryPoints = [
      'dist/server.js',
      'dist/server.js.map',
      'dist/server.d.ts',
      '.mcp.json',
      '.app.json',
    ];
    const leakedPublishedFiles = [];
    for (const relative of retiredV04EntryPoints) {
      if (await exists(path.join(packageRoot, relative))) leakedPublishedFiles.push(relative);
    }
    invariant(
      leakedPublishedFiles.length === 0,
      `retired v0.4 MCP/app outputs leaked into the published package: ${leakedPublishedFiles.join(', ')}`,
    );

    const mcpEntry = path.join(packageRoot, 'dist', 'mcp', 'server.js');
    const mcpSource = await readFile(mcpEntry, 'utf8');
    invariant(
      mcpSource.startsWith('#!/usr/bin/env node'),
      'the published MCP entry point lost its shebang, so the bin cannot be executed directly',
    );

    const cliEntry = path.join(packageRoot, 'dist', 'cli.js');
    const runCli = (args) => run(process.execPath, [cliEntry, ...args], {
      cwd: consumerRoot,
      env: { ASSET_LOG_LEVEL: 'error' },
    });
    const capabilityRun = await runCli(['capabilities', '--json', '--output-dir', outputRoot]);
    const envelope = JSON.parse(capabilityRun.stdout);
    invariant(envelope.ok === true, 'installed capabilities command failed');
    invariant(envelope.data?.schema === 'game_dev.capabilities.v1', 'installed capabilities schema changed');
    invariant(envelope.data?.transport === 'local-cli', 'installed package did not report the local CLI transport');

    const tools = envelope.data.localOperations ?? [];
    const foundTools = tools.map((tool) => tool.name).sort();
    const missingTools = EXPECTED_TOOLS.filter((name) => !foundTools.includes(name));
    const families = envelope.data.commandFamilies ?? [];
    const missingFamilies = EXPECTED_FAMILIES.filter((name) => !families.includes(name));
    invariant(
      missingTools.length === 0 && missingFamilies.length === 0,
      `installed command contract is incomplete: operations=[${missingTools.join(', ')}] families=[${missingFamilies.join(', ')}]`,
    );

    // A negative guard that merely bans a filename stops guarding the moment
    // someone picks a different one. Assert instead that the shipped server
    // actually answers a client.
    const mcpProbe = await probeMcpOverStdio(
      path.join(packageRoot, 'dist', 'mcp', 'server.js'),
      { ASSET_OUTPUT_DIR: outputRoot, ASSET_LOG_LEVEL: 'error' },
    );
    const mcpTools = (mcpProbe.result?.tools ?? []).map((tool) => tool.name).sort();
    const missingMcpTools = EXPECTED_TOOLS.filter((name) => !mcpTools.includes(name));
    invariant(
      missingMcpTools.length === 0,
      `the installed MCP server did not advertise: ${missingMcpTools.join(', ')}`,
    );
    invariant(
      mcpTools.length === foundTools.length,
      `MCP advertises ${mcpTools.length} tools but the CLI reports ${foundTools.length}: the two transports have drifted`,
    );
    invariant(
      mcpProbe.lines.every((line) => line.jsonrpc === '2.0'),
      'the installed MCP server wrote a non-JSON-RPC message to stdout',
    );

    const promptRequest = JSON.stringify({
      spec: { name: 'verify_probe', description: 'A small inert test prop.' },
    });
    const commandRun = await runCli([
      'tool', 'call', 'preview_asset_prompt', '--input', promptRequest,
      '--json', '--output-dir', outputRoot,
    ]);
    const command = JSON.parse(commandRun.stdout);
    invariant(command.ok === true && typeof command.data?.prompt === 'string', 'installed free local operation failed');

    const skillRun = await runCli(['skill', 'list', '--json', '--output-dir', outputRoot]);
    const skillEnvelope = JSON.parse(skillRun.stdout);
    invariant(skillEnvelope.ok === true, 'installed skill listing failed');
    invariant(skillEnvelope.data?.schema === 'game_dev.skill_bundle.v1', 'installed skill schema changed');
    invariant(skillEnvelope.data?.version === packRecord.version, 'installed skill bundle version changed');
    invariant(skillEnvelope.data?.skills?.length === EXPECTED_SKILLS.length, 'installed skill count changed');
    invariant(
      skillEnvelope.data.skills.every((skill) => typeof skill.source !== 'string'),
      'installed skill listing leaked an internal source path',
    );

    const skillInstallRun = await runCli([
      'skill', 'install', 'all',
      '--target', installedSkillsRoot,
      '--confirm',
      '--json',
      '--output-dir', outputRoot,
    ]);
    const skillInstall = JSON.parse(skillInstallRun.stdout);
    invariant(skillInstall.ok === true && skillInstall.data?.dryRun === false, 'installed skill copy failed');
    invariant(
      JSON.stringify((await readdir(installedSkillsRoot)).sort()) === JSON.stringify(EXPECTED_SKILLS),
      'installed skill directory roster changed',
    );

    const installedBin = path.join(
      consumerRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'game-dev.cmd' : 'game-dev',
    );
    const binRun = await run(installedBin, ['--version'], { cwd: consumerRoot });
    invariant(binRun.stdout.trim() === installedPackage.version, 'installed npm bin did not execute the packed CLI');

    const library = await import(pathToFileURL(path.join(packageRoot, 'dist', 'index.js')).href);
    invariant(library.GAME_DEV_VERSION === installedPackage.version, 'installed library export has the wrong version');

    const builderRun = await run(process.execPath, [
      path.join(packageRoot, 'scripts', 'build-skills-repository.mjs'),
      exportedRepository,
    ], { cwd: consumerRoot });
    const builderReceipt = JSON.parse(builderRun.stdout);
    invariant(builderReceipt.ok === true && builderReceipt.mcp === false, 'installed skills repository builder failed');
    const exportedPlugin = path.join(exportedRepository, 'plugins', 'game-development-studio');
    const exportedManifest = await readJson(path.join(exportedPlugin, '.codex-plugin', 'plugin.json'));
    invariant(
      exportedManifest.mcpServers === undefined && exportedManifest.apps === undefined,
      'installed builder exported an MCP server or app',
    );
    invariant(exportedManifest.version === packRecord.version, 'installed builder exported the wrong plugin version');
    invariant(
      exportedManifest.interface?.screenshots === undefined,
      'installed builder exported screenshots in a no-UI plugin',
    );
    const exportedReadme = await readFile(path.join(exportedPlugin, 'README.md'), 'utf8');
    invariant(
      !exportedReadme.includes('assets/screenshots/'),
      'exported plugin README references marketing screenshots',
    );
    invariant(await exists(path.join(exportedPlugin, 'assets', 'icon.png')), 'exported plugin icon is missing');
    for (const relative of [
      'assets/screenshots/01-skill-suite.png',
      'assets/screenshots/02-cli-contract.png',
      'assets/screenshots/03-visual-debugging.png',
    ]) {
      invariant(await exists(path.join(exportedRepository, relative)), `exported repository marketing asset is missing: ${relative}`);
      invariant(!await exists(path.join(exportedPlugin, relative)), `exported plugin leaked marketing screenshot: ${relative}`);
    }

    console.log(`packed ${packRecord.name}@${packRecord.version}: ${packRecord.entryCount} files`);
    console.log(`installed CLI: ${foundTools.length} local operations across ${families.length} command families`);
    console.log(`installed skills: ${EXPECTED_SKILLS.length}; exported skills-only repository: verified`);
    console.log(`installed MCP server: ${mcpTools.length} tools over stdio, stdout clean`);
    console.log('OK: the disposable installed tarball completed free local checks without profile writes.');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
