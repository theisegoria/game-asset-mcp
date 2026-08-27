import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const builder = path.join(sourceRoot, 'scripts', 'build-skills-repository.mjs');
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
      'distribution/skills-repo/gitignore.template',
      'distribution/skills-repo/.agents/plugins/marketplace.json',
      'distribution/skills-repo/.github/workflows/validate.yml',
      'distribution/skills-repo/scripts/build_release.py',
      'distribution/skills-repo/scripts/verify.py',
    ]));
    expect(files).not.toEqual(expect.arrayContaining([
      'dist/server.js',
      'dist/server.js.map',
      'dist/server.d.ts',
      '.mcp.json',
      '.app.json',
    ]));
  }, 30_000);

  it('exports a standalone repository and plugin README with locally resolvable images', async () => {
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
    expect(pluginReadme).not.toContain('plugins/game-development-studio/assets/');
    for (const relative of [
      'assets/icon.png',
      'assets/screenshots/01-skill-suite.png',
      'assets/screenshots/02-cli-contract.png',
      'assets/screenshots/03-visual-debugging.png',
    ]) {
      expect(pluginReadme).toContain(relative);
      await expect(access(path.join(plugin, relative))).resolves.toBeUndefined();
    }
    await expect(access(path.join(destination, '.gitignore'))).resolves.toBeUndefined();
    await expect(access(path.join(destination, '.agents', 'plugins', 'marketplace.json'))).resolves.toBeUndefined();
    await expect(access(path.join(destination, '.github', 'workflows', 'validate.yml'))).resolves.toBeUndefined();

    const manifest = JSON.parse(await readFile(
      path.join(plugin, '.codex-plugin', 'plugin.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('mcpServers');
    expect(manifest).not.toHaveProperty('apps');
  });
});
