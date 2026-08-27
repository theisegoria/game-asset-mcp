#!/usr/bin/env node

import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destinationArgument = process.argv[2];

if (!destinationArgument) {
  throw new Error('usage: node scripts/build-skills-repository.mjs NEW_DESTINATION');
}

const destination = path.resolve(destinationArgument);
if (destination === sourceRoot || destination === path.parse(destination).root) {
  throw new Error('destination must be a new, dedicated directory');
}

try {
  await access(destination);
  throw new Error(`refusing to overwrite existing destination: ${destination}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const template = path.join(sourceRoot, 'distribution', 'skills-repo');
const plugin = path.join(destination, 'plugins', 'game-development-studio');
await mkdir(plugin, { recursive: true });

for (const relative of [
  'README.md',
  'CHANGELOG.md',
  '.agents',
  '.github',
  'scripts',
]) {
  await cp(path.join(template, relative), path.join(destination, relative), { recursive: true });
}
await writeFile(
  path.join(destination, '.gitignore'),
  await readFile(path.join(template, 'gitignore.template'), 'utf8'),
  { flag: 'wx' },
);

for (const relative of ['LICENSE', 'PRIVACY.md', 'TERMS.md', 'SUPPORT.md', 'SECURITY.md']) {
  await cp(path.join(sourceRoot, relative), path.join(destination, relative));
  await cp(path.join(sourceRoot, relative), path.join(plugin, relative));
}

for (const relative of ['.codex-plugin', 'skills', 'assets']) {
  await cp(path.join(sourceRoot, relative), path.join(plugin, relative), { recursive: true });
}

await mkdir(path.join(plugin, 'marketing'), { recursive: true });
for (const relative of ['COPY.md', 'STORE_SUBMISSION.md']) {
  await cp(path.join(sourceRoot, 'marketing', relative), path.join(plugin, 'marketing', relative));
}
const repositoryReadme = await readFile(path.join(template, 'README.md'), 'utf8');
await writeFile(
  path.join(plugin, 'README.md'),
  repositoryReadme.replaceAll('plugins/game-development-studio/assets/', 'assets/'),
  { flag: 'wx' },
);
await cp(path.join(template, 'CHANGELOG.md'), path.join(plugin, 'CHANGELOG.md'));

const manifestPath = path.join(plugin, '.codex-plugin', 'plugin.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.name !== 'game-development-studio' || manifest.mcpServers !== undefined || manifest.apps !== undefined) {
  throw new Error('source plugin is not the expected skills-only manifest');
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' }).catch(async (error) => {
  if (error?.code !== 'EEXIST') throw error;
  const existing = await readFile(manifestPath, 'utf8');
  if (existing !== `${JSON.stringify(manifest, null, 2)}\n`) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
});

console.log(JSON.stringify({
  ok: true,
  schema: 'game_dev.skills_repository_export.v1',
  destination,
  plugin: path.relative(destination, plugin),
  mcp: false,
}));
