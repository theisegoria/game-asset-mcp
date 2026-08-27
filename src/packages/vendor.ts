import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256, writeJsonAtomic } from '../storage/filesystem.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { readAssetPackage, type AssetPackageManifest } from './format.js';

export const VENDOR_LOCK_SCHEMA = 'game_dev.vendor_lock.v1';
export const VENDOR_RECEIPT_SCHEMA = 'game_dev.vendor_receipt.v1';

export interface VendorLockEntry {
  packageId: string;
  assetId: string;
  version: string;
  destination: string;
  modelSha256: string;
  manifestSha256: string;
  license: string;
  admittedAt: string;
}

export interface VendorLock {
  schema: typeof VENDOR_LOCK_SCHEMA;
  entries: VendorLockEntry[];
}

export interface VendorAdmissionOptions {
  packagePath: string;
  projectRoot: string;
  destinationRelative?: string;
  confirm?: boolean;
  allowUnknownLicense?: boolean;
  allowInvalid?: boolean;
  clock?: () => Date;
}

export interface VendorAdmissionResult {
  dryRun: boolean;
  reused: boolean;
  packageId: string;
  projectRoot: string;
  destination: string;
  lockPath: string;
  receiptPath?: string;
  blockers: string[];
  evidence: {
    packageHashesVerified: boolean;
    copiedPackageHashesVerified: boolean;
    projectImportTestPerformed: boolean;
    gpuRenderTestPerformed: boolean;
  };
}

function safeDestination(projectRoot: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]+/).some((segment) => segment === '..')) {
    throw invalidInput('vendor destination must be a relative path inside the project');
  }
  const target = path.resolve(projectRoot, relative);
  const rel = path.relative(projectRoot, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw invalidInput('vendor destination must identify a child directory inside the project');
  }
  return target;
}

async function rejectSymlinks(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw invalidState(`asset package contains a symbolic link: ${target}`);
      if (entry.isDirectory()) pending.push(target);
    }
  }
}

async function readLock(lockPath: string): Promise<VendorLock> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as VendorLock;
    if (parsed.schema !== VENDOR_LOCK_SCHEMA || !Array.isArray(parsed.entries)) {
      throw invalidState(`unsupported vendor lock at ${lockPath}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schema: VENDOR_LOCK_SCHEMA, entries: [] };
    }
    throw error;
  }
}

function modelIdentity(manifest: AssetPackageManifest): { sha256: string } {
  const model = manifest.files.find((file) => file.kind === 'model');
  if (!model) throw invalidState(`package ${manifest.packageId} has no model entry`);
  return model;
}

export async function admitVendorPackage(
  options: VendorAdmissionOptions,
): Promise<VendorAdmissionResult> {
  const packagePath = await fs.realpath(path.resolve(options.packagePath));
  const projectRoot = await fs.realpath(path.resolve(options.projectRoot));
  if (!(await fs.stat(projectRoot)).isDirectory()) throw invalidInput('project root must be a directory');
  await rejectSymlinks(packagePath);
  const manifest = await readAssetPackage(packagePath);
  const destinationRelative = options.destinationRelative
    ?? path.join('Assets', 'Vendored', manifest.assetId, manifest.version);
  const destination = safeDestination(projectRoot, destinationRelative);
  const gameDevDirectory = path.join(projectRoot, '.game-dev');
  const lockPath = path.join(gameDevDirectory, 'vendor-lock.json');
  const blockers: string[] = [];
  if (manifest.license.toLocaleLowerCase() === 'unknown' && !options.allowUnknownLicense) {
    blockers.push('license is unknown; provide provenance or use --allow-unknown-license with explicit confirmation');
  }
  if (!manifest.validation.passed && !options.allowInvalid) {
    blockers.push(
      `package validation has ${manifest.validation.errorCount} error(s); repair it or explicitly allow invalid admission`,
    );
  }

  let reused = false;
  try {
    const existing = await readAssetPackage(destination);
    if (existing.packageId !== manifest.packageId) {
      blockers.push(`destination already contains different package ${existing.packageId}`);
    } else {
      reused = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      try {
        await fs.access(destination);
        blockers.push(`destination exists but is not the same verified package: ${destination}`);
      } catch {
        // Destination is absent, which is the normal admission case.
      }
    }
  }

  const base: Omit<VendorAdmissionResult, 'dryRun' | 'receiptPath'> = {
    reused,
    packageId: manifest.packageId,
    projectRoot,
    destination,
    lockPath,
    blockers,
    evidence: {
      packageHashesVerified: true,
      copiedPackageHashesVerified: reused,
      projectImportTestPerformed: false,
      gpuRenderTestPerformed: false,
    },
  };
  if (!options.confirm || blockers.length > 0) return { ...base, dryRun: true };

  const now = (options.clock ?? (() => new Date()))().toISOString();
  await fs.mkdir(gameDevDirectory, { recursive: true, mode: 0o700 });
  if (!reused) {
    const stage = path.join(gameDevDirectory, `.vendor-staging-${randomUUID()}`);
    try {
      await fs.cp(packagePath, stage, {
        recursive: true,
        errorOnExist: true,
        force: false,
        dereference: false,
      });
      const copied = await readAssetPackage(stage);
      if (copied.packageId !== manifest.packageId) throw invalidState('copied package identity changed');
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      try {
        await fs.rename(stage, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const raced = await readAssetPackage(destination);
        if (raced.packageId !== manifest.packageId) throw error;
      }
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }

  const verified = await readAssetPackage(destination);
  if (verified.packageId !== manifest.packageId) throw invalidState('vendored package identity mismatch');
  const lock = await readLock(lockPath);
  const manifestBytes = await fs.readFile(path.join(destination, 'manifest.json'));
  const model = modelIdentity(manifest);
  const entry: VendorLockEntry = {
    packageId: manifest.packageId,
    assetId: manifest.assetId,
    version: manifest.version,
    destination: path.relative(projectRoot, destination),
    modelSha256: model.sha256,
    manifestSha256: sha256(manifestBytes),
    license: manifest.license,
    admittedAt: now,
  };
  lock.entries = [
    ...lock.entries.filter((candidate) => candidate.destination !== entry.destination),
    entry,
  ].sort((left, right) => left.destination.localeCompare(right.destination));
  await writeJsonAtomic(lockPath, lock);

  const receiptsDirectory = path.join(gameDevDirectory, 'vendor-receipts');
  await fs.mkdir(receiptsDirectory, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(
    receiptsDirectory,
    `${now.replace(/[:.]/g, '-')}-${manifest.assetId}-${randomUUID()}.json`,
  );
  await writeJsonAtomic(receiptPath, {
    schema: VENDOR_RECEIPT_SCHEMA,
    ...entry,
    sourcePackagePath: packagePath,
    projectRoot,
    evidence: {
      packageHashesVerified: true,
      copiedPackageHashesVerified: true,
      projectImportTestPerformed: false,
      gpuRenderTestPerformed: false,
    },
  });
  return {
    ...base,
    dryRun: false,
    reused,
    receiptPath,
    evidence: {
      ...base.evidence,
      copiedPackageHashesVerified: true,
    },
  };
}
