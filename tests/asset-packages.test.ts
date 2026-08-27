import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAssetPackage, canonicalJson, readAssetPackage } from '../src/packages/format.js';
import { AssetCatalog } from '../src/packages/catalog.js';
import { admitVendorPackage } from '../src/packages/vendor.js';
import { writeGameReadyGlb } from './helpers/model-fixture.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-package-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('canonical asset packages', () => {
  it('copies a portable GLB, records provenance and validation, and is repeat-safe', async () => {
    const root = await temporaryRoot();
    const source = await writeGameReadyGlb(path.join(root, 'source.glb'));
    const sourceBefore = await readFile(source);
    const options = {
      packagesRoot: path.join(root, 'packages'),
      sourcePath: source,
      name: 'Brass Orrery',
      version: '1.2.0',
      category: 'environment_prop' as const,
      license: 'CC0-1.0',
      provenance: {
        origin: 'authored' as const,
        author: 'Test Artist',
        apiToken: 'must-not-survive',
        sourceUri: 'https://user:password@example.com/model.glb?X-Amz-Signature=secret',
      },
      clock: () => new Date('2026-08-27T00:00:00.000Z'),
    };

    const first = await buildAssetPackage(options);
    const second = await buildAssetPackage(options);
    const manifest = await readAssetPackage(first.packagePath);
    const provenance = JSON.parse(
      await readFile(path.join(first.packagePath, 'provenance.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.manifestSha256).toBe(first.manifestSha256);
    expect(manifest).toMatchObject({
      schema: 'game_dev.asset_package.v1',
      assetId: 'brass_orrery',
      version: '1.2.0',
      license: 'CC0-1.0',
      validation: { passed: true, errorCount: 0 },
      provenance: { origin: 'authored' },
    });
    expect(provenance.apiToken).toBe('[redacted]');
    expect(provenance.sourceUri).toBe('https://example.com/model.glb');
    expect(await readFile(source)).toEqual(sourceBefore);
  });

  it('refuses a same-name/version collision without replacing the first package', async () => {
    const root = await temporaryRoot();
    const packagesRoot = path.join(root, 'packages');
    const firstSource = await writeGameReadyGlb(path.join(root, 'first.glb'), 1);
    const secondSource = await writeGameReadyGlb(path.join(root, 'second.glb'), 2);
    const first = await buildAssetPackage({ packagesRoot, sourcePath: firstSource, name: 'Beacon' });
    const original = await readFile(path.join(first.packagePath, 'model.glb'));

    await expect(buildAssetPackage({
      packagesRoot,
      sourcePath: secondSource,
      name: 'Beacon',
    })).rejects.toThrow(/different pkg_/);
    expect(await readFile(path.join(first.packagePath, 'model.glb'))).toEqual(original);
  });

  it('detects tampering against the manifest', async () => {
    const root = await temporaryRoot();
    const built = await buildAssetPackage({
      packagesRoot: path.join(root, 'packages'),
      sourcePath: await writeGameReadyGlb(path.join(root, 'source.glb')),
      name: 'Tamper Target',
    });
    await writeFile(path.join(built.packagePath, 'model.glb'), 'not the recorded model');
    await expect(readAssetPackage(built.packagePath)).rejects.toThrow(/does not match its manifest/);
  });

  it('binds semantic manifest fields into the content-addressed package id', async () => {
    const root = await temporaryRoot();
    const built = await buildAssetPackage({
      packagesRoot: path.join(root, 'packages'),
      sourcePath: await writeGameReadyGlb(path.join(root, 'source.glb')),
      name: 'Manifest Target',
      license: 'CC0-1.0',
    });
    const manifestPath = path.join(built.packagePath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.license = 'Proprietary';
    await writeFile(manifestPath, canonicalJson(manifest));
    await expect(readAssetPackage(built.packagePath)).rejects.toThrow(/identity does not match/);
  });

  it('rejects a symlink substituted for a recorded package artifact', async () => {
    const root = await temporaryRoot();
    const built = await buildAssetPackage({
      packagesRoot: path.join(root, 'packages'),
      sourcePath: await writeGameReadyGlb(path.join(root, 'source.glb')),
      name: 'Symlink Target',
    });
    const model = path.join(built.packagePath, 'model.glb');
    const external = path.join(root, 'external.glb');
    await writeFile(external, await readFile(model));
    await rm(model);
    await symlink(external, model);
    await expect(readAssetPackage(built.packagePath)).rejects.toThrow(/regular owned file/);
  });

  it('requires the receipt to bind the exact canonical manifest', async () => {
    const root = await temporaryRoot();
    const built = await buildAssetPackage({
      packagesRoot: path.join(root, 'packages'),
      sourcePath: await writeGameReadyGlb(path.join(root, 'source.glb')),
      name: 'Receipt Target',
    });
    const receiptPath = path.join(built.packagePath, 'receipt.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.manifestSha256 = '0'.repeat(64);
    await writeFile(receiptPath, canonicalJson(receipt));
    await expect(readAssetPackage(built.packagePath)).rejects.toThrow(/receipt does not bind/);
  });

  it('includes an optional USDZ preview as a hashed package artifact', async () => {
    const root = await temporaryRoot();
    const preview = path.join(root, 'preview.usdz');
    await writeFile(preview, Buffer.from('PK\x03\x04fake-usdz-test'));
    const built = await buildAssetPackage({
      packagesRoot: path.join(root, 'packages'),
      sourcePath: await writeGameReadyGlb(path.join(root, 'source.glb')),
      previewPath: preview,
      name: 'Previewed Asset',
    });
    expect(built.manifest.preview).toBe('preview.usdz');
    expect(built.manifest.files.find((file) => file.kind === 'preview')).toMatchObject({
      path: 'preview.usdz',
      bytes: 18,
    });
  });
});

describe('SQLite asset catalog', () => {
  it('admits, searches, closes, and reopens verified packages', async () => {
    const root = await temporaryRoot();
    const built = await buildAssetPackage({
      packagesRoot: path.join(root, 'packages'),
      sourcePath: await writeGameReadyGlb(path.join(root, 'source.glb')),
      name: 'Searchable Orrery',
      description: 'A brass astronomy prop',
      category: 'environment_prop',
      license: 'CC0-1.0',
    });
    const databasePath = path.join(root, 'catalog.sqlite3');
    let catalog = await AssetCatalog.open(databasePath);
    const admitted = await catalog.admit(built.packagePath);
    expect(catalog.get(admitted.packageId).displayName).toBe('Searchable Orrery');
    expect(catalog.list({ query: 'astronomy', validationPassed: true })).toHaveLength(1);
    catalog.close();

    catalog = await AssetCatalog.open(databasePath);
    expect(catalog.list({ category: 'environment_prop' })).toHaveLength(1);
    catalog.close();
  });

  it('rebuilds derived state and preserves the previous database as a backup', async () => {
    const root = await temporaryRoot();
    const packagesRoot = path.join(root, 'packages');
    await buildAssetPackage({
      packagesRoot,
      sourcePath: await writeGameReadyGlb(path.join(root, 'source.glb')),
      name: 'Indexed Asset',
    });
    const databasePath = path.join(root, 'catalog.sqlite3');
    const initial = await AssetCatalog.open(databasePath);
    initial.close();
    const rebuilt = await AssetCatalog.rebuild(databasePath, packagesRoot);
    expect(rebuilt.indexed).toHaveLength(1);
    expect(rebuilt.backupPath).toBeTruthy();
    const catalog = await AssetCatalog.open(databasePath);
    expect(catalog.list()).toHaveLength(1);
    catalog.close();
  });

  it('leaves the standing catalog intact when a rebuild encounters a corrupt package', async () => {
    const root = await temporaryRoot();
    const packagesRoot = path.join(root, 'packages');
    const built = await buildAssetPackage({
      packagesRoot,
      sourcePath: await writeGameReadyGlb(path.join(root, 'source.glb')),
      name: 'Recovery Asset',
    });
    const databasePath = path.join(root, 'catalog.sqlite3');
    const initial = await AssetCatalog.open(databasePath);
    await initial.admit(built.packagePath);
    initial.close();
    await writeFile(path.join(built.packagePath, 'model.glb'), 'corrupt');

    await expect(AssetCatalog.rebuild(databasePath, packagesRoot)).rejects.toThrow(/manifest/);
    const standing = await AssetCatalog.open(databasePath);
    expect(standing.list()).toHaveLength(1);
    standing.close();
    expect((await readdir(root)).some((entry) => entry.includes('.rebuild-'))).toBe(false);
  });
});

describe('project vendoring', () => {
  it('is a no-write dry run by default and blocks unknown licenses', async () => {
    const root = await temporaryRoot();
    const projectRoot = path.join(root, 'game');
    await (await import('node:fs/promises')).mkdir(projectRoot);
    const built = await buildAssetPackage({
      packagesRoot: path.join(root, 'packages'),
      sourcePath: await writeGameReadyGlb(path.join(root, 'source.glb')),
      name: 'Unknown License',
    });
    const result = await admitVendorPackage({ packagePath: built.packagePath, projectRoot });
    expect(result.dryRun).toBe(true);
    expect(result.blockers.join(' ')).toMatch(/license is unknown/);
    await expect(readFile(path.join(projectRoot, '.game-dev', 'vendor-lock.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('copies and re-verifies an explicitly admitted package and writes a lock receipt', async () => {
    const root = await temporaryRoot();
    const projectRoot = path.join(root, 'game');
    await (await import('node:fs/promises')).mkdir(projectRoot);
    const built = await buildAssetPackage({
      packagesRoot: path.join(root, 'packages'),
      sourcePath: await writeGameReadyGlb(path.join(root, 'source.glb')),
      name: 'Vendored Orrery',
      license: 'CC0-1.0',
    });
    const result = await admitVendorPackage({
      packagePath: built.packagePath,
      projectRoot,
      confirm: true,
    });
    expect(result).toMatchObject({ dryRun: false, blockers: [], reused: false });
    expect((await readAssetPackage(result.destination)).packageId).toBe(built.manifest.packageId);
    const lock = JSON.parse(await readFile(result.lockPath, 'utf8')) as Record<string, any>;
    expect(lock.entries).toHaveLength(1);
    expect(lock.entries[0].packageId).toBe(built.manifest.packageId);
    expect(result.evidence).toMatchObject({
      copiedPackageHashesVerified: true,
      projectImportTestPerformed: false,
      gpuRenderTestPerformed: false,
    });
  });

  it('rejects destination traversal before writing inside the project', async () => {
    const root = await temporaryRoot();
    const projectRoot = path.join(root, 'game');
    await (await import('node:fs/promises')).mkdir(projectRoot);
    const built = await buildAssetPackage({
      packagesRoot: path.join(root, 'packages'),
      sourcePath: await writeGameReadyGlb(path.join(root, 'source.glb')),
      name: 'Traversal Target',
      license: 'CC0-1.0',
    });
    await expect(admitVendorPackage({
      packagePath: built.packagePath,
      projectRoot,
      destinationRelative: '../escape',
      confirm: true,
    })).rejects.toThrow(/inside the project/);
  });
});
