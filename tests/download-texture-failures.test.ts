/**
 * A download that could not read the container must SAY so.
 *
 * `download_asset` catches a failed `io.read()` and reports `textureCount: 0`
 * with nothing else — indistinguishable from "this model has no embedded
 * textures". A Draco/meshopt/KTX2 GLB lands there and providers do return
 * those. The per-texture half of this was fixed one release before the
 * whole-container half, the same one-call-site-over shape as everything else
 * in this repo.
 *
 * The fix that added `textureFailures` here shipped with **no test of any
 * kind** — deleting the line left the entire suite green. This is that test.
 *
 * It runs the real tool over a real localhost HTTP server, so it is also the
 * suite's only end-to-end exercise of the download path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { registerDownloadTools } from '../src/tools/downloads.js';
import { createAssetJob } from '../src/domain/asset-job.js';
import { JobStore } from '../src/storage/jobs.js';
import { connectTools, type ToolClient } from './helpers/tool-harness.js';

let work: string;
let tools: ToolClient;
let server: Server;
let baseUrl: string;
let previousTlsReject: string | undefined;

/** Bytes that pass a GLB magic sniff but that no glTF reader can parse. */
function corruptGlb(): Buffer {
  const header = Buffer.alloc(12);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(64, 8);
  return Buffer.concat([header, Buffer.from('THIS IS NOT A VALID CHUNK TABLE, DELIBERATELY'.padEnd(52, ' '))]);
}

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'download-failures-'));

  // HTTPS, not HTTP. The download layer refuses any non-https URL
  // (`UNSUPPORTED_PROTOCOL`) because provider payloads are untrusted input —
  // a real control, and the test bends to it rather than the other way round.
  // The cert is generated per run into the temp dir and never leaves it.
  const key = path.join(work, 'key.pem');
  const cert = path.join(work, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { stdio: 'ignore' });

  // Scoped to this file only: vitest's default `forks` pool gives each test
  // file its own process, and it is restored in afterEach. Needed because the
  // cert above is self-signed by construction.
  previousTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  server = createServer(
    { key: await fs.readFile(key), cert: await fs.readFile(cert) },
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'model/gltf-binary' });
      res.end(corruptGlb());
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

  tools = await connectTools(registerDownloadTools, work);
});

afterEach(async () => {
  await tools.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsReject;
  await fs.rm(work, { recursive: true, force: true });
});

/** A job already in a terminal state, so no provider is contacted. */
async function readyJob(): Promise<string> {
  const store = await JobStore.open(path.join(work, '.jobs'));
  const job = createAssetJob({
    spec: { name: 'broken-crate', prompt: 'a crate' } as never,
    slug: 'broken-crate',
  });
  job.status = 'ready';
  job.model3d = { modelUrl: `${baseUrl}/model.glb` } as never;
  await store.save(job);
  return job.id;
}

describe('an unreadable container is named, not reported as zero textures', () => {
  it('surfaces textureFailures instead of a bare textureCount: 0', async () => {
    const assetJobId = await readyJob();

    const { isError, payload, text } = await tools.call('download_asset', { assetJobId });

    // The download itself succeeded — the model is on disk. Only the texture
    // extraction failed, and that must not discard the download.
    expect(isError, text).toBe(false);
    expect(payload.textureCount).toBe(0);

    const failures = payload.textureFailures as string[] | undefined;
    expect(failures, 'textureFailures must be present, not merely logged').toBeDefined();
    expect(failures?.length).toBeGreaterThan(0);
    expect(failures?.join(' ')).toMatch(/model|glb|read/i);
  }, 60_000);
});
