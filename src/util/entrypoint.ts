import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve a path the way both `process.argv[1]` and `import.meta.url` must be
 * resolved before they can be compared.
 */
export function canonical(target: string): string {
  try {
    return realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

/**
 * True when this module's file is the one node was asked to run, so importing
 * a module never starts it.
 *
 * The naive comparison silently fails two ways, both observed rather than
 * imagined:
 *
 *  1. Any space or non-ASCII character in the install path is percent-encoded
 *     in `import.meta.url` but literal in argv, so string-building a file://
 *     URL never matches. Hence `fileURLToPath`.
 *  2. An npm-installed package is launched through `node_modules/.bin`, which
 *     is a SYMLINK. Node resolves `import.meta.url` to the real file but leaves
 *     `argv[1]` as the symlink, so the paths differ and main() never runs. For
 *     the CLI that is a no-op exit; for an MCP server it is worse, because the
 *     client sees only "connection closed" and no diagnosis at all. Hence
 *     realpath on both sides.
 *
 * Both failures are invisible in development, where the real path is invoked
 * directly, and fatal for anyone who installs the package.
 */
export function isDirectInvocation(importMetaUrl: string): boolean {
  const invoked = process.argv[1] ? canonical(process.argv[1]) : undefined;
  if (!invoked) return false;
  return canonical(fileURLToPath(importMetaUrl)) === invoked;
}
