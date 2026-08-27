import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../packages/format.js';
import { sha256 } from '../storage/filesystem.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { GAME_DEV_VERSION } from '../version.js';

export const GAME_DEV_SKILL_BUNDLE_SCHEMA = 'game_dev.skill_bundle.v1';
export const GAME_DEV_SKILL_INSTALL_SCHEMA = 'game_dev.skill_install.v1';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/);
const skillEntrySchema = z.object({
  id: skillId,
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().min(12).max(240),
  relativePath: skillId,
}).strict();
const skillBundleSchema = z.object({
  schema: z.literal(GAME_DEV_SKILL_BUNDLE_SCHEMA),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  skills: z.array(skillEntrySchema).min(1).max(32),
}).strict();

export interface SkillFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PackagedSkill {
  id: string;
  displayName: string;
  description: string;
  relativePath: string;
  files: SkillFile[];
  contentSha256: string;
}

export interface SkillBundle {
  schema: typeof GAME_DEV_SKILL_BUNDLE_SCHEMA;
  version: string;
  skills: PackagedSkill[];
  bundleSha256: string;
}

function bundleRoot(): string {
  return path.resolve(moduleDirectory, '..', '..', 'skills');
}

function portableRelative(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidState('packaged skill file escaped its skill directory', { target });
  }
  return relative.split(path.sep).join('/');
}

async function readRegularFile(target: string, description: string): Promise<Buffer> {
  const stats = await fs.lstat(target).catch(() => undefined);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
    throw invalidState(`${description} must be a non-symlink regular file`, { path: target });
  }
  if (stats.size > 16 * 1024 * 1024) {
    throw invalidState(`${description} exceeds the 16 MiB packaged-skill file ceiling`, { path: target, bytes: stats.size });
  }
  return fs.readFile(target);
}

async function walkSkillFiles(root: string, current = root): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw invalidState('packaged skill must not contain symbolic links', { path: candidate });
    if (entry.isDirectory()) files.push(...await walkSkillFiles(root, candidate));
    else if (entry.isFile()) files.push(candidate);
    else throw invalidState('packaged skill must contain only directories and regular files', { path: candidate });
  }
  return files;
}

function frontmatterValue(markdown: string, field: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1];
  if (!frontmatter) return undefined;
  const match = new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'm').exec(frontmatter)?.[1];
  return match?.replace(/^['"]|['"]$/g, '');
}

async function validateSkillSource(entry: z.infer<typeof skillEntrySchema>, root: string): Promise<PackagedSkill> {
  if (entry.relativePath !== entry.id) {
    throw invalidState('packaged skill relativePath must equal its id', { id: entry.id });
  }
  const source = path.join(root, entry.relativePath);
  const sourceStats = await fs.lstat(source).catch(() => undefined);
  if (!sourceStats?.isDirectory() || sourceStats.isSymbolicLink()) {
    throw invalidState('packaged skill source must be a non-symlink directory', { id: entry.id });
  }
  const resolvedSource = await fs.realpath(source);
  if (path.dirname(resolvedSource) !== await fs.realpath(root)) {
    throw invalidState('packaged skill source resolves outside the bundle', { id: entry.id });
  }
  const paths = await walkSkillFiles(resolvedSource);
  const files: SkillFile[] = [];
  for (const file of paths) {
    const bytes = await readRegularFile(file, `packaged skill ${entry.id} file`);
    files.push({ path: portableRelative(resolvedSource, file), bytes: bytes.length, sha256: sha256(bytes) });
  }
  const skillMarkdown = await readRegularFile(path.join(resolvedSource, 'SKILL.md'), `packaged skill ${entry.id} SKILL.md`);
  const markdown = skillMarkdown.toString('utf8');
  if (frontmatterValue(markdown, 'name') !== entry.id || !frontmatterValue(markdown, 'description')) {
    throw invalidState('packaged skill frontmatter does not match its manifest entry', { id: entry.id });
  }
  const openaiYaml = await readRegularFile(
    path.join(resolvedSource, 'agents', 'openai.yaml'),
    `packaged skill ${entry.id} agents/openai.yaml`,
  );
  const sourceText = `${markdown}\n${openaiYaml.toString('utf8')}`;
  if (/\[TODO(?::|\])/i.test(sourceText) || !sourceText.includes(`$${entry.id}`)) {
    throw invalidState('packaged skill contains an unfinished scaffold or invalid default prompt', { id: entry.id });
  }
  return {
    ...entry,
    files,
    contentSha256: sha256(Buffer.from(canonicalJson(files))),
  };
}

export async function listSkillBundle(): Promise<SkillBundle> {
  const root = bundleRoot();
  const manifestBytes = await readRegularFile(path.join(root, 'manifest.json'), 'skill bundle manifest');
  let value: unknown;
  try {
    value = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw invalidState('skill bundle manifest is not valid JSON');
  }
  const parsed = skillBundleSchema.safeParse(value);
  if (!parsed.success) throw invalidState('skill bundle manifest violates game_dev.skill_bundle.v1');
  if (parsed.data.version !== GAME_DEV_VERSION) {
    throw invalidState('skill bundle version does not match the CLI version', {
      expected: GAME_DEV_VERSION,
      actual: parsed.data.version,
    });
  }
  const ids = new Set<string>();
  const skills: PackagedSkill[] = [];
  for (const entry of parsed.data.skills) {
    if (ids.has(entry.id)) throw invalidState('skill bundle contains a duplicate id', { id: entry.id });
    ids.add(entry.id);
    skills.push(await validateSkillSource(entry, root));
  }
  const canonical = {
    schema: parsed.data.schema,
    version: parsed.data.version,
    skills,
  };
  return {
    ...canonical,
    bundleSha256: sha256(Buffer.from(canonicalJson(canonical))),
  };
}

export function defaultCodexSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return path.resolve(configured ? configured : path.join(os.homedir(), '.codex'), 'skills');
}

async function destinationFiles(destination: string): Promise<SkillFile[]> {
  const paths = await walkSkillFiles(destination);
  const files: SkillFile[] = [];
  for (const file of paths) {
    const bytes = await readRegularFile(file, 'installed skill file');
    files.push({ path: portableRelative(destination, file), bytes: bytes.length, sha256: sha256(bytes) });
  }
  return files;
}

async function destinationState(destination: string, expected: SkillFile[]): Promise<'absent' | 'identical'> {
  const stats = await fs.lstat(destination).catch(() => undefined);
  if (!stats) return 'absent';
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw invalidState('skill destination exists but is not a non-symlink directory', { destination });
  }
  const actual = await destinationFiles(await fs.realpath(destination));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw invalidState('skill destination already exists with different content; refusing to overwrite it', { destination });
  }
  return 'identical';
}

async function copySkillAtomically(source: string, destination: string, files: SkillFile[]): Promise<void> {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.install-${randomUUID()}`);
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    for (const file of files) {
      const sourcePath = path.join(source, ...file.path.split('/'));
      const destinationPath = path.join(temporary, ...file.path.split('/'));
      await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
      const bytes = await readRegularFile(sourcePath, 'packaged skill file');
      if (sha256(bytes) !== file.sha256 || bytes.length !== file.bytes) {
        throw invalidState('packaged skill changed while it was being installed', { path: sourcePath });
      }
      const handle = await fs.open(destinationPath, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    if (canonicalJson(await destinationFiles(temporary)) !== canonicalJson(files)) {
      throw invalidState('staged skill files failed hash verification');
    }
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function installSkillBundle(options: {
  selection: string;
  targetRoot?: string;
  confirm: boolean;
}): Promise<Record<string, unknown>> {
  const bundle = await listSkillBundle();
  const selected = options.selection === 'all'
    ? bundle.skills
    : bundle.skills.filter((skill) => skill.id === options.selection);
  if (selected.length === 0) throw invalidInput('unknown packaged skill', { selection: options.selection });
  const targetRoot = path.resolve(options.targetRoot ?? defaultCodexSkillsRoot());
  const rootStats = await fs.lstat(targetRoot).catch(() => undefined);
  if (rootStats && (rootStats.isSymbolicLink() || !rootStats.isDirectory())) {
    throw invalidState('Codex skills target must be a non-symlink directory', { targetRoot });
  }

  const planned: Array<{ skill: PackagedSkill; destination: string; reused: boolean }> = [];
  for (const skill of selected) {
    const destination = path.join(targetRoot, skill.id);
    const state = await destinationState(destination, skill.files);
    planned.push({ skill, destination, reused: state === 'identical' });
  }
  if (options.confirm) {
    await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
    const realTarget = await fs.realpath(targetRoot);
    for (const item of planned) {
      if (item.reused) continue;
      const destination = path.join(realTarget, item.skill.id);
      await copySkillAtomically(path.join(bundleRoot(), item.skill.relativePath), destination, item.skill.files);
      item.destination = destination;
    }
  }
  return {
    schema: GAME_DEV_SKILL_INSTALL_SCHEMA,
    bundleVersion: bundle.version,
    bundleSha256: bundle.bundleSha256,
    selection: options.selection,
    targetRoot,
    dryRun: !options.confirm,
    installations: planned.map(({ skill, destination, reused }) => ({
      id: skill.id,
      destination,
      contentSha256: skill.contentSha256,
      fileCount: skill.files.length,
      reused,
    })),
    evidenceCeiling:
      'Skill installation proves an exact byte copy of packaged local instructions. It does not install the game-dev CLI, configure credentials, modify a game project, run a provider, or execute a capture.',
  };
}
