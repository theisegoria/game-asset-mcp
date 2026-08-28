import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GAME_DEV_ADAPTER_SCHEMA } from '../src/harness/contracts.js';

const roots: string[] = [];

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('CLI signal cleanup', () => {
  it('terminates an owned detached scenario group before the CLI exits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-signal-'));
    roots.push(root);
    const projectRoot = path.join(root, 'game');
    const outputRoot = path.join(root, 'output');
    const pidPath = path.join(projectRoot, 'worker.pid');
    await mkdir(path.join(projectRoot, '.game-dev'), { recursive: true });

    const runnerPath = path.join(projectRoot, 'runner.mjs');
    await writeFile(runnerPath, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
  stdio: ['ignore', process.stdout, process.stderr],
});
await writeFile(path.join(process.cwd(), 'worker.pid'), String(worker.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);
    await chmod(runnerPath, 0o755);
    await writeFile(path.join(projectRoot, '.game-dev', 'adapter.json'), JSON.stringify({
      schema: GAME_DEV_ADAPTER_SCHEMA,
      id: 'signal-fixture',
      name: 'Signal fixture',
      version: '1.0.0',
      scenarios: [{
        id: 'cancel-me',
        title: 'Cancellation fixture',
        command: { executable: 'runner.mjs', arguments: [], workingDirectory: '.' },
        timeoutSeconds: 30,
        capabilities: ['cpu', 'project-write'],
        parameters: {},
        outputs: { format: 'none' },
      }],
    }));

    const cli = spawn(process.execPath, [
      path.join(process.cwd(), 'dist', 'cli.js'),
      'scenario', 'run', 'cancel-me',
      '--project', projectRoot,
      '--confirm',
      '--json',
      '--output-dir', outputRoot,
    ], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? root,
        TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
        LANG: process.env.LANG ?? 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let workerPid = 0;
    try {
      await waitUntil(async () => {
        try {
          workerPid = Number.parseInt(await readFile(pidPath, 'utf8'), 10);
          return Number.isSafeInteger(workerPid) && workerPid > 0;
        } catch {
          return false;
        }
      }, 5_000);

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        cli.once('exit', (code, signal) => resolve({ code, signal }));
      });
      cli.kill('SIGTERM');
      const outcome = await Promise.race([
        exited,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('CLI did not exit after SIGTERM')),
          5_000,
        )),
      ]);

      expect(outcome).toEqual({ code: 143, signal: null });
      await waitUntil(async () => !processExists(workerPid), 1_000);
    } finally {
      if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
      if (workerPid > 0 && processExists(workerPid)) {
        try {
          process.kill(workerPid, 'SIGKILL');
        } catch {
          // The process exited between the check and cleanup.
        }
      }
    }
  }, 10_000);
});
