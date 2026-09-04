/**
 * One product, one version, five places that state it.
 *
 * The 1.0.2 release bumped package.json and left the macOS legal record at
 * 1.0.1, which broke the app build and a CI job for a week. The mechanism was
 * ordinary: a version bump was a many-file manual edit with no tooling, and
 * nothing asserted the files agreed. This does. Every site is READ from disk
 * and compared against package.json; nothing here is a literal, because a
 * literal would be the sixth place that could go stale.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GAME_DEV_VERSION } from '../src/version.js';

const root = fileURLToPath(new URL('..', import.meta.url));

async function json<T>(relative: string): Promise<T> {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8')) as T;
}

describe('every surface states the same version', () => {
  it('agrees across package.json, src/version.ts, the skill bundle, the plugin, and the macOS record', async () => {
    const pkg = await json<{ version: string }>('package.json');
    const manifest = await json<{ version: string }>('skills/manifest.json');
    const plugin = await json<{ version: string }>('.codex-plugin/plugin.json');
    const provenance = await json<{ bundledRuntime: { gameDevCli: { version: string; licenseAssets: string[] } } }>(
      'distribution/macos-app-repo/THIRD_PARTY_PROVENANCE.json',
    );

    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(GAME_DEV_VERSION).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
    expect(provenance.bundledRuntime.gameDevCli.version).toBe(pkg.version);
    // The license asset is named after the version, so a bump that forgets the
    // rename leaves the record pointing at a file that no longer exists.
    expect(provenance.bundledRuntime.gameDevCli.licenseAssets).toContain(
      `game-development-studio-${pkg.version}-MIT.txt`,
    );
  });

  it('is enforced by a script rather than by remembering', async () => {
    // The bump tool must exist and must name every site this test checks, so
    // the two cannot drift apart silently.
    const script = await readFile(path.join(root, 'scripts', 'set-version.mjs'), 'utf8');
    for (const site of [
      'package.json',
      'src/version.ts',
      'skills/manifest.json',
      '.codex-plugin/plugin.json',
      'THIRD_PARTY_PROVENANCE.json',
    ]) {
      expect(script, `set-version.mjs does not touch ${site}`).toContain(site);
    }
  });
});
