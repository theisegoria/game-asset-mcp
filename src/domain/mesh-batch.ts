/**
 * The batch preparation loop, separated from the tool that exposes it.
 *
 * The interesting behaviour of a batch is not the pipeline — it is what happens
 * when an item goes wrong halfway through. That property is worth testing
 * directly, so the loop takes its filesystem, inspector and normalizer as
 * arguments instead of importing them. `batch.ts` supplies the real ones.
 *
 * Deliberately LOCAL-only. Batching provider calls would multiply spend by the
 * item count, and the point of a batch is that nobody is watching it.
 */

import path from 'node:path';
import { evaluateAsset, type GameAssetPolicy } from './asset-policy.js';
import type { AssetInspection } from '../inspection/gltf.js';
import { invalidInput } from '../util/errors.js';

export interface MeshBatchItem {
  input: string;
  status: 'prepared' | 'already_valid' | 'failed';
  normalizedPath?: string;
  passedBefore?: boolean;
  passedAfter?: boolean;
  unwrapped?: number;
  trianglesBefore?: number;
  trianglesAfter?: number;
  failures?: string[];
  error?: string;
}

export interface MeshBatchResult {
  total: number;
  prepared: number;
  alreadyValid: number;
  failed: number;
  blenderAvailable: boolean;
  items: MeshBatchItem[];
}

export interface MeshBatchOptions {
  outputDir?: string;
  normalize: boolean;
  skipAlreadyValid: boolean;
  policy: Partial<GameAssetPolicy>;
}

/**
 * Everything that touches the world. Injected so the loop's error handling can
 * be tested against failures that are awkward to stage for real.
 */
export interface MeshBatchDeps {
  access(file: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  inspect(file: string): Promise<AssetInspection>;
  /** Repairs `source` into `target` and returns the normalizer's receipt. */
  normalize(source: string, target: string): Promise<Record<string, number>>;
  blenderAvailable: boolean;
}

function errorIds(report: ReturnType<typeof evaluateAsset>): string[] {
  return report.checks
    .filter((check) => !check.passed && check.severity === 'error')
    .map((check) => check.id);
}

async function prepareOne(
  source: string,
  options: MeshBatchOptions,
  deps: MeshBatchDeps,
): Promise<MeshBatchItem> {
  const item: MeshBatchItem = { input: source, status: 'failed' };

  const ext = path.extname(source).toLowerCase();
  if (ext !== '.glb' && ext !== '.gltf') {
    throw invalidInput(`batch_prepare_meshes reads .glb or .gltf; received "${ext}"`);
  }
  await deps.access(source);

  const before = evaluateAsset(await deps.inspect(source), options.policy);
  item.passedBefore = before.passed;

  if (before.passed && options.skipAlreadyValid) {
    item.status = 'already_valid';
    item.passedAfter = true;
    return item;
  }

  // Report-only: either the caller asked for no repair, or there is no Blender
  // to repair with. Saying what is wrong is still worth the call.
  if (!options.normalize || !deps.blenderAvailable) {
    item.status = before.passed ? 'already_valid' : 'failed';
    item.passedAfter = before.passed;
    item.failures = errorIds(before);
    if (!deps.blenderAvailable && options.normalize) {
      item.error = 'Blender not found; reported without repairing';
    }
    return item;
  }

  const dir = options.outputDir ? path.resolve(options.outputDir) : path.dirname(source);
  await deps.mkdir(dir);
  const target = path.join(dir, `${path.basename(source, ext)}_normalized.glb`);

  const receipt = await deps.normalize(source, target);
  item.normalizedPath = target;
  item.unwrapped = receipt.objectsUnwrapped ?? 0;
  item.trianglesBefore = receipt.trianglesBefore ?? 0;
  item.trianglesAfter = receipt.trianglesAfter ?? 0;

  const after = evaluateAsset(await deps.inspect(target), options.policy);
  item.passedAfter = after.passed;
  item.status = after.passed ? 'prepared' : 'failed';
  if (!after.passed) item.failures = errorIds(after);
  return item;
}

export async function runMeshBatch(
  modelPaths: readonly string[],
  options: MeshBatchOptions,
  deps: MeshBatchDeps,
): Promise<MeshBatchResult> {
  const items: MeshBatchItem[] = [];

  for (const raw of modelPaths) {
    const source = path.resolve(raw);
    try {
      items.push(await prepareOne(source, options, deps));
    } catch (err) {
      // One bad file must not stall a forty-item run. The error is reported
      // against its own item and the loop moves on.
      items.push({
        input: source,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    total: items.length,
    prepared: items.filter((item) => item.status === 'prepared').length,
    alreadyValid: items.filter((item) => item.status === 'already_valid').length,
    failed: items.filter((item) => item.status === 'failed').length,
    blenderAvailable: deps.blenderAvailable,
    items,
  };
}
