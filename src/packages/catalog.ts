import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { sha256 } from '../storage/filesystem.js';
import { invalidInput, notFound } from '../util/errors.js';
import { readAssetPackage, type AssetPackageManifest } from './format.js';

export const CATALOG_SCHEMA = 'game_dev.catalog.v1';
const DATABASE_VERSION = 1;

async function openDatabase(databasePath: string): Promise<DatabaseSync> {
  const sqlite = await import('node:sqlite');
  return new sqlite.DatabaseSync(databasePath);
}

export interface CatalogAsset {
  packageId: string;
  assetId: string;
  version: string;
  displayName: string;
  description?: string;
  category?: string;
  license: string;
  packagePath: string;
  modelPath: string;
  previewPath?: string;
  modelSha256: string;
  manifestSha256: string;
  validationPassed: boolean;
  validationErrors: number;
  validationWarnings: number;
  origin: string;
  provider?: string;
  indexedAt: string;
}

export interface CatalogListOptions {
  query?: string;
  category?: string;
  validationPassed?: boolean;
  limit?: number;
}

function createSchema(database: DatabaseSync, journalMode: 'WAL' | 'DELETE' = 'WAL'): void {
  database.exec(`
    PRAGMA journal_mode = ${journalMode};
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS catalog_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS assets (
      package_id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      version TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      license TEXT NOT NULL,
      package_path TEXT NOT NULL UNIQUE,
      model_path TEXT NOT NULL,
      preview_path TEXT,
      model_sha256 TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      validation_passed INTEGER NOT NULL CHECK (validation_passed IN (0, 1)),
      validation_errors INTEGER NOT NULL,
      validation_warnings INTEGER NOT NULL,
      origin TEXT NOT NULL,
      provider TEXT,
      indexed_at TEXT NOT NULL,
      search_text TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS assets_asset_id ON assets(asset_id);
    CREATE INDEX IF NOT EXISTS assets_category ON assets(category);
    CREATE INDEX IF NOT EXISTS assets_validation ON assets(validation_passed);
  `);
  database.prepare(
    'INSERT OR REPLACE INTO catalog_meta(key, value) VALUES (?, ?)',
  ).run('schema', CATALOG_SCHEMA);
  database.prepare(
    'INSERT OR REPLACE INTO catalog_meta(key, value) VALUES (?, ?)',
  ).run('database_version', String(DATABASE_VERSION));
}

function rowToAsset(row: Record<string, unknown>): CatalogAsset {
  return {
    packageId: String(row.package_id),
    assetId: String(row.asset_id),
    version: String(row.version),
    displayName: String(row.display_name),
    ...(row.description !== null ? { description: String(row.description) } : {}),
    ...(row.category !== null ? { category: String(row.category) } : {}),
    license: String(row.license),
    packagePath: String(row.package_path),
    modelPath: String(row.model_path),
    ...(row.preview_path !== null ? { previewPath: String(row.preview_path) } : {}),
    modelSha256: String(row.model_sha256),
    manifestSha256: String(row.manifest_sha256),
    validationPassed: Number(row.validation_passed) === 1,
    validationErrors: Number(row.validation_errors),
    validationWarnings: Number(row.validation_warnings),
    origin: String(row.origin),
    ...(row.provider !== null ? { provider: String(row.provider) } : {}),
    indexedAt: String(row.indexed_at),
  };
}

async function catalogRecord(
  packagePath: string,
  manifest?: AssetPackageManifest,
): Promise<CatalogAsset> {
  const resolved = await fs.realpath(path.resolve(packagePath));
  const checked = manifest ?? await readAssetPackage(resolved);
  const manifestBytes = await fs.readFile(path.join(resolved, 'manifest.json'));
  const model = checked.files.find((file) => file.kind === 'model');
  if (!model) throw invalidInput(`package ${checked.packageId} has no model file`);
  return {
    packageId: checked.packageId,
    assetId: checked.assetId,
    version: checked.version,
    displayName: checked.displayName,
    ...(checked.description ? { description: checked.description } : {}),
    ...(checked.category ? { category: checked.category } : {}),
    license: checked.license,
    packagePath: resolved,
    modelPath: path.join(resolved, checked.model),
    ...(checked.preview ? { previewPath: path.join(resolved, checked.preview) } : {}),
    modelSha256: model.sha256,
    manifestSha256: sha256(manifestBytes),
    validationPassed: checked.validation.passed,
    validationErrors: checked.validation.errorCount,
    validationWarnings: checked.validation.warningCount,
    origin: checked.provenance.origin,
    ...(checked.provenance.provider ? { provider: checked.provenance.provider } : {}),
    indexedAt: new Date().toISOString(),
  };
}

function insert(database: DatabaseSync, asset: CatalogAsset): void {
  const searchText = [
    asset.assetId,
    asset.displayName,
    asset.description,
    asset.category,
    asset.provider,
    asset.license,
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  database.prepare(`
    INSERT INTO assets (
      package_id, asset_id, version, display_name, description, category, license,
      package_path, model_path, preview_path, model_sha256, manifest_sha256,
      validation_passed, validation_errors, validation_warnings, origin, provider,
      indexed_at, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(package_id) DO UPDATE SET
      asset_id = excluded.asset_id,
      version = excluded.version,
      display_name = excluded.display_name,
      description = excluded.description,
      category = excluded.category,
      license = excluded.license,
      package_path = excluded.package_path,
      model_path = excluded.model_path,
      preview_path = excluded.preview_path,
      model_sha256 = excluded.model_sha256,
      manifest_sha256 = excluded.manifest_sha256,
      validation_passed = excluded.validation_passed,
      validation_errors = excluded.validation_errors,
      validation_warnings = excluded.validation_warnings,
      origin = excluded.origin,
      provider = excluded.provider,
      indexed_at = excluded.indexed_at,
      search_text = excluded.search_text
  `).run(
    asset.packageId,
    asset.assetId,
    asset.version,
    asset.displayName,
    asset.description ?? null,
    asset.category ?? null,
    asset.license,
    asset.packagePath,
    asset.modelPath,
    asset.previewPath ?? null,
    asset.modelSha256,
    asset.manifestSha256,
    asset.validationPassed ? 1 : 0,
    asset.validationErrors,
    asset.validationWarnings,
    asset.origin,
    asset.provider ?? null,
    asset.indexedAt,
    searchText,
  );
}

async function findPackages(root: string): Promise<string[]> {
  const resolved = path.resolve(root);
  const found: string[] = [];
  let assets: import('node:fs').Dirent[];
  try {
    assets = await fs.readdir(resolved, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  for (const asset of assets) {
    if (!asset.isDirectory() || asset.name.startsWith('.')) continue;
    const versions = await fs.readdir(path.join(resolved, asset.name), { withFileTypes: true });
    for (const version of versions) {
      if (!version.isDirectory() || version.name.startsWith('.')) continue;
      const packagePath = path.join(resolved, asset.name, version.name);
      try {
        await fs.access(path.join(packagePath, 'manifest.json'));
        found.push(packagePath);
      } catch {
        // Non-package directories are ignored; an invalid package with a
        // manifest is surfaced by readAssetPackage below.
      }
    }
  }
  return found.sort();
}

export class AssetCatalog {
  private constructor(
    readonly databasePath: string,
    private readonly database: DatabaseSync,
  ) {}

  static async open(databasePath: string): Promise<AssetCatalog> {
    const resolved = path.resolve(databasePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
    const database = await openDatabase(resolved);
    createSchema(database);
    return new AssetCatalog(resolved, database);
  }

  close(): void {
    this.database.close();
  }

  async admit(packagePath: string): Promise<CatalogAsset> {
    const asset = await catalogRecord(packagePath);
    insert(this.database, asset);
    return asset;
  }

  get(packageId: string): CatalogAsset {
    const row = this.database.prepare(
      'SELECT * FROM assets WHERE package_id = ?',
    ).get(packageId) as Record<string, unknown> | undefined;
    if (!row) throw notFound('catalog package', packageId);
    return rowToAsset(row);
  }

  list(options: CatalogListOptions = {}): CatalogAsset[] {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
      throw invalidInput('catalog limit must be an integer from 1 through 10000');
    }
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.query?.trim()) {
      clauses.push('search_text LIKE ? ESCAPE \'\\\'');
      const escaped = options.query.trim().toLocaleLowerCase().replace(/[\\%_]/g, '\\$&');
      parameters.push(`%${escaped}%`);
    }
    if (options.category) {
      clauses.push('category = ?');
      parameters.push(options.category);
    }
    if (options.validationPassed !== undefined) {
      clauses.push('validation_passed = ?');
      parameters.push(options.validationPassed ? 1 : 0);
    }
    parameters.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.prepare(
      `SELECT * FROM assets ${where} ORDER BY display_name COLLATE NOCASE, version DESC LIMIT ?`,
    ).all(...parameters) as Record<string, unknown>[];
    return rows.map(rowToAsset);
  }

  static async rebuild(
    databasePath: string,
    packagesRoot: string,
  ): Promise<{ indexed: CatalogAsset[]; databasePath: string; backupPath?: string }> {
    const resolved = path.resolve(databasePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
    const temporary = `${resolved}.rebuild-${randomUUID()}`;
    const database = await openDatabase(temporary);
    const indexed: CatalogAsset[] = [];
    let preparationError: unknown;
    try {
      createSchema(database, 'DELETE');
      const packages = await findPackages(packagesRoot);
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const packagePath of packages) {
          const asset = await catalogRecord(packagePath);
          insert(database, asset);
          indexed.push(asset);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      preparationError = error;
    } finally {
      database.close();
    }
    if (preparationError !== undefined) {
      await fs.rm(temporary, { force: true });
      throw preparationError;
    }

    let backupPath: string | undefined;
    try {
      await fs.access(resolved);
      backupPath = `${resolved}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fs.rename(resolved, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await fs.rm(temporary, { force: true });
        throw error;
      }
    }
    try {
      await fs.rename(temporary, resolved);
    } catch (error) {
      if (backupPath) await fs.rename(backupPath, resolved);
      await fs.rm(temporary, { force: true });
      throw error;
    }
    return { indexed, databasePath: resolved, ...(backupPath ? { backupPath } : {}) };
  }
}
