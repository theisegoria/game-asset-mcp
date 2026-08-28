#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = 'game_dev.codebase_memory_artifact_sanitization.v1';
// Construct rather than spell the workstation-root prefix as a URL-like
// literal. The graph indexer classifies slash-delimited string literals as
// routes; keeping this diagnostic guard out of the route graph lets the
// persisted artifact prove that any matching bytes came from local state.
const macUserRootPrefix = ['', 'Users', ''].join('/');
const requiredTables = [
  'projects',
  'project_summaries',
  'nodes',
  'edges',
  'file_hashes',
  'nodes_fts',
  'node_vectors',
  'token_vectors',
];
const textColumns = [
  ['projects', ['name', 'indexed_at', 'root_path']],
  ['project_summaries', ['project', 'summary', 'source_hash', 'created_at', 'updated_at']],
  ['nodes', ['project', 'label', 'name', 'qualified_name', 'file_path', 'properties']],
  ['edges', ['project', 'type', 'properties']],
  ['file_hashes', ['project', 'rel_path', 'sha256']],
  ['node_vectors', ['project']],
  ['token_vectors', ['project', 'token']],
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function usage() {
  return `Usage: node scripts/sanitize-codebase-memory-artifact.mjs [options]

Read and validate a persisted codebase-memory SQLite artifact. The default mode
does not modify files and fails if the graph still carries a local root.

Options:
  --write                    Sanitize the artifact and update artifact.json atomically per file.
  --check                    Validate only (the default).
  --artifact <path>          Path to graph.db.zst.
  --metadata <path>          Path to artifact.json.
  --portable-root <path>     Portable absolute root (default: /workspace/<project-name>).
  --forbid-token <token>     Additional token that must not occur in the decompressed database.
  --help                     Print this help.
`;
}

function parseArguments(argv) {
  const options = {
    write: false,
    artifact: path.join(root, '.codebase-memory', 'graph.db.zst'),
    metadata: path.join(root, '.codebase-memory', 'artifact.json'),
    portableRoot: undefined,
    forbiddenTokens: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (argument === '--write') {
      options.write = true;
      continue;
    }
    if (argument === '--check') continue;
    if (argument === '--artifact' || argument === '--metadata' || argument === '--portable-root' || argument === '--forbid-token') {
      const value = argv[index + 1];
      invariant(typeof value === 'string' && value.length > 0, `${argument} requires a value`);
      index += 1;
      if (argument === '--artifact') options.artifact = path.resolve(value);
      else if (argument === '--metadata') options.metadata = path.resolve(value);
      else if (argument === '--portable-root') options.portableRoot = value;
      else options.forbiddenTokens.push(value);
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  options.artifact = path.resolve(options.artifact);
  options.metadata = path.resolve(options.metadata);
  options.forbiddenTokens = [...new Set(options.forbiddenTokens)];
  for (const token of options.forbiddenTokens) {
    invariant(!token.includes('\0'), '--forbid-token must not contain a NUL byte');
  }
  return options;
}

function normalizedPortableRoot(value, project) {
  const candidate = value ?? path.posix.join('/workspace', project);
  const normalized = path.posix.normalize(candidate);
  invariant(path.posix.isAbsolute(normalized), 'portable root must be a POSIX absolute path');
  invariant(!normalized.startsWith(macUserRootPrefix), 'portable root must not be inside a macOS user directory');
  invariant(normalized !== '/', 'portable root must identify a project directory');
  return normalized;
}

function readMetadata(metadataPath) {
  const raw = readFileSync(metadataPath, 'utf8');
  const metadata = JSON.parse(raw);
  invariant(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'artifact metadata must be an object');
  invariant(metadata.schema_version === 2, 'unsupported artifact metadata schema');
  invariant(typeof metadata.project === 'string' && metadata.project.length > 0, 'artifact metadata project is required');
  invariant(Number.isInteger(metadata.nodes) && metadata.nodes >= 0, 'artifact metadata nodes must be a non-negative integer');
  invariant(Number.isInteger(metadata.edges) && metadata.edges >= 0, 'artifact metadata edges must be a non-negative integer');
  invariant(Number.isInteger(metadata.original_size) && metadata.original_size > 0, 'artifact metadata original_size must be positive');
  invariant(Number.isInteger(metadata.compressed_size) && metadata.compressed_size > 0, 'artifact metadata compressed_size must be positive');
  invariant(Number.isInteger(metadata.compression_level) && metadata.compression_level >= 1 && metadata.compression_level <= 22, 'artifact metadata compression_level is invalid');
  const indent = raw.match(/\n( +)"/)?.[1].length ?? 2;
  return { metadata, indent };
}

function runZstd(commandArguments, label) {
  const result = spawnSync('zstd', commandArguments, {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${label}: could not execute zstd: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : '';
    throw new Error(`${label}: zstd failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function decompressArtifact(artifactPath, destination) {
  const bytes = runZstd(['-q', '-d', '-c', artifactPath], 'decompress artifact');
  writeFileSync(destination, bytes, { mode: 0o600 });
}

function compressArtifact(databasePath, destination, compressionLevel) {
  runZstd(['-q', `-${compressionLevel}`, '-f', databasePath, '-o', destination], 'compress artifact');
}

function openDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;');
  return database;
}

function scalar(database, sql, ...parameters) {
  const row = database.prepare(sql).get(...parameters);
  invariant(row && typeof row === 'object', `query did not return a row: ${sql}`);
  const values = Object.values(row);
  invariant(values.length === 1, `query must return exactly one value: ${sql}`);
  return values[0];
}

function schemaState(database, metadata) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const table of requiredTables) invariant(tables.has(table), `graph database is missing required table: ${table}`);

  const integrity = scalar(database, 'PRAGMA integrity_check;');
  invariant(integrity === 'ok', `graph database integrity check failed: ${integrity}`);
  const foreignKeys = database.prepare('PRAGMA foreign_key_check;').all();
  invariant(foreignKeys.length === 0, 'graph database foreign key check failed');

  const projects = database.prepare('SELECT name, root_path FROM projects ORDER BY name').all();
  invariant(projects.length === 1, `graph database must contain one project, found ${projects.length}`);
  const project = projects[0];
  invariant(typeof project.name === 'string' && project.name.length > 0, 'graph project name is invalid');
  invariant(typeof project.root_path === 'string' && project.root_path.startsWith('/'), 'graph project root must remain an absolute POSIX path');
  invariant(metadata.project === project.name, 'artifact metadata project does not match graph project');

  const semantics = {
    nodes: Number(scalar(database, 'SELECT count(*) FROM nodes;')),
    edges: Number(scalar(database, 'SELECT count(*) FROM edges;')),
    files: Number(scalar(database, 'SELECT count(*) FROM file_hashes;')),
    nodeVectors: Number(scalar(database, 'SELECT count(*) FROM node_vectors;')),
    tokenVectors: Number(scalar(database, 'SELECT count(*) FROM token_vectors;')),
    ftsRuntimeRows: database.prepare('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY rowid LIMIT 32').all('runtime').map((row) => Number(row.rowid)),
  };
  invariant(metadata.nodes === semantics.nodes, 'artifact metadata node count does not match graph database');
  invariant(metadata.edges === semantics.edges, 'artifact metadata edge count does not match graph database');
  return { project, semantics };
}

function propertyRows(database, table, rootPath) {
  return database.prepare(`SELECT id, properties FROM ${table} WHERE instr(properties, ?) > 0 ORDER BY id`).all(rootPath);
}

function replaceRootInProperty(value, oldRoot, newRoot, location) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${location} properties must be an object`);
  let replacements = 0;
  for (const [key, property] of Object.entries(value)) {
    if (typeof property === 'string' && property.includes(oldRoot)) {
      invariant(property === oldRoot, `${location}.${key} contains a local root as a substring`);
      invariant(key === 'canonical_root' || key === 'worktree_root', `${location}.${key} is not an approved root-path field`);
      value[key] = newRoot;
      replacements += 1;
    }
  }
  if (replacements > 0 && Object.hasOwn(value, 'root_exists')) {
    invariant(typeof value.root_exists === 'boolean', `${location}.root_exists must be boolean`);
    value.root_exists = false;
  }
  return replacements;
}

function legacyLocations(database, term) {
  const locations = [];
  for (const [table, columns] of textColumns) {
    const where = columns.map((column) => `instr(${column}, ?) > 0`).join(' OR ');
    const count = Number(scalar(database, `SELECT count(*) FROM ${table} WHERE ${where};`, ...columns.map(() => term)));
    if (count > 0) locations.push({ table, count });
  }
  return locations;
}

function assertExpectedLegacyLocations(database, oldRoot, oldLeaf) {
  const allowed = new Set(['projects', 'nodes', 'edges']);
  for (const term of [oldRoot, oldLeaf]) {
    for (const location of legacyLocations(database, term)) {
      invariant(allowed.has(location.table), `legacy root data appears in unsupported table: ${location.table}`);
    }
  }
}

function sanitizeDatabase(database, state, portableRoot) {
  const oldRoot = state.project.root_path;
  const oldLeaf = path.posix.basename(oldRoot);
  const rootSegments = oldRoot.split('/').filter(Boolean);
  const usersSegment = rootSegments.indexOf('Users');
  const oldUser = usersSegment >= 0 ? rootSegments[usersSegment + 1] : undefined;
  invariant(oldLeaf.length > 0 && oldLeaf !== '.', 'legacy root must have a project-directory component');
  invariant(oldLeaf !== state.project.name, 'legacy root already uses the current project identity; choose --portable-root explicitly if migration is required');
  invariant(!portableRoot.includes(oldLeaf), 'portable root must not retain the legacy project token');
  assertExpectedLegacyLocations(database, oldRoot, oldLeaf);

  database.exec('BEGIN IMMEDIATE;');
  try {
    const projectUpdate = database.prepare('UPDATE projects SET root_path = ? WHERE name = ? AND root_path = ?').run(portableRoot, state.project.name, oldRoot);
    invariant(projectUpdate.changes === 1, 'graph project root changed while sanitizing');

    let propertyReplacements = 0;
    for (const table of ['nodes', 'edges']) {
      const update = database.prepare(`UPDATE ${table} SET properties = ? WHERE id = ?`);
      for (const row of propertyRows(database, table, oldRoot)) {
        const properties = JSON.parse(row.properties);
        const replacements = replaceRootInProperty(properties, oldRoot, portableRoot, `${table}[${row.id}]`);
        invariant(replacements > 0, `${table}[${row.id}] contains an unsupported local-root location`);
        invariant(update.run(JSON.stringify(properties), row.id).changes === 1, `${table}[${row.id}] could not be updated`);
        propertyReplacements += replacements;
      }
    }
    invariant(propertyReplacements > 0, 'graph does not contain a branch-root property to sanitize');
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }

  database.exec('VACUUM;');
  return { oldRoot, oldLeaf, oldUser };
}

function assertPortableGraph(database, portableRoot, forbiddenTokens) {
  const rootPath = scalar(database, 'SELECT root_path FROM projects LIMIT 1;');
  invariant(rootPath === portableRoot, 'graph project root is not the requested portable root');

  for (const table of ['nodes', 'edges']) {
    const nonPortable = Number(scalar(
      database,
      `SELECT count(*) FROM ${table} WHERE
        (json_extract(properties, '$.canonical_root') IS NOT NULL AND json_extract(properties, '$.canonical_root') != ?)
        OR (json_extract(properties, '$.worktree_root') IS NOT NULL AND json_extract(properties, '$.worktree_root') != ?)
        OR ((json_extract(properties, '$.canonical_root') IS NOT NULL OR json_extract(properties, '$.worktree_root') IS NOT NULL) AND COALESCE(json_extract(properties, '$.root_exists'), 1) != 0);`,
      portableRoot,
      portableRoot,
    ));
    invariant(nonPortable === 0, `${table} contains a non-portable branch-root property`);
  }

  for (const token of forbiddenTokens) {
    invariant(legacyLocations(database, token).length === 0, 'forbidden local data remains in a graph text column');
  }
}

function assertNoRawTokens(databasePath, forbiddenTokens) {
  const bytes = readFileSync(databasePath);
  for (const token of forbiddenTokens) {
    invariant(!bytes.includes(Buffer.from(token, 'utf8')), 'forbidden local data remains in the vacuumed graph bytes');
  }
}

function sameSemantics(before, after) {
  invariant(before.nodes === after.nodes, 'sanitization changed node count');
  invariant(before.edges === after.edges, 'sanitization changed edge count');
  invariant(before.files === after.files, 'sanitization changed file-hash count');
  invariant(before.nodeVectors === after.nodeVectors, 'sanitization changed node-vector count');
  invariant(before.tokenVectors === after.tokenVectors, 'sanitization changed token-vector count');
  invariant(JSON.stringify(before.ftsRuntimeRows) === JSON.stringify(after.ftsRuntimeRows), 'sanitization changed a representative FTS query result');
}

function formatMetadata(metadata, indent) {
  return `${JSON.stringify(metadata, null, indent)}\n`;
}

function replacePublishedFiles(artifactPath, metadataPath, artifactSource, metadataContents) {
  const artifactMode = statSync(artifactPath).mode & 0o777;
  const metadataMode = statSync(metadataPath).mode & 0o777;
  const originalArtifact = readFileSync(artifactPath);
  const originalMetadata = readFileSync(metadataPath);
  const artifactStage = mkdtempSync(path.join(path.dirname(artifactPath), '.codebase-memory-artifact-'));
  const metadataStage = path.dirname(artifactPath) === path.dirname(metadataPath)
    ? artifactStage
    : mkdtempSync(path.join(path.dirname(metadataPath), '.codebase-memory-metadata-'));
  const stagedArtifact = path.join(artifactStage, path.basename(artifactPath));
  const stagedMetadata = path.join(metadataStage, path.basename(metadataPath));
  let artifactPublished = false;
  try {
    copyFileSync(artifactSource, stagedArtifact);
    chmodSync(stagedArtifact, artifactMode);
    writeFileSync(stagedMetadata, metadataContents, { mode: metadataMode });
    renameSync(stagedArtifact, artifactPath);
    artifactPublished = true;
    renameSync(stagedMetadata, metadataPath);
  } catch (error) {
    try {
      if (artifactPublished) writeFileSync(artifactPath, originalArtifact, { mode: artifactMode });
      writeFileSync(metadataPath, originalMetadata, { mode: metadataMode });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'artifact replacement and rollback both failed');
    }
    throw error;
  } finally {
    rmSync(artifactStage, { recursive: true, force: true });
    if (metadataStage !== artifactStage) rmSync(metadataStage, { recursive: true, force: true });
  }
}

function inspectArtifact(artifactPath, metadataPath, portableRootOption, forbiddenTokens, write) {
  const { metadata, indent } = readMetadata(metadataPath);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'codebase-memory-artifact-'));
  try {
    const databasePath = path.join(temporaryRoot, 'graph.db');
    decompressArtifact(artifactPath, databasePath);
    invariant(statSync(databasePath).size === metadata.original_size, 'artifact metadata original_size does not match decompressed graph');
    invariant(statSync(artifactPath).size === metadata.compressed_size, 'artifact metadata compressed_size does not match graph.db.zst');

    const database = openDatabase(databasePath);
    const state = schemaState(database, metadata);
    const portableRoot = normalizedPortableRoot(portableRootOption, state.project.name);
    let changed = false;
    let legacy = undefined;
    const before = state.semantics;

    if (state.project.root_path !== portableRoot) {
      invariant(write, `graph root is not portable; rerun with --write to replace it with ${portableRoot}`);
      legacy = sanitizeDatabase(database, state, portableRoot);
      changed = true;
    }

    assertPortableGraph(database, portableRoot, forbiddenTokens);
    const after = schemaState(database, { ...metadata, project: state.project.name, nodes: before.nodes, edges: before.edges }).semantics;
    sameSemantics(before, after);
    database.close();

    const rawTokens = [...new Set([
      ...forbiddenTokens,
      ...(legacy ? [legacy.oldRoot, legacy.oldLeaf, legacy.oldUser].filter(Boolean) : []),
    ])];
    assertNoRawTokens(databasePath, rawTokens);

    if (!changed) {
      return {
        ok: true,
        schema,
        changed: false,
        project: state.project.name,
        portableRoot,
        originalSize: metadata.original_size,
        compressedSize: metadata.compressed_size,
        semantics: before,
      };
    }

    const sanitizedArtifact = path.join(temporaryRoot, 'graph.db.zst');
    compressArtifact(databasePath, sanitizedArtifact, metadata.compression_level);
    const verifyDatabasePath = path.join(temporaryRoot, 'verified.db');
    decompressArtifact(sanitizedArtifact, verifyDatabasePath);
    const verifyDatabase = openDatabase(verifyDatabasePath);
    const candidateMetadata = {
      ...metadata,
      original_size: statSync(verifyDatabasePath).size,
      compressed_size: statSync(sanitizedArtifact).size,
    };
    const verifiedState = schemaState(verifyDatabase, candidateMetadata);
    assertPortableGraph(verifyDatabase, portableRoot, forbiddenTokens);
    sameSemantics(before, verifiedState.semantics);
    verifyDatabase.close();
    assertNoRawTokens(verifyDatabasePath, rawTokens);

    replacePublishedFiles(artifactPath, metadataPath, sanitizedArtifact, formatMetadata(candidateMetadata, indent));
    return {
      ok: true,
      schema,
      changed: true,
      project: state.project.name,
      portableRoot,
      originalSize: candidateMetadata.original_size,
      compressedSize: candidateMetadata.compressed_size,
      semantics: verifiedState.semantics,
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = inspectArtifact(
    options.artifact,
    options.metadata,
    options.portableRoot,
    options.forbiddenTokens,
    options.write,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`codebase-memory artifact sanitization failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
