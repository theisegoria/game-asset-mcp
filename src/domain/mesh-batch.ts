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
  /** True when a normalized file was produced but did not clear the policy. */
  outputKept?: boolean;
  error?: string;
}

export interface MeshBatchResult {
  total: number;
  prepared: number;
  alreadyValid: number;
  failed: number;
  /**
   * Files written to the output directory: every prepared item, plus every
   * failed item that still produced a mesh. `prepared` is a verdict, not a
   * file count, and conflating them made a leaked file look like an invariant
   * violation instead of a deliberate keep.
   */
  outputsWritten: number;
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
  /**
   * Atomically claims an unused path in `dir` for `fileName` and returns it.
   *
   * A batch is the one place where output names collide: forty meshes into one
   * directory, and any two sources sharing a basename — `crate.glb` from two
   * folders, or the `.glb`/`.gltf` pair a generator emits side by side — derive
   * the SAME target. Computing the name inline let the second write silently
   * destroy the first while both items still reported success, describing bytes
   * that no longer existed. The reservation must be exclusive-create, not a
   * existence check, or two items still race.
   */
  reserveOutputPath(dir: string, fileName: string): Promise<string>;
  /**
   * Releases a reservation whose work then failed.
   *
   * The reservation creates the file to claim the name. Without this, a failed
   * item leaves a zero-byte .glb behind that (a) breaks the invariant that
   * `prepared` equals the file count in the output directory, (b) is never
   * mentioned in the failed item's verdict, so the write is silent, and (c)
   * permanently steals the canonical name — a later successful re-run gets
   * `_2` while the empty file keeps the name and sorts first in any glob.
   */
  discardReservation(target: string): Promise<void>;
  blenderAvailable: boolean;
}

function errorIds(report: ReturnType<typeof evaluateAsset>): string[] {
  return report.checks
    .filter((check) => !check.passed && check.severity === 'error')
    .map((check) => check.id);
}

/**
 * Releases a reservation without letting the cleanup become the reported error.
 */
async function release(deps: MeshBatchDeps, target: string): Promise<void> {
  try {
    await deps.discardReservation(target);
  } catch {
    // Swallowed on purpose. A failure to tidy up is strictly less interesting
    // than whatever made the item fail, and must never displace it.
  }
}

async function prepareOne(
  source: string,
  options: MeshBatchOptions,
  deps: MeshBatchDeps,
): Promise<MeshBatchItem> {
  const item: MeshBatchItem = { input: source, status: 'failed' };

  // Two different extensions: the lowercased one decides acceptance, the
  // verbatim one strips the stem. Using the lowercased form to strip left
  // "BARREL.GLB" as "BARREL.GLB_normalized.glb", because basename's suffix
  // removal is case-sensitive even where the filesystem is not.
  const actualExt = path.extname(source);
  const ext = actualExt.toLowerCase();
  if (ext !== '.glb' && ext !== '.gltf') {
    throw invalidInput(`batch_prepare_meshes reads .glb or .gltf; received "${actualExt}"`);
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

  const dir = options.outputDir === undefined ? path.dirname(source) : path.resolve(options.outputDir);
  await deps.mkdir(dir);
  const target = await deps.reserveOutputPath(dir, `${path.basename(source, actualExt)}_normalized.glb`);

  let receipt: Record<string, number>;
  try {
    receipt = await deps.normalize(source, target);
  } catch (err) {
    // The discard must not be able to replace the reason we are here. It
    // could: an EPERM from the cleanup threw first, so a caller whose Blender
    // had segfaulted was told only "EPERM_cleanup_failed" and the real cause
    // was gone.
    await release(deps, target);
    throw err;
  }
  item.normalizedPath = target;
  item.unwrapped = receipt.objectsUnwrapped ?? 0;
  item.trianglesBefore = receipt.trianglesBefore ?? 0;
  item.trianglesAfter = receipt.trianglesAfter ?? 0;

  let after;
  try {
    after = evaluateAsset(await deps.inspect(target), options.policy);
  } catch (err) {
    await release(deps, target);
    delete item.normalizedPath;
    throw err;
  }
  item.passedAfter = after.passed;
  item.status = after.passed ? 'prepared' : 'failed';
  if (!after.passed) {
    item.failures = errorIds(after);
    // The file is KEPT deliberately. Normalization succeeded and produced a
    // real mesh; it simply did not clear the policy. Deleting it would destroy
    // work the caller may want to inspect or re-policy. But it must not be a
    // silent write: `normalizedPath` names it, and `outputsWritten` counts it,
    // because "prepared" is a verdict and was never the file count.
    item.outputKept = true;
  }
  return item;
}

export async function runMeshBatch(
  modelPaths: readonly string[],
  options: MeshBatchOptions,
  deps: MeshBatchDeps,
): Promise<MeshBatchResult> {
  const items: MeshBatchItem[] = [];

  for (const raw of modelPaths) {
    // Inside the try, deliberately. path.resolve throws on a non-string, and
    // outside it that TypeError escaped the loop and discarded every verdict
    // already computed — the precise failure this function exists to prevent.
    // The MCP schema rejects non-strings, but a batch runner that loses forty
    // results to one bad element is wrong regardless of who calls it.
    let source = typeof raw === 'string' ? raw : String(raw);
    try {
      source = path.resolve(raw);
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
    outputsWritten: items.filter((item) => item.normalizedPath !== undefined).length,
    blenderAvailable: deps.blenderAvailable,
    items,
  };
}
