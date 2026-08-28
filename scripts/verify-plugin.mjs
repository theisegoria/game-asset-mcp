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
  const expected = new Set([
    ...roster.pluginFiles,
    ...roster.repositorySourceFiles,
    ...roster.sourceOnlyFiles,
  ]);
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
  for (const relative of roster.repositorySourceFiles) {
    invariant(roster.repositoryFiles.includes(relative), `repository source entry is not exported: ${relative}`);
  }
  invariant(
    !roster.pluginFiles.some((relative) => relative.startsWith('assets/screenshots/')),
    'skills-only plugin roster must not ship screenshots',
  );
  const manifest = await json('.codex-plugin/plugin.json');
  invariant(manifest.name === 'game-development-studio', 'unexpected plugin name');
  invariant(manifest.version === '1.0.2', 'unexpected plugin version');
  invariant(manifest.skills === './skills/', 'plugin must publish the canonical skills directory');
  invariant(manifest.mcpServers === undefined && manifest.apps === undefined, 'skills-only plugin must not declare MCP or apps');
  invariant(manifest.interface?.screenshots === undefined, 'skills-only plugin must not declare screenshots');
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
    'brandColor', 'composerIcon', 'logo', 'logoDark',
  ]);
  for (const field of Object.keys(manifest.interface ?? {})) {
    invariant(allowedInterfaceFields.has(field), `unsupported plugin interface field: ${field}`);
  }
  invariant(manifest.interface?.shortDescription.length <= 30, 'short description exceeds the 30-character limit');
  const marketingCopy = await readFile(path.join(root, 'marketing', 'COPY.md'), 'utf8');
  invariant(
    marketingCopy.includes(`## Short store description\n\n${manifest.interface.shortDescription}`),
    'marketing short description must match the plugin manifest',
  );
  invariant(
    Array.isArray(manifest.interface?.defaultPrompt) && manifest.interface.defaultPrompt.length === 3,
    'plugin must declare exactly three starter prompts',
  );

  const privacyPolicy = await readFile(path.join(root, 'PRIVACY.md'), 'utf8');
  const terms = await readFile(path.join(root, 'TERMS.md'), 'utf8');
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  const storeBrief = await readFile(path.join(root, 'marketing', 'STORE_SUBMISSION.md'), 'utf8');
  const routerSkill = await readFile(path.join(root, 'skills', 'game-development-studio', 'SKILL.md'), 'utf8');
  const productionSkill = await readFile(path.join(root, 'skills', 'game-asset-production', 'SKILL.md'), 'utf8');
  const productionCommands = await readFile(
    path.join(root, 'skills', 'game-asset-production', 'references', 'commands.md'),
    'utf8',
  );
  for (const phrase of [
    '**Publisher retention is zero:**',
    'remain in the user-selected workspace until the user deletes',
    'Data sent in an authorized provider request is retained and controlled by that',
    'The plugin does not collect, solicit, accept, store, or transmit provider',
  ]) {
    invariant(privacyPolicy.includes(phrase), `privacy policy is missing required disclosure: ${phrase}`);
  }
  for (const phrase of [
    'not a publisher-operated provider account',
    'Do not use another person\'s',
    'affiliation, sponsorship, endorsement, certification, partnership, or official',
  ]) {
    invariant(terms.includes(phrase), `terms are missing required provider boundary: ${phrase}`);
  }
  invariant(!/^\s*export\s+(?:TRIPO|LEONARDO)_API_KEY=/m.test(readme), 'README must not solicit provider keys in shell commands');
  invariant(routerSkill.includes('do not activate for unrelated development or general creative work'), 'router activation boundary is too broad');
  invariant(routerSkill.includes('A command without a `--confirm` flag still requires'), 'router is missing the no-flag write boundary');
  invariant(productionSkill.includes('never request, accept, reveal, or configure that credential'), 'production skill can solicit provider credentials');
  invariant(productionCommands.includes('leave the command unexecuted until the user explicitly'), 'production commands are missing exact write authorization');
  for (const prompt of manifest.interface.defaultPrompt) {
    invariant(storeBrief.includes(prompt), `submission brief is missing starter prompt: ${prompt}`);
  }
  const positiveBlock = storeBrief.match(/## Positive test cases\n([\s\S]*?)\n## Negative test cases\n/)?.[1] ?? '';
  const negativeBlock = storeBrief.match(/## Negative test cases\n([\s\S]*?)\n## Release notes\n/)?.[1] ?? '';
  invariant((positiveBlock.match(/^### \d+\./gm) ?? []).length === 5, 'submission brief must contain exactly five positive tests');
  invariant((negativeBlock.match(/^### \d+\./gm) ?? []).length === 3, 'submission brief must contain exactly three negative tests');
  invariant(negativeBlock.includes('refuses to echo, save, configure, or use it'), 'negative tests must cover pasted credential refusal');

  const iconPath = localPath(manifest.interface.composerIcon, 'composerIcon');
  invariant(iconPath === localPath(manifest.interface.logo, 'logo'), 'composer icon and logo must share the suite mark');
  const iconProvenance = await json('assets/icon-provenance.json');
  invariant(await sha256(iconPath) === iconProvenance.sha256, 'top-level icon provenance hash mismatch');
  await png(iconPath, 1254, 1254);

  const marketingScreenshotProvenance = await json('assets/screenshots/provenance.json');
  const marketingScreenshots = [
    'assets/screenshots/01-skill-suite.png',
    'assets/screenshots/02-cli-contract.png',
    'assets/screenshots/03-visual-debugging.png',
  ];
  for (const screenshot of marketingScreenshots) {
    invariant(roster.repositorySourceFiles.includes(screenshot), `marketing screenshot is not exported at repository root: ${screenshot}`);
    const screenshotPath = path.join(root, screenshot);
    const entry = marketingScreenshotProvenance.screenshots.find((item) => item.path === path.basename(screenshotPath));
    invariant(entry, `missing marketing screenshot provenance for ${screenshot}`);
    invariant(await sha256(screenshotPath) === entry.sha256, `marketing screenshot provenance hash mismatch for ${screenshot}`);
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
    screenshots: 0,
    marketingScreenshots: marketingScreenshots.length,
    mcp: false,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
