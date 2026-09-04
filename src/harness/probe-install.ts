/**
 * Copy the probe SDK sources into a game project.
 *
 * The SDK ships as source inside the npm package and is compiled by the
 * engine's build, never by npm -- that is what keeps the install story free of
 * a native toolchain. But "it is somewhere under node_modules" is not a place
 * an engine's build can point at. This puts the two files where the project
 * can vendor them, with the same discipline as adapter installation: plan
 * first, write only on --confirm, never overwrite bytes that differ.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../storage/filesystem.js';
import { invalidInput, invalidState } from '../util/errors.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

function packagedProbeRoot(): string {
  return path.resolve(moduleDirectory, '..', '..', 'probe', 'c');
}

/** The closed set of files an install writes. Nothing else is copied. */
export const PROBE_SDK_FILES = ['gdprobe.h', 'gdprobe.c'] as const;

export interface ProbeInstallResult {
  schema: 'game_dev.probe_install.v1';
  destination: string;
  dryRun: boolean;
  /** True when every file already existed with identical bytes. */
  reused: boolean;
  files: Array<{ name: string; path: string; bytes: number; sha256: string; existed: boolean }>;
  compile: string;
  evidenceCeiling: string;
}

async function packagedFile(name: string): Promise<Buffer> {
  const source = path.join(packagedProbeRoot(), name);
  const stats = await fs.lstat(source).catch(() => undefined);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw invalidState('packaged probe SDK file is missing', { name });
  }
  return fs.readFile(source);
}

export async function installProbeSdk(options: {
  projectRoot: string;
  /** Project-relative directory; defaults to third_party/gdprobe. */
  destination?: string | undefined;
  confirm: boolean;
}): Promise<ProbeInstallResult> {
  const projectRoot = await fs.realpath(path.resolve(options.projectRoot)).catch(() => {
    throw invalidInput('probe install project root does not exist');
  });
  if (!(await fs.stat(projectRoot)).isDirectory()) {
    throw invalidInput('probe install project root must be a directory');
  }

  const relative = options.destination ?? path.join('third_party', 'gdprobe');
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw invalidInput('probe install destination must be a project-relative path without ..', {
      destination: relative,
    });
  }
  const destination = path.resolve(projectRoot, relative);
  // Containment checked on the resolved path as well as the literal one, so a
  // symlinked directory inside the project cannot redirect the write outside it.
  const containment = await fs.realpath(destination).catch(() => destination);
  if (containment !== projectRoot && !containment.startsWith(`${projectRoot}${path.sep}`)) {
    throw invalidInput('probe install destination escapes the project', { destination });
  }

  const files: ProbeInstallResult['files'] = [];
  let allIdentical = true;
  for (const name of PROBE_SDK_FILES) {
    const bytes = await packagedFile(name);
    const target = path.join(destination, name);
    const existing = await fs.lstat(target).catch(() => undefined);
    let existed = false;
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw invalidState('probe install destination already holds something that is not a regular file', {
          target,
        });
      }
      existed = true;
      const current = await fs.readFile(target);
      if (!current.equals(bytes)) {
        // Refused rather than overwritten: a project may have patched its copy,
        // and silently replacing it would be the worst way to find out.
        throw invalidState(
          `${name} already exists with different contents; remove it or choose another destination`,
          { target },
        );
      }
    } else {
      allIdentical = false;
    }
    files.push({ name, path: target, bytes: bytes.length, sha256: sha256(bytes), existed });
  }

  if (options.confirm && !allIdentical) {
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    for (const name of PROBE_SDK_FILES) {
      const target = path.join(destination, name);
      if (files.find((file) => file.name === name)?.existed) continue;
      const handle = await fs.open(target, 'wx', 0o644);
      try {
        await handle.writeFile(await packagedFile(name));
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  return {
    schema: 'game_dev.probe_install.v1',
    destination,
    dryRun: !options.confirm,
    reused: allIdentical,
    files,
    compile: `cc -std=c99 -Wall -Wextra -Werror -c ${path.join(relative, 'gdprobe.c')}`,
    evidenceCeiling:
      'Installing the probe SDK copies two C source files into the project. It compiles nothing, ' +
      'links nothing, and proves nothing about the engine that will include them.',
  };
}
