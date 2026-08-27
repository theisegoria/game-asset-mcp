import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const roots: string[] = [];

interface Invocation {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Invocation> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        TRIPO_API_KEY: '',
        LEONARDO_API_KEY: '',
        ASSET_LOG_LEVEL: 'error',
        ...env,
      },
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-cli-durable-'));
  roots.push(root);
  return root;
}

async function durableJobs(root: string): Promise<Array<Record<string, unknown>>> {
  const jobsRoot = path.join(root, '.game-dev', 'jobs');
  const entries = await readdir(jobsRoot);
  return Promise.all(entries.map(async (entry) => JSON.parse(
    await readFile(path.join(jobsRoot, entry, 'job.json'), 'utf8'),
  ) as Record<string, unknown>));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('game-dev durable CLI contract', () => {
  it('documents the confirmation and fresh paid-approval boundary for resume', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('game-dev job resume <job-id> --confirm');
    expect(result.stdout).toContain('[--approve-spend --spend-limit-cents N]');
  });

  it('stops paid provider work at an explicit approval boundary before credentials or network', async () => {
    const root = await workspace();
    const request = JSON.stringify({
      textPrompt: 'a simple brass cube',
      spec: { name: 'brass_cube', description: 'A simple brass cube.' },
    });
    const result = await run([
      'provider', 'tripo', 'generate',
      '--input', request,
      '--output-dir', root,
      '--json',
    ]);

    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as Record<string, any>;
    expect(envelope.error.error).toBe('APPROVAL_REQUIRED');
    const [job] = await durableJobs(root);
    expect(job?.status).toBe('approval_required');
    expect(job?.request).toMatchObject({ input: JSON.parse(request) });
    expect(result.stderr).not.toContain('TRIPO_API_KEY');
  });

  it('requires a fresh confirmation and spend ceiling when retrying a paid job', async () => {
    const root = await workspace();
    const request = JSON.stringify({
      textPrompt: 'a simple brass cube',
      spec: { name: 'brass_cube', description: 'A simple brass cube.' },
    });
    await run(['provider', 'tripo', 'generate', '--input', request, '--output-dir', root, '--json']);
    const [source] = await durableJobs(root);
    const jobId = String(source?.id);

    const unconfirmed = await run(['job', 'resume', jobId, '--output-dir', root, '--json']);
    expect(JSON.parse(unconfirmed.stdout).error.error).toBe('APPROVAL_REQUIRED');
    expect((await durableJobs(root))).toHaveLength(1);

    const retried = await run([
      'job', 'resume', jobId,
      '--confirm',
      '--approve-spend',
      '--spend-limit-cents', '30',
      '--output-dir', root,
      '--json',
    ]);
    expect(retried.code).toBe(1);
    const retryEnvelope = JSON.parse(retried.stdout) as Record<string, any>;
    expect(retryEnvelope.error.result.error).toBe('CONFIG_MISSING');
    const jobs = await durableJobs(root);
    expect(jobs).toHaveLength(2);
    const child = jobs.find((job) => job.parentJobId === jobId);
    expect(child).toMatchObject({ status: 'failed', parentJobId: jobId });
  });

  it('follows a stopped durable job without waiting for the timeout', async () => {
    const root = await workspace();
    await run([
      'provider', 'tripo', 'generate',
      '--input', JSON.stringify({ textPrompt: 'cube', spec: { name: 'cube', description: 'cube' } }),
      '--output-dir', root,
      '--json',
    ]);
    const [source] = await durableJobs(root);
    const result = await run([
      'job', 'follow', String(source?.id),
      '--max-seconds', '30',
      '--output-dir', root,
      '--json',
    ]);
    const envelope = JSON.parse(result.stdout) as Record<string, any>;
    expect(result.code).toBe(0);
    expect(envelope.data).toMatchObject({
      status: 'approval_required',
      waitingForApproval: true,
      timedOut: false,
    });
  });
});
