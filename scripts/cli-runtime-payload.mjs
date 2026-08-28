import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI_RUNTIME_ROSTER_SCHEMA = 'game_dev.cli_runtime_roster.v1';
export const CLI_RUNTIME_ROOT_NAME = 'GameDevelopmentStudioRuntime';
export const CLI_RUNTIME_PAYLOAD_ROOT = 'payload';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const defaultSourceRoot = path.resolve(moduleDirectory, '..');

const DIRECTORY_MODE = 0o755;
const REGULAR_FILE_MODE = 0o644;
const NODE_BINARY_MODE = 0o755;

const REQUIRED_APP_METADATA_FILES = [
  'LICENSE',
  'PRIVACY.md',
  'SECURITY.md',
  'SUPPORT.md',
  'TERMS.md',
];

const REQUIRED_APP_SCRIPTS = [
  'blender_normalize.py',
  'blender_usd_export.py',
];

const REQUIRED_PAYLOAD_PATHS = [
  'app',
  'app/adapters',
  'app/dist',
  'app/dist/cli.js',
  'app/node_modules',
  'app/package.json',
  'app/scripts',
  'app/scripts/blender_normalize.py',
  'app/scripts/blender_usd_export.py',
  'app/skills',
  'app/skills/manifest.json',
  'node',
  'node/bin',
  'node/bin/node',
  'node/lib',
  ...REQUIRED_APP_METADATA_FILES.map((relative) => `app/${relative}`),
];

const MACOS_SYSTEM_LIBRARY_PREFIXES = ['/System/Library/', '/usr/lib/'];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function runMacTool(tool, argumentsList) {
  return new Promise((resolve, reject) => {
    execFile(tool, argumentsList, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(
          `${tool} ${argumentsList.join(' ')} failed: ${stderr || stdout}`,
          { cause: error },
        ));
      } else {
        resolve(stdout);
      }
    });
  });
}

function isMacOSSystemLibrary(reference) {
  return MACOS_SYSTEM_LIBRARY_PREFIXES.some((prefix) => reference.startsWith(prefix));
}

function parseMachODependencies(output, binary) {
  const lines = output.split('\n').slice(1);
  const dependencies = [];
  for (const line of lines) {
    const match = /^\s+(.+?) \(compatibility version /.exec(line);
    if (!match?.[1]) continue;
    dependencies.push(match[1]);
  }
  invariant(dependencies.length > 0, `otool did not report dynamic dependencies for ${binary}`);
  return dependencies;
}

function parseMachORpaths(output) {
  const rpaths = [];
  const pattern = /\n\s*cmd LC_RPATH[\s\S]*?\n\s*path (.+?) \(offset /g;
  for (const match of output.matchAll(pattern)) {
    if (match[1]) rpaths.push(match[1]);
  }
  return rpaths;
}

async function machODependencies(binary) {
  return parseMachODependencies(await runMacTool('/usr/bin/otool', ['-L', binary]), binary);
}

async function machORpaths(binary) {
  return parseMachORpaths(await runMacTool('/usr/bin/otool', ['-l', binary]));
}

function expandMachOPath(reference, loaderPath, executablePath) {
  if (reference.startsWith('@loader_path/')) return path.resolve(path.dirname(loaderPath), reference.slice('@loader_path/'.length));
  if (reference.startsWith('@executable_path/')) return path.resolve(path.dirname(executablePath), reference.slice('@executable_path/'.length));
  if (path.isAbsolute(reference)) return reference;
  return undefined;
}

async function resolveMachODependency(reference, binary, executable) {
  if (isMacOSSystemLibrary(reference)) return undefined;
  const candidates = [];
  const direct = expandMachOPath(reference, binary, executable);
  if (direct) candidates.push(direct);
  if (reference.startsWith('@rpath/')) {
    const suffix = reference.slice('@rpath/'.length);
    for (const rpath of await machORpaths(binary)) {
      const expanded = expandMachOPath(rpath, binary, executable);
      if (expanded) candidates.push(path.resolve(expanded, suffix));
    }
  }
  for (const candidate of candidates) {
    const physical = await realpath(candidate).catch(() => undefined);
    if (!physical) continue;
    const stats = await lstat(physical).catch(() => undefined);
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) continue;
    return physical;
  }
  throw new Error(`unable to resolve non-system Mach-O dependency ${reference} for ${binary}`);
}

async function macOSNodeLibraryClosure(nodeExecutable) {
  invariant(process.platform === 'darwin', 'closed direct Node runtime staging is currently supported only on macOS');
  const executable = await realpath(nodeExecutable);
  const pending = [executable];
  const visited = new Set();
  const libraryBySource = new Map();
  const libraryNameSources = new Map();
  let executableReferences = [];

  while (pending.length > 0) {
    const binary = pending.shift();
    if (!binary || visited.has(binary)) continue;
    visited.add(binary);
    const references = [];
    for (const reference of await machODependencies(binary)) {
      if (isMacOSSystemLibrary(reference)) continue;
      const dependency = await resolveMachODependency(reference, binary, executable);
      if (!dependency || dependency === binary) continue;
      const name = path.basename(dependency);
      invariant(name.length > 0 && !name.includes(path.sep), `unsafe Mach-O library name: ${dependency}`);
      const existingSource = libraryNameSources.get(name);
      invariant(!existingSource || existingSource === dependency, `Mach-O dependency basename collision for ${name}`);
      libraryNameSources.set(name, dependency);
      references.push({ dependency, reference });
      pending.push(dependency);
      if (dependency !== executable && !libraryBySource.has(dependency)) {
        libraryBySource.set(dependency, { dependency, references: [] });
      }
    }
    if (binary === executable) executableReferences = references;
    else {
      const library = libraryBySource.get(binary);
      invariant(library, `missing Mach-O library closure record for ${binary}`);
      library.references = references;
    }
  }
  return {
    executable,
    executableReferences,
    libraries: [...libraryBySource.values()].sort((left, right) => compareUtf8(path.basename(left.dependency), path.basename(right.dependency))),
  };
}

async function rewriteMachOLibrary(binary, references, replacement) {
  for (const { dependency, reference } of references) {
    const nextReference = replacement(path.basename(dependency));
    if (reference === nextReference) continue;
    await runMacTool('/usr/bin/install_name_tool', ['-change', reference, nextReference, binary]);
  }
}

async function adHocSignMacOSRuntimeBinary(binary, identifier) {
  await runMacTool('/usr/bin/codesign', [
    '--force',
    '--identifier', identifier,
    '--sign', '-',
    '--timestamp=none',
    binary,
  ]);
}

async function stageMacOSNodeRuntime(stagingRoot, nodeExecutable, destinationRoot) {
  const closure = await macOSNodeLibraryClosure(nodeExecutable);
  const nodeBinary = path.join(destinationRoot, 'bin', 'node');
  const libraryRoot = path.join(destinationRoot, 'lib');
  await ensureDirectory(stagingRoot, path.join(destinationRoot, 'bin'));
  await ensureDirectory(stagingRoot, libraryRoot);
  await copyAsRuntimeFile(stagingRoot, closure.executable, nodeBinary, NODE_BINARY_MODE);
  for (const library of closure.libraries) {
    await copyAsRuntimeFile(
      stagingRoot,
      library.dependency,
      path.join(libraryRoot, path.basename(library.dependency)),
    );
  }
  await rewriteMachOLibrary(nodeBinary, closure.executableReferences, (name) => `@loader_path/../lib/${name}`);
  for (const library of closure.libraries) {
    const stagedLibrary = path.join(libraryRoot, path.basename(library.dependency));
    await rewriteMachOLibrary(stagedLibrary, library.references, (name) => `@loader_path/${name}`);
    await runMacTool('/usr/bin/install_name_tool', ['-id', `@rpath/${path.basename(library.dependency)}`, stagedLibrary]);
    await adHocSignMacOSRuntimeBinary(stagedLibrary, 'com.theisegoria.game-development-studio.runtime-library');
  }
  await adHocSignMacOSRuntimeBinary(nodeBinary, 'com.theisegoria.game-development-studio.runtime-node');
}

async function verifyMacOSNodeRuntime(payloadRoot) {
  if (process.platform !== 'darwin') return;
  const nodeRoot = path.join(payloadRoot, 'node');
  const nodeBinary = path.join(nodeRoot, 'bin', 'node');
  const libraryRoot = path.join(nodeRoot, 'lib');
  const binaries = [nodeBinary];
  for (const entry of await sortedDirectoryEntries(libraryRoot, 'runtime node library directory')) {
    const candidate = path.join(libraryRoot, entry.name);
    await requireRegularFile(candidate, `runtime node library ${entry.name}`);
    binaries.push(candidate);
  }
  for (const binary of binaries) {
    for (const reference of await machODependencies(binary)) {
      if (isMacOSSystemLibrary(reference)) continue;
      if (binary !== nodeBinary && reference === `@rpath/${path.basename(binary)}`) continue;
      invariant(reference.startsWith('@loader_path/'), `runtime Node has a non-closed dynamic dependency: ${reference}`);
      const target = path.resolve(path.dirname(binary), reference.slice('@loader_path/'.length));
      invariant(target.startsWith(`${nodeRoot}${path.sep}`), `runtime Node dynamic dependency escapes node root: ${reference}`);
      await requireRegularFile(target, `runtime Node dynamic dependency ${reference}`);
    }
    await runMacTool('/usr/bin/codesign', ['--verify', '--strict', binary]);
  }
}

function modeString(mode) {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if ((codePoint !== undefined && codePoint > 0 && codePoint < 32) || codePoint === 127) return true;
  }
  return false;
}

/**
 * Cross-language canonical JSON: UTF-8 strings, recursively byte-sorted keys,
 * no insignificant whitespace, and array order preserved.
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    invariant(Number.isFinite(value) && Number.isSafeInteger(value), 'canonical JSON numbers must be safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  invariant(isPlainObject(value), 'canonical JSON only supports plain objects, arrays, primitives, and null');
  return `{${Object.keys(value).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function normalizedRelativePath(relative, label) {
  invariant(typeof relative === 'string' && relative.length > 0, `${label} must be a non-empty string`);
  invariant(!relative.includes('\\') && !relative.includes('\0'), `${label} must use safe POSIX separators`);
  invariant(!path.posix.isAbsolute(relative), `${label} must be relative`);
  invariant(!hasControlCharacter(relative), `${label} contains a control character`);
  const components = relative.split('/');
  invariant(
    components.every((component) => component.length > 0 && component !== '.' && component !== '..'),
    `${label} contains an empty, current-directory, or parent-directory segment`,
  );
  invariant(path.posix.normalize(relative) === relative, `${label} is not normalized`);
  return relative;
}

function payloadPath(relative) {
  return normalizedRelativePath(relative, 'payload roster path');
}

function joinInside(root, relative, label) {
  const normalized = normalizedRelativePath(relative, label);
  const resolved = path.resolve(root, ...normalized.split('/'));
  invariant(resolved.startsWith(`${root}${path.sep}`), `${label} escapes its root`);
  return resolved;
}

async function requireDirectory(target, label) {
  const stats = await lstat(target).catch((error) => {
    throw new Error(`${label} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`);
  });
  invariant(!stats.isSymbolicLink(), `${label} must not be a symlink`);
  invariant(stats.isDirectory(), `${label} must be a directory`);
  return stats;
}

async function requireRegularFile(target, label) {
  const stats = await lstat(target).catch((error) => {
    throw new Error(`${label} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`);
  });
  invariant(!stats.isSymbolicLink(), `${label} must not be a symlink`);
  invariant(stats.isFile(), `${label} must be a regular file`);
  return stats;
}

async function sortedDirectoryEntries(directory, label) {
  await requireDirectory(directory, label);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.sort((left, right) => compareUtf8(left.name, right.name));
}

function forbiddenPayloadReason(relative) {
  const normalized = payloadPath(relative);
  const lower = normalized.toLowerCase();
  const base = path.posix.basename(lower);
  const sensitiveBase = base.replace(/^\.+/, '');
  const components = lower.split('/');

  if (sensitiveBase === 'env' || sensitiveBase === 'envrc' || /^env[._-]/.test(sensitiveBase)) {
    return 'environment files are not allowed';
  }
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials?|secrets?|tokens?|passwords?|private[._-]?key)(?:[._-]|$)/.test(sensitiveBase)) {
    return 'credential-like file names are not allowed';
  }
  if (/(?:^|[._-])(?:api[._-]?key|secret|token|credential|password|private[._-]?key)(?:[._-]|$)/.test(sensitiveBase)) {
    return 'credential-like file names are not allowed';
  }
  if (/\.(?:key|pem|crt|cer|csr|p12|pfx|der|jks|keystore)$/i.test(base)) {
    return 'key and certificate files are not allowed';
  }
  if (/\.(?:map|ts|tsx|mts|cts)$/i.test(base)) {
    return 'source maps and TypeScript files are not allowed';
  }
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base)) {
    return 'test and specification files are not allowed';
  }
  if (components.some((component) => [
    '.git', '.hg', '.svn', '.github', '.nyc_output', '__mocks__', '__tests__', 'benchmark', 'benchmarks',
    'coverage', 'example', 'examples', 'fixture', 'fixtures', 'mock', 'mocks', 'story', 'stories', 'test', 'tests',
  ].includes(component))) {
    return 'development-only directories are not allowed';
  }
  if (components.some((component, index) => component === '.bin' && components[index - 1] === 'node_modules')) {
    return 'node_modules command shims are not allowed';
  }
  if (/^(?:\.ds_store|\.gitignore|\.npmignore|\.eslint(?:rc)?(?:\.|$)|\.prettier(?:rc)?(?:\.|$)|eslint\.config\.|prettier\.config\.|tsconfig(?:\.|$))/i.test(base)) {
    return 'development configuration is not allowed';
  }
  return undefined;
}

function isExpectedDistArtifact(relative) {
  const lower = relative.toLowerCase();
  return lower.endsWith('.map') || /\.(?:d\.)?(?:ts|tsx|mts|cts)$/.test(lower);
}

async function ensureDirectory(root, destination) {
  const relative = path.relative(root, destination);
  invariant(relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'), 'destination escapes staging root');
  let current = root;
  await mkdir(current, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(current, DIRECTORY_MODE);
  if (relative === '') return;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    await mkdir(current, { recursive: false, mode: DIRECTORY_MODE }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    await chmod(current, DIRECTORY_MODE);
  }
}

async function copyAsRuntimeFile(stagingRoot, source, destination, mode = REGULAR_FILE_MODE) {
  await requireRegularFile(source, `runtime source ${source}`);
  await ensureDirectory(stagingRoot, path.dirname(destination));
  await copyFile(source, destination);
  await chmod(destination, mode);
}

async function writeRuntimeFile(stagingRoot, destination, contents, mode = REGULAR_FILE_MODE) {
  await ensureDirectory(stagingRoot, path.dirname(destination));
  await writeFile(destination, contents, { flag: 'wx', mode });
  await chmod(destination, mode);
}

async function copyRuntimeDirectory({
  source,
  destination,
  stagingRoot,
  payloadRelative,
  policy,
}) {
  const visit = async (sourcePath, destinationPath, relative) => {
    const stats = await lstat(sourcePath).catch((error) => {
      throw new Error(`runtime source entry is unreadable: ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
    });
    invariant(!stats.isSymbolicLink(), `runtime source entry must not be a symlink: ${payloadRelative(relative)}`);
    if (stats.isDirectory()) {
      const decision = policy.directory(relative);
      if (decision === 'skip') return;
      invariant(decision === 'include', `invalid directory policy for ${payloadRelative(relative)}`);
      for (const entry of await sortedDirectoryEntries(sourcePath, `runtime source directory ${sourcePath}`)) {
        await visit(
          path.join(sourcePath, entry.name),
          path.join(destinationPath, entry.name),
          relative ? `${relative}/${entry.name}` : entry.name,
        );
      }
      return;
    }
    invariant(stats.isFile(), `runtime source entry must be a regular file: ${payloadRelative(relative)}`);
    const decision = policy.file(relative);
    if (decision === 'skip') return;
    invariant(decision === 'include', `invalid file policy for ${payloadRelative(relative)}`);
    await copyAsRuntimeFile(stagingRoot, sourcePath, destinationPath);
  };

  await requireDirectory(source, `runtime source directory ${source}`);
  await ensureDirectory(stagingRoot, destination);
  await visit(source, destination, '');
}

function exactPayloadScopePolicy(payloadPrefix) {
  return {
    directory(relative) {
      if (relative) {
        const forbidden = forbiddenPayloadReason(`${payloadPrefix}/${relative}`);
        invariant(!forbidden, `forbidden runtime source directory ${payloadPrefix}/${relative}: ${forbidden}`);
      }
      return 'include';
    },
    file(relative) {
      const forbidden = forbiddenPayloadReason(`${payloadPrefix}/${relative}`);
      invariant(!forbidden, `forbidden runtime source file ${payloadPrefix}/${relative}: ${forbidden}`);
      return 'include';
    },
  };
}

function distScopePolicy() {
  return {
    directory(relative) {
      if (!relative) return 'include';
      const forbidden = forbiddenPayloadReason(`app/dist/${relative}`);
      invariant(!forbidden, `forbidden dist directory app/dist/${relative}: ${forbidden}`);
      return 'include';
    },
    file(relative) {
      if (relative.toLowerCase().endsWith('.js') && !forbiddenPayloadReason(`app/dist/${relative}`)) return 'include';
      if (isExpectedDistArtifact(relative)) return 'skip';
      const forbidden = forbiddenPayloadReason(`app/dist/${relative}`);
      if (forbidden) throw new Error(`forbidden dist file app/dist/${relative}: ${forbidden}`);
      throw new Error(`dist contains a non-JavaScript runtime artifact: app/dist/${relative}`);
    },
  };
}

function productionModuleScopePolicy(packagePayloadPrefix) {
  return {
    directory(relative) {
      if (relative && path.posix.basename(relative) === 'node_modules') return 'skip';
      if (!relative) return 'include';
      const forbidden = forbiddenPayloadReason(`${packagePayloadPrefix}/${relative}`);
      return forbidden ? 'skip' : 'include';
    },
    file(relative) {
      const forbidden = forbiddenPayloadReason(`${packagePayloadPrefix}/${relative}`);
      return forbidden ? 'skip' : 'include';
    },
  };
}

function withoutTypeMetadata(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map((item) => withoutTypeMetadata(item));
  invariant(isPlainObject(value), 'runtime package metadata must be JSON-compatible');
  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key !== 'types') sanitized[key] = withoutTypeMetadata(nested);
  }
  return sanitized;
}

function runtimePackageMetadata(sourcePackage) {
  invariant(isPlainObject(sourcePackage), 'source package.json must be an object');
  invariant(typeof sourcePackage.name === 'string' && sourcePackage.name.length > 0, 'source package.json must contain a name');
  invariant(typeof sourcePackage.version === 'string' && sourcePackage.version.length > 0, 'source package.json must contain a version');
  invariant(sourcePackage.type === 'module', 'runtime package.json must use ESM module type');
  invariant(isPlainObject(sourcePackage.dependencies), 'source package.json must contain production dependencies');
  for (const [name, version] of Object.entries(sourcePackage.dependencies)) {
    invariant(typeof version === 'string' && version.length > 0, `invalid production dependency version for ${name}`);
    packageInstallPath(name);
  }
  return {
    bin: sourcePackage.bin,
    dependencies: sourcePackage.dependencies,
    engines: sourcePackage.engines,
    exports: withoutTypeMetadata(sourcePackage.exports),
    license: sourcePackage.license,
    main: sourcePackage.main,
    name: sourcePackage.name,
    type: 'module',
    version: sourcePackage.version,
  };
}

function packageInstallPath(packageName) {
  invariant(typeof packageName === 'string' && packageName.length > 0, 'dependency package name must be a non-empty string');
  invariant(!packageName.includes('\\') && !packageName.includes('..') && !packageName.includes('\0'), `unsafe dependency package name: ${packageName}`);
  if (packageName.startsWith('@')) {
    const scoped = packageName.split('/');
    invariant(scoped.length === 2 && scoped.every((part) => part.length > 1), `invalid scoped dependency package name: ${packageName}`);
  } else {
    invariant(!packageName.includes('/'), `invalid dependency package name: ${packageName}`);
  }
  return packageName;
}

function productionPackagePaths(lockfile) {
  invariant(isPlainObject(lockfile) && lockfile.lockfileVersion === 3, 'package-lock.json must use lockfileVersion 3');
  invariant(isPlainObject(lockfile.packages), 'package-lock.json must contain a packages object');
  const paths = [];
  for (const [relative, metadata] of Object.entries(lockfile.packages)) {
    if (!relative.startsWith('node_modules/')) continue;
    invariant(isPlainObject(metadata), `invalid package-lock metadata for ${relative}`);
    if (metadata.dev === true) continue;
    const packageRelative = relative.slice('node_modules/'.length);
    normalizedRelativePath(packageRelative, `package-lock production package path ${relative}`);
    paths.push(packageRelative);
  }
  paths.sort(compareUtf8);
  invariant(paths.length > 0, 'package-lock.json contains no production packages');
  invariant(new Set(paths).size === paths.length, 'package-lock.json contains duplicate production package paths');
  return paths;
}

async function collectPayloadEntries(payloadRoot) {
  const entries = [];
  const visit = async (absolute, relative) => {
    const stats = await lstat(absolute).catch((error) => {
      throw new Error(`runtime payload entry is unreadable: ${relative || '.'}: ${error instanceof Error ? error.message : String(error)}`);
    });
    invariant(!stats.isSymbolicLink(), `runtime payload symlink is not allowed: ${relative || '.'}`);
    invariant(stats.isDirectory() || stats.isFile(), `runtime payload special file is not allowed: ${relative || '.'}`);
    if (relative) {
      const normalized = payloadPath(relative);
      const forbidden = forbiddenPayloadReason(normalized);
      invariant(!forbidden, `forbidden runtime payload entry ${normalized}: ${forbidden}`);
      entries.push({
        mode: modeString(stats.mode),
        path: normalized,
        sha256: stats.isFile() ? sha256(await readFile(absolute)) : null,
        size: stats.isFile() ? stats.size : 0,
        type: stats.isFile() ? 'file' : 'directory',
      });
    }
    if (stats.isDirectory()) {
      for (const entry of await sortedDirectoryEntries(absolute, `runtime payload directory ${relative || '.'}`)) {
        await visit(path.join(absolute, entry.name), relative ? `${relative}/${entry.name}` : entry.name);
      }
    }
  };

  await requireDirectory(payloadRoot, 'runtime payload root');
  await visit(payloadRoot, '');
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  return entries;
}

function treeSha256(entries) {
  return sha256(Buffer.from(canonicalJson(entries), 'utf8'));
}

function assertExactObject(value, keys, label) {
  invariant(isPlainObject(value), `${label} must be an object`);
  const actualKeys = Object.keys(value).sort(compareUtf8);
  const expectedKeys = [...keys].sort(compareUtf8);
  invariant(
    actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]),
    `${label} has an unexpected shape`,
  );
}

function validSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validateRoster(roster) {
  assertExactObject(roster, ['entries', 'payloadRoot', 'schema', 'treeSha256'], 'runtime roster');
  invariant(roster.schema === CLI_RUNTIME_ROSTER_SCHEMA, 'unexpected runtime roster schema');
  invariant(roster.payloadRoot === CLI_RUNTIME_PAYLOAD_ROOT, 'runtime roster must name payload as its payload root');
  invariant(Array.isArray(roster.entries) && roster.entries.length > 0, 'runtime roster entries must be a non-empty array');
  invariant(validSha256(roster.treeSha256), 'runtime roster treeSha256 must be lowercase SHA-256');

  let previous;
  const paths = new Set();
  for (const [index, entry] of roster.entries.entries()) {
    assertExactObject(entry, ['mode', 'path', 'sha256', 'size', 'type'], `runtime roster entry ${index}`);
    const relative = payloadPath(entry.path);
    invariant(previous === undefined || compareUtf8(previous, relative) < 0, 'runtime roster entries must be strictly UTF-8 byte sorted');
    previous = relative;
    invariant(!paths.has(relative), `runtime roster has a duplicate path: ${relative}`);
    paths.add(relative);
    invariant(entry.type === 'file' || entry.type === 'directory', `runtime roster entry has an invalid type: ${relative}`);
    invariant(typeof entry.mode === 'string' && /^(?:0[0-7]{3}|[1-7][0-7]{3})$/.test(entry.mode), `runtime roster entry has an invalid mode: ${relative}`);
    invariant(Number.isSafeInteger(entry.size) && entry.size >= 0, `runtime roster entry has an invalid size: ${relative}`);
    if (entry.type === 'file') {
      invariant(validSha256(entry.sha256), `runtime roster file entry has an invalid SHA-256: ${relative}`);
    } else {
      invariant(entry.sha256 === null && entry.size === 0, `runtime roster directory entry must have null SHA-256 and size zero: ${relative}`);
    }
    const forbidden = forbiddenPayloadReason(relative);
    invariant(!forbidden, `runtime roster contains forbidden path ${relative}: ${forbidden}`);
  }
  invariant(treeSha256(roster.entries) === roster.treeSha256, 'runtime roster treeSha256 does not match its canonical entries');

  for (const required of REQUIRED_PAYLOAD_PATHS) {
    invariant(paths.has(required), `runtime roster is missing required payload entry: ${required}`);
  }
  const byPath = new Map(roster.entries.map((entry) => [entry.path, entry]));
  invariant(byPath.get('node/bin/node')?.type === 'file' && byPath.get('node/bin/node')?.mode === modeString(NODE_BINARY_MODE), 'runtime node binary must be a regular 0755 file');
  for (const [relative, entry] of byPath) {
    if (entry.type === 'directory') {
      invariant(entry.mode === modeString(DIRECTORY_MODE), `runtime directory must use mode 0755: ${relative}`);
    } else if (relative !== 'node/bin/node') {
      invariant(entry.mode === modeString(REGULAR_FILE_MODE), `runtime regular file must use mode 0644: ${relative}`);
    }
    if (relative.startsWith('app/dist/') && entry.type === 'file') {
      invariant(relative.endsWith('.js'), `runtime dist contains a non-JavaScript file: ${relative}`);
    }
  }

  const nodeEntries = [...byPath.keys()]
    .filter((relative) => relative === 'node' || relative.startsWith('node/'))
    .sort(compareUtf8);
  for (const relative of nodeEntries) {
    const entry = byPath.get(relative);
    invariant(entry, `runtime node entry is missing from the roster map: ${relative}`);
    if (['node', 'node/bin', 'node/lib'].includes(relative)) {
      invariant(entry.type === 'directory', `runtime Node directory has the wrong type: ${relative}`);
    } else if (relative === 'node/bin/node') {
      invariant(entry.type === 'file' && entry.mode === modeString(NODE_BINARY_MODE), 'runtime node binary must be a regular 0755 file');
    } else if (relative.startsWith('node/lib/')) {
      const leaf = relative.slice('node/lib/'.length);
      invariant(!leaf.includes('/'), `runtime node library must not be nested: ${relative}`);
      invariant(entry.type === 'file' && entry.mode === modeString(REGULAR_FILE_MODE), `runtime node library must be a regular 0644 file: ${relative}`);
    } else {
      throw new Error(`runtime node directory contains an unexpected entry: ${relative}`);
    }
  }

  const scriptEntries = [...byPath.values()]
    .filter((entry) => entry.type === 'file' && entry.path.startsWith('app/scripts/'))
    .map((entry) => entry.path.slice('app/scripts/'.length))
    .sort(compareUtf8);
  invariant(
    canonicalJson(scriptEntries) === canonicalJson([...REQUIRED_APP_SCRIPTS].sort(compareUtf8)),
    'runtime scripts directory must contain exactly the required Blender scripts',
  );

  return byPath;
}

async function verifyRuntimePackageMetadata(payloadRoot, rosterPaths) {
  const packagePath = joinInside(payloadRoot, 'app/package.json', 'runtime package metadata path');
  const packageStats = await requireRegularFile(packagePath, 'runtime package metadata');
  invariant(modeString(packageStats.mode) === modeString(REGULAR_FILE_MODE), 'runtime package metadata must use mode 0644');
  const parsed = JSON.parse(await readFile(packagePath, 'utf8'));
  assertExactObject(parsed, ['bin', 'dependencies', 'engines', 'exports', 'license', 'main', 'name', 'type', 'version'], 'runtime package metadata');
  invariant(parsed.type === 'module', 'runtime package metadata must use ESM');
  invariant(isPlainObject(parsed.dependencies), 'runtime package metadata must contain production dependencies');
  invariant(!Object.hasOwn(parsed, 'devDependencies') && !Object.hasOwn(parsed, 'scripts'), 'runtime package metadata must not contain development dependencies or scripts');
  for (const [packageName, version] of Object.entries(parsed.dependencies)) {
    invariant(typeof version === 'string' && version.length > 0, `runtime package metadata has an invalid dependency version: ${packageName}`);
    const installedManifest = `app/node_modules/${packageInstallPath(packageName)}/package.json`;
    invariant(rosterPaths.has(installedManifest), `runtime roster is missing production dependency package metadata: ${installedManifest}`);
  }
}

async function replaceRuntimeRoot(stagingRoot, outputRoot) {
  const parent = path.dirname(outputRoot);
  const base = path.basename(outputRoot);
  let backup;
  const existing = await lstat(outputRoot).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) {
    invariant(!existing.isSymbolicLink(), `runtime output must not replace a symlink: ${outputRoot}`);
    invariant(existing.isDirectory(), `runtime output must be a directory when it already exists: ${outputRoot}`);
    backup = path.join(parent, `.${base}.previous-${randomBytes(8).toString('hex')}`);
    await rename(outputRoot, backup);
  }
  try {
    await rename(stagingRoot, outputRoot);
  } catch (error) {
    if (backup) await rename(backup, outputRoot).catch(() => undefined);
    throw error;
  }
  if (backup) await rm(backup, { recursive: true, force: true });
}

export async function buildRuntimePayload({
  sourceRoot = defaultSourceRoot,
  outputRoot,
  nodeExecutable = process.execPath,
} = {}) {
  invariant(typeof outputRoot === 'string' && outputRoot.length > 0, 'runtime outputRoot is required');
  const source = path.resolve(sourceRoot);
  const output = path.resolve(outputRoot);
  invariant(path.basename(output) === CLI_RUNTIME_ROOT_NAME, `runtime output root must be named ${CLI_RUNTIME_ROOT_NAME}`);
  invariant(source !== output, 'runtime output root must not be the source root');
  await requireDirectory(source, 'runtime source root');
  const nodeSource = path.resolve(nodeExecutable);
  await requireRegularFile(nodeSource, 'runtime node executable');
  const outputParent = path.dirname(output);
  await mkdir(outputParent, { recursive: true, mode: DIRECTORY_MODE });
  await requireDirectory(outputParent, 'runtime output parent');

  const stagingContainer = await mkdtemp(path.join(outputParent, `.${CLI_RUNTIME_ROOT_NAME}.staging-`));
  const stagingRoot = path.join(stagingContainer, CLI_RUNTIME_ROOT_NAME);
  await ensureDirectory(stagingRoot, stagingRoot);
  await chmod(stagingRoot, DIRECTORY_MODE);
  try {
    const payload = path.join(stagingRoot, CLI_RUNTIME_PAYLOAD_ROOT);
    await ensureDirectory(stagingRoot, payload);
    await stageMacOSNodeRuntime(stagingRoot, nodeSource, path.join(payload, 'node'));

    const sourcePackagePath = path.join(source, 'package.json');
    await requireRegularFile(sourcePackagePath, 'source package metadata');
    const sourcePackage = JSON.parse(await readFile(sourcePackagePath, 'utf8'));
    const runtimePackage = runtimePackageMetadata(sourcePackage);
    const app = path.join(payload, 'app');
    await ensureDirectory(stagingRoot, app);
    await writeRuntimeFile(stagingRoot, path.join(app, 'package.json'), `${canonicalJson(runtimePackage)}\n`);
    for (const relative of REQUIRED_APP_METADATA_FILES) {
      await copyAsRuntimeFile(stagingRoot, joinInside(source, relative, `source metadata ${relative}`), path.join(app, relative));
    }

    await copyRuntimeDirectory({
      source: path.join(source, 'dist'),
      destination: path.join(app, 'dist'),
      stagingRoot,
      payloadRelative: (relative) => `app/dist${relative ? `/${relative}` : ''}`,
      policy: distScopePolicy(),
    });
    for (const relative of REQUIRED_APP_SCRIPTS) {
      await copyAsRuntimeFile(
        stagingRoot,
        joinInside(source, `scripts/${relative}`, `source runtime script ${relative}`),
        path.join(app, 'scripts', relative),
      );
    }
    await copyRuntimeDirectory({
      source: path.join(source, 'adapters'),
      destination: path.join(app, 'adapters'),
      stagingRoot,
      payloadRelative: (relative) => `app/adapters${relative ? `/${relative}` : ''}`,
      policy: exactPayloadScopePolicy('app/adapters'),
    });
    await copyRuntimeDirectory({
      source: path.join(source, 'skills'),
      destination: path.join(app, 'skills'),
      stagingRoot,
      payloadRelative: (relative) => `app/skills${relative ? `/${relative}` : ''}`,
      policy: exactPayloadScopePolicy('app/skills'),
    });

    const sourceLockPath = path.join(source, 'package-lock.json');
    await requireRegularFile(sourceLockPath, 'source package lock');
    const packagePaths = productionPackagePaths(JSON.parse(await readFile(sourceLockPath, 'utf8')));
    await ensureDirectory(stagingRoot, path.join(app, 'node_modules'));
    for (const packageRelative of packagePaths) {
      const sourcePackageRoot = joinInside(source, `node_modules/${packageRelative}`, `source production package ${packageRelative}`);
      const destinationPackageRoot = path.join(app, 'node_modules', ...packageRelative.split('/'));
      await copyRuntimeDirectory({
        source: sourcePackageRoot,
        destination: destinationPackageRoot,
        stagingRoot,
        payloadRelative: (relative) => `app/node_modules/${packageRelative}${relative ? `/${relative}` : ''}`,
        policy: productionModuleScopePolicy(`app/node_modules/${packageRelative}`),
      });
    }

    const entries = await collectPayloadEntries(payload);
    const roster = {
      entries,
      payloadRoot: CLI_RUNTIME_PAYLOAD_ROOT,
      schema: CLI_RUNTIME_ROSTER_SCHEMA,
      treeSha256: treeSha256(entries),
    };
    await writeRuntimeFile(stagingRoot, path.join(stagingRoot, 'runtime-roster.json'), `${canonicalJson(roster)}\n`);
    const verification = await verifyRuntimePayload(stagingRoot);
    await replaceRuntimeRoot(stagingRoot, output);
    return {
      ...verification,
      runtimeRoot: output,
    };
  } finally {
    await rm(stagingContainer, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function verifyRuntimePayload(runtimeRoot) {
  const root = path.resolve(runtimeRoot);
  invariant(path.basename(root) === CLI_RUNTIME_ROOT_NAME, `runtime root must be named ${CLI_RUNTIME_ROOT_NAME}`);
  await requireDirectory(root, 'runtime root');
  const rootEntries = await sortedDirectoryEntries(root, 'runtime root');
  const rootNames = rootEntries.map((entry) => entry.name);
  invariant(
    canonicalJson(rootNames) === canonicalJson([CLI_RUNTIME_PAYLOAD_ROOT, 'runtime-roster.json'].sort(compareUtf8)),
    'runtime root must contain exactly payload and runtime-roster.json',
  );
  const payload = path.join(root, CLI_RUNTIME_PAYLOAD_ROOT);
  const manifestPath = path.join(root, 'runtime-roster.json');
  await requireDirectory(payload, 'runtime payload root');
  const manifestStats = await requireRegularFile(manifestPath, 'runtime roster');
  invariant(modeString(manifestStats.mode) === modeString(REGULAR_FILE_MODE), 'runtime roster must use mode 0644');
  const manifestBytes = await readFile(manifestPath);
  const roster = JSON.parse(manifestBytes.toString('utf8'));
  invariant(
    manifestBytes.equals(Buffer.from(`${canonicalJson(roster)}\n`, 'utf8')),
    'runtime roster must use canonical JSON followed by one newline',
  );
  const expected = validateRoster(roster);
  await verifyRuntimePackageMetadata(payload, expected);
  await verifyMacOSNodeRuntime(payload);
  const actualEntries = await collectPayloadEntries(payload);
  invariant(actualEntries.length === roster.entries.length, 'runtime payload entry count differs from its roster');
  for (let index = 0; index < roster.entries.length; index += 1) {
    invariant(
      canonicalJson(actualEntries[index]) === canonicalJson(roster.entries[index]),
      `runtime payload entry does not match its roster at index ${index}`,
    );
  }
  return {
    entries: roster.entries.length,
    ok: true,
    schema: 'game_dev.cli_runtime_verification.v1',
    treeSha256: roster.treeSha256,
  };
}

export function parseBuildArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') return { help: true };
    invariant(['--node', '--output', '--source'].includes(argument), `unknown runtime build argument: ${argument}`);
    const value = argumentsList[index + 1];
    invariant(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `runtime build argument ${argument} requires a value`);
    const key = argument.slice(2);
    invariant(!Object.hasOwn(options, key), `runtime build argument ${argument} was supplied more than once`);
    options[key] = value;
    index += 1;
  }
  invariant(options.output, 'runtime build requires --output <GameDevelopmentStudioRuntime>');
  return {
    nodeExecutable: options.node,
    outputRoot: options.output,
    sourceRoot: options.source,
  };
}

export function parseVerifyArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') return { help: true };
    invariant(argument === '--runtime', `unknown runtime verify argument: ${argument}`);
    const value = argumentsList[index + 1];
    invariant(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'runtime verify argument --runtime requires a value');
    invariant(!Object.hasOwn(options, 'runtime'), 'runtime verify argument --runtime was supplied more than once');
    options.runtime = value;
    index += 1;
  }
  invariant(options.runtime, 'runtime verify requires --runtime <GameDevelopmentStudioRuntime>');
  return { runtimeRoot: options.runtime };
}
