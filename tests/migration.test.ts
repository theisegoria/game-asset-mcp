import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAssetJob } from '../src/domain/asset-job.js';
import { JobStore } from '../src/storage/jobs.js';
import { migrateLegacyWorkspace } from '../src/packages/migration.js';
import { AssetCatalog } from '../src/packages/catalog.js';
import { readAssetPackage } from '../src/packages/format.js';
import { writeGameReadyGlb } from './helpers/model-fixture.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-migration-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('legacy v0.4 migration', () => {
  it('plans without writing, then migrates downloaded GLBs without provider calls', async () => {
    const root = await temporaryRoot();
    const outputRoot = path.join(root, 'legacy-output');
    const store = await JobStore.open(path.join(outputRoot, '.jobs'));
    const modelPath = await writeGameReadyGlb(path.join(root, 'legacy-model.glb'));
    const job = createAssetJob({
      spec: { name: 'Legacy Orrery', description: 'A migrated brass astronomy prop.', category: 'environment_prop' },
      slug: 'legacy_orrery',
    });
    job.status = 'ready';
    job.model3d = {
      provider: 'tripo',
      modelVersion: 'v2.5-20250123',
      providerTaskId: 'provider-task-123',
      taskType: 'text_to_model',
      parameters: {},
      requestedAt: '2026-08-26T00:00:00.000Z',
    };
    const modelBytes = await readFile(modelPath);
    job.files.push({
      path: modelPath,
      bytes: modelBytes.length,
      sha256: (await import('../src/storage/filesystem.js')).sha256(modelBytes),
      kind: 'model',
    });
    await store.save(job);

    const packagesRoot = path.join(root, 'data', 'packages');
    const catalogPath = path.join(root, 'data', 'catalog.sqlite3');
    const dryRun = await migrateLegacyWorkspace({ outputRoot, packagesRoot, catalogPath });
    expect(dryRun).toMatchObject({ dryRun: true, migrated: 0, skipped: 0, failed: 0 });
    expect(dryRun.items).toMatchObject([{ assetJobId: job.id, eligible: true }]);
    await expect(readFile(catalogPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const migrated = await migrateLegacyWorkspace({
      outputRoot,
      packagesRoot,
      catalogPath,
      confirm: true,
      defaultLicense: 'CC0-1.0',
      clock: () => new Date('2026-08-27T00:00:00.000Z'),
    });
    expect(migrated).toMatchObject({ dryRun: false, migrated: 1, skipped: 0, failed: 0 });
    const packagePath = migrated.items[0]?.packagePath;
    expect(packagePath).toBeTruthy();
    const manifest = await readAssetPackage(packagePath!);
    expect(manifest).toMatchObject({
      displayName: 'Legacy Orrery',
      license: 'CC0-1.0',
      provenance: { origin: 'migrated', provider: 'tripo', sourceJobId: job.id },
    });
    const receipt = JSON.parse(await readFile(migrated.receiptPath!, 'utf8')) as Record<string, any>;
    expect(receipt.evidence).toMatchObject({
      providerCallsPerformed: false,
      sourceModelsCopiedAndHashed: true,
      gpuImportTestPerformed: false,
    });
    const catalog = await AssetCatalog.open(catalogPath);
    expect(catalog.list()).toHaveLength(1);
    catalog.close();
  });

  it('reports missing model jobs as skipped instead of aborting the migration', async () => {
    const root = await temporaryRoot();
    const outputRoot = path.join(root, 'legacy-output');
    const store = await JobStore.open(path.join(outputRoot, '.jobs'));
    await store.save(createAssetJob({
      spec: { name: 'Not Downloaded', description: 'Provider result was never downloaded.' },
      slug: 'not_downloaded',
    }));
    const result = await migrateLegacyWorkspace({
      outputRoot,
      packagesRoot: path.join(root, 'packages'),
      confirm: true,
    });
    expect(result).toMatchObject({ migrated: 0, skipped: 1, failed: 0 });
    expect(result.items[0]?.reason).toMatch(/no downloaded portable/);
  });
});
