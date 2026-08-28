#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function localPath(relative, label) {
  invariant(typeof relative === 'string' && relative.startsWith('./'), `${label} must begin with ./`);
  const resolved = path.resolve(root, relative);
  invariant(resolved.startsWith(`${root}${path.sep}`), `${label} escapes the plugin root`);
  return resolved;
}

async function json(relative) {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function png(file, width, height) {
  const decoded = PNG.sync.read(await readFile(file));
  invariant(decoded.width === width && decoded.height === height, `${file} must be ${width}x${height}`);
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
  for (const field of ['repositoryFiles', 'pluginFiles', 'templateFiles', 'templateOnlyFiles', 'sourceOnlyFiles', 'sourceOnlyDirectoryPrefixes']) {
    invariant(Array.isArray(roster[field]), `release roster ${field} must be an array`);
    const normalized = roster[field].map((entry) => {
      invariant(typeof entry === 'string' && entry.length > 0, `release roster ${field} contains an invalid path`);
      invariant(!path.posix.isAbsolute(entry) && !entry.split('/').includes('..'), `release roster ${field} escapes its root`);
      invariant(!entry.includes('\\'), `release roster ${field} must use POSIX paths`);
      return entry;
    });
    invariant(new Set(normalized).size === normalized.length, `release roster ${field} contains duplicate paths`);
  }
  return roster;
}

async function inspectScopedEntry(root, relative, expected, label, actual, ignoredDirectoryPrefixes = []) {
  const normalized = posixPath(relative);
  const target = path.join(root, relative);
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`missing ${label} entry: ${normalized}`);
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
      await inspectScopedEntry(root, path.join(relative, entry.name), expected, label, actual, ignoredDirectoryPrefixes);
    }
    return;
  }
  invariant(stats.isFile(), `non-regular file is not allowed in ${label}: ${normalized}`);
  invariant((stats.mode & 0o111) === 0, `executable file is not allowed in ${label}: ${normalized}`);
  const forbidden = forbiddenArtifact(normalized);
  if (forbidden) throw new Error(`forbidden artifact in ${label}: ${normalized} (${forbidden})`);
  invariant(expected.has(normalized), `unexpected file in ${label}: ${normalized}`);
  actual.add(normalized);
}

async function validateSourceReleaseScope(roster) {
  const expected = new Set([...roster.pluginFiles, ...roster.sourceOnlyFiles]);
  const sourceOnlyDirectoryPrefixes = roster.sourceOnlyDirectoryPrefixes.map(posixPath);
  const scopeRoots = new Set([...expected, ...sourceOnlyDirectoryPrefixes].map((entry) => entry.split('/')[0]));
  const actual = new Set();
  for (const scopeRoot of scopeRoots) {
    await inspectScopedEntry(root, scopeRoot, expected, 'source release scope', actual, sourceOnlyDirectoryPrefixes);
  }
  for (const entry of roster.pluginFiles) {
    invariant(actual.has(entry), `missing source release entry: ${entry}`);
  }
}

async function main() {
  const rosterPath = path.join(root, 'distribution', 'skills-repo', 'release-roster.json');
  const rosterStats = await lstat(rosterPath);
  invariant(rosterStats.isFile(), 'release roster must be a regular file');
  invariant((rosterStats.mode & 0o111) === 0, 'release roster must not be executable');
  const roster = checkedRoster(JSON.parse(await readFile(rosterPath, 'utf8')));
  await validateSourceReleaseScope(roster);
  const manifest = await json('.codex-plugin/plugin.json');
  invariant(manifest.name === 'game-development-studio', 'unexpected plugin name');
  invariant(manifest.version === '1.0.1', 'unexpected plugin version');
  invariant(manifest.skills === './skills/', 'plugin must publish the canonical skills directory');
  invariant(manifest.mcpServers === undefined && manifest.apps === undefined, 'skills-only plugin must not declare MCP or apps');
  await Promise.all(['.mcp.json', '.app.json'].map(async (relative) => {
    try {
      await access(path.join(root, relative));
      throw new Error(`skills-only plugin must not ship ${relative}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }));

  invariant(
    manifest.interface?.privacyPolicyURL === 'https://github.com/theisegoria/game-development-studio-skills/blob/main/PRIVACY.md',
    'unexpected privacy URL',
  );
  invariant(
    manifest.interface?.termsOfServiceURL === 'https://github.com/theisegoria/game-development-studio-skills/blob/main/TERMS.md',
    'unexpected terms URL',
  );
  const allowedInterfaceFields = new Set([
    'displayName', 'shortDescription', 'longDescription', 'developerName', 'category',
    'capabilities', 'websiteURL', 'privacyPolicyURL', 'termsOfServiceURL', 'defaultPrompt',
    'brandColor', 'composerIcon', 'logo', 'logoDark', 'screenshots',
  ]);
  for (const field of Object.keys(manifest.interface ?? {})) {
    invariant(allowedInterfaceFields.has(field), `unsupported plugin interface field: ${field}`);
  }
  invariant(manifest.interface?.shortDescription.length <= 30, 'short description exceeds the 30-character limit');

  const iconPath = localPath(manifest.interface.composerIcon, 'composerIcon');
  invariant(iconPath === localPath(manifest.interface.logo, 'logo'), 'composer icon and logo must share the suite mark');
  const iconProvenance = await json('assets/icon-provenance.json');
  invariant(await sha256(iconPath) === iconProvenance.sha256, 'top-level icon provenance hash mismatch');
  await png(iconPath, 1254, 1254);

  const screenshotProvenance = await json('assets/screenshots/provenance.json');
  const screenshots = [
    './assets/screenshots/01-skill-suite.png',
    './assets/screenshots/02-cli-contract.png',
    './assets/screenshots/03-visual-debugging.png',
  ];
  invariant(
    JSON.stringify(manifest.interface?.screenshots) === JSON.stringify(screenshots),
    'plugin manifest must declare the exact three release screenshots',
  );
  for (const screenshot of screenshots) {
    const screenshotPath = localPath(screenshot, 'screenshot');
    const entry = screenshotProvenance.screenshots.find((item) => item.path === path.basename(screenshotPath));
    invariant(entry, `missing screenshot provenance for ${screenshot}`);
    invariant(await sha256(screenshotPath) === entry.sha256, `screenshot provenance hash mismatch for ${screenshot}`);
    await png(screenshotPath, 1440, 900);
  }

  const skillManifest = await json('skills/manifest.json');
  invariant(skillManifest.schema === 'game_dev.skill_bundle.v1', 'unexpected skill bundle schema');
  invariant(skillManifest.version === manifest.version, 'skill and plugin versions must match');
  invariant(skillManifest.skills.length === 5, 'exactly five skills required');
  const skillFolders = (await readdir(path.join(root, 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  invariant(
    JSON.stringify(skillFolders) === JSON.stringify(skillManifest.skills.map((skill) => skill.relativePath).sort()),
    'skill manifest must be a closed directory roster',
  );

  for (const skill of skillManifest.skills) {
    const skillRoot = path.join(root, 'skills', skill.relativePath);
    const markdown = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const metadata = await readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8');
    const provenance = await json(path.join('skills', skill.relativePath, 'assets', 'icon-provenance.json'));
    const skillIcon = path.join(skillRoot, 'assets', 'icon.png');
    invariant(markdown.includes(`name: ${skill.id}`), `${skill.id} frontmatter name mismatch`);
    invariant(!/\[TODO/i.test(markdown), `${skill.id} contains a TODO placeholder`);
    invariant(metadata.includes(`$${skill.id}`), `${skill.id} default prompt does not name the skill`);
    invariant(metadata.includes('icon_small: "./assets/icon.png"'), `${skill.id} small icon metadata missing`);
    invariant(metadata.includes('icon_large: "./assets/icon.png"'), `${skill.id} large icon metadata missing`);
    invariant(metadata.includes('brand_color: "#10C9D5"'), `${skill.id} brand color mismatch`);
    invariant(await sha256(skillIcon) === provenance.sha256, `${skill.id} icon provenance hash mismatch`);
    await png(skillIcon, 1254, 1254);
  }

  for (const relative of ['README.md', 'LICENSE', 'PRIVACY.md', 'TERMS.md', 'SUPPORT.md', 'SECURITY.md']) {
    await access(path.join(root, relative));
  }

  console.log(JSON.stringify({
    ok: true,
    schema: 'game_dev.plugin_verification.v1',
    plugin: manifest.name,
    version: manifest.version,
    distribution: 'skills-only',
    skills: skillManifest.skills.length,
    screenshots: screenshots.length,
    mcp: false,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
