/**
 * `generate_sound_effect`, driven end to end without a credential.
 *
 * The provider layer was thoroughly tested — request contract, credit safety,
 * undocumented response shapes, URL recognition, retrieval discovery — and the
 * TOOL was tested by nothing at all. Every assertion stopped at the boundary
 * where this project has repeatedly lost values on the way out.
 *
 * So this stubs the provider and keeps everything else real: the spend ledger,
 * the job store, the bounded poll, the HTTPS download, the atomic write, the
 * workspace layout, the provenance file, and the JSON a client receives.
 *
 * It is NOT a substitute for one live call. Leonardo documents the sound-effect
 * REQUEST contract but not its response shape, so the parsing in
 * `src/providers/audio/leonardo.ts` remains unverified against the real API and
 * is marked as such in the README. What this proves is that everything AROUND
 * that parsing is wired up and works.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { registerAudioTools } from '../src/tools/audio.js';
import type { AudioProvider } from '../src/providers/audio/types.js';
import { connectTools, type ToolClient } from './helpers/tool-harness.js';

let work: string;
let server: Server;
let baseUrl: string;
let previousTlsReject: string | undefined;
const open: ToolClient[] = [];

/** Sixteen bytes that are recognisably not a PNG — the clip payload. */
const CLIP_BYTES = Buffer.from('RIFF....WAVEfmt ');

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-e2e-'));

  // HTTPS because the download layer refuses any non-https URL outright
  // (UNSUPPORTED_PROTOCOL) — a real control, and the test bends to it.
  const key = path.join(work, 'key.pem');
  const cert = path.join(work, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'ignore' },
  );
  previousTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  server = createServer(
    { key: await fs.readFile(key), cert: await fs.readFile(cert) },
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(CLIP_BYTES);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsReject;
  await fs.rm(work, { recursive: true, force: true });
});

interface StubCalls {
  generate: number;
  poll: number;
}

/** A provider that behaves like the documented contract, with no network. */
function stubProvider(
  calls: StubCalls,
  behaviour: { clips?: number; pendingPolls?: number; error?: string } = {},
): AudioProvider {
  const pendingPolls = behaviour.pendingPolls ?? 0;
  return {
    name: 'stub-audio',
    defaultModel: 'stub-sfx-v2',
    async generateSoundEffect() {
      calls.generate += 1;
      return { providerGenerationId: 'gen_stub_1', rawStatus: 'PENDING' };
    },
    async getGeneration(providerGenerationId) {
      calls.poll += 1;
      const base = { providerGenerationId, raw: { stub: true } };
      if (behaviour.error !== undefined) {
        return { ...base, rawStatus: 'FAILED', audio: [], errorMessage: behaviour.error };
      }
      if (calls.poll <= pendingPolls) return { ...base, rawStatus: 'PENDING', audio: [] };
      return {
        ...base,
        rawStatus: 'COMPLETE',
        audio: Array.from({ length: behaviour.clips ?? 1 }, (_unused, i) => ({
          url: `${baseUrl}/clip_${i + 1}.wav`,
        })),
      };
    },
  };
}

async function client(provider: AudioProvider): Promise<ToolClient> {
  const c = await connectTools(registerAudioTools, work, { audioProvider: () => provider });
  open.push(c);
  return c;
}

describe('generate_sound_effect works end to end', () => {
  it('writes real audio files and reports where they landed', async () => {
    const calls: StubCalls = { generate: 0, poll: 0 };
    const tools = await client(stubProvider(calls, { clips: 2 }));

    const { isError, payload, text } = await tools.call('generate_sound_effect', {
      name: 'shotgun-rack',
      prompt: 'a pump shotgun racking, close, dry',
      durationSeconds: 2,
      quantity: 2,
    });

    expect(isError, text).toBe(false);
    expect(calls.generate).toBe(1);

    const clips = payload.clips as Array<Record<string, unknown>>;
    expect(clips).toHaveLength(2);

    // BYTES on disk, not a path in a response. Every clip must exist, carry the
    // payload the server sent, and report its size honestly.
    for (const clip of clips) {
      const bytes = await fs.readFile(String(clip.path));
      expect(bytes.equals(CLIP_BYTES)).toBe(true);
      expect(clip.bytes).toBe(CLIP_BYTES.byteLength);
    }
  }, 60_000);

  it('records provenance beside the clips', async () => {
    const calls: StubCalls = { generate: 0, poll: 0 };
    const tools = await client(stubProvider(calls));

    const { payload } = await tools.call('generate_sound_effect', {
      name: 'door-close',
      prompt: 'a heavy steel door closing',
    });

    // asset.json is the provenance document. A clip nobody can trace back to a
    // prompt and a model is the thing this server exists to prevent.
    const asset = JSON.parse(
      await fs.readFile(path.join(String(payload.workspacePath), 'asset.json'), 'utf8'),
    ) as Record<string, unknown>;
    const audio = asset.audio as Record<string, unknown>;

    expect(audio.prompt).toBe('a heavy steel door closing');
    expect(audio.provider).toBe('stub-audio');
    expect(audio.model).toBe('stub-sfx-v2');
    expect(audio.providerGenerationId).toBe('gen_stub_1');
    expect((asset.files as unknown[]).length).toBe(1);
  }, 60_000);

  it('polls until the clips appear rather than giving up on the first PENDING', async () => {
    const calls: StubCalls = { generate: 0, poll: 0 };
    const tools = await client(stubProvider(calls, { pendingPolls: 1 }));

    const { isError, payload } = await tools.call('generate_sound_effect', {
      name: 'ui-blip',
      prompt: 'a short UI confirmation blip',
      waitSeconds: 30,
    });

    expect(isError).toBe(false);
    expect(calls.poll).toBeGreaterThan(1);
    expect((payload.clips as unknown[]).length).toBe(1);
  }, 60_000);

  it('reports a provider failure as a failed job, not a thrown call', async () => {
    const calls: StubCalls = { generate: 0, poll: 0 };
    const tools = await client(stubProvider(calls, { error: 'content policy refused the prompt' }));

    const { isError, payload } = await tools.call('generate_sound_effect', {
      name: 'bad',
      prompt: 'something the provider will not do',
      waitSeconds: 30,
    });

    // The call SUCCEEDS and the job carries the failure — a spent credit with a
    // traceable record beats an exception with none.
    expect(isError).toBe(false);
    expect(payload.status).toBe('failed');
    expect(JSON.stringify(payload)).toMatch(/content policy/);
  }, 60_000);

  it('charges the spend ceiling before contacting the provider', async () => {
    // The ceiling is worthless if it is checked after the money is spent.
    const calls: StubCalls = { generate: 0, poll: 0 };
    const provider = stubProvider(calls);
    const tools = await connectTools(registerAudioTools, work, {
      audioProvider: () => provider,
      charge: async () => {
        throw new Error('SPEND_CEILING_REACHED');
      },
    });
    open.push(tools);

    const { isError } = await tools.call('generate_sound_effect', {
      name: 'nope',
      prompt: 'a sound that must never be paid for',
    });

    expect(isError).toBe(true);
    expect(calls.generate, 'the provider was contacted despite a refused charge').toBe(0);
  }, 60_000);
});
