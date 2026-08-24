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
  /** Triangle count MEASURED from the produced file, not claimed by the normalizer. */
  trianglesAfterMeasured?: number;
  /**
   * True when the normalizer's receipt disagreed with this tool's own reading
   * of the file it produced. The receipt is a claim; the bytes are evidence.
   */
  receiptDisagreed?: boolean;
  /**
   * A reserved file that could NOT be removed after the item failed. It is
   * still on disk, so it is counted in outputsWritten — a cleanup that failed
   * must never make the count and the filesystem disagree silently.
   */
  orphanedOutput?: string;
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
  /** True when `dir` exists and is a directory. */
  isDirectory(dir: string): Promise<boolean>;
  /** Opaque identity (device+inode) of a path, or null if absent. */
  fileIdentity(target: string): Promise<unknown>;
  /** True when `target` is still the same file the identity was taken from. */
  isSameFile(target: string, identity: unknown): Promise<boolean>;
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
async function release(
  deps: MeshBatchDeps,
  target: string,
  reservationIdentity: unknown,
): Promise<boolean> {
  try {
    // I argued this could stay unconditional, on the grounds that the batch
    // reserves by exclusive create and has no overwrite path, so the bytes here
    // are always its own. That was WRONG, and a later review proved it:
    // normalize_mesh DOES have an overwrite path and can legitimately rename a
    // verified mesh onto this very name. The unconditional remove then deleted
    // it, leaving that caller holding a receipt with a SHA-256 for bytes that
    // existed nowhere — the mirror of the race normalize_mesh already guards.
    //
    // Identity, not size: our own Blender may legitimately have written bytes
    // here, and those are ours to remove. What is not ours is a file whose
    // inode changed, because only a rename from outside can do that.
    if (!(await deps.isSameFile(target, reservationIdentity))) return true;
    await deps.discardReservation(target);
    return true;
  } catch {
    // Swallowed as the REPORTED cause — a failure to tidy up is strictly less
    // interesting than whatever made the item fail. But it is returned, because
    // a release that failed leaves a file on disk, and outputsWritten must not
    // silently disagree with the filesystem.
    return false;
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
  if (options.outputDir === undefined) {
    // The source's own directory, which exists by definition.
    await deps.mkdir(dir);
  } else if (!(await deps.isDirectory(dir))) {
    // A caller-named outputDir must ALREADY exist. This used to mkdir -p
    // unconditionally, so `outputDir: "~/nested/deep/out"` built a literal "~"
    // tree wherever the server happened to be running — no shell is involved,
    // so ~ is not expanded. normalize_mesh stopped doing exactly this; the
    // sibling tool kept doing it.
    throw invalidInput(
      `outputDir does not exist: ${dir}. Create it first, or omit outputDir to write beside each ` +
      'source. A leading ~ is NOT expanded here, and a relative path resolves against the ' +
      "server's working directory rather than yours.",
      { outputDir: dir },
    );
  }
  const target = await deps.reserveOutputPath(dir, `${path.basename(source, actualExt)}_normalized.glb`);
  // Captured at reservation time, so a later rename from another tool is
  // detectable: only a rename changes the inode standing at this path.
  const reservationIdentity = await deps.fileIdentity(target);

  let receipt: Record<string, number>;
  try {
    receipt = await deps.normalize(source, target);
  } catch (err) {
    // The discard must not be able to replace the reason we are here. It
    // could: an EPERM from the cleanup threw first, so a caller whose Blender
    // had segfaulted was told only "EPERM_cleanup_failed" and the real cause
    // was gone.
    if (!(await release(deps, target, reservationIdentity))) item.orphanedOutput = target;
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      meshBatchOrphan: item.orphanedOutput,
    });
  }
  item.normalizedPath = target;
  item.unwrapped = receipt.objectsUnwrapped ?? 0;
  item.trianglesBefore = receipt.trianglesBefore ?? 0;
  item.trianglesAfter = receipt.trianglesAfter ?? 0;

  let after;
  let inspection;
  try {
    inspection = await deps.inspect(target);
    after = evaluateAsset(inspection, options.policy);
  } catch (err) {
    if (!(await release(deps, target, reservationIdentity))) item.orphanedOutput = target;
    delete item.normalizedPath;
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      meshBatchOrphan: item.orphanedOutput,
    });
  }
  // The receipt above is the normalizer's CLAIM; `inspection` is this tool's own
  // measurement of the same bytes. They were both reported and never compared,
  // so a stub could report "unwrapped: 3" for a mesh the very next line
  // observed to have no UVs at all. Where they disagree, the measurement wins
  // and the disagreement is surfaced rather than averaged away.
  item.trianglesAfterMeasured = inspection.triangleCount;
  // Tests the value REPORTED, not the raw receipt. The `?? 0` above fabricates
  // a claim when the normalizer says nothing, and the guard used to exempt
  // exactly that fabrication — so an item could report trianglesAfter 0 beside
  // trianglesAfterMeasured 2050 and leave the flag whose whole job is to notice
  // that silent, under "All 1 mesh(es) are game-ready."
  if (item.trianglesAfter !== inspection.triangleCount) {
    item.receiptDisagreed = true;
  }
  if ((receipt.objectsUnwrapped ?? 0) > 0 && !inspection.hasUVs) {
    item.receiptDisagreed = true;
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
      const orphan = (err as { meshBatchOrphan?: string } | null)?.meshBatchOrphan;
      items.push({
        input: source,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        ...(orphan !== undefined ? { orphanedOutput: orphan } : {}),
      });
    }
  }

  return {
    total: items.length,
    prepared: items.filter((item) => item.status === 'prepared').length,
    alreadyValid: items.filter((item) => item.status === 'already_valid').length,
    failed: items.filter((item) => item.status === 'failed').length,
    outputsWritten: items.filter(
      (item) => item.normalizedPath !== undefined || item.orphanedOutput !== undefined,
    ).length,
    blenderAvailable: deps.blenderAvailable,
    items,
  };
}
