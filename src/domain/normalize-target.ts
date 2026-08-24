/**
 * Choosing where a normalized mesh is written.
 *
 * Separated from the tool because this is the part that was wrong. An explicit
 * `outputPath` used to be written verbatim with no check of any kind, so
 * `outputPath === modelPath` replaced the caller's own mesh in place and
 * reported success, and any existing file at that path was destroyed silently —
 * while the derived-name branch three lines away went through an exclusive
 * reservation. One rule, enforced on one branch and dropped on the other.
 *
 * Living inside the tool handler meant no test could reach it: mutants that
 * removed both guards passed the entire suite.
 */

import path from 'node:path';
import { invalidInput } from '../util/errors.js';

export interface NormalizeTargetDeps {
  /** True when something already exists at the path. */
  exists(target: string): Promise<boolean>;
  /** Atomically claims an unused path in `dir` for `fileName`. */
  reserve(dir: string, fileName: string): Promise<string>;
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
  /** Explicit opt-in to replacing an existing file. Never permits in-place. */
  overwrite?: boolean | undefined;
}

export async function resolveNormalizeTarget(
  request: NormalizeTargetRequest,
  deps: NormalizeTargetDeps,
): Promise<string> {
  if (!request.outputPath) {
    const stem = path.basename(request.source, request.sourceExtension);
    return deps.reserve(request.outputDir, `${stem}_normalized.glb`);
  }

  const target = path.resolve(request.outputPath);

  // Unconditional: there is no opt-in for this. Normalizing over the input
  // destroys the original with no copy anywhere, and the caller cannot undo it.
  if (target === request.source) {
    throw invalidInput(
      'outputPath is the input mesh; normalizing in place would destroy the original ' +
      'irrecoverably. Omit outputPath to write <name>_normalized.glb beside it, or name a ' +
      'different destination.',
      { modelPath: request.source },
    );
  }

  if ((await deps.exists(target)) && !request.overwrite) {
    throw invalidInput(
      `refusing to overwrite an existing file at ${target}. Pass overwrite:true if you ` +
      'genuinely mean to replace it, or omit outputPath to get a numbered name instead.',
      { outputPath: target },
    );
  }

  return target;
}
