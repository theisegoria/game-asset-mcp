/**
 * The probe SDK ships as source under node_modules, which is not a place an
 * engine's build can point at. `probe install` puts the two files where the
 * project can vendor them, with the same discipline as adapter installation:
 * plan first, write only on --confirm, never overwrite bytes that differ.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installProbeSdk, PROBE_SDK_FILES } from '../src/harness/probe-install.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let project: string;

beforeEach(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-install-'));
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

async function run(args: string[]): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args, '--json'], {
      env: { ...process.env, ASSET_LOG_LEVEL: 'error' },
      maxBuffer: 16 * 1024 * 1024,
    }, (_error, stdout, stderr) => {
      try { resolve(JSON.parse(stdout) as Record<string, any>); }
      catch (parseError) { reject(new Error(`non-JSON: ${stdout}\n${stderr}`, { cause: parseError })); }
    });
  });
}

function compilerAvailable(): boolean {
  try { execFileSync('cc', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

describe('probe install', () => {
  it('plans without writing, and names every file it would write', async () => {
    const result = await installProbeSdk({ projectRoot: project, confirm: false });

    expect(result.dryRun).toBe(true);
    expect(result.files.map((file) => file.name)).toEqual([...PROBE_SDK_FILES]);
    expect(result.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
    await expect(fs.access(result.destination)).rejects.toThrow();
  });

  it('writes both files on confirm, then reports them reused on a second run', async () => {
    const first = await installProbeSdk({ projectRoot: project, confirm: true });
    expect(first.reused).toBe(false);
    for (const file of first.files) {
      const bytes = await fs.readFile(file.path);
      expect(bytes.length).toBe(file.bytes);
    }

    // Idempotent: the same bytes are already there, so nothing is rewritten.
    const second = await installProbeSdk({ projectRoot: project, confirm: true });
    expect(second.reused).toBe(true);
    expect(second.files.every((file) => file.existed)).toBe(true);
  });

  it('refuses to overwrite a copy the project has changed', async () => {
    await installProbeSdk({ projectRoot: project, confirm: true });
    const header = path.join(project, 'third_party', 'gdprobe', 'gdprobe.h');
    await fs.appendFile(header, '\n/* local patch */\n');

    // A project may have patched its copy; silently replacing it would be the
    // worst way to find out. Refused on plan AND on confirm.
    await expect(installProbeSdk({ projectRoot: project, confirm: false })).rejects.toThrow(/different contents/);
    await expect(installProbeSdk({ projectRoot: project, confirm: true })).rejects.toThrow(/different contents/);
  });

  it('refuses a destination that escapes the project', async () => {
    await expect(installProbeSdk({ projectRoot: project, destination: '../outside', confirm: true }))
      .rejects.toThrow(/without \.\./);
    await expect(installProbeSdk({ projectRoot: project, destination: '/tmp/abs', confirm: true }))
      .rejects.toThrow(/project-relative/);
  });

  it('is reachable through the CLI, dry-run first', async () => {
    const plan = await run(['probe', 'install', '--project', project]);
    expect(plan.ok).toBe(true);
    expect(plan.data.dryRun).toBe(true);

    const done = await run(['probe', 'install', '--project', project, '--confirm']);
    expect(done.ok).toBe(true);
    expect(done.data.dryRun).toBe(false);
    await expect(fs.access(path.join(project, 'third_party', 'gdprobe', 'gdprobe.c'))).resolves.toBeUndefined();
  });

  it.skipIf(!compilerAvailable())('installs something that compiles under the flags it advertises', async () => {
    const result = await installProbeSdk({ projectRoot: project, confirm: true });
    // The `compile` hint is not decoration: run exactly what it says.
    const [command, ...args] = result.compile.split(' ');
    execFileSync(command!, [...args, '-o', path.join(project, 'gdprobe.o')], { cwd: project, stdio: 'pipe' });
    await expect(fs.access(path.join(project, 'gdprobe.o'))).resolves.toBeUndefined();
  });
});
