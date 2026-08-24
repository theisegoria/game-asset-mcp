/**
 * Workspace layout and path safety.
 *
 * Layout per asset:
 *
 *   <root>/<slug>/
 *     asset.json      complete provenance
 *     source/         the reference image(s) the model was built from
 *     model/          the mesh
 *     textures/       extracted PBR maps
 *     previews/       provider renders
 *     metadata/       raw provider payloads, kept for debugging
 *
 * Nothing is ever silently overwritten. Names that collide get a numeric
 * suffix, so re-running a generation preserves the earlier result instead of
 * destroying work the user may have already reviewed.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AssetPipelineError } from '../util/errors.js';

export const ASSET_SUBDIRS = ['source', 'model', 'textures', 'previews', 'metadata'] as const;
export type AssetSubdir = (typeof ASSET_SUBDIRS)[number];

/**
 * Join under `root` and refuse anything that escapes it LEXICALLY.
 *
 * Guards against `..` and absolute segments. It deliberately does not resolve
 * symlinks — `path.resolve` cannot — so a link planted inside the workspace
 * would still pass. `assertRealPathInside` covers that case and is applied
 * where a directory is first created, which is the only point an attacker-
 * planted link could be introduced.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AssetPipelineError('PATH_ESCAPE', 'refusing to write outside the asset workspace', {
      details: { root: resolvedRoot, attempted: target },
    });
  }
  return target;
}

/** Strip anything path-like out of a provider-supplied filename. */
export function sanitizeFileName(raw: string, fallback: string): string {
  const base = path.basename(raw).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 128);
  return base.length > 0 ? base : fallback;
}

/**
 * Verify that `target` really lives under `root` once symlinks are resolved.
 *
 * The lexical check in `safeJoin` is defeated by a symlink; this is the
 * counterpart that actually holds the promise.
 */
export async function assertRealPathInside(root: string, target: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AssetPipelineError(
      'PATH_ESCAPE',
      'resolved path escapes the asset workspace (symlink?)',
      { details: { root: realRoot, resolved: realTarget } },
    );
  }
}

/**
 * Reserve a workspace directory for `slug`, appending `_2`, `_3`, … if taken.
 * Returns the absolute directory and the slug actually used.
 */
export async function reserveWorkspace(
  root: string,
  slug: string,
): Promise<{ dir: string; slug: string }> {
  await fs.mkdir(root, { recursive: true });
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const candidate = attempt === 1 ? slug : `${slug}_${attempt}`;
    const dir = safeJoin(root, candidate);
    try {
      // `mkdir` without `recursive` fails if it already exists, which makes
      // reservation atomic against a concurrent caller rather than racy
      // check-then-create.
      await fs.mkdir(dir);
      // Resolve links now, before anything is written into it.
      await assertRealPathInside(root, dir);
      for (const sub of ASSET_SUBDIRS) {
        await fs.mkdir(path.join(dir, sub), { recursive: true });
      }
      return { dir, slug: candidate };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new AssetPipelineError('INVALID_STATE', `could not reserve a workspace for "${slug}"`, {
    details: { root, slug },
  });
}

/**
 * Reserve a free path inside `dir`, suffixing before the extension.
 *
 * The name is claimed by CREATING the file exclusively (`wx`) rather than by
 * checking whether it exists first: a check-then-create leaves a window in
 * which two concurrent downloads pick the same name, and the loser then
 * reports a hash for bytes that are no longer in the file.
 */
export async function uniqueFilePath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const candidate = attempt === 1 ? fileName : `${stem}_${attempt}${ext}`;
    const full = safeJoin(dir, candidate);
    try {
      const handle = await fs.open(full, 'wx');
      await handle.close();
      return full;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new AssetPipelineError('INVALID_STATE', `could not find a free filename for ${fileName}`, {
    details: { dir, fileName },
  });
}

export function sha256(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Write bytes atomically (temp + fsync + rename) and return the digest.
 *
 * The temp suffix is random rather than time-derived: millisecond resolution
 * is not unique under concurrency, and two writers sharing a temp name means
 * one silently truncates the other's file mid-write. `wx` makes the collision
 * an error instead of a corruption.
 */
export async function writeFileAtomic(target: string, data: Uint8Array): Promise<string> {
  const tmp = `${target}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    const handle = await fs.open(tmp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
  } catch (err) {
    // Clean up on EVERY failure path, not just a failed rename — a write that
    // dies on ENOSPC would otherwise leak its temp file forever.
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return sha256(data);
}

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await writeFileAtomic(target, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}
