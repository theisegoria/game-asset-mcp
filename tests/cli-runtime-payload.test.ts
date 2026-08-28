import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const builder = path.join(sourceRoot, 'scripts', 'build-cli-runtime.mjs');
const verifier = path.join(sourceRoot, 'scripts', 'verify-cli-runtime.mjs');
const runtimeRootName = 'GameDevelopmentStudioRuntime';
const roots: string[] = [];

interface RunResult {
  stdout: string;
  stderr: string;
}

interface Fixture {
  node: string;
  source: string;
}

function run(command: string, args: string[], cwd = sourceRoot): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr || stdout}`, { cause: error }));
      else resolve({ stdout, stderr });
    });
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-cli-runtime-'));
  roots.push(root);
  return root;
}

async function writeFixtureFile(root: string, relative: string, contents: string, mode = 0o644): Promise<string> {
  const destination = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents, { flag: 'wx', mode });
  await chmod(destination, mode);
  return destination;
}

async function fixture(): Promise<Fixture> {
  const root = await temporaryRoot();
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFixtureFile(source, 'package.json', `${JSON.stringify({
    name: '@fixture/game-development-studio',
    version: '1.2.3',
    type: 'module',
    main: 'dist/index.js',
    exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    bin: { 'fixture-game-dev': 'dist/cli.js' },
    engines: { node: '>=22.5' },
    license: 'MIT',
    dependencies: { 'runtime-dependency': '1.0.0' },
    devDependencies: { 'development-dependency': '1.0.0' },
    scripts: { test: 'should-not-stage' },
  }, null, 2)}\n`);
  await writeFixtureFile(source, 'package-lock.json', `${JSON.stringify({
    name: '@fixture/game-development-studio',
    version: '1.2.3',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: '@fixture/game-development-studio',
        version: '1.2.3',
        dependencies: { 'runtime-dependency': '1.0.0' },
        devDependencies: { 'development-dependency': '1.0.0' },
      },
      'node_modules/runtime-dependency': {
        version: '1.0.0',
        license: 'MIT',
      },
      'node_modules/development-dependency': {
        version: '1.0.0',
        dev: true,
        license: 'MIT',
      },
    },
  }, null, 2)}\n`);
  for (const relative of ['LICENSE', 'PRIVACY.md', 'SECURITY.md', 'SUPPORT.md', 'TERMS.md']) {
    await writeFixtureFile(source, relative, `${relative} fixture\n`);
  }
  await writeFixtureFile(source, 'dist/cli.js', 'console.log("fixture cli");\n');
  await writeFixtureFile(source, 'dist/index.js', 'export const fixture = true;\n');
  await writeFixtureFile(source, 'dist/index.d.ts', 'export declare const fixture: boolean;\n');
  await writeFixtureFile(source, 'dist/index.js.map', '{"version":3}\n');
  await writeFixtureFile(source, 'scripts/blender_normalize.py', 'print("normalize")\n');
  await writeFixtureFile(source, 'scripts/blender_usd_export.py', 'print("export")\n');
  await writeFixtureFile(source, 'adapters/demo/adapter.json', '{"schema":"demo.adapter.v1"}\n');
  await writeFixtureFile(source, 'skills/manifest.json', '{"schema":"game_dev.skill_bundle.v1","skills":[]}\n');
  await writeFixtureFile(source, 'skills/sample/SKILL.md', '# Sample skill\n');
  await writeFixtureFile(source, 'node_modules/runtime-dependency/package.json', '{"name":"runtime-dependency","version":"1.0.0","main":"index.js"}\n');
  await writeFixtureFile(source, 'node_modules/runtime-dependency/index.js', 'export const runtime = true;\n');
  await writeFixtureFile(source, 'node_modules/runtime-dependency/LICENSE', 'MIT\n');
  await writeFixtureFile(source, 'node_modules/runtime-dependency/src/index.ts', 'export const developmentOnly = true;\n');
  await writeFixtureFile(source, 'node_modules/runtime-dependency/tests/runtime.test.js', 'throw new Error("not runtime");\n');
  await writeFixtureFile(source, 'node_modules/development-dependency/package.json', '{"name":"development-dependency","version":"1.0.0"}\n');
  await writeFixtureFile(source, 'node_modules/development-dependency/index.js', 'throw new Error("not runtime");\n');
  return { node: process.execPath, source };
}

function runtimeAt(root: string): string {
  return path.join(root, runtimeRootName);
}

async function stage(source: Fixture, destination: string): Promise<Record<string, unknown>> {
  const result = await run(process.execPath, [
    builder,
    '--source', source.source,
    '--node', source.node,
    '--output', destination,
  ]);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function verify(destination: string): Promise<Record<string, unknown>> {
  const result = await run(process.execPath, [verifier, '--runtime', destination]);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('closed CLI runtime payload', () => {
  it('stages a deterministic, production-only payload with a canonical exact roster', async () => {
    const source = await fixture();
    const first = runtimeAt(path.join(await temporaryRoot(), 'first'));
    const second = runtimeAt(path.join(await temporaryRoot(), 'second'));

    const firstStage = await stage(source, first);
    const secondStage = await stage(source, second);
    expect(firstStage).toMatchObject({
      ok: true,
      schema: 'game_dev.cli_runtime_stage.v1',
      runtimeRoot: first,
    });
    expect(secondStage).toMatchObject({
      ok: true,
      schema: 'game_dev.cli_runtime_stage.v1',
      runtimeRoot: second,
    });
    await expect(verify(first)).resolves.toMatchObject({
      ok: true,
      schema: 'game_dev.cli_runtime_verification.v1',
    });
    expect(await readFile(path.join(first, 'runtime-roster.json'), 'utf8'))
      .toBe(await readFile(path.join(second, 'runtime-roster.json'), 'utf8'));

    const roster = JSON.parse(await readFile(path.join(first, 'runtime-roster.json'), 'utf8')) as {
      entries: Array<{ mode: string; path: string; sha256: string | null; size: number; type: string }>;
      payloadRoot: string;
      schema: string;
      treeSha256: string;
    };
    expect(roster).toMatchObject({
      schema: 'game_dev.cli_runtime_roster.v1',
      payloadRoot: 'payload',
      treeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(roster.entries.map((entry) => entry.path)).toEqual([...roster.entries.map((entry) => entry.path)].sort());
    expect(roster.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'node/bin/node', type: 'file', mode: '0755' }),
      expect.objectContaining({ path: 'app/dist/cli.js', type: 'file', mode: '0644' }),
      expect.objectContaining({ path: 'app/dist', type: 'directory', size: 0, sha256: null }),
    ]));

    const payload = path.join(first, 'payload', 'app');
    const runtimePackage = JSON.parse(await readFile(path.join(payload, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(runtimePackage).not.toHaveProperty('devDependencies');
    expect(runtimePackage).not.toHaveProperty('scripts');
    expect(JSON.stringify(runtimePackage)).not.toContain('.d.ts');
    await expect(access(path.join(payload, 'dist', 'index.d.ts'))).rejects.toThrow();
    await expect(access(path.join(payload, 'dist', 'index.js.map'))).rejects.toThrow();
    await expect(access(path.join(payload, 'node_modules', 'runtime-dependency', 'src', 'index.ts'))).rejects.toThrow();
    await expect(access(path.join(payload, 'node_modules', 'runtime-dependency', 'tests', 'runtime.test.js'))).rejects.toThrow();
    await expect(access(path.join(payload, 'node_modules', 'development-dependency'))).rejects.toThrow();
  });

  it('refuses changed, added, unsafe, and symlinked payload entries', async () => {
    const source = await fixture();

    const changed = runtimeAt(path.join(await temporaryRoot(), 'changed'));
    await stage(source, changed);
    await writeFile(path.join(changed, 'payload', 'app', 'dist', 'cli.js'), 'console.log("changed");\n');
    await expect(verify(changed)).rejects.toThrow(/does not match its roster/);

    const missing = runtimeAt(path.join(await temporaryRoot(), 'missing'));
    await stage(source, missing);
    await rm(path.join(missing, 'payload', 'app', 'dist', 'cli.js'));
    await expect(verify(missing)).rejects.toThrow(/entry count differs/);

    const added = runtimeAt(path.join(await temporaryRoot(), 'added'));
    await stage(source, added);
    await writeFixtureFile(path.join(added, 'payload'), 'app/dist/added.js', 'console.log("unexpected");\n');
    await expect(verify(added)).rejects.toThrow(/entry count differs/);

    const unsafe = runtimeAt(path.join(await temporaryRoot(), 'unsafe'));
    await stage(source, unsafe);
    await writeFixtureFile(path.join(unsafe, 'payload'), 'app/.env', 'NOT_A_SECRET=fixture\n');
    await expect(verify(unsafe)).rejects.toThrow(/environment files are not allowed/);

    const map = runtimeAt(path.join(await temporaryRoot(), 'map'));
    await stage(source, map);
    await writeFixtureFile(path.join(map, 'payload'), 'app/dist/cli.js.map', '{"version":3}\n');
    await expect(verify(map)).rejects.toThrow(/source maps and TypeScript files are not allowed/);

    const linked = runtimeAt(path.join(await temporaryRoot(), 'linked'));
    await stage(source, linked);
    await symlink('cli.js', path.join(linked, 'payload', 'app', 'dist', 'linked.js'));
    await expect(verify(linked)).rejects.toThrow(/symlink/);
  }, 45_000);
});
