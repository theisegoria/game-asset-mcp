#!/usr/bin/env node

import { access, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destinationArgument = process.argv[2];

if (!destinationArgument) {
  throw new Error('usage: node scripts/build-skills-repository.mjs NEW_DESTINATION');
}

const destination = path.resolve(destinationArgument);

async function resolvePhysicalPath(candidate) {
  const missingSegments = [];
  let cursor = path.resolve(candidate);
  for (;;) {
    try {
      return path.join(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isSameOrDescendant(candidate, ancestor) {
  const relative = path.relative(ancestor, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

const physicalSourceRoot = await realpath(sourceRoot);
const physicalDestination = await resolvePhysicalPath(destination);
if (isSameOrDescendant(physicalDestination, physicalSourceRoot)) {
  throw new Error(`destination must be outside the source root: ${destination}`);
}
if (destination === path.parse(destination).root) {
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

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function posixPath(relative) {
  return relative.split(path.sep).join('/');
}

function isWithinDirectoryPrefix(relative, prefixes) {
  return prefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
}

function forbiddenArtifact(relative) {
  const basename = path.posix.basename(relative).toLowerCase();
  if (/^\.env(?:\.|$)/.test(basename)) return '.env files are not releasable';
  if (/\.(?:key|pem|crt|cer|csr|p12|pfx|der|jks|keystore)$/.test(basename)) {
    return 'credential and certificate files are not releasable';
  }
  if (/\.(?:swift|m|mm|h|hpp|c|cc|cpp|rs|go|java|kt|ts|tsx|js|jsx|mjs|cjs|rb|php|sh|bash|zsh|fish)$/.test(basename)) {
    return 'source files are not releasable';
  }
  return undefined;
}

function checkedRoster(roster) {
  invariant(roster?.schema === 'game_dev.skills_release_roster.v1', 'unexpected skills release roster schema');
  for (const field of [
    'repositoryFiles',
    'pluginFiles',
    'templateFiles',
    'templateOnlyFiles',
    'repositorySourceFiles',
    'sourceOnlyFiles',
    'sourceOnlyDirectoryPrefixes',
  ]) {
    invariant(Array.isArray(roster[field]), `release roster ${field} must be an array`);
  }
  for (const [field, entries] of Object.entries(roster)) {
    if (!Array.isArray(entries)) continue;
    const normalized = entries.map((entry) => {
      invariant(typeof entry === 'string' && entry.length > 0, `release roster ${field} contains an invalid path`);
      invariant(!path.posix.isAbsolute(entry) && !entry.split('/').includes('..'), `release roster ${field} escapes its root`);
      invariant(!entry.includes('\\'), `release roster ${field} must use POSIX paths`);
      return entry;
    });
    invariant(new Set(normalized).size === normalized.length, `release roster ${field} contains duplicate paths`);
  }
  return roster;
}

async function inspectEntry(root, relative, expected, label, rejectSourceArtifacts, actual, ignoredDirectoryPrefixes = []) {
  const normalized = posixPath(relative);
  const target = path.join(root, relative);
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`missing ${label} entry: ${normalized}`);
    }
    throw error;
  }
  invariant(!stats.isSymbolicLink(), `symlink is not allowed in ${label}: ${normalized}`);
  if (isWithinDirectoryPrefix(normalized, ignoredDirectoryPrefixes)) {
    invariant(stats.isDirectory(), `source-only directory must be a directory in ${label}: ${normalized}`);
    return;
  }
  if (stats.isDirectory()) {
    const entries = await readdir(target, { withFileTypes: true });
    invariant(entries.length > 0, `empty directory is not allowed in ${label}: ${normalized || '.'}`);
    for (const entry of entries) {
      await inspectEntry(root, path.join(relative, entry.name), expected, label, rejectSourceArtifacts, actual, ignoredDirectoryPrefixes);
    }
    return;
  }
  invariant(stats.isFile(), `non-regular file is not allowed in ${label}: ${normalized}`);
  invariant((stats.mode & 0o111) === 0, `executable file is not allowed in ${label}: ${normalized}`);
  const forbidden = rejectSourceArtifacts ? forbiddenArtifact(normalized) : undefined;
  if (forbidden) throw new Error(`forbidden artifact in ${label}: ${normalized} (${forbidden})`);
  invariant(expected.has(normalized), `unexpected file in ${label}: ${normalized}`);
  actual.add(normalized);
}

async function validateExactTree(root, roster, label, rejectSourceArtifacts = false) {
  const expected = new Set(roster);
  const actual = new Set();
  await inspectEntry(root, '', expected, label, rejectSourceArtifacts, actual);
  for (const relative of roster) {
    const stats = await lstat(path.join(root, relative));
    invariant(stats.isFile(), `non-regular file is not allowed in ${label}: ${relative}`);
  }
  invariant(
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()),
    `${label} does not match the closed release roster`,
  );
}

async function validateScopedFiles(root, requiredFiles, optionalFiles, optionalDirectoryPrefixes, label, rejectSourceArtifacts) {
  const expected = new Set([...requiredFiles, ...optionalFiles]);
  const optionalPrefixes = optionalDirectoryPrefixes.map(posixPath);
  const scopeRoots = new Set([...expected, ...optionalPrefixes].map((entry) => entry.split('/')[0]));
  const actual = new Set();
  for (const scopeRoot of scopeRoots) {
    const scopeTarget = path.join(root, scopeRoot);
    const scopeStats = await lstat(scopeTarget).catch((error) => {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!scopeStats && !requiredFiles.some((entry) => entry.split('/')[0] === scopeRoot)) continue;
    await inspectEntry(root, scopeRoot, expected, label, rejectSourceArtifacts, actual, optionalPrefixes);
  }
  const expectedRequired = new Set(requiredFiles);
  const expectedOptional = new Set(optionalFiles);
  for (const entry of actual) {
    invariant(expectedRequired.has(entry) || expectedOptional.has(entry), `unexpected file in ${label}: ${entry}`);
  }
  for (const entry of requiredFiles) {
    const target = path.join(root, entry);
    const stats = await lstat(target).catch((error) => {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stats) throw new Error(`missing ${label} entry: ${entry}`);
    invariant(stats.isFile(), `non-regular file is not allowed in ${label}: ${entry}`);
  }
  for (const entry of optionalFiles) {
    const target = path.join(root, entry);
    const stats = await lstat(target).catch((error) => {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stats) invariant(stats.isFile(), `non-regular file is not allowed in ${label}: ${entry}`);
  }
}

async function validateScopedSource(root, roster) {
  await validateScopedFiles(root, [
    ...roster.pluginFiles,
    ...roster.repositorySourceFiles,
  ], roster.sourceOnlyFiles, roster.sourceOnlyDirectoryPrefixes, 'source release scope', true);
}

const rosterPath = path.join(template, 'release-roster.json');
const rosterStats = await lstat(rosterPath);
invariant(rosterStats.isFile(), 'release roster must be a regular file');
invariant((rosterStats.mode & 0o111) === 0, 'release roster must not be executable');
const roster = checkedRoster(JSON.parse(await readFile(rosterPath, 'utf8')));
await validateScopedFiles(template, roster.templateFiles, roster.templateOnlyFiles, [], 'release template', false);
await validateScopedSource(sourceRoot, roster);
await mkdir(plugin, { recursive: true });

for (const relative of [
  'README.md',
  'CHANGELOG.md',
  '.agents',
  '.github',
  'scripts',
  'release-roster.json',
]) {
  if (relative === '.agents' || relative === '.github' || relative === 'scripts') {
    const sourceEntries = relative === '.agents'
      ? ['.agents/plugins/marketplace.json']
      : relative === '.github'
        ? ['.github/workflows/validate.yml']
        : ['scripts/build_release.py', 'scripts/verify.py'];
    for (const entry of sourceEntries) {
      await mkdir(path.dirname(path.join(destination, entry)), { recursive: true });
      await cp(path.join(template, entry), path.join(destination, entry));
    }
  } else {
    await mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
    await cp(path.join(template, relative), path.join(destination, relative));
  }
}
await mkdir(path.dirname(path.join(destination, '.gitignore')), { recursive: true });
await writeFile(path.join(destination, '.gitignore'), await readFile(path.join(template, 'gitignore.template'), 'utf8'), { flag: 'wx' });

for (const relative of ['LICENSE', 'PRIVACY.md', 'TERMS.md', 'SUPPORT.md', 'SECURITY.md']) {
  await mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  await cp(path.join(sourceRoot, relative), path.join(destination, relative));
  await mkdir(path.dirname(path.join(plugin, relative)), { recursive: true });
  await cp(path.join(sourceRoot, relative), path.join(plugin, relative));
}

for (const relative of roster.repositorySourceFiles) {
  await mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  await cp(path.join(sourceRoot, relative), path.join(destination, relative));
}

for (const relative of roster.pluginFiles) {
  if (['README.md', 'CHANGELOG.md', 'LICENSE', 'PRIVACY.md', 'TERMS.md', 'SUPPORT.md', 'SECURITY.md'].includes(relative)) continue;
  await mkdir(path.dirname(path.join(plugin, relative)), { recursive: true });
  await cp(path.join(sourceRoot, relative), path.join(plugin, relative));
}

await writeFile(path.join(plugin, 'README.md'), await readFile(path.join(template, 'PLUGIN_README.md'), 'utf8'), { flag: 'wx' });
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

await validateExactTree(destination, roster.repositoryFiles, 'exported repository');
await validateExactTree(plugin, roster.pluginFiles, 'exported plugin', true);

console.log(JSON.stringify({
  ok: true,
  schema: 'game_dev.skills_repository_export.v1',
  destination,
  plugin: path.relative(destination, plugin),
  mcp: false,
}));
