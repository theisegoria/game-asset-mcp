import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AssetJob, DownloadedFile } from '../domain/asset-job.js';
import { writeJsonAtomic } from '../storage/filesystem.js';
import { JobStore } from '../storage/jobs.js';
import { buildAssetPackage, type BuildAssetPackageResult } from './format.js';
import { AssetCatalog } from './catalog.js';

export const MIGRATION_RECEIPT_SCHEMA = 'game_dev.migration_receipt.v1';

export interface LegacyMigrationItem {
  assetJobId: string;
  name: string;
  modelPath?: string;
  eligible: boolean;
  reason?: string;
  packageId?: string;
  packagePath?: string;
  reused?: boolean;
  error?: string;
}

export interface LegacyMigrationOptions {
  outputRoot: string;
  packagesRoot: string;
  catalogPath?: string;
  confirm?: boolean;
  defaultLicense?: string;
  clock?: () => Date;
}

function preferredModel(job: AssetJob): DownloadedFile | undefined {
  return job.files.find((file) => file.kind === 'model' && path.extname(file.path).toLowerCase() === '.glb');
}

async function planJob(job: AssetJob): Promise<LegacyMigrationItem> {
  const model = preferredModel(job);
  if (!model) {
    return {
      assetJobId: job.id,
      name: job.name,
      eligible: false,
      reason: 'job has no downloaded portable .glb model',
    };
  }
  try {
    const stat = await fs.stat(model.path);
    if (!stat.isFile()) throw new Error('not a regular file');
  } catch (error) {
    return {
      assetJobId: job.id,
      name: job.name,
      modelPath: model.path,
      eligible: false,
      reason: `downloaded model is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    assetJobId: job.id,
    name: job.name,
    modelPath: model.path,
    eligible: true,
  };
}

function migrationVersion(job: AssetJob): string {
  return `1.0.0-migrated.${job.id.replace(/^asset_/, '').replace(/-/g, '').slice(0, 12)}`;
}

async function migrateOne(
  job: AssetJob,
  item: LegacyMigrationItem,
  options: LegacyMigrationOptions,
): Promise<BuildAssetPackageResult> {
  return buildAssetPackage({
    packagesRoot: options.packagesRoot,
    sourcePath: item.modelPath!,
    name: job.name,
    version: migrationVersion(job),
    description: job.spec.description,
    ...(job.spec.category ? { category: job.spec.category } : {}),
    license: options.defaultLicense ?? 'unknown',
    provenance: {
      origin: 'migrated',
      sourceJobId: job.id,
      ...(job.model3d?.provider ? { provider: job.model3d.provider } : {}),
      ...(job.model3d?.providerTaskId ? { providerTaskId: job.model3d.providerTaskId } : {}),
      ...(job.model3d?.modelVersion ? { model: job.model3d.modelVersion } : {}),
      prompt: job.spec.description,
      notes: 'Migrated from the v0.4 AssetJob workspace without re-contacting a provider.',
    },
    clock: options.clock,
  });
}

export async function migrateLegacyWorkspace(options: LegacyMigrationOptions): Promise<{
  schema: typeof MIGRATION_RECEIPT_SCHEMA;
  dryRun: boolean;
  sourceJobsPath: string;
  items: LegacyMigrationItem[];
  migrated: number;
  skipped: number;
  failed: number;
  receiptPath?: string;
}> {
  const outputRoot = path.resolve(options.outputRoot);
  const jobsPath = path.join(outputRoot, '.jobs');
  try {
    await fs.access(jobsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        schema: MIGRATION_RECEIPT_SCHEMA,
        dryRun: !options.confirm,
        sourceJobsPath: jobsPath,
        items: [],
        migrated: 0,
        skipped: 0,
        failed: 0,
      };
    }
    throw error;
  }
  const store = await JobStore.open(jobsPath);
  const jobs = await store.list();
  const items = await Promise.all(jobs.map(planJob));
  if (!options.confirm) {
    return {
      schema: MIGRATION_RECEIPT_SCHEMA,
      dryRun: true,
      sourceJobsPath: jobsPath,
      items,
      migrated: 0,
      skipped: items.filter((item) => !item.eligible).length,
      failed: 0,
    };
  }

  let catalog: AssetCatalog | undefined;
  if (options.catalogPath) catalog = await AssetCatalog.open(options.catalogPath);
  try {
    for (const item of items) {
      if (!item.eligible) continue;
      const job = jobs.find((candidate) => candidate.id === item.assetJobId);
      if (!job) continue;
      try {
        const built = await migrateOne(job, item, options);
        item.packageId = built.manifest.packageId;
        item.packagePath = built.packagePath;
        item.reused = built.reused;
        if (catalog) await catalog.admit(built.packagePath);
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
      }
    }
  } finally {
    catalog?.close();
  }
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const migrationsDirectory = path.join(path.dirname(path.resolve(options.packagesRoot)), 'migrations');
  await fs.mkdir(migrationsDirectory, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(migrationsDirectory, `legacy-v0.4-${now.replace(/[:.]/g, '-')}.json`);
  const migrated = items.filter((item) => item.packageId).length;
  const skipped = items.filter((item) => !item.eligible).length;
  const failed = items.filter((item) => item.error).length;
  await writeJsonAtomic(receiptPath, {
    schema: MIGRATION_RECEIPT_SCHEMA,
    sourceJobsPath: jobsPath,
    completedAt: now,
    items,
    migrated,
    skipped,
    failed,
    evidence: {
      providerCallsPerformed: false,
      sourceModelsCopiedAndHashed: true,
      staticValidationPerformed: true,
      gpuImportTestPerformed: false,
      humanVisualReviewPerformed: false,
    },
  });
  return {
    schema: MIGRATION_RECEIPT_SCHEMA,
    dryRun: false,
    sourceJobsPath: jobsPath,
    items,
    migrated,
    skipped,
    failed,
    receiptPath,
  };
}
