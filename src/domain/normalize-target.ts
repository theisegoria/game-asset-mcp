/**
 * Choosing where a normalized mesh is written.
 *
 * Separated from the tool because this is the part that was wrong, twice.
 *
 * First an explicit `outputPath` was written verbatim with no check at all, so
 * passing the input mesh as the output replaced it in place and reported
 * success. That was fixed with a string comparison — which was still wrong,
 * because a path is not a file. A symlink, a hardlink, a symlinked parent
 * directory, or merely a different capitalisation on a case-insensitive volume
 * all name the SAME file by a different string, and all four destroyed the
 * source while the receipt reported two distinct paths and a healthy byte count.
 * The capitalisation case needs no symlink and no privilege: `Crate.glb` and
 * `crate.glb` are one file on APFS, and capitalised asset filenames are
 * entirely ordinary.
 *
 * Identity is therefore decided by the filesystem — device plus inode — never
 * by comparing strings.
 */

import path from 'node:path';
import { invalidInput } from '../util/errors.js';

/** Device and inode. Two paths with the same pair are the same file. */
export interface FileIdentity {
  dev: number;
  ino: number;
}

export interface NormalizeTargetDeps {
  /**
   * The identity of whatever is at `target`, or null if nothing is.
   *
   * MUST follow symlinks: the question is "which file would a write land on",
   * not "what is this link". A path that does not exist cannot alias anything,
   * so null is a safe answer.
   */
  fileIdentity(target: string): Promise<FileIdentity | null>;
  /** Atomically claims an unused path in `dir` for `fileName`. */
  reserve(dir: string, fileName: string): Promise<string>;
  /**
   * Exclusively creates `target`, returning false if it already exists.
   *
   * MUST be an atomic exclusive create (O_EXCL), never a stat-then-write. The
   * explicit-outputPath branch used an existence CHECK, which is a decision
   * taken at t=0 about a write that happens seconds later: two concurrent
   * calls both passed it, and one caller's output was silently destroyed while
   * its receipt reported a healthy byte count and hash for bytes that no
   * longer existed. mesh-batch.ts already says this in as many words.
   */
  claimExclusive(target: string): Promise<boolean>;
}

export interface NormalizeTargetRequest {
  /** Absolute path to the source mesh. */
  source: string;
  /** The source's extension, verbatim — case matters when stripping the stem. */
  sourceExtension: string;
  /** Directory the output belongs in when no explicit path is given. */
  outputDir: string;
  /** Caller-supplied destination, if any. */
  outputPath?: string | undefined;
  /** Explicit opt-in to replacing a DIFFERENT file. Never permits in-place. */
  overwrite?: boolean | undefined;
}

function sameFile(a: FileIdentity | null, b: FileIdentity | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

/** The chosen path, and whether WE created the file standing at it. */
export interface NormalizeTarget {
  target: string;
  /**
   * True when this call created the file to claim the name, so the caller must
   * remove it if the work then fails.
   *
   * Returned rather than re-derived. The tool used to compute it separately as
   * `args.outputPath === undefined`, while this function branched on
   * `!request.outputPath` — so `outputPath: ""` took the reserve branch, which
   * creates a file, and the tool believed it held nothing and leaked it. One
   * fact, two tests, different answers.
   */
  reserved: boolean;
}

export async function resolveNormalizeTarget(
  request: NormalizeTargetRequest,
  deps: NormalizeTargetDeps,
): Promise<NormalizeTarget> {
  if (!request.outputPath) {
    const stem = path.basename(request.source, request.sourceExtension);
    return { target: await deps.reserve(request.outputDir, `${stem}_normalized.glb`), reserved: true };
  }

  // Check the path Blender will WRITE, not the path we were handed.
  //
  // The exporter normalises the extension: given ".../crate" it writes
  // ".../crate.glb". So an identity check against the literal argument passed
  // — "crate" is not "crate.glb" — while the write landed on the source and
  // destroyed it. The guard was correct about a file nobody was going to touch.
  // Modelling that normalisation here, once, is what makes every downstream
  // step (identity, overwrite, reservation, read-back) talk about the same file.
  const requested = path.resolve(request.outputPath);
  const requestedExt = path.extname(requested);
  if (requestedExt === '') {
    // No extension: Blender appends .glb, so we say so explicitly.
  } else if (requestedExt.toLowerCase() !== '.glb') {
    throw invalidInput(
      `outputPath must end in .glb (or have no extension); received "${requestedExt}". This tool ` +
      'always writes a GLB, and the exporter rewrites the extension — so a path like ' +
      '"mesh.gltf" would silently become "mesh.glb", which may be a DIFFERENT file from the one ' +
      'you named and has overwritten an input mesh in exactly that way.',
      { outputPath: requested },
    );
  }
  const target = requestedExt === '' ? `${requested}.glb` : requested;

  const [sourceIdentity, targetIdentity] = await Promise.all([
    deps.fileIdentity(request.source),
    deps.fileIdentity(target),
  ]);

  // Checked BEFORE the overwrite rule, deliberately. When the target aliased
  // the source, the overwrite branch used to fire first and answer "refusing to
  // overwrite an existing file — pass overwrite:true if you genuinely mean to
  // replace it". That instruction is the destruction: following it fed the very
  // input mesh to the writer. A guard must not name the flag that defeats it.
  if (target === request.source || sameFile(sourceIdentity, targetIdentity)) {
    throw invalidInput(
      'outputPath resolves to the input mesh itself; normalizing in place would destroy the ' +
      'original irrecoverably. Note this is decided by filesystem identity, so a symlink, a ' +
      'hardlink, a symlinked parent directory, or a different capitalisation on a ' +
      'case-insensitive volume all count. Omit outputPath to write <name>_normalized.glb ' +
      'beside it, or name a genuinely different destination.',
      { modelPath: request.source, outputPath: target },
    );
  }

  // Exclusive create, not the earlier existence check. Winning the create is
  // what makes "this file was not already there" true at the moment of the
  // write rather than at the moment of the question.
  const claimed = await deps.claimExclusive(target);
  if (!claimed && !request.overwrite) {
    throw invalidInput(
      `refusing to overwrite an existing file at ${target}. Pass overwrite:true if you ` +
      'genuinely mean to replace it, or omit outputPath to get a numbered name instead.',
      { outputPath: target },
    );
  }

  // `reserved` tracks whether WE created it: only then is removing it on
  // failure ours to do. Losing the race under overwrite:true means the file was
  // someone else's and we are deliberately replacing it.
  return { target, reserved: claimed };
}
