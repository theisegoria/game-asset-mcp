import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateUsdzPreview } from '../src/packages/usdz.js';
import { writeGameReadyGlb } from './helpers/model-fixture.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-usdz-test-'));
  roots.push(root);
  return root;
}

async function executable(filePath: string, source: string): Promise<string> {
  await writeFile(filePath, `#!${process.execPath}\n${source}`, 'utf8');
  await chmod(filePath, 0o755);
  return filePath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('USDZ preview generation', () => {
  it('requires measured Blender export and usdzip output before publishing the preview', async () => {
    const root = await temporaryRoot();
    const model = await writeGameReadyGlb(path.join(root, 'model.glb'));
    const blender = await executable(path.join(root, 'fake-blender'), `
const fs = require('node:fs');
const request = JSON.parse(process.argv.at(-1));
fs.writeFileSync(request.output, Buffer.from('USDC test scene'));
console.log('NORMALIZE_RECEIPT=' + JSON.stringify({operation:'export_usd_preview', blenderVersion:'test-4.5'}));
`);
    const usdzip = await executable(path.join(root, 'fake-usdzip'), `
const fs = require('node:fs');
const output = process.argv[2];
if (process.argv.includes('--arkitAsset')) fs.writeFileSync(output, Buffer.from([0x50,0x4b,0x03,0x04,1,2,3,4]));
if (process.argv.includes('--list')) console.log('scene.usdc');
`);
    const output = path.join(root, 'preview.usdz');
    const result = await generateUsdzPreview(model, output, {
      blenderPath: blender,
      usdzipPath: usdzip,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      schema: 'game_dev.usdz_preview.v1',
      outputPath: output,
      bytes: 8,
      blenderVersion: 'test-4.5',
      complianceChecked: true,
      evidence: {
        blenderUsdExportCompleted: true,
        usdzipPackagingCompleted: true,
        quickLookOpened: false,
        humanVisualReviewPerformed: false,
      },
    });
    expect([...await readFile(output)].slice(0, 4)).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect((await readdir(root)).some((entry) => entry.startsWith('.game-dev-usdz-'))).toBe(false);
  });

  it('never overwrites an existing preview', async () => {
    const root = await temporaryRoot();
    const model = await writeGameReadyGlb(path.join(root, 'model.glb'));
    const output = path.join(root, 'preview.usdz');
    await writeFile(output, 'owned-by-user');
    await expect(generateUsdzPreview(model, output, {
      blenderPath: '/not/reached',
      usdzipPath: '/not/reached',
    })).rejects.toThrow(/already exists/);
    expect(await readFile(output, 'utf8')).toBe('owned-by-user');
  });
});
