import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const sanitizer = path.join(sourceRoot, 'scripts', 'sanitize-codebase-memory-artifact.mjs');
const roots: string[] = [];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface ArtifactFixture {
  artifact: string;
  metadata: string;
  database: string;
  legacyRoot: string;
  legacyToken: string;
}

function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: sourceRoot,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const status = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      if (error && status !== 1) reject(new Error(`${command} failed: ${stderr || stdout}`, { cause: error }));
      else resolve({ status, stdout, stderr });
    });
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebase-memory-artifact-test-'));
  roots.push(root);
  return root;
}

async function createFixture(root: string, unexpectedLegacyToken = false): Promise<ArtifactFixture> {
  const artifactDirectory = path.join(root, '.codebase-memory');
  const database = path.join(artifactDirectory, 'graph.db');
  const artifact = path.join(artifactDirectory, 'graph.db.zst');
  const metadata = path.join(artifactDirectory, 'artifact.json');
  const legacyToken = 'retired-project-token';
  const legacyRoot = ['', 'Users', 'example-user', 'Developer', legacyToken].join('/');

  await mkdir(artifactDirectory, { recursive: true });
  const graph = new DatabaseSync(database);
  graph.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (name TEXT PRIMARY KEY, indexed_at TEXT NOT NULL, root_path TEXT NOT NULL);
    CREATE TABLE project_summaries (project TEXT PRIMARY KEY, summary TEXT NOT NULL, source_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
      label TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      file_path TEXT DEFAULT '',
      start_line INTEGER DEFAULT 0,
      end_line INTEGER DEFAULT 0,
      properties TEXT DEFAULT '{}',
      UNIQUE(project, qualified_name)
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
      source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      properties TEXT DEFAULT '{}',
      url_path_gen TEXT GENERATED ALWAYS AS (json_extract(properties, '$.url_path')),
      local_name_gen TEXT GENERATED ALWAYS AS (CASE WHEN type='IMPORTS' THEN coalesce(json_extract(properties, '$.local_name'),'') ELSE '' END),
      UNIQUE(source_id, target_id, type, local_name_gen)
    );
    CREATE TABLE file_hashes (project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE, rel_path TEXT NOT NULL, sha256 TEXT NOT NULL, mtime_ns INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project, rel_path));
    CREATE TABLE node_vectors (node_id INTEGER PRIMARY KEY, project TEXT NOT NULL, vector BLOB NOT NULL);
    CREATE TABLE token_vectors (id INTEGER PRIMARY KEY, project TEXT NOT NULL, token TEXT NOT NULL, vector BLOB NOT NULL, idf INTEGER NOT NULL);
    CREATE VIRTUAL TABLE nodes_fts USING fts5(name, qualified_name, label, file_path, content='', tokenize='unicode61 remove_diacritics 2');
  `);
  const project = 'portable-project';
  const branchProperties = JSON.stringify({
    is_git: true,
    root_exists: true,
    canonical_root: legacyRoot,
    worktree_root: legacyRoot,
  });
  graph.prepare('INSERT INTO projects (name, indexed_at, root_path) VALUES (?, ?, ?)').run(project, '2026-08-28T00:00:00Z', legacyRoot);
  graph.prepare('INSERT INTO nodes (id, project, label, name, qualified_name, properties) VALUES (?, ?, ?, ?, ?, ?)').run(1, project, 'Project', project, `${project}.__project__`, '{}');
  graph.prepare('INSERT INTO nodes (id, project, label, name, qualified_name, properties) VALUES (?, ?, ?, ?, ?, ?)').run(2, project, 'Branch', 'main', `${project}.__branch__.main`, branchProperties);
  graph.prepare('INSERT INTO nodes (id, project, label, name, qualified_name, file_path, start_line, end_line, properties) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(3, project, 'Function', unexpectedLegacyToken ? legacyToken : 'runtimeWorker', `${project}.runtimeWorker`, 'src/runtime.ts', 1, 4, '{}');
  graph.prepare('INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)').run(project, 1, 2, 'HAS_BRANCH', branchProperties);
  graph.prepare('INSERT INTO edges (project, source_id, target_id, type, properties) VALUES (?, ?, ?, ?, ?)').run(project, 3, 2, 'CALLS', '{}');
  graph.prepare('INSERT INTO file_hashes (project, rel_path, sha256, mtime_ns, size) VALUES (?, ?, ?, ?, ?)').run(project, 'src/runtime.ts', '0'.repeat(64), 1, 10);
  graph.prepare('INSERT INTO node_vectors (node_id, project, vector) VALUES (?, ?, ?)').run(3, project, Buffer.from([1, 2, 3]));
  graph.prepare('INSERT INTO token_vectors (id, project, token, vector, idf) VALUES (?, ?, ?, ?, ?)').run(1, project, 'runtime', Buffer.from([4, 5, 6]), 1);
  graph.prepare('INSERT INTO nodes_fts (rowid, name, qualified_name, label, file_path) VALUES (?, ?, ?, ?, ?)').run(1, project, `${project}.__project__`, 'Project', '');
  graph.prepare('INSERT INTO nodes_fts (rowid, name, qualified_name, label, file_path) VALUES (?, ?, ?, ?, ?)').run(2, 'main', `${project}.__branch__.main`, 'Branch', '');
  graph.prepare('INSERT INTO nodes_fts (rowid, name, qualified_name, label, file_path) VALUES (?, ?, ?, ?, ?)').run(3, unexpectedLegacyToken ? legacyToken : 'runtimeWorker', `${project}.runtimeWorker`, 'Function', 'src/runtime.ts');
  graph.close();

  const compressed = await run('zstd', ['-q', '-3', '-f', database, '-o', artifact]);
  expect(compressed.status).toBe(0);
  const databaseStats = await stat(database);
  const artifactStats = await stat(artifact);
  await writeFile(metadata, `${JSON.stringify({
    schema_version: 2,
    commit: '0123456789012345678901234567890123456789',
    indexed_at: '2026-08-28T00:00:00Z',
    project,
    nodes: 3,
    edges: 2,
    original_size: databaseStats.size,
    compressed_size: artifactStats.size,
    compression_level: 3,
  }, null, 2)}\n`);
  return { artifact, metadata, database, legacyRoot, legacyToken };
}

async function decompressedDatabase(fixture: ArtifactFixture): Promise<string> {
  const output = `${fixture.database}.verified`;
  const result = await run('zstd', ['-q', '-d', '-f', fixture.artifact, '-o', output]);
  expect(result.status).toBe(0);
  return output;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('codebase-memory artifact sanitizer', () => {
  it('replaces only the local graph root, vacuums old bytes, and preserves query data', async () => {
    const root = await temporaryRoot();
    const fixture = await createFixture(root);
    const originalCompressed = await readFile(fixture.artifact);

    const sanitized = await run(process.execPath, [
      '--no-warnings',
      sanitizer,
      '--artifact', fixture.artifact,
      '--metadata', fixture.metadata,
      '--write',
      '--forbid-token', fixture.legacyToken,
    ]);
    expect(sanitized.status).toBe(0);
    expect(JSON.parse(sanitized.stdout)).toMatchObject({
      ok: true,
      changed: true,
      project: 'portable-project',
      portableRoot: '/workspace/portable-project',
      semantics: {
        nodes: 3,
        edges: 2,
        files: 1,
        nodeVectors: 1,
        tokenVectors: 1,
        ftsRuntimeRows: [3],
      },
    });
    await expect(readFile(fixture.artifact)).resolves.not.toEqual(originalCompressed);
    const sanitizedArtifact = await readFile(fixture.artifact);

    const repeatedWrite = await run(process.execPath, [
      '--no-warnings',
      sanitizer,
      '--artifact', fixture.artifact,
      '--metadata', fixture.metadata,
      '--write',
      '--forbid-token', fixture.legacyToken,
    ]);
    expect(repeatedWrite.status).toBe(0);
    expect(JSON.parse(repeatedWrite.stdout)).toMatchObject({ ok: true, changed: false });
    await expect(readFile(fixture.artifact)).resolves.toEqual(sanitizedArtifact);

    const checked = await run(process.execPath, [
      '--no-warnings',
      sanitizer,
      '--artifact', fixture.artifact,
      '--metadata', fixture.metadata,
      '--check',
      '--forbid-token', fixture.legacyToken,
    ]);
    expect(checked.status).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({ ok: true, changed: false, portableRoot: '/workspace/portable-project' });

    const databasePath = await decompressedDatabase(fixture);
    const graph = new DatabaseSync(databasePath);
    expect(graph.prepare('SELECT root_path FROM projects').get()).toEqual({ root_path: '/workspace/portable-project' });
    const branch = graph.prepare("SELECT properties FROM nodes WHERE label = 'Branch'").get() as { properties: string };
    expect(JSON.parse(branch.properties)).toMatchObject({
      canonical_root: '/workspace/portable-project',
      worktree_root: '/workspace/portable-project',
      root_exists: false,
    });
    expect(graph.prepare("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'runtime' ORDER BY rowid").all()).toEqual([{ rowid: 3 }]);
    expect(graph.prepare('SELECT count(*) AS count FROM node_vectors').get()).toEqual({ count: 1 });
    expect(graph.prepare('SELECT count(*) AS count FROM token_vectors').get()).toEqual({ count: 1 });
    graph.close();

    const raw = await readFile(databasePath);
    expect(raw.includes(Buffer.from(fixture.legacyRoot))).toBe(false);
    expect(raw.includes(Buffer.from(fixture.legacyToken))).toBe(false);
    expect(raw.includes(Buffer.from('example-user'))).toBe(false);
    const metadata = JSON.parse(await readFile(fixture.metadata, 'utf8')) as { original_size: number; compressed_size: number };
    expect(metadata.original_size).toBe((await stat(databasePath)).size);
    expect(metadata.compressed_size).toBe((await stat(fixture.artifact)).size);
  });

  it('refuses to publish an artifact when a legacy token occurs outside approved root fields', async () => {
    const root = await temporaryRoot();
    const fixture = await createFixture(root, true);
    const originalArtifact = await readFile(fixture.artifact);
    const originalMetadata = await readFile(fixture.metadata);

    const result = await run(process.execPath, [
      '--no-warnings',
      sanitizer,
      '--artifact', fixture.artifact,
      '--metadata', fixture.metadata,
      '--write',
      '--forbid-token', fixture.legacyToken,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('forbidden local data remains');
    await expect(readFile(fixture.artifact)).resolves.toEqual(originalArtifact);
    await expect(readFile(fixture.metadata)).resolves.toEqual(originalMetadata);
  });
});
