import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { writeGameReadyGlb } from './helpers/model-fixture.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-cli-package-'));
  roots.push(root);
  return root;
}

async function run(args: string[]): Promise<{ code: number; payload: Record<string, any>; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], {
      env: { ...process.env, ASSET_LOG_LEVEL: 'error' },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      try {
        resolve({
          code: typeof error?.code === 'number' ? error.code : 0,
          payload: JSON.parse(stdout) as Record<string, any>,
          stderr,
        });
      } catch (parseError) {
        reject(new Error(`non-JSON CLI output: ${stdout}\n${stderr}`, { cause: parseError }));
      }
    });
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('game-dev package/catalog/vendor CLI', () => {
  it('builds, indexes, verifies, plans launch, and vendors through stable envelopes', async () => {
    const root = await temporaryRoot();
    const model = await writeGameReadyGlb(path.join(root, 'source.glb'));
    const built = await run([
      'package', 'build', model,
      '--name', 'CLI Orrery',
      '--version', '1.0.0',
      '--license', 'CC0-1.0',
      '--category', 'environment_prop',
      '--output-dir', root,
      '--json',
    ]);
    expect(built.code, JSON.stringify(built.payload)).toBe(0);
    expect(built.payload).toMatchObject({
      schema: 'game_dev.result.v1',
      operation: 'package.build',
      ok: true,
      data: {
        schema: 'game_dev.package_build_result.v1',
        validation: { passed: true },
        evidence: { gpuImportTestPerformed: false },
      },
    });
    const packageId = String(built.payload.data.packageId);
    const jobIds = await readdir(path.join(root, '.game-dev', 'jobs'));
    expect(jobIds).toHaveLength(1);
    const durable = JSON.parse(
      await readFile(path.join(root, '.game-dev', 'jobs', jobIds[0]!, 'job.json'), 'utf8'),
    ) as Record<string, any>;
    expect(durable).toMatchObject({
      status: 'completed',
      artifacts: [
        { kind: 'asset_package' },
        { kind: 'manifest' },
        { kind: 'receipt' },
      ],
    });

    const listed = await run(['catalog', 'list', '--query', 'orrery', '--output-dir', root, '--json']);
    expect(listed.payload.data).toMatchObject({ total: 1, assets: [{ packageId }] });

    const verified = await run(['package', 'verify', packageId, '--output-dir', root, '--json']);
    expect(verified.payload.data).toMatchObject({ manifest: { packageId }, hashesVerified: true });

    const launch = await run([
      'launch', packageId,
      '--with', 'blender',
      '--output-dir', root,
      '--json',
    ]);
    expect(launch.payload).toMatchObject({
      operation: 'launch.plan',
      data: { application: 'blender', dryRun: true, executable: '/usr/bin/open' },
    });

    const project = path.join(root, 'game-project');
    await mkdir(project);
    const dryRun = await run([
      'vendor', 'admit', packageId,
      '--project', project,
      '--output-dir', root,
      '--json',
    ]);
    expect(dryRun.payload.data).toMatchObject({ dryRun: true, blockers: [] });
    await expect(access(path.join(project, '.game-dev'))).rejects.toMatchObject({ code: 'ENOENT' });

    const admitted = await run([
      'vendor', 'admit', packageId,
      '--project', project,
      '--confirm',
      '--output-dir', root,
      '--json',
    ]);
    expect(admitted.payload.data).toMatchObject({
      dryRun: false,
      packageId,
      evidence: { copiedPackageHashesVerified: true, gpuRenderTestPerformed: false },
    });
    await expect(access(String(admitted.payload.data.lockPath))).resolves.toBeUndefined();
  });

  it('keeps unrelated capability discovery free of SQLite experimental warnings', async () => {
    const root = await temporaryRoot();
    const result = await run(['capabilities', '--output-dir', root, '--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('SQLite is an experimental feature');
  });
});
