import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ASSET_CATEGORIES, sanitizeAssetName, type AssetCategory } from '../domain/asset-spec.js';
import { evaluateAsset, type GameAssetPolicy, type ValidationReport } from '../domain/asset-policy.js';
import { inspectGltf, type AssetInspection } from '../inspection/gltf.js';
import { sha256 } from '../storage/filesystem.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { redact } from '../util/logging.js';
import { safeUrlForLogs } from '../util/http.js';

export const ASSET_PACKAGE_SCHEMA = 'game_dev.asset_package.v1';
export const ASSET_METADATA_SCHEMA = 'game_dev.asset_metadata.v1';
export const ASSET_PROVENANCE_SCHEMA = 'game_dev.asset_provenance.v1';
export const ASSET_VALIDATION_SCHEMA = 'game_dev.asset_validation.v1';
export const PACKAGE_RECEIPT_SCHEMA = 'game_dev.package_receipt.v1';

export type AssetOrigin = 'authored' | 'generated' | 'imported' | 'migrated';

export interface AssetPackageFile {
  path: string;
  kind: 'model' | 'preview' | 'metadata' | 'provenance' | 'validation';
  bytes: number;
  sha256: string;
}

export interface AssetPackageManifest {
  schema: typeof ASSET_PACKAGE_SCHEMA;
  packageId: string;
  assetId: string;
  version: string;
  displayName: string;
  description?: string;
  category?: AssetCategory;
  license: string;
  model: 'model.glb';
  preview?: 'preview.usdz';
  files: AssetPackageFile[];
  validation: {
    passed: boolean;
    errorCount: number;
    warningCount: number;
  };
  provenance: {
    origin: AssetOrigin;
    provider?: string;
    sourceJobId?: string;
  };
}

export interface AssetProvenanceInput {
  origin?: AssetOrigin;
  provider?: string;
  providerTaskId?: string;
  sourceJobId?: string;
  prompt?: string;
  negativePrompt?: string;
  seed?: number;
  model?: string;
  author?: string;
  sourceUri?: string;
  notes?: string;
  parentPackageIds?: string[];
}

export interface BuildAssetPackageOptions {
  packagesRoot: string;
  sourcePath: string;
  name: string;
  version?: string;
  description?: string;
  category?: AssetCategory;
  license?: string;
  previewPath?: string;
  policy?: Partial<GameAssetPolicy>;
  provenance?: AssetProvenanceInput;
  maximumBytes?: number;
  clock?: () => Date;
}

export interface BuildAssetPackageResult {
  packagePath: string;
  manifestPath: string;
  receiptPath: string;
  manifestSha256: string;
  manifest: AssetPackageManifest;
  inspection: AssetInspection;
  validation: ValidationReport;
  reused: boolean;
}

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const LICENSE = /^[0-9A-Za-z][0-9A-Za-z ._()+:/-]{0,127}$/;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sorted(entry)]),
  );
}

/** Stable, newline-terminated JSON for package identity and reviewable diffs. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

async function hashFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    digest.update(buffer);
  }
  return { bytes, sha256: digest.digest('hex') };
}

async function writeCanonical(
  directory: string,
  fileName: string,
  kind: AssetPackageFile['kind'],
  value: unknown,
): Promise<AssetPackageFile> {
  const bytes = Buffer.from(canonicalJson(value));
  await fs.writeFile(path.join(directory, fileName), bytes, { flag: 'wx', mode: 0o600 });
  return { path: fileName, kind, bytes: bytes.length, sha256: sha256(bytes) };
}

function validateInputs(options: BuildAssetPackageOptions): {
  assetId: string;
  version: string;
  license: string;
} {
  if (options.name.trim().length === 0) throw invalidInput('package name must not be empty');
  const assetId = sanitizeAssetName(options.name);
  const version = options.version?.trim() || '1.0.0';
  if (!VERSION.test(version)) throw invalidInput('package version must be SemVer-like, for example 1.0.0');
  const license = options.license?.trim() || 'unknown';
  if (!LICENSE.test(license)) throw invalidInput('license contains unsupported characters');
  if (options.category && !ASSET_CATEGORIES.includes(options.category)) {
    throw invalidInput(`unsupported asset category: ${options.category}`);
  }
  return { assetId, version, license };
}

async function assertPortableModel(sourcePath: string, maximumBytes: number): Promise<string> {
  const resolved = await fs.realpath(path.resolve(sourcePath));
  if (path.extname(resolved).toLowerCase() !== '.glb') {
    throw invalidInput('portable packages require a binary .glb model; normalize or convert .gltf first');
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw invalidInput('package source must be a regular .glb file');
  if (stat.size <= 0) throw invalidInput('package source is empty');
  if (stat.size > maximumBytes) {
    throw invalidInput(`package source exceeds the ${maximumBytes}-byte safety limit`, {
      bytes: stat.size,
      maximumBytes,
    });
  }
  return resolved;
}

function normalizedInspection(inspection: AssetInspection): AssetInspection {
  return { ...inspection, filePath: 'model.glb' };
}

async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

async function existingResult(
  finalPath: string,
  expectedPackageId: string,
  inspection: AssetInspection,
  validation: ValidationReport,
): Promise<BuildAssetPackageResult | undefined> {
  let manifest: AssetPackageManifest;
  try {
    manifest = await readAssetPackage(finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (manifest.schema !== ASSET_PACKAGE_SCHEMA || manifest.packageId !== expectedPackageId) {
    throw invalidState(
      `package destination already contains a different ${manifest.packageId ?? 'unknown package'}`,
      { finalPath, expectedPackageId },
    );
  }
  const raw = await fs.readFile(path.join(finalPath, 'manifest.json'), 'utf8');
  return {
    packagePath: finalPath,
    manifestPath: path.join(finalPath, 'manifest.json'),
    receiptPath: path.join(finalPath, 'receipt.json'),
    manifestSha256: sha256(Buffer.from(raw)),
    manifest,
    inspection,
    validation,
    reused: true,
  };
}

export interface AssetPackagePlan {
  assetId: string;
  version: string;
  license: string;
  sourcePath: string;
  sourceIdentity: { bytes: number; sha256: string };
  packagesRoot: string;
  /** Where the built package would land. */
  destination: string;
  destinationExists: boolean;
  validation: ReturnType<typeof evaluateAsset>;
  inspection: ReturnType<typeof normalizedInspection>;
}

/**
 * Everything `buildAssetPackage` determines before it writes anything.
 *
 * Extracted rather than reimplemented so a plan cannot disagree with the build
 * it predicts: the build calls this too.
 *
 * It deliberately does NOT report a packageId. That id hashes the staged file
 * set, so producing it means doing the write this function exists to avoid.
 * Saying "unknown" is better than reporting a guess that a later build
 * contradicts.
 */
export async function planAssetPackage(
  options: BuildAssetPackageOptions,
): Promise<AssetPackagePlan> {
  const { assetId, version, license } = validateInputs(options);
  const maximumBytes = options.maximumBytes ?? 512 * 1024 * 1024;
  const source = await assertPortableModel(options.sourcePath, maximumBytes);
  const sourceIdentity = await hashFile(source);
  const inspected = normalizedInspection(await inspectGltf(source));
  const validation = evaluateAsset(inspected, options.policy);
  const packagesRoot = path.resolve(options.packagesRoot);
  const destination = path.join(packagesRoot, assetId, version);
  const destinationExists = await fs.access(destination).then(() => true, () => false);
  return {
    assetId,
    version,
    license,
    sourcePath: source,
    sourceIdentity,
    packagesRoot,
    destination,
    destinationExists,
    validation,
    inspection: inspected,
  };
}

export async function buildAssetPackage(
  options: BuildAssetPackageOptions,
): Promise<BuildAssetPackageResult> {
  const plan = await planAssetPackage(options);
  const { assetId, version, license, packagesRoot, sourceIdentity, validation, inspection: inspected } = plan;
  const source = plan.sourcePath;
  await fs.mkdir(packagesRoot, { recursive: true, mode: 0o700 });

  let preview: { source: string; identity: { bytes: number; sha256: string } } | undefined;
  if (options.previewPath) {
    const previewSource = await fs.realpath(path.resolve(options.previewPath));
    if (path.extname(previewSource).toLowerCase() !== '.usdz') {
      throw invalidInput('package preview must be a .usdz file');
    }
    const header = await fs.readFile(previewSource).then((bytes) => bytes.subarray(0, 4));
    if (header[0] !== 0x50 || header[1] !== 0x4b) {
      throw invalidInput('package preview is not a USDZ/ZIP container');
    }
    preview = { source: previewSource, identity: await hashFile(previewSource) };
  }

  const suppliedProvenance = {
    ...(options.provenance ?? {}),
    ...(options.provenance?.sourceUri
      ? { sourceUri: safeUrlForLogs(options.provenance.sourceUri) }
      : {}),
  };
  const provenance = redact({
    ...suppliedProvenance,
    schema: ASSET_PROVENANCE_SCHEMA,
    origin: options.provenance?.origin ?? 'imported',
    source: {
      fileName: path.basename(source),
      bytes: sourceIdentity.bytes,
      sha256: sourceIdentity.sha256,
    },
  }) as Record<string, unknown>;
  const metadata = {
    schema: ASSET_METADATA_SCHEMA,
    assetId,
    displayName: options.name.trim(),
    ...(options.description?.trim() ? { description: options.description.trim() } : {}),
    ...(options.category ? { category: options.category } : {}),
    license,
    inspection: inspected,
  };
  const validationDocument = {
    schema: ASSET_VALIDATION_SCHEMA,
    policy: options.policy ?? {},
    report: validation,
  };

  const stage = path.join(packagesRoot, `.staging-${assetId}-${randomUUID()}`);
  await fs.mkdir(stage, { recursive: false, mode: 0o700 });
  try {
    const modelTarget = path.join(stage, 'model.glb');
    await fs.copyFile(source, modelTarget, fs.constants.COPYFILE_EXCL);
    const copiedModel = await hashFile(modelTarget);
    if (copiedModel.sha256 !== sourceIdentity.sha256 || copiedModel.bytes !== sourceIdentity.bytes) {
      throw invalidState('copied model does not match its source bytes');
    }
    const files: AssetPackageFile[] = [
      { path: 'model.glb', kind: 'model', ...copiedModel },
    ];
    if (preview) {
      const previewTarget = path.join(stage, 'preview.usdz');
      await fs.copyFile(preview.source, previewTarget, fs.constants.COPYFILE_EXCL);
      const copiedPreview = await hashFile(previewTarget);
      if (copiedPreview.sha256 !== preview.identity.sha256 || copiedPreview.bytes !== preview.identity.bytes) {
        throw invalidState('copied preview does not match its source bytes');
      }
      files.push({ path: 'preview.usdz', kind: 'preview', ...copiedPreview });
    }
    files.push(await writeCanonical(stage, 'metadata.json', 'metadata', metadata));
    files.push(await writeCanonical(stage, 'provenance.json', 'provenance', provenance));
    files.push(await writeCanonical(stage, 'validation.json', 'validation', validationDocument));

    const identityDocument = {
      assetId,
      version,
      displayName: options.name.trim(),
      ...(options.description?.trim() ? { description: options.description.trim() } : {}),
      ...(options.category ? { category: options.category } : {}),
      license,
      files,
      validation: {
        passed: validation.passed,
        errorCount: validation.errorCount,
        warningCount: validation.warningCount,
      },
      provenance: {
        origin: options.provenance?.origin ?? 'imported',
        ...(options.provenance?.provider ? { provider: options.provenance.provider } : {}),
        ...(options.provenance?.sourceJobId ? { sourceJobId: options.provenance.sourceJobId } : {}),
      },
    };
    const packageId = `pkg_${sha256(Buffer.from(canonicalJson(identityDocument))).slice(0, 24)}`;
    const manifest: AssetPackageManifest = {
      schema: ASSET_PACKAGE_SCHEMA,
      packageId,
      ...identityDocument,
      model: 'model.glb',
      ...(preview ? { preview: 'preview.usdz' } : {}),
    };
    const manifestText = canonicalJson(manifest);
    const manifestSha256 = sha256(Buffer.from(manifestText));
    await fs.writeFile(path.join(stage, 'manifest.json'), manifestText, { flag: 'wx', mode: 0o600 });

    const finalPath = path.join(packagesRoot, assetId, version);
    const reused = await existingResult(finalPath, packageId, inspected, validation);
    if (reused) return reused;

    const now = (options.clock ?? (() => new Date()))().toISOString();
    await fs.writeFile(path.join(stage, 'receipt.json'), canonicalJson({
      schema: PACKAGE_RECEIPT_SCHEMA,
      packageId,
      manifestSha256,
      source: {
        fileName: path.basename(source),
        bytes: sourceIdentity.bytes,
        sha256: sourceIdentity.sha256,
      },
      destination: { assetId, version },
      completedAt: now,
      evidence: {
        modelBytesCopiedAndHashed: true,
        staticInspectionCompleted: true,
        policyValidationCompleted: true,
        blenderNormalizationPerformed: false,
        gpuImportTestPerformed: false,
        humanVisualReviewPerformed: false,
      },
    }), { flag: 'wx', mode: 0o600 });
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    await fsyncDirectory(stage);
    await fs.rename(stage, finalPath);
    await fsyncDirectory(path.dirname(finalPath));
    return {
      packagePath: finalPath,
      manifestPath: path.join(finalPath, 'manifest.json'),
      receiptPath: path.join(finalPath, 'receipt.json'),
      manifestSha256,
      manifest,
      inspection: inspected,
      validation,
      reused: false,
    };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function readAssetPackage(packagePath: string): Promise<AssetPackageManifest> {
  const target = await fs.realpath(path.resolve(packagePath));
  const raw = await fs.readFile(path.join(target, 'manifest.json'), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalidState(`${target} has an invalid package manifest`, { reason: String(error) });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidState(`${target} has a non-object package manifest`);
  }
  const manifest = parsed as AssetPackageManifest;
  if (
    manifest.schema !== ASSET_PACKAGE_SCHEMA
    || !/^pkg_[0-9a-f]{24}$/.test(manifest.packageId)
    || !/^[\p{Letter}\p{Number}_-]{1,64}$/u.test(manifest.assetId)
    || !VERSION.test(manifest.version)
    || typeof manifest.displayName !== 'string'
    || manifest.displayName.trim().length === 0
    || typeof manifest.license !== 'string'
    || !Array.isArray(manifest.files)
    || !manifest.validation
    || typeof manifest.validation.passed !== 'boolean'
    || !manifest.provenance
    || typeof manifest.provenance.origin !== 'string'
    || manifest.model !== 'model.glb'
  ) {
    throw invalidState(`${target} is not a supported Game Development Studio asset package`);
  }
  if (raw !== canonicalJson(manifest)) {
    throw invalidState(`${target} manifest is not in canonical JSON form`);
  }
  const { schema: _schema, packageId: _packageId, model: _model, preview: _preview, ...identity } = manifest;
  const expectedPackageId = `pkg_${sha256(Buffer.from(canonicalJson(identity))).slice(0, 24)}`;
  if (manifest.packageId !== expectedPackageId) {
    throw invalidState(`package identity does not match its manifest content`, {
      expectedPackageId,
      actualPackageId: manifest.packageId,
    });
  }
  const expectedKinds: Record<string, AssetPackageFile['kind']> = {
    'model.glb': 'model',
    'metadata.json': 'metadata',
    'provenance.json': 'provenance',
    'validation.json': 'validation',
    ...(manifest.preview === 'preview.usdz' ? { 'preview.usdz': 'preview' as const } : {}),
  };
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (
      !file
      || typeof file.path !== 'string'
      || path.basename(file.path) !== file.path
      || expectedKinds[file.path] !== file.kind
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || !/^[0-9a-f]{64}$/.test(file.sha256)
      || seen.has(file.path)
    ) {
      throw invalidState(`package manifest has an invalid file entry`, { file });
    }
    seen.add(file.path);
    const absolute = path.resolve(target, file.path);
    if (path.dirname(absolute) !== target) throw invalidState(`package file escapes its root: ${file.path}`);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw invalidState(`package artifact is not a regular owned file: ${file.path}`);
    }
    const identity = await hashFile(absolute);
    if (identity.sha256 !== file.sha256 || identity.bytes !== file.bytes) {
      throw invalidState(`package file does not match its manifest: ${file.path}`, {
        expected: { bytes: file.bytes, sha256: file.sha256 },
        actual: identity,
      });
    }
  }
  const expectedPaths = Object.keys(expectedKinds).sort();
  if (JSON.stringify([...seen].sort()) !== JSON.stringify(expectedPaths)) {
    throw invalidState(`package manifest does not contain exactly the required artifacts`, {
      expectedPaths,
      actualPaths: [...seen].sort(),
    });
  }
  const receiptRaw = await fs.readFile(path.join(target, 'receipt.json'), 'utf8');
  let receipt: unknown;
  try {
    receipt = JSON.parse(receiptRaw);
  } catch (error) {
    throw invalidState(`package receipt is invalid JSON`, { reason: String(error) });
  }
  const record = receipt as Record<string, unknown> | null;
  const manifestSha256 = sha256(Buffer.from(raw));
  if (
    !record
    || record.schema !== PACKAGE_RECEIPT_SCHEMA
    || record.packageId !== manifest.packageId
    || record.manifestSha256 !== manifestSha256
  ) {
    throw invalidState(`package receipt does not bind the verified manifest`);
  }
  return manifest;
}
