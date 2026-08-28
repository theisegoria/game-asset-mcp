#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_ROSTER_SCHEMA = 'game_dev.cli_runtime_roster.v1';
const PROVENANCE_SCHEMA = 'game_dev.macos_bundled_third_party_provenance.v1';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sameSortedNames(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizedNodeVersion(value, label) {
  invariant(typeof value === 'string', `${label} must be a string`);
  const match = /^v?([0-9]+\.[0-9]+\.[0-9]+)$/.exec(value.trim());
  invariant(match?.[1], `${label} must be an exact semantic version`);
  return match[1];
}

function dylibName(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} must be a non-empty string`);
  invariant(!value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..', `${label} must be a filename`);
  invariant(value.endsWith('.dylib'), `${label} must name a dylib`);
  return value;
}

function declaredDylibNames(provenance) {
  invariant(isPlainObject(provenance), 'third-party provenance must be an object');
  invariant(provenance.schema === PROVENANCE_SCHEMA, 'third-party provenance schema mismatch');
  const bundledRuntime = provenance.bundledRuntime;
  invariant(isPlainObject(bundledRuntime), 'third-party provenance bundledRuntime must be an object');
  invariant(Number.isSafeInteger(bundledRuntime.nonSystemDylibCount) && bundledRuntime.nonSystemDylibCount >= 0,
    'third-party provenance non-system dylib count must be a non-negative integer');
  invariant(Array.isArray(bundledRuntime.nonSystemDylibs), 'third-party provenance non-system dylibs must be an array');

  const names = [];
  for (const [libraryIndex, library] of bundledRuntime.nonSystemDylibs.entries()) {
    invariant(isPlainObject(library), `third-party provenance non-system dylib ${libraryIndex} must be an object`);
    invariant(Array.isArray(library.runtimeFiles) && library.runtimeFiles.length > 0,
      `third-party provenance non-system dylib ${libraryIndex} must declare runtime files`);
    for (const [fileIndex, file] of library.runtimeFiles.entries()) {
      names.push(dylibName(file, `third-party provenance runtime file ${libraryIndex}.${fileIndex}`));
    }
  }
  invariant(names.length === bundledRuntime.nonSystemDylibCount,
    'third-party provenance non-system dylib count does not match its runtime filenames');
  const sorted = names.sort(compareUtf8);
  invariant(new Set(sorted).size === sorted.length, 'third-party provenance contains duplicate runtime dylib filenames');
  return sorted;
}

function rosterDylibNames(runtimeRoster) {
  invariant(isPlainObject(runtimeRoster), 'runtime roster must be an object');
  invariant(runtimeRoster.schema === RUNTIME_ROSTER_SCHEMA, 'runtime roster schema mismatch');
  invariant(runtimeRoster.payloadRoot === 'payload', 'runtime roster must name payload as its payload root');
  invariant(Array.isArray(runtimeRoster.entries), 'runtime roster entries must be an array');

  const names = [];
  for (const [entryIndex, entry] of runtimeRoster.entries.entries()) {
    invariant(isPlainObject(entry), `runtime roster entry ${entryIndex} must be an object`);
    if (typeof entry.path !== 'string' || !entry.path.startsWith('node/lib/')) continue;
    invariant(entry.type === 'file', `runtime roster Node library must be a file: ${entry.path}`);
    const name = entry.path.slice('node/lib/'.length);
    names.push(dylibName(name, `runtime roster Node library ${entryIndex}`));
  }
  const sorted = names.sort(compareUtf8);
  invariant(new Set(sorted).size === sorted.length, 'runtime roster contains duplicate Node library filenames');
  return sorted;
}

/**
 * Binds the validated, staged runtime identity to its checked-in legal provenance.
 * The caller must verify the roster against the on-disk payload before invoking this.
 */
export function validateMacOSRuntimeProvenanceBinding({
  runtimeRoster,
  runtimePackage,
  provenance,
  nodeVersion,
}) {
  invariant(isPlainObject(provenance?.bundledRuntime), 'third-party provenance bundledRuntime must be an object');
  invariant(isPlainObject(provenance.bundledRuntime.node), 'third-party provenance bundled Node metadata must be an object');
  invariant(isPlainObject(provenance.bundledRuntime.gameDevCli), 'third-party provenance bundled game-dev CLI metadata must be an object');
  invariant(isPlainObject(runtimePackage), 'staged runtime package metadata must be an object');

  const expectedNodeVersion = normalizedNodeVersion(
    provenance.bundledRuntime.node.version,
    'third-party provenance bundled Node version',
  );
  const actualNodeVersion = normalizedNodeVersion(nodeVersion, 'staged runtime Node version');
  invariant(actualNodeVersion === expectedNodeVersion,
    'staged Node version does not match third-party provenance');

  invariant(typeof provenance.bundledRuntime.gameDevCli.version === 'string'
    && provenance.bundledRuntime.gameDevCli.version.length > 0,
  'third-party provenance bundled game-dev CLI version must be a non-empty string');
  invariant(runtimePackage.version === provenance.bundledRuntime.gameDevCli.version,
    'staged game-dev CLI package version does not match third-party provenance');

  const expectedDylibs = declaredDylibNames(provenance);
  const actualDylibs = rosterDylibNames(runtimeRoster);
  invariant(sameSortedNames(actualDylibs, expectedDylibs),
    'runtime roster non-system dylib filenames do not exactly match third-party provenance');

  return {
    gameDevCliVersion: runtimePackage.version,
    nodeVersion: actualNodeVersion,
    nonSystemDylibCount: actualDylibs.length,
    ok: true,
    schema: 'game_dev.macos_runtime_third_party_provenance_verification.v1',
  };
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--help') return { help: true };
    invariant(['--node-version', '--provenance', '--runtime'].includes(argument), `unknown argument: ${argument}`);
    const value = argumentsList[index + 1];
    invariant(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `${argument} requires a value`);
    const key = argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    invariant(!Object.hasOwn(options, key), `${argument} was supplied more than once`);
    options[key] = value;
    index += 1;
  }
  invariant(options.runtime, 'missing --runtime <GameDevelopmentStudioRuntime>');
  invariant(options.provenance, 'missing --provenance <THIRD_PARTY_PROVENANCE.json>');
  invariant(options.nodeVersion, 'missing --node-version <vX.Y.Z>');
  return options;
}

function usage() {
  return 'Usage: node scripts/verify-macos-runtime-provenance.mjs --runtime <GameDevelopmentStudioRuntime> --provenance <THIRD_PARTY_PROVENANCE.json> --node-version <vX.Y.Z>';
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const runtimeRoot = path.resolve(options.runtime);
  const [runtimeRoster, runtimePackage, provenance] = await Promise.all([
    readFile(path.join(runtimeRoot, 'runtime-roster.json'), 'utf8').then(JSON.parse),
    readFile(path.join(runtimeRoot, 'payload', 'app', 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.resolve(options.provenance), 'utf8').then(JSON.parse),
  ]);
  console.log(JSON.stringify(validateMacOSRuntimeProvenanceBinding({
    runtimeRoster,
    runtimePackage,
    provenance,
    nodeVersion: options.nodeVersion,
  })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
