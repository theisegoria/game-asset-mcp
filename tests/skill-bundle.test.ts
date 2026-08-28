import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultCodexSkillsRoot,
  installSkillBundle,
  listSkillBundle,
} from '../src/skills/bundle.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-skills-'));
  roots.push(root);
  return root;
}

async function run(args: string[]): Promise<{ code: number; payload: Record<string, any>; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], {
      env: { ...process.env, ASSET_LOG_LEVEL: 'error' },
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      try {
        resolve({
          code: typeof error?.code === 'number' ? error.code : 0,
          payload: JSON.parse(stdout) as Record<string, any>,
          stderr,
        });
      } catch (parseError) {
        reject(new Error(`game-dev returned non-JSON: ${stdout}\n${stderr}`, { cause: parseError }));
      }
    });
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('packaged Codex skill suite', () => {
  it('validates five self-contained skills and computes stable closed rosters', async () => {
    const first = await listSkillBundle();
    const second = await listSkillBundle();
    expect(first).toEqual(second);
    expect(first).toMatchObject({ schema: 'game_dev.skill_bundle.v1', version: '1.0.1' });
    expect(first.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.skills.map((skill) => skill.id)).toEqual([
      'game-development-studio',
      'game-asset-production',
      'game-asset-vendoring',
      'game-visual-debugging',
      'game-performance-optimization',
    ]);
    for (const skill of first.skills) {
      expect(skill.contentSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(skill.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'SKILL.md' }),
        expect.objectContaining({ path: 'agents/openai.yaml' }),
        expect.objectContaining({ path: 'assets/icon.png' }),
        expect.objectContaining({ path: 'assets/icon-provenance.json' }),
      ]));
      expect(skill.files.every((file) => !path.isAbsolute(file.path) && !file.path.includes('..'))).toBe(true);
      const markdown = await readFile(path.join('skills', skill.relativePath, 'SKILL.md'), 'utf8');
      const metadata = await readFile(path.join('skills', skill.relativePath, 'agents', 'openai.yaml'), 'utf8');
      const icon = await readFile(path.join('skills', skill.relativePath, 'assets', 'icon.png'));
      const provenance = JSON.parse(await readFile(
        path.join('skills', skill.relativePath, 'assets', 'icon-provenance.json'),
        'utf8',
      )) as Record<string, unknown>;
      expect(markdown).not.toMatch(/\[TODO/i);
      expect(metadata).toContain(`$${skill.id}`);
      expect(metadata).toContain('icon_small: "./assets/icon.png"');
      expect(metadata).toContain('icon_large: "./assets/icon.png"');
      expect(metadata).toContain('brand_color: "#10C9D5"');
      expect(provenance).toMatchObject({
        schema: 'game_dev.image_asset_provenance.v1',
        asset: 'icon.png',
        generator: 'OpenAI ImageGen in Codex',
        inputImages: [],
      });
      expect(provenance.sha256).toBe(createHash('sha256').update(icon).digest('hex'));
    }
  });

  it('is dry-run-first, installs atomically, reuses exact bytes, and refuses drift or symlinks', async () => {
    const root = await temporaryRoot();
    const target = path.join(root, 'codex', 'skills');
    const dryRun = await installSkillBundle({ selection: 'all', targetRoot: target, confirm: false });
    expect(dryRun).toMatchObject({
      schema: 'game_dev.skill_install.v1',
      dryRun: true,
      installations: [{ reused: false }, { reused: false }, { reused: false }, { reused: false }, { reused: false }],
    });
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });

    const installed = await installSkillBundle({ selection: 'all', targetRoot: target, confirm: true });
    expect(installed).toMatchObject({ dryRun: false });
    expect((await readdir(target)).sort()).toEqual([
      'game-asset-production',
      'game-asset-vendoring',
      'game-development-studio',
      'game-performance-optimization',
      'game-visual-debugging',
    ]);
    expect((await readdir(path.dirname(target))).some((entry) => entry.includes('.install-'))).toBe(false);

    const reused = await installSkillBundle({ selection: 'all', targetRoot: target, confirm: true });
    expect((reused.installations as Array<{ reused: boolean }>).every((item) => item.reused)).toBe(true);

    await writeFile(path.join(target, 'game-asset-production', 'SKILL.md'), 'different\n');
    await expect(installSkillBundle({
      selection: 'game-asset-production',
      targetRoot: target,
      confirm: true,
    })).rejects.toThrow(/different content/i);

    const linkedTarget = path.join(root, 'linked-skills');
    const external = path.join(root, 'external');
    await mkdir(external);
    await symlink(external, linkedTarget);
    await expect(installSkillBundle({
      selection: 'game-development-studio',
      targetRoot: linkedTarget,
      confirm: false,
    })).rejects.toThrow(/non-symlink directory/i);
  });

  it('exposes list and explicit installation through the public CLI without touching the default profile', async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, 'workspace');
    const target = path.join(root, 'skills');
    expect(defaultCodexSkillsRoot({ CODEX_HOME: path.join(root, 'profile') })).toBe(path.join(root, 'profile', 'skills'));

    const listed = await run(['skill', 'list', '--output-dir', workspace, '--json']);
    expect(listed).toMatchObject({
      code: 0,
      payload: {
        schema: 'game_dev.result.v1',
        operation: 'skill.list',
        ok: true,
        data: { schema: 'game_dev.skill_bundle.v1', version: '1.0.1' },
      },
    });
    expect(listed.payload.data.skills).toHaveLength(5);

    const planned = await run([
      'skill', 'install', 'game-development-studio',
      '--target', target,
      '--output-dir', workspace,
      '--json',
    ]);
    expect(planned.payload).toMatchObject({
      operation: 'skill.install',
      ok: true,
      data: { dryRun: true, installations: [{ id: 'game-development-studio', reused: false }] },
    });
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });

    const installed = await run([
      'skill', 'install', 'game-development-studio',
      '--target', target,
      '--confirm',
      '--output-dir', workspace,
      '--json',
    ]);
    expect(installed).toMatchObject({
      code: 0,
      payload: {
        operation: 'skill.install',
        ok: true,
        data: { dryRun: false, installations: [{ id: 'game-development-studio', reused: false }] },
      },
    });
    await expect(access(path.join(target, 'game-development-studio', 'SKILL.md'))).resolves.toBeUndefined();
  });
});
