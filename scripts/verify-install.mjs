#!/usr/bin/env node
/**
 * Verify the artifact users actually receive. The verifier packs this source
 * tree, installs the tarball into an empty disposable consumer, and exercises
 * only that installed copy. It spends nothing and contacts no provider.
 */

import { execFile } from 'node:child_process';
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

    const retiredPublishedFiles = [
      'dist/server.js',
      'dist/server.js.map',
      'dist/server.d.ts',
      '.mcp.json',
      '.app.json',
    ];
    const leakedPublishedFiles = [];
    for (const relative of retiredPublishedFiles) {
      if (await exists(path.join(packageRoot, relative))) leakedPublishedFiles.push(relative);
    }
    invariant(
      leakedPublishedFiles.length === 0,
      `retired MCP/app outputs leaked into the published package: ${leakedPublishedFiles.join(', ')}`,
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
    invariant(skillEnvelope.data?.version === '1.0.2', 'installed skill bundle version changed');
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
    invariant(exportedManifest.version === '1.0.2', 'installed builder exported the wrong plugin version');
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
    console.log('OK: the disposable installed tarball completed free local checks without MCP or profile writes.');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
