import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableJobStore } from '../src/jobs/durable.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'game-dev-durable-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableJobStore', () => {
  it('persists redacted requests and fsynced JSONL events across reopen', async () => {
    const root = await temporaryRoot();
    const store = await DurableJobStore.open(root);
    const created = await store.create('provider.tripo.generate', {
      prompt: 'a brass observatory instrument',
      apiToken: 'must-not-survive',
    });
    await store.markRunning(created.id);
    store.appendEvent(created.id, {
      sequence: 0,
      type: 'started',
      nested: { authorization: 'must-not-survive-either' },
    });

    const reopened = await DurableJobStore.open(root);
    const job = await reopened.get(created.id);
    const events = await reopened.readEvents(created.id);

    expect(job.status).toBe('running');
    expect(job.attempts).toBe(1);
    expect(job.eventCount).toBe(1);
    expect(job.request.apiToken).toBe('[redacted]');
    expect(events).toEqual([
      {
        sequence: 0,
        type: 'started',
        nested: { authorization: '[redacted]' },
      },
    ]);
  });

  it('pages events strictly after a sequence', async () => {
    const store = await DurableJobStore.open(await temporaryRoot());
    const job = await store.create('asset.normalize', {});
    for (let sequence = 0; sequence < 4; sequence += 1) {
      store.appendEvent(job.id, { sequence, type: 'progress' });
    }
    expect(await store.readEvents(job.id, { afterSequence: 1, limit: 1 })).toEqual([
      { sequence: 2, type: 'progress' },
    ]);
  });

  it('writes a durable receipt and refuses to rewrite terminal evidence', async () => {
    const root = await temporaryRoot();
    const store = await DurableJobStore.open(root);
    const created = await store.create('package.build', { source: '/tmp/source.glb' });
    await store.markRunning(created.id);
    const completed = await store.complete(created.id, {
      schema: 'game_dev.receipt.v1',
      ok: true,
      accessToken: 'must-not-survive',
    });

    expect(completed.status).toBe('completed');
    expect(completed.receiptPath).toBeTruthy();
    const receipt = JSON.parse(await readFile(completed.receiptPath!, 'utf8')) as Record<string, unknown>;
    expect(receipt.accessToken).toBe('[redacted]');
    await expect(store.complete(created.id, { ok: false })).rejects.toThrow(/cannot be completed again/);
    await expect(store.markRunning(created.id)).rejects.toThrow(/cannot run again/);
  });

  it('surfaces a corrupt event stream instead of silently dropping evidence', async () => {
    const store = await DurableJobStore.open(await temporaryRoot());
    const job = await store.create('capture.run', {});
    await writeFile(store.eventsPath(job.id), '{not json}\n', 'utf8');
    await expect(store.readEvents(job.id)).rejects.toThrow(/corrupt event stream/);
  });

  it('records retries as new child jobs so the failed parent stays intact', async () => {
    const store = await DurableJobStore.open(await temporaryRoot());
    const parent = await store.create('asset.normalize', { input: 'a.glb' });
    await store.markRunning(parent.id);
    await store.fail(parent.id, { error: 'INTERRUPTED' });
    const child = await store.create(parent.operation, parent.request, { parentJobId: parent.id });

    expect(child.id).not.toBe(parent.id);
    expect(child.parentJobId).toBe(parent.id);
    expect((await store.get(parent.id)).status).toBe('failed');
  });
});
