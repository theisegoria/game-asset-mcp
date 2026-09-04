/**
 * Graphics lanes need environment variables the harness does not inherit:
 * lavapipe needs VK_ICD_FILENAMES, a Metal frame capture needs
 * MTL_CAPTURE_ENABLED, a software GL lane needs LIBGL_ALWAYS_SOFTWARE.
 *
 * The tempting fix is to widen the inherited allowlist. That would make a run's
 * meaning depend on the shell that launched it, which contradicts the
 * determinism the sealed-bundle model rests on. So the values are DECLARED in
 * the adapter, restricted to a hardcoded allowlist, and sealed into the plan.
 *
 * The allowlist is the security boundary. LD_* and DYLD_* are loader-injection
 * vectors: a capture harness that let a manifest set them would be a
 * code-execution primitive wearing a configuration hat.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAdapter, planScenarioRun } from '../src/harness/adapter.js';
import { writeHarnessProject } from './helpers/harness-fixture.js';

let root: string;
let projectRoot: string;
let source: string;
let objectIds: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'scenario-env-'));
  const project = await writeHarnessProject(root);
  projectRoot = project.projectRoot;
  source = path.relative(projectRoot, project.baselinePng);
  objectIds = path.relative(projectRoot, project.objectIdPng);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Rewrite the fixture adapter so its first scenario declares `environment`. */
async function withEnvironment(environment: Record<string, string>): Promise<void> {
  const manifestPath = path.join(projectRoot, '.game-dev', 'adapter.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
    scenarios: Array<Record<string, unknown>>;
  };
  manifest.scenarios[0]!.environment = environment;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

async function plan() {
  const adapter = await loadAdapter(projectRoot);
  return planScenarioRun({
    adapter,
    scenarioId: 'capture',
    runsRoot: path.join(root, 'runs'),
    parameters: { source, objectIds, frameTime: 12, mode: 'normal' },
  });
}

describe('a declared graphics environment', () => {
  it('is carried into the plan, so it is reviewable and gets sealed', async () => {
    await withEnvironment({
      VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json',
      LIBGL_ALWAYS_SOFTWARE: '1',
    });

    const resolved = await plan();

    expect(resolved.environment).toEqual({
      VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json',
      LIBGL_ALWAYS_SOFTWARE: '1',
    });
  });

  it('defaults to empty rather than absent, so every plan has the field', async () => {
    expect((await plan()).environment).toEqual({});
  });
});

describe('the allowlist is the boundary', () => {
  it.each([
    ['LD_PRELOAD', '/tmp/evil.so'],
    ['DYLD_INSERT_LIBRARIES', '/tmp/evil.dylib'],
    ['LD_LIBRARY_PATH', '/tmp'],
  ])('refuses %s, which would make this a code-execution primitive', async (name, value) => {
    await withEnvironment({ [name]: value });
    await expect(loadAdapter(projectRoot)).rejects.toThrow();
  });

  it('refuses DISPLAY, because surfaceless rendering is the whole point', async () => {
    await withEnvironment({ DISPLAY: ':0' });
    await expect(loadAdapter(projectRoot)).rejects.toThrow();
  });

  it('refuses the harness contract variables, so a manifest cannot redirect them', async () => {
    // GAME_DEV_RUN_DIR tells the game where to write its capture. A manifest
    // that could set it could aim the write anywhere.
    await withEnvironment({ GAME_DEV_RUN_DIR: '/tmp/anywhere' });
    await expect(loadAdapter(projectRoot)).rejects.toThrow();
  });
});
