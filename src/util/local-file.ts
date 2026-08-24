/**
 * Reading files the user named explicitly.
 *
 * Only paths supplied directly as tool arguments reach here — never a path
 * taken from a provider response or a model-generated string interpolated into
 * a shell. The size cap keeps a mistyped path pointing at something enormous
 * from exhausting memory before we notice.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AssetPipelineError, invalidInput } from './errors.js';

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
export const MESH_EXTENSIONS = new Set(['.glb', '.gltf', '.fbx', '.obj', '.stl']);

export interface LocalFile {
  bytes: Uint8Array;
  fileName: string;
  extension: string;
  path: string;
}

export async function readLocalFile(
  filePath: string,
  maxBytes: number,
  allowedExtensions?: ReadonlySet<string>,
): Promise<LocalFile> {
  const resolved = path.resolve(filePath);
  const extension = path.extname(resolved).toLowerCase();

  if (allowedExtensions && !allowedExtensions.has(extension)) {
    throw invalidInput(`unsupported file type "${extension || '(none)'}"`, {
      path: resolved,
      allowed: [...allowedExtensions],
    });
  }

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw invalidInput(`file not found: ${resolved}`);
  }
  if (!stat.isFile()) throw invalidInput(`not a regular file: ${resolved}`);
  if (stat.size === 0) throw invalidInput(`file is empty: ${resolved}`);
  if (stat.size > maxBytes) {
    throw new AssetPipelineError(
      'DOWNLOAD_TOO_LARGE',
      `file is ${stat.size} bytes, limit is ${maxBytes}`,
      { details: { size: stat.size, limit: maxBytes, path: resolved } },
    );
  }

  return {
    bytes: new Uint8Array(await fs.readFile(resolved)),
    fileName: path.basename(resolved),
    extension,
    path: resolved,
  };
}
