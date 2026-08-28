import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const builder = path.join(sourceRoot, 'scripts', 'build-skills-repository.mjs');
const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const roots: string[] = [];

interface RunResult {
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd = sourceRoot, env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr || stdout}`, { cause: error }));
      else resolve({ stdout, stderr });
    });
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-release-'));
  roots.push(root);
  return root;
}

async function exportRepository(root: string, exporter = builder): Promise<string> {
  const destination = path.join(root, 'public-skills-repository');
  await run(process.execPath, [exporter, destination]);
  return destination;
}

async function sourceVerifierFixture(root: string): Promise<string> {
  const fixture = path.join(root, 'source-fixture');
  await mkdir(fixture);
  for (const relative of ['.codex-plugin', 'assets', 'distribution', 'marketing', 'skills']) {
    await cp(path.join(sourceRoot, relative), path.join(fixture, relative), { recursive: true });
  }
  for (const relative of ['CHANGELOG.md', 'LICENSE', 'PRIVACY.md', 'README.md', 'SECURITY.md', 'SUPPORT.md', 'TERMS.md']) {
    await cp(path.join(sourceRoot, relative), path.join(fixture, relative));
  }
  await mkdir(path.join(fixture, 'scripts'));
  for (const relative of ['build-skills-repository.mjs', 'verify-plugin.mjs']) {
    await cp(path.join(sourceRoot, 'scripts', relative), path.join(fixture, 'scripts', relative));
  }
  await symlink(path.join(sourceRoot, 'node_modules'), path.join(fixture, 'node_modules'));
  return fixture;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('public release distribution', () => {
  it('packs every README asset, policy, and runnable exporter dependency without MCP output', async () => {
    const root = await temporaryRoot();
    const result = await run(npmExecutable, [
      'pack',
      '--dry-run',
      '--ignore-scripts',
      '--json',
      '--cache', path.join(root, 'npm-cache'),
    ]);
    const records = JSON.parse(result.stdout) as Array<{
      entryCount: number;
      files: Array<{ path: string }>;
    }>;
    expect(records).toHaveLength(1);
    const record = records[0];
    if (!record) throw new Error('npm pack returned no release record');
    const files = record.files.map((entry) => entry.path);

    expect(record.entryCount).toBe(files.length);
    expect(files).toEqual(expect.arrayContaining([
      'README.md',
      'PRIVACY.md',
      'SECURITY.md',
      'SUPPORT.md',
      'TERMS.md',
      'assets/icon.png',
      'assets/screenshots/01-skill-suite.png',
      'assets/screenshots/02-cli-contract.png',
      'assets/screenshots/03-visual-debugging.png',
      '.codex-plugin/plugin.json',
      'marketing/COPY.md',
      'marketing/STORE_SUBMISSION.md',
      'scripts/build-skills-repository.mjs',
      'distribution/skills-repo/README.md',
      'distribution/skills-repo/PLUGIN_README.md',
      'distribution/skills-repo/gitignore.template',
      'distribution/skills-repo/.agents/plugins/marketplace.json',
      'distribution/skills-repo/.github/workflows/validate.yml',
      'distribution/skills-repo/scripts/build_release.py',
      'distribution/skills-repo/scripts/verify.py',
      'distribution/skills-repo/release-roster.json',
    ]));
    expect(files).not.toEqual(expect.arrayContaining([
      'dist/server.js',
      'dist/server.js.map',
      'dist/server.d.ts',
      '.mcp.json',
      '.app.json',
    ]));
  }, 30_000);

  it('exports repository-root marketing images and a screenshot-free plugin archive', async () => {
    const root = await temporaryRoot();
    const destination = path.join(root, 'public-skills-repository');
    const result = await run(process.execPath, [builder, destination]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      schema: 'game_dev.skills_repository_export.v1',
      plugin: 'plugins/game-development-studio',
      mcp: false,
    });

    const plugin = path.join(destination, 'plugins', 'game-development-studio');
    const pluginReadme = await readFile(path.join(plugin, 'README.md'), 'utf8');
    expect(pluginReadme).not.toContain('assets/screenshots/');
    await expect(access(path.join(plugin, 'assets', 'icon.png'))).resolves.toBeUndefined();
    for (const relative of [
      'assets/screenshots/01-skill-suite.png',
      'assets/screenshots/02-cli-contract.png',
      'assets/screenshots/03-visual-debugging.png',
    ]) {
      await expect(access(path.join(destination, relative))).resolves.toBeUndefined();
      await expect(access(path.join(plugin, relative))).rejects.toThrow();
    }
    for (const relative of [
      'assets/macos/AppIcon.icns',
      'assets/macos/AppIcon.png',
      'assets/macos/AppIcon.provenance.json',
      'marketing/01-skill-suite.html',
      'marketing/02-cli-contract.html',
      'marketing/03-visual-debugging.html',
      'marketing/MACOS_APP_COPY.md',
      'marketing/COPY.md',
      'marketing/STORE_SUBMISSION.md',
      'assets/generated',
    ]) {
      await expect(access(path.join(plugin, relative))).rejects.toThrow();
    }
    await expect(access(path.join(destination, 'marketing', 'COPY.md'))).resolves.toBeUndefined();
    await expect(access(path.join(destination, 'marketing', 'STORE_SUBMISSION.md'))).resolves.toBeUndefined();
    await expect(access(path.join(destination, '.gitignore'))).resolves.toBeUndefined();
    await expect(access(path.join(destination, '.agents', 'plugins', 'marketplace.json'))).resolves.toBeUndefined();
    await expect(access(path.join(destination, '.github', 'workflows', 'validate.yml'))).resolves.toBeUndefined();
    const verification = await run(pythonExecutable, ['scripts/verify.py'], destination);
    expect(JSON.parse(verification.stdout)).toMatchObject({
      schema: 'game_dev.public_plugin_verification.v1',
      version: '1.0.2',
      screenshots: 0,
      marketingScreenshots: 3,
    });

    const archive = path.join(root, 'plugin.zip');
    await expect(run(pythonExecutable, ['scripts/build_release.py', archive], destination)).resolves.toMatchObject({
      stdout: expect.stringContaining('files 36'),
    });
    expect((await readFile(archive)).includes(Buffer.from('assets/screenshots/'))).toBe(false);

    const manifest = JSON.parse(await readFile(
      path.join(plugin, '.codex-plugin', 'plugin.json'),
      'utf8',
    )) as { version?: string; interface?: Record<string, unknown> };
    expect(manifest.version).toBe('1.0.2');
    expect(manifest).not.toHaveProperty('mcpServers');
    expect(manifest).not.toHaveProperty('apps');
    expect(manifest.interface?.screenshots).toBeUndefined();
  });

  it('rejects screenshots from no-UI source and exported plugin manifests', async () => {
    const sourceRootFixture = await temporaryRoot();
    const sourceFixture = await sourceVerifierFixture(sourceRootFixture);
    const sourceManifestPath = path.join(sourceFixture, '.codex-plugin', 'plugin.json');
    const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8')) as {
      interface: Record<string, unknown>;
    };
    sourceManifest.interface.screenshots = ['./assets/screenshots/01-skill-suite.png'];
    await writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`);
    await expect(run(process.execPath, [path.join(sourceFixture, 'scripts', 'verify-plugin.mjs')], sourceFixture))
      .rejects.toThrow(/skills-only plugin must not declare screenshots/);

    const exportRoot = await temporaryRoot();
    const destination = await exportRepository(exportRoot);
    const manifestPath = path.join(destination, 'plugins', 'game-development-studio', '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      interface: Record<string, unknown>;
    };
    manifest.interface.screenshots = ['./assets/screenshots/01-skill-suite.png'];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(run(pythonExecutable, ['scripts/verify.py'], destination))
      .rejects.toThrow(/skills-only plugin must not declare screenshots/);
  });

  it('rejects an exporter destination within its source root, including a symlink alias', async () => {
    const root = await temporaryRoot();
    const literalChild = path.join(sourceRoot, `.release-export-${path.basename(root)}`);
    await expect(run(process.execPath, [builder, sourceRoot])).rejects.toThrow(/outside the source root/);
    await expect(run(process.execPath, [builder, literalChild])).rejects.toThrow(/outside the source root/);
    await expect(access(literalChild)).rejects.toThrow();

    const sourceAlias = path.join(root, 'source-alias');
    await symlink(sourceRoot, sourceAlias);
    const aliasChild = path.join(sourceAlias, path.basename(literalChild));
    await expect(run(process.execPath, [builder, aliasChild])).rejects.toThrow(/outside the source root/);
    await expect(access(aliasChild)).rejects.toThrow();
  });

  it('requires an explicit archive output outside the exported repository and plugin', async () => {
    const root = await temporaryRoot();
    const destination = await exportRepository(root);
    const plugin = path.join(destination, 'plugins', 'game-development-studio');
    const outputCandidates = [
      path.join(destination, 'game-development-studio-plugin.zip'),
      path.join(plugin, 'game-development-studio-plugin.zip'),
    ];

    await expect(run(pythonExecutable, ['scripts/build_release.py'], destination)).rejects.toThrow(/usage: .*OUTPUT_PATH/);
    for (const output of outputCandidates) {
      await expect(run(pythonExecutable, ['scripts/build_release.py', output], destination))
        .rejects.toThrow(/outside the exported repository and plugin/);
      await expect(access(output)).rejects.toThrow();
    }
  });

  it('accepts only repository-root Git administrative state in initialized and cloned exports', async () => {
    const root = await temporaryRoot();
    const destination = await exportRepository(root);

    const gitdirFixtureRoot = await temporaryRoot();
    const gitdirFixture = await exportRepository(gitdirFixtureRoot);
    const gitdirPath = path.join(gitdirFixture, '.git');
    await writeFile(gitdirPath, 'gitdir: /private/tmp/release-fixture-admin\n');
    await expect(run(pythonExecutable, ['scripts/verify.py'], gitdirFixture)).resolves.toMatchObject({
      stdout: expect.stringContaining('game_dev.public_plugin_verification.v1'),
    });
    await writeFile(gitdirPath, 'gitdir: /private/tmp/release-fixture-admin\nunexpected second line\n');
    await expect(run(pythonExecutable, ['scripts/verify.py'], gitdirFixture))
      .rejects.toThrow(/well-formed single-line gitdir file/);
    await writeFile(gitdirPath, 'gitdir: \n');
    await expect(run(pythonExecutable, ['scripts/verify.py'], gitdirFixture))
      .rejects.toThrow(/well-formed single-line gitdir file/);

    await run('git', ['init', '--quiet'], destination);
    await expect(run(pythonExecutable, ['scripts/verify.py'], destination)).resolves.toMatchObject({
      stdout: expect.stringContaining('game_dev.public_plugin_verification.v1'),
    });

    await run('git', ['add', '.'], destination);
    await run('git', [
      '-c', 'user.name=Release Fixture',
      '-c', 'user.email=release-fixture@example.invalid',
      'commit', '--quiet', '-m', 'fixture export',
    ], destination);
    const cloned = path.join(root, 'cloned-public-skills-repository');
    await run('git', ['clone', '--quiet', destination, cloned], root);
    await expect(run(pythonExecutable, ['scripts/verify.py'], cloned)).resolves.toMatchObject({
      stdout: expect.stringContaining('game_dev.public_plugin_verification.v1'),
    });

    const archive = path.join(root, 'cloned-plugin.zip');
    await expect(run(pythonExecutable, ['scripts/build_release.py', archive], cloned)).resolves.toMatchObject({
      stdout: expect.stringContaining('files 36'),
    });

    const nestedGit = path.join(cloned, 'plugins', 'game-development-studio', '.git');
    await mkdir(nestedGit);
    await expect(run(pythonExecutable, ['scripts/verify.py'], cloned)).rejects.toThrow(/unexpected file|closed release roster|empty directory/);
  }, 30_000);

  it('rejects unexpected empty directories in the source and exported release trees', async () => {
    const root = await temporaryRoot();
    const sourceFixture = await sourceVerifierFixture(root);
    const emptySourceDirectory = path.join(sourceFixture, 'assets', 'unexpected-empty-directory');
    await mkdir(emptySourceDirectory);
    const blockedDestination = path.join(root, 'blocked-export');
    await expect(run(
      process.execPath,
      [path.join(sourceFixture, 'scripts', 'build-skills-repository.mjs'), blockedDestination],
    )).rejects.toThrow(/empty directory is not allowed in source release scope/);
    await expect(access(blockedDestination)).rejects.toThrow();

    const exportRoot = await temporaryRoot();
    const destination = await exportRepository(exportRoot);
    const plugin = path.join(destination, 'plugins', 'game-development-studio');
    await mkdir(path.join(plugin, 'unexpected-empty-directory'));
    await expect(run(pythonExecutable, ['scripts/verify.py'], destination))
      .rejects.toThrow(/empty directory is not allowed/);
    const archive = path.join(exportRoot, 'plugin.zip');
    await expect(run(pythonExecutable, ['scripts/build_release.py', archive], destination))
      .rejects.toThrow(/empty directory is not allowed/);
    await expect(access(archive)).rejects.toThrow();
  }, 30_000);

  it('enforces field-exact policy URLs and confined matching icons in both verifiers', async () => {
    const sourceRootFixture = await temporaryRoot();
    const sourceFixture = await sourceVerifierFixture(sourceRootFixture);
    const sourceManifestPath = path.join(sourceFixture, '.codex-plugin', 'plugin.json');
    const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8')) as {
      interface: Record<string, string>;
    };
    const sourcePrivacyURL = sourceManifest.interface.privacyPolicyURL;
    const sourceTermsURL = sourceManifest.interface.termsOfServiceURL;
    if (sourcePrivacyURL === undefined || sourceTermsURL === undefined) {
      throw new Error('source fixture has incomplete policy URLs');
    }
    sourceManifest.interface.privacyPolicyURL = sourceTermsURL;
    await writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`);
    await expect(run(process.execPath, [path.join(sourceFixture, 'scripts', 'verify-plugin.mjs')], sourceFixture))
      .rejects.toThrow(/unexpected privacy URL/);
    sourceManifest.interface.privacyPolicyURL = sourcePrivacyURL;
    sourceManifest.interface.termsOfServiceURL = sourcePrivacyURL;
    await writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`);
    await expect(run(process.execPath, [path.join(sourceFixture, 'scripts', 'verify-plugin.mjs')], sourceFixture))
      .rejects.toThrow(/unexpected terms URL/);
    sourceManifest.interface.termsOfServiceURL = sourceTermsURL;
    sourceManifest.interface.supportURL = 'https://example.invalid/support';
    await writeFile(sourceManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`);
    await expect(run(process.execPath, [path.join(sourceFixture, 'scripts', 'verify-plugin.mjs')], sourceFixture))
      .rejects.toThrow(/unsupported plugin interface field: supportURL/);

    const exportRoot = await temporaryRoot();
    const destination = await exportRepository(exportRoot);
    const manifestPath = path.join(destination, 'plugins', 'game-development-studio', '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      interface: Record<string, string>;
    };
    const privacyURL = manifest.interface.privacyPolicyURL;
    const termsURL = manifest.interface.termsOfServiceURL;
    if (privacyURL === undefined || termsURL === undefined) throw new Error('exported fixture has incomplete policy URLs');
    manifest.interface.privacyPolicyURL = termsURL;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(run(pythonExecutable, ['scripts/verify.py'], destination)).rejects.toThrow(/unexpected privacy URL/);
    manifest.interface.privacyPolicyURL = privacyURL;
    manifest.interface.termsOfServiceURL = privacyURL;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(run(pythonExecutable, ['scripts/verify.py'], destination)).rejects.toThrow(/unexpected terms URL/);

    manifest.interface.termsOfServiceURL = termsURL;
    manifest.interface.supportURL = 'https://example.invalid/support';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(run(pythonExecutable, ['scripts/verify.py'], destination))
      .rejects.toThrow(/unsupported plugin interface fields: \['supportURL'\]/);
    delete manifest.interface.supportURL;
    manifest.interface.logo = './README.md';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(run(pythonExecutable, ['scripts/verify.py'], destination))
      .rejects.toThrow(/composer icon and logo must share the suite mark/);

    manifest.interface.logo = './assets/icon.png';
    manifest.interface.composerIcon = './../../README.md';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(run(pythonExecutable, ['scripts/verify.py'], destination)).rejects.toThrow(/composerIcon escapes the plugin root/);
  }, 30_000);

  it('requires top-level and skill icon provenance hashes and 1254px dimensions', async () => {
    const root = await temporaryRoot();
    const destination = await exportRepository(root);
    const plugin = path.join(destination, 'plugins', 'game-development-studio');
    const iconPath = path.join(plugin, 'assets', 'icon.png');
    const provenancePath = path.join(plugin, 'assets', 'icon-provenance.json');
    const originalIcon = await readFile(iconPath);
    const originalProvenance = await readFile(provenancePath, 'utf8');

    await writeFile(iconPath, 'tampered image');
    await expect(run(pythonExecutable, ['scripts/verify.py'], destination)).rejects.toThrow(/suite icon hash mismatch/);

    const onePixelPng = Buffer.alloc(24);
    onePixelPng.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    onePixelPng.writeUInt32BE(13, 8);
    onePixelPng.write('IHDR', 12, 'ascii');
    onePixelPng.writeUInt32BE(1, 16);
    onePixelPng.writeUInt32BE(1, 20);
    const onePixelHash = createHash('sha256').update(onePixelPng).digest('hex');
    const suiteProvenance = JSON.parse(originalProvenance) as Record<string, unknown>;
    suiteProvenance.sha256 = onePixelHash;
    await writeFile(iconPath, onePixelPng);
    await writeFile(provenancePath, `${JSON.stringify(suiteProvenance, null, 2)}\n`);
    await expect(run(pythonExecutable, ['scripts/verify.py'], destination)).rejects.toThrow(/suite icon dimensions changed/);

    await writeFile(iconPath, originalIcon);
    await writeFile(provenancePath, originalProvenance);
    const skillRoot = path.join(plugin, 'skills', 'game-asset-production', 'assets');
    const skillIconPath = path.join(skillRoot, 'icon.png');
    const skillProvenancePath = path.join(skillRoot, 'icon-provenance.json');
    const skillProvenance = JSON.parse(await readFile(skillProvenancePath, 'utf8')) as Record<string, unknown>;
    skillProvenance.sha256 = onePixelHash;
    await writeFile(skillIconPath, onePixelPng);
    await writeFile(skillProvenancePath, `${JSON.stringify(skillProvenance, null, 2)}\n`);
    await expect(run(pythonExecutable, ['scripts/verify.py'], destination))
      .rejects.toThrow(/game-asset-production icon dimensions changed/);
  }, 30_000);

  it('exports only the closed roster and refuses unsafe or unexpected archive inputs', async () => {
    const fixtures = [
      { name: 'environment files', relative: 'assets/.env', contents: 'TOKEN=must-not-ship', message: /\.env|unexpected/ },
      { name: 'credential files', relative: 'assets/provider.key', contents: 'private', message: /credential|unexpected/ },
      { name: 'source files', relative: 'skills/game-development-studio/source.swift', contents: 'import Foundation', message: /source|unexpected/ },
    ];

    for (const fixture of fixtures) {
      const root = await temporaryRoot();
      const destination = path.join(root, 'public-skills-repository');
      await run(process.execPath, [builder, destination]);
      const plugin = path.join(destination, 'plugins', 'game-development-studio');
      await writeFile(path.join(plugin, fixture.relative), fixture.contents, { flag: 'wx' });

      await expect(run(pythonExecutable, ['scripts/verify.py'], destination)).rejects.toThrow(fixture.message);
      const archive = path.join(root, 'plugin.zip');
      await expect(run(pythonExecutable, ['scripts/build_release.py', archive], destination)).rejects.toThrow(fixture.message);
      await expect(access(archive)).rejects.toThrow();
    }

    const symlinkRoot = await temporaryRoot();
    const symlinkDestination = path.join(symlinkRoot, 'public-skills-repository');
    await run(process.execPath, [builder, symlinkDestination]);
    const symlinkPlugin = path.join(symlinkDestination, 'plugins', 'game-development-studio');
    await symlink('README.md', path.join(symlinkPlugin, 'assets', 'README-link'));
    await expect(run(pythonExecutable, ['scripts/verify.py'], symlinkDestination)).rejects.toThrow(/symlink/);
    await expect(run(pythonExecutable, ['scripts/build_release.py', path.join(symlinkRoot, 'plugin.zip')], symlinkDestination))
      .rejects.toThrow(/symlink/);

    const executableRoot = await temporaryRoot();
    const executableDestination = path.join(executableRoot, 'public-skills-repository');
    await run(process.execPath, [builder, executableDestination]);
    const executableManifest = path.join(
      executableDestination,
      'plugins',
      'game-development-studio',
      '.codex-plugin',
      'plugin.json',
    );
    await chmod(executableManifest, 0o755);
    await expect(run(pythonExecutable, ['scripts/verify.py'], executableDestination)).rejects.toThrow(/executable/);
    await expect(run(pythonExecutable, ['scripts/build_release.py', path.join(executableRoot, 'plugin.zip')], executableDestination))
      .rejects.toThrow(/executable/);
  });
});
