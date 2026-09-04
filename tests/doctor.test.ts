import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { listSkillBundle } from '../src/skills/bundle.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const roots: string[] = [];

interface DoctorCheck {
  id: string;
  status: string;
  detail: string;
  evidence?: { skills?: Array<{ name: string; installed: boolean }> };
}

async function temporaryCodexHome(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-doctor-'));
  roots.push(root);
  return root;
}

async function run(args: string[], codexHome: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], {
      env: { ...process.env, ASSET_LOG_LEVEL: 'error', CODEX_HOME: codexHome },
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

function skillsCheck(payload: Record<string, any>): DoctorCheck {
  const checks = payload.data.checks as DoctorCheck[];
  const check = checks.find((entry) => entry.id === 'codex-skills');
  if (!check) throw new Error('doctor did not report a codex-skills check');
  return check;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('doctor codex-skills check', () => {
  it('expects exactly the skill ids that the bundle actually ships', async () => {
    // The drift this locks: doctor once hardcoded three ids that no longer
    // shipped, so the check warned forever and `skill install all` could not
    // clear it. Comparing against the bundle keeps the two definitions welded.
    const codexHome = await temporaryCodexHome();
    const bundle = await listSkillBundle();
    const reported = skillsCheck(await run(['doctor', '--json'], codexHome))
      .evidence?.skills?.map((skill) => skill.name) ?? [];

    expect([...reported].sort()).toEqual(bundle.skills.map((skill) => skill.id).sort());
  });

  it('passes once every packaged skill is installed', async () => {
    const codexHome = await temporaryCodexHome();

    const before = skillsCheck(await run(['doctor', '--json'], codexHome));
    expect(before.status).toBe('warning');
    expect(before.evidence?.skills?.every((skill) => !skill.installed)).toBe(true);

    await run(['skill', 'install', 'all', '--confirm', '--json'], codexHome);

    const after = skillsCheck(await run(['doctor', '--json'], codexHome));
    expect(after.evidence?.skills?.every((skill) => skill.installed)).toBe(true);
    expect(after.status).toBe('pass');
  });
});
