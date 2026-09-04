import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateMacOSRuntimeProvenanceBinding } from '../scripts/verify-macos-runtime-provenance.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const distributionRoot = path.join(sourceRoot, 'distribution', 'macos-app-repo');
const licenseRoot = path.join(distributionRoot, 'legal', 'third-party-licenses');

interface LegalAsset {
  path: string;
  sha256: string;
  bytes: number;
  source: string;
  scope: string;
}

interface RuntimeLibrary {
  runtimeFiles: string[];
  sourceFormula: string;
  sourceFormulaVersion: string;
  licenseAssets: string[];
}

interface NpmProductionPackage {
  name: string;
  declaredRange: string;
  lockedVersion: string;
  lockIntegrity: string;
  license: string;
  licenseAssets: string[];
}

interface Provenance {
  schema: string;
  release: {
    appVersion: string;
    bundleIdentifier: string;
    licenseDirectory: string;
  };
  bundledRuntime: {
    gameDevCli: { version: string };
    node: { version: string };
    nonSystemDylibCount: number;
    nonSystemDylibs: RuntimeLibrary[];
  };
  npmProductionPackages: NpmProductionPackage[];
  versionQualification: {
    examples: Array<{ runtimeFile: string; auditedSourceVersion: string }>;
  };
  zstdScopeQualification: {
    shippedObject: string;
    sourceArchiveSbomLicenseConcluded: string;
    sourceArchiveSbomFilesAnalyzed: boolean;
    ancillaryScope: string;
  };
  legalAssets: LegalAsset[];
}

interface LockedPackage {
  version: string;
  integrity?: string;
  license?: string;
  dependencies?: Record<string, string>;
}

interface PackageLock {
  packages: Record<string, LockedPackage>;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

const expectedLicenseAssets = [
  'brotli-1.2.0-MIT.txt',
  'c-ares-1.34.6-MIT.txt',
  'game-development-studio-1.0.2-MIT.txt',
  'icu4c-78.3-ICU.txt',
  'libuv-1.51.0-BSD-2-Clause-tree.h.txt',
  'libuv-1.51.0-ISC-inet.c.txt',
  'libuv-1.51.0-MIT.txt',
  'libuv-1.51.0-extra-MIT-BSD-2-ISC-index.txt',
  'nghttp2-1.68.0-MIT.txt',
  'nghttp3-1.13.1-MIT.txt',
  'ngtcp2-1.18.0-MIT.txt',
  'node-25.2.1-LICENSE.txt',
  'npm-gltf-transform-core-4.4.2-MIT.txt',
  'npm-jpeg-js-0.4.4-BSD-3-Clause.txt',
  'npm-pngjs-7.0.0-MIT.txt',
  'npm-property-graph-4.1.0-MIT.txt',
  'npm-zod-3.25.76-MIT.txt',
  'openssl-3.6.3-Apache-2.0.txt',
  'simdjson-4.2.3-Apache-2.0.txt',
  'simdjson-4.2.3-MIT.txt',
  'sqlite-3.53.4-public-domain.txt',
  'uvwasi-0.0.23-Apache-2.0.txt',
  'zstd-1.5.7-BSD-3-Clause.txt',
  'zstd-1.5.7-GPL-2.0-alternative.txt',
  'zstd-1.5.7-source-archive-ancillary-BSD-2-Clause.txt',
  'zstd-1.5.7-source-archive-ancillary-MIT.txt',
] as const;

const expectedDylibs = [
  'libbrotlicommon.1.2.0.dylib',
  'libbrotlidec.1.2.0.dylib',
  'libbrotlienc.1.2.0.dylib',
  'libcares.2.19.5.dylib',
  'libcrypto.3.dylib',
  'libicudata.78.3.dylib',
  'libicui18n.78.3.dylib',
  'libicuuc.78.3.dylib',
  'libnghttp2.14.dylib',
  'libnghttp3.9.5.1.dylib',
  'libngtcp2.16.dylib',
  'libnode.141.dylib',
  'libsimdjson.29.0.0.dylib',
  'libsqlite3.3.53.4.dylib',
  'libssl.3.dylib',
  'libuv.1.0.0.dylib',
  'libuvwasi.dylib',
  'libzstd.1.5.7.dylib',
] as const;

function runtimeRosterFor(dylibs: readonly string[]) {
  return {
    entries: dylibs.map((name) => ({
      mode: '0644',
      path: `node/lib/${name}`,
      sha256: 'a'.repeat(64),
      size: 1,
      type: 'file',
    })),
    payloadRoot: 'payload',
    schema: 'game_dev.cli_runtime_roster.v1',
    treeSha256: 'b'.repeat(64),
  };
}

function provenanceFor(dylibs: readonly string[]) {
  return {
    bundledRuntime: {
      gameDevCli: { version: '1.0.1' },
      node: { version: '25.2.1' },
      nonSystemDylibCount: dylibs.length,
      nonSystemDylibs: [{ runtimeFiles: [...dylibs] }],
    },
    schema: 'game_dev.macos_bundled_third_party_provenance.v1',
  };
}

describe('macOS bundled-runtime third-party notices', () => {
  it('rejects a staged runtime dylib filename that the legal provenance does not declare', () => {
    const provenance = provenanceFor(expectedDylibs);
    const runtimePackage = { version: '1.0.1' };

    expect(() => validateMacOSRuntimeProvenanceBinding({
      provenance,
      runtimePackage,
      runtimeRoster: runtimeRosterFor(expectedDylibs),
      nodeVersion: 'v25.2.1',
    })).not.toThrow();

    const mismatchedDylibs: string[] = [...expectedDylibs];
    mismatchedDylibs[mismatchedDylibs.length - 1] = 'libunexpected.1.0.0.dylib';
    expect(() => validateMacOSRuntimeProvenanceBinding({
      provenance,
      runtimePackage,
      runtimeRoster: runtimeRosterFor(mismatchedDylibs),
      nodeVersion: 'v25.2.1',
    })).toThrow('runtime roster non-system dylib filenames do not exactly match third-party provenance');
  });

  it('rejects a staged Node version that the legal provenance does not declare', () => {
    expect(() => validateMacOSRuntimeProvenanceBinding({
      provenance: provenanceFor(expectedDylibs),
      runtimePackage: { version: '1.0.1' },
      runtimeRoster: runtimeRosterFor(expectedDylibs),
      nodeVersion: 'v25.2.2',
    })).toThrow('staged Node version does not match third-party provenance');
  });

  it('describes the actual closed runtime rather than the former no-runtime boundary', async () => {
    const notice = await readFile(path.join(distributionRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const provenance = await readJson<Provenance>(
      path.join(distributionRoot, 'THIRD_PARTY_PROVENANCE.json'),
    );

    // Derived, not pinned. A literal here is the same staleness one level up:
    // it went on asserting 1.0.1 after the package shipped 1.0.2.
    expect(notice).toContain(`\`game-dev\` CLI ${provenance.bundledRuntime.gameDevCli.version}`);
    expect(notice).toContain(`Node.js ${provenance.bundledRuntime.node.version}`);
    expect(notice).toContain('18 non-system dynamic libraries');
    expect(notice).not.toContain('No provider SDK, game engine, Blender build, Node.js runtime, or `game-dev` CLI is bundled');
    expect(provenance.schema).toBe('game_dev.macos_bundled_third_party_provenance.v1');
    expect(provenance.release).toMatchObject({
      appVersion: '1.0.0',
      bundleIdentifier: 'com.theisegoria.GameDevelopmentStudio',
      licenseDirectory: 'ThirdPartyLicenses',
    });
    // The bundled CLI version is asserted against package.json in its own test
    // rather than pinned here. A literal in this position is what let the
    // record sit at 1.0.1 through the 1.0.2 release: the test agreed with the
    // stale value, so it confirmed the bug instead of catching it.
    expect(provenance.bundledRuntime.gameDevCli.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(provenance.bundledRuntime.node.version).toBe('25.2.1');
    expect(provenance.bundledRuntime.nonSystemDylibCount).toBe(18);
    expect(provenance.bundledRuntime.nonSystemDylibs.flatMap((item) => item.runtimeFiles).sort())
      .toEqual([...expectedDylibs].sort());
    expect(provenance.versionQualification.examples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtimeFile: 'libuv.1.0.0.dylib',
        auditedSourceVersion: '1.51.0',
      }),
    ]));
  });

  it('binds every checked-in full legal text by its declared byte count and SHA-256', async () => {
    const provenance = await readJson<Provenance>(
      path.join(distributionRoot, 'THIRD_PARTY_PROVENANCE.json'),
    );
    const onDiskPaths = (await readdir(licenseRoot)).sort();

    expect(onDiskPaths).toEqual([...expectedLicenseAssets]);
    expect(provenance.legalAssets.map((asset) => asset.path)).toEqual([...expectedLicenseAssets]);
    for (const asset of provenance.legalAssets) {
      const contents = await readFile(path.join(licenseRoot, asset.path));
      expect(contents.byteLength).toBe(asset.bytes);
      expect(createHash('sha256').update(contents).digest('hex')).toBe(asset.sha256);
      expect(asset.source).not.toHaveLength(0);
      expect(asset.scope).not.toHaveLength(0);
    }
  });

  it('bundles the CLI version the package actually ships', async () => {
    // The 1.0.2 release bumped package.json and left this record pinned at
    // 1.0.1. verify-macos-runtime-provenance asserts the two match, so staging
    // the app died on an unrelated-looking line and the CI macos-app job went
    // red -- for a stale legal record, not a build problem.
    const [provenance, packageJson] = await Promise.all([
      readJson<Provenance>(path.join(distributionRoot, 'THIRD_PARTY_PROVENANCE.json')),
      readJson<{ version: string }>(path.join(sourceRoot, 'package.json')),
    ]);

    expect(provenance.bundledRuntime.gameDevCli.version).toBe(packageJson.version);
  });

  it('names only legal assets that the corpus actually contains', async () => {
    // Nothing cross-checked these two lists, so licenseAssets could name a file
    // that had been renamed out from under it and stay silently wrong.
    const provenance = await readJson<Provenance>(
      path.join(distributionRoot, 'THIRD_PARTY_PROVENANCE.json'),
    );
    const corpus = new Set(provenance.legalAssets.map((asset) => asset.path));

    for (const [component, record] of Object.entries(provenance.bundledRuntime)) {
      const named = (record as { licenseAssets?: string[] }).licenseAssets ?? [];
      for (const asset of named) {
        expect(corpus, `bundledRuntime.${component} names ${asset}`).toContain(asset);
      }
    }
  });

  it('preserves libuv BSD-2 and ISC texts and makes the zstd ancillary evidence ceiling explicit', async () => {
    const [treeHeader, inetHeader, zstdBsd2, zstdMit, provenance] = await Promise.all([
      readFile(path.join(licenseRoot, 'libuv-1.51.0-BSD-2-Clause-tree.h.txt'), 'utf8'),
      readFile(path.join(licenseRoot, 'libuv-1.51.0-ISC-inet.c.txt'), 'utf8'),
      readFile(path.join(licenseRoot, 'zstd-1.5.7-source-archive-ancillary-BSD-2-Clause.txt'), 'utf8'),
      readFile(path.join(licenseRoot, 'zstd-1.5.7-source-archive-ancillary-MIT.txt'), 'utf8'),
      readJson<Provenance>(path.join(distributionRoot, 'THIRD_PARTY_PROVENANCE.json')),
    ]);

    expect(treeHeader).toBe(`/*-
 * Copyright 2002 Niels Provos <provos@citi.umich.edu>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE AUTHOR \`\`AS IS'' AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
 * OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 * IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT,
 * INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 * NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
`);
    expect(inetHeader).toBe(`/*
 * Copyright (c) 1996 by Internet Software Consortium.
 *
 * Permission to use, copy, modify, and distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND INTERNET SOFTWARE CONSORTIUM DISCLAIMS
 * ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES
 * OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL INTERNET SOFTWARE
 * CONSORTIUM BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL
 * DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR
 * PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS
 * ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS
 * SOFTWARE.
 */
`);
    expect(zstdBsd2).toContain('BSD 2-Clause License');
    expect(zstdMit).toContain('MIT License');
    expect(provenance.zstdScopeQualification).toMatchObject({
      shippedObject: 'libzstd.1.5.7.dylib',
      sourceArchiveSbomLicenseConcluded: '(BSD-3-Clause OR GPL-2.0-only) AND BSD-2-Clause AND MIT',
      sourceArchiveSbomFilesAnalyzed: false,
    });
    expect(provenance.zstdScopeQualification.ancillaryScope)
      .toContain('does not establish that either ancillary component is present in the staged libzstd dylib');
  });

  it('matches package-lock production packages instead of the looser package.json ranges', async () => {
    const [provenance, packageLock] = await Promise.all([
      readJson<Provenance>(path.join(distributionRoot, 'THIRD_PARTY_PROVENANCE.json')),
      readJson<PackageLock>(path.join(sourceRoot, 'package-lock.json')),
    ]);
    const rootPackage = packageLock.packages[''];
    const gltfTransform = packageLock.packages['node_modules/@gltf-transform/core'];

    expect(rootPackage).toBeDefined();
    expect(gltfTransform).toBeDefined();
    for (const listed of provenance.npmProductionPackages) {
      const lockEntry = packageLock.packages[`node_modules/${listed.name}`];
      expect(lockEntry).toBeDefined();
      expect(lockEntry?.version).toBe(listed.lockedVersion);
      expect(lockEntry?.integrity).toBe(listed.lockIntegrity);
      expect(lockEntry?.license).toBe(listed.license);
      const declaredRange = rootPackage?.dependencies?.[listed.name]
        ?? gltfTransform?.dependencies?.[listed.name];
      expect(declaredRange).toBe(listed.declaredRange);
    }
    expect(provenance.npmProductionPackages.map((item) => item.name)).toEqual([
      '@gltf-transform/core',
      'property-graph',
      'jpeg-js',
      'pngjs',
      'zod',
    ]);
  });

  it('stages the canonical legal corpus in ordinary native builds before signing', async () => {
    const builder = await readFile(path.join(sourceRoot, 'script', 'build_and_run.sh'), 'utf8');
    const packager = await readFile(path.join(sourceRoot, 'script', 'package_macos_release.sh'), 'utf8');
    const noticeCopy = builder.indexOf('cp "$THIRD_PARTY_NOTICE" "$APP_RESOURCES/THIRD_PARTY_NOTICES.md"');
    const provenanceCopy = builder.indexOf(
      'cp "$THIRD_PARTY_PROVENANCE" "$APP_RESOURCES/THIRD_PARTY_PROVENANCE.json"',
    );
    const licenseCopy = builder.indexOf('cp -R "$THIRD_PARTY_LICENSE_SOURCE"');
    const signing = builder.indexOf('/usr/bin/codesign --force --sign -');

    expect(noticeCopy).toBeGreaterThan(0);
    expect(provenanceCopy).toBeGreaterThan(noticeCopy);
    expect(licenseCopy).toBeGreaterThan(provenanceCopy);
    expect(signing).toBeGreaterThan(licenseCopy);
    expect(builder).toContain('/usr/bin/diff -qr "$THIRD_PARTY_LICENSE_SOURCE"');
    expect(builder).toContain('refusing symlinked macOS third-party license resources');
    expect(builder.indexOf('node "$RUNTIME_PROVENANCE_VERIFIER"')).toBeGreaterThan(0);
    expect(builder.indexOf('node "$RUNTIME_PROVENANCE_VERIFIER"')).toBeLessThan(signing);

    const preSignRuntimePath = packager.indexOf(
      '    "$staged_app/Contents/Resources/$CLI_RUNTIME_NAME" \\',
    );
    const preSignBinding = packager.lastIndexOf(
      'validate_runtime_third_party_provenance',
      preSignRuntimePath,
    );
    const packageSigning = packager.indexOf(
      '/usr/bin/codesign --force --sign - --identifier "$BUNDLE_IDENTIFIER" "$staged_app"',
    );
    expect(preSignRuntimePath).toBeGreaterThan(0);
    expect(preSignBinding).toBeGreaterThan(0);
    expect(preSignBinding).toBeLessThan(packageSigning);
  });
});
