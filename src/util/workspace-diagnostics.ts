import path from 'node:path';

/**
 * ENOTDIR: the path, or a component of it, is a file. ELOOP: a symlink cycle.
 * ENAMETOOLONG: an over-long component. Each produced a bare errno that told
 * the caller nothing about which setting was wrong.
 */
const WORKSPACE_ERRNOS = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG', 'ENOSPC',
]);

/**
 * Explain a failure to open the asset workspace, or return undefined when the
 * error is not about the workspace path.
 *
 * The case worth naming is a RELATIVE `ASSET_OUTPUT_DIR`. It resolves against
 * the process working directory, and under MCP the client chooses that
 * directory, not the user — Claude Desktop and others spawn from `/`, where
 * "assets/generated" becomes "/assets" and mkdir fails. The raw errno reached
 * the client as nothing at all: the process exited and the client reported only
 * "connection closed", so the one configuration mistake everybody makes was
 * also the one with no diagnosis.
 */
export function describeWorkspaceFailure(
  error: unknown,
  outputDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const code = (error as NodeJS.ErrnoException).code ?? '';
  if (!WORKSPACE_ERRNOS.has(code)) return undefined;

  const supplied = env.ASSET_OUTPUT_DIR?.trim();
  const notDirectory = code === 'ENOTDIR'
    ? 'Something on that path is a file, not a directory — ASSET_OUTPUT_DIR must name a ' +
      'directory this process may create. '
    : '';
  const advice = supplied && !path.isAbsolute(supplied)
    ? `ASSET_OUTPUT_DIR is "${supplied}", a RELATIVE path, resolved against this process's ` +
      `working directory "${process.cwd()}" — which the client chose, not you. ` +
      'Set ASSET_OUTPUT_DIR to an absolute path.'
    : 'Set ASSET_OUTPUT_DIR to an absolute path this process may write to.';

  return `cannot create the asset workspace at ${outputDir} (${code}). ${notDirectory}${advice}`;
}
