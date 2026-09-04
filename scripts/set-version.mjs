#!/usr/bin/env node
/**
 * Set the product version everywhere it is stated structurally.
 *
 * A version bump used to be a many-file manual edit with no tooling, and the
 * 1.0.2 release proved what that costs: package.json moved and the macOS legal
 * record did not, which broke the app build and a CI job. This touches every
 * structural site in one command and renames the version-named license asset.
 * tests/version-parity.test.ts asserts they all agree afterwards.
 *
 * Prose mentions ("requires 1.0.2 or newer") are deliberately NOT rewritten:
 * a compatibility floor in a README is a statement about history, not about
 * the current version, and blindly bumping it would falsify it.
 *
 *   node scripts/set-version.mjs 1.1.0
 */

import { readFile, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const next = process.argv[2];

if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('usage: node scripts/set-version.mjs <major.minor.patch>');
  process.exit(2);
}

const current = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
if (current === next) {
  console.log(`already at ${next}`);
  process.exit(0);
}

async function editJson(relative, mutate) {
  const file = path.join(root, relative);
  const document = JSON.parse(await readFile(file, 'utf8'));
  mutate(document);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`updated ${relative}`);
}

async function editText(relative, from, to) {
  const file = path.join(root, relative);
  const text = await readFile(file, 'utf8');
  if (!text.includes(from)) throw new Error(`${relative} does not contain ${JSON.stringify(from)}`);
  await writeFile(file, text.split(from).join(to));
  console.log(`updated ${relative}`);
}

await editJson('package.json', (d) => { d.version = next; });
await editText('src/version.ts', `GAME_DEV_VERSION = '${current}'`, `GAME_DEV_VERSION = '${next}'`);
await editJson('skills/manifest.json', (d) => { d.version = next; });
await editJson('.codex-plugin/plugin.json', (d) => { d.version = next; });

// The macOS legal record: version, the license asset it names, and the
// asset's roster entry. The file itself is renamed so the record stays true.
const oldAsset = `game-development-studio-${current}-MIT.txt`;
const newAsset = `game-development-studio-${next}-MIT.txt`;
await editJson('distribution/macos-app-repo/THIRD_PARTY_PROVENANCE.json', (d) => {
  d.bundledRuntime.gameDevCli.version = next;
  d.bundledRuntime.gameDevCli.licenseAssets = d.bundledRuntime.gameDevCli.licenseAssets
    .map((name) => (name === oldAsset ? newAsset : name));
  for (const asset of d.legalAssets ?? []) {
    if (asset.path === oldAsset) {
      asset.path = newAsset;
      asset.source = asset.source.replace(current, next);
    }
  }
});
const legal = path.join(root, 'distribution', 'macos-app-repo', 'legal', 'third-party-licenses');
await access(path.join(legal, oldAsset));
await rename(path.join(legal, oldAsset), path.join(legal, newAsset));
console.log(`renamed ${oldAsset} -> ${newAsset}`);
await editText('script/package_macos_release.sh', `"${oldAsset}"`, `"${newAsset}"`);
await editText('distribution/macos-app-repo/THIRD_PARTY_NOTICES.md', `CLI ${current},`, `CLI ${next},`);
await editText('distribution/macos-app-repo/README.md', `CLI ${current} and`, `CLI ${next} and`);

console.log(`\n${current} -> ${next}. Now: npm test (version-parity), add a CHANGELOG entry, commit, tag v${next}.`);
