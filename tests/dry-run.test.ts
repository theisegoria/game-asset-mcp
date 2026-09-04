/**
 * `package build` and `catalog admit` were the only two write paths with no
 * plan step at all.
 *
 * Gating them behind --confirm would have been the uniform fix and the wrong
 * one: three shipped call sites invoke `package build` bare, and it only ever
 * writes inside the tool's own workspace, content-addressed and idempotent. So
 * the rule is stated accurately instead -- confirmation is for writes OUTSIDE
 * the workspace -- and both paths gain a plan.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeGameReadyGlb } from './helpers/model-fixture.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let work: string;

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'dry-run-'));
});

afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true });
});

async function run(args: string[]): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args, '--output-dir', work, '--json'], {
      env: { ...process.env, ASSET_LOG_LEVEL: 'error' },
      maxBuffer: 16 * 1024 * 1024,
    }, (_error, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout) as Record<string, any>);
      } catch (parseError) {
        reject(new Error(`game-dev returned non-JSON: ${stdout}\n${stderr}`, { cause: parseError }));
      }
    });
  });
}

async function entryCount(directory: string): Promise<number> {
  return fs.readdir(directory).then((names) => names.length, () => 0);
}

describe('package build --dry-run', () => {
  it('reports the validation verdict and destination without writing anything', async () => {
    const model = await writeGameReadyGlb(path.join(work, 'crate.glb'));
    const packagesDir = path.join(work, '.game-dev', 'packages');

    const payload = await run(['package', 'build', model, '--name', 'Crate', '--dry-run']);

    expect(payload.ok).toBe(true);
    expect(payload.data.dryRun).toBe(true);
    expect(payload.data.assetId).toBe('crate');
    expect(payload.data.version).toBe('1.0.0');
    expect(payload.data.destination).toContain(path.join('crate', '1.0.0'));
    expect(payload.data.destinationExists).toBe(false);
    expect(payload.data.wouldWrite).toBe(true);
    // The verdict is the reason to run a plan at all.
    expect(payload.data.validation).toHaveProperty('passed');
    expect(payload.data.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.data.evidence.nothingWritten).toBe(true);

    // Nothing on disk. Not "nothing important" -- nothing.
    expect(await entryCount(packagesDir)).toBe(0);
  });

  it('says plainly that it cannot compute the packageId, rather than guessing one', async () => {
    const model = await writeGameReadyGlb(path.join(work, 'crate.glb'));
    const payload = await run(['package', 'build', model, '--name', 'Crate', '--dry-run']);

    // The id hashes the staged file set, so producing it means doing the write
    // the plan exists to avoid. A guess a later build contradicts is worse.
    expect(payload.data).not.toHaveProperty('packageId');
    expect(payload.data.evidence.packageIdComputed).toBe(false);
    expect(payload.data.evidenceCeiling).toContain('cannot be computed');
  });

  it('predicts a destination that a real build then actually uses', async () => {
    const model = await writeGameReadyGlb(path.join(work, 'crate.glb'));
    const planned = await run(['package', 'build', model, '--name', 'Crate', '--dry-run']);
    const built = await run(['package', 'build', model, '--name', 'Crate']);

    expect(built.ok).toBe(true);
    expect(built.data.packagePath).toBe(planned.data.destination);

    // And a second plan now sees the package that exists.
    const replanned = await run(['package', 'build', model, '--name', 'Crate', '--dry-run']);
    expect(replanned.data.destinationExists).toBe(true);
    expect(replanned.data.wouldWrite).toBe(false);
  });
});

describe('catalog admit --dry-run', () => {
  it('reports the row it would index without touching the catalog', async () => {
    const model = await writeGameReadyGlb(path.join(work, 'crate.glb'));
    const built = await run(['package', 'build', model, '--name', 'Crate']);
    const packagePath = built.data.packagePath as string;

    const planned = await run(['catalog', 'admit', packagePath, '--dry-run']);

    expect(planned.ok).toBe(true);
    expect(planned.data.dryRun).toBe(true);
    expect(planned.data.asset.packageId).toBe(built.data.packageId);
    // package build already admitted it, so a plan must say so rather than
    // implying a fresh insert.
    expect(planned.data.alreadyIndexed).toBe(true);
    expect(planned.data.evidence.nothingWritten).toBe(true);
  });
});
