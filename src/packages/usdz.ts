import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile as hashLocalFile } from './usdz_hash.js';
import { invalidInput, invalidState } from '../util/errors.js';
import { runBlenderScript } from '../util/blender.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/blender_usd_export.py', import.meta.url));

export interface UsdzPreviewResult {
  schema: 'game_dev.usdz_preview.v1';
  outputPath: string;
  bytes: number;
  sha256: string;
  blenderVersion?: string;
  complianceChecked: boolean;
  evidence: {
    blenderUsdExportCompleted: true;
    usdzipPackagingCompleted: true;
    quickLookOpened: false;
    humanVisualReviewPerformed: false;
  };
}

async function execFileChecked(executable: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(invalidState(`${path.basename(executable)} failed`, {
          exitCode: error.code,
          stderr: stderr.split('\n').slice(-40).join('\n'),
        }));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function generateUsdzPreview(
  modelPath: string,
  outputPath: string,
  options: {
    blenderPath?: string;
    usdzipPath?: string;
    timeoutMs?: number;
  } = {},
): Promise<UsdzPreviewResult> {
  const source = await fs.realpath(path.resolve(modelPath));
  if (path.extname(source).toLowerCase() !== '.glb') throw invalidInput('USDZ preview source must be .glb');
  const target = path.resolve(outputPath);
  if (path.extname(target).toLowerCase() !== '.usdz') throw invalidInput('USDZ preview output must end in .usdz');
  const parent = path.dirname(target);
  if (!(await fs.stat(parent)).isDirectory()) throw invalidInput('USDZ preview output directory must already exist');
  try {
    await fs.access(target);
    throw invalidInput(`USDZ preview output already exists: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const timeoutMs = options.timeoutMs ?? 120_000;
  const temporary = await fs.mkdtemp(path.join(parent, '.game-dev-usdz-'));
  try {
    const usd = path.join(temporary, 'scene.usdc');
    const staged = path.join(temporary, 'preview.usdz');
    const blender = await runBlenderScript(SCRIPT, { input: source, output: usd }, {
      timeoutMs,
      ...(options.blenderPath ? { blenderPath: options.blenderPath } : {}),
    });
    const usdIdentity = await hashLocalFile(usd);
    if (usdIdentity.bytes === 0) throw invalidState('Blender produced an empty USD scene');
    const usdzip = options.usdzipPath ?? '/usr/bin/usdzip';
    await execFileChecked(usdzip, [staged, '--arkitAsset', usd, '--checkCompliance'], timeoutMs);
    await execFileChecked(usdzip, [staged, '--list', '-'], timeoutMs);
    const stagedIdentity = await hashLocalFile(staged);
    const header = await fs.readFile(staged).then((bytes) => bytes.subarray(0, 4));
    if (header[0] !== 0x50 || header[1] !== 0x4b) throw invalidState('usdzip produced a non-ZIP output');
    await fs.link(staged, target);
    return {
      schema: 'game_dev.usdz_preview.v1',
      outputPath: target,
      ...stagedIdentity,
      ...(typeof blender.receipt.blenderVersion === 'string'
        ? { blenderVersion: blender.receipt.blenderVersion }
        : {}),
      complianceChecked: true,
      evidence: {
        blenderUsdExportCompleted: true,
        usdzipPackagingCompleted: true,
        quickLookOpened: false,
        humanVisualReviewPerformed: false,
      },
    };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
