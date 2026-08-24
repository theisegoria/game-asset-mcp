/**
 * Tests for the session spend ceiling.
 *
 * The decisive property is ORDER: the ceiling must refuse before a request
 * reaches the provider. A guard that refuses after the call has already been
 * billed is not a guard, and nothing downstream could tell the difference.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { estimateCost, FREE_TOOLS, isSpendingTool, spendingToolNames, summarize } from '../src/domain/spend.js';
import { SpendLedger, formatCents } from '../src/storage/spend.js';

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spend-'));
  scratch.push(dir);
  return dir;
}

describe('cost estimation is honest about what it knows', () => {
  it('uses published prices where they exist', () => {
    const estimate = estimateCost('create_3d_asset');
    expect(estimate.cents).toBe(30);
    expect(estimate.confidence).toBe('documented');
  });

  it('marks placeholder prices as estimates rather than passing them off as real', () => {
    expect(estimateCost('generate_sound_effect').confidence).toBe('estimated');
    expect(estimateCost('generate_asset_reference').confidence).toBe('estimated');
  });

  it('multiplies per-unit tools', () => {
    expect(estimateCost('generate_asset_reference', 4).cents).toBe(
      estimateCost('generate_asset_reference', 1).cents * 4,
    );
  });

  it('treats an UNKNOWN tool as spending, not free', () => {
    // Assuming a newly added tool is free is exactly how a guard stops guarding.
    const estimate = estimateCost('some_future_tool');
    expect(estimate.cents).toBeGreaterThan(0);
    expect(isSpendingTool('some_future_tool')).toBe(false);
  });

  it('keeps the free list and the priced list disjoint', () => {
    // Overlap would mean a tool is both billed and advertised as free.
    for (const tool of spendingToolNames()) {
      expect(FREE_TOOLS.has(tool), `${tool} appears in both lists`).toBe(false);
    }
  });
});

describe('the ledger refuses rather than overspending', () => {
  it('accumulates across calls and persists', async () => {
    const dir = await tmpDir();
    const ledger = await SpendLedger.open(dir, 1000);
    await ledger.reserve({ tool: 'create_3d_asset' });
    await ledger.reserve({ tool: 'texture_existing_asset' });
    expect(ledger.spentCents()).toBe(50);

    // A fresh instance must see the same spend, or a restart resets the budget.
    const reopened = await SpendLedger.open(dir, 1000);
    expect(reopened.spentCents()).toBe(50);
  });

  it('refuses the call that would breach the ceiling, and names the shortfall', async () => {
    const dir = await tmpDir();
    const ledger = await SpendLedger.open(dir, 35);
    await ledger.reserve({ tool: 'create_3d_asset' }); // 30 of 35 used

    await expect(ledger.reserve({ tool: 'create_3d_asset' })).rejects.toMatchObject({
      code: 'SPEND_LIMIT_EXCEEDED',
    });
    // The refused call must not be charged.
    expect(ledger.spentCents()).toBe(30);

    try {
      await ledger.reserve({ tool: 'create_3d_asset' });
    } catch (err) {
      expect((err as Error).message).toContain('$0.05');
      expect((err as Error).message).toContain('ASSET_SPEND_LIMIT_CENTS');
    }
  });

  it('allows a call that exactly reaches the ceiling', async () => {
    const dir = await tmpDir();
    const ledger = await SpendLedger.open(dir, 30);
    await expect(ledger.reserve({ tool: 'create_3d_asset' })).resolves.toBeTruthy();
    expect(ledger.spentCents()).toBe(30);
  });

  it('imposes no ceiling when none is configured', async () => {
    const dir = await tmpDir();
    const ledger = await SpendLedger.open(dir);
    for (let i = 0; i < 20; i += 1) await ledger.reserve({ tool: 'create_3d_asset' });
    expect(ledger.spentCents()).toBe(600);
    expect(ledger.summary().remainingCents).toBeUndefined();
  });

  it('releases a reservation whose call never went out', async () => {
    const dir = await tmpDir();
    const ledger = await SpendLedger.open(dir, 100);
    const { entryId } = await ledger.reserve({ tool: 'create_3d_asset' });
    await ledger.release(entryId);
    expect(ledger.spentCents()).toBe(0);
  });

  it('records what the provider actually reported alongside the estimate', async () => {
    const dir = await tmpDir();
    const ledger = await SpendLedger.open(dir, 100);
    const { entryId } = await ledger.reserve({ tool: 'create_3d_asset' });
    await ledger.reconcile(entryId, 22);
    const row = ledger.summary().byTool.find((entry) => entry.tool === 'create_3d_asset');
    expect(row?.estimatedCents).toBe(30);
    expect(row?.reportedCents).toBe(22);
  });

  it('survives a corrupt ledger instead of bricking the server', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'spend-ledger.json'), '{ not json', 'utf8');
    const ledger = await SpendLedger.open(dir, 100);
    // Bookkeeping damage must not make every tool unusable.
    expect(ledger.spentCents()).toBe(0);
  });
});

describe('reporting', () => {
  it('flags when any figure is a placeholder', () => {
    const documented = summarize(
      [{ id: '1', tool: 'create_3d_asset', estimatedCents: 30, confidence: 'documented', basis: 'x', at: 'now' }],
      100,
    );
    expect(documented.containsEstimates).toBe(false);

    const guessed = summarize(
      [{ id: '2', tool: 'generate_sound_effect', estimatedCents: 10, confidence: 'estimated', basis: 'x', at: 'now' }],
      100,
    );
    expect(guessed.containsEstimates).toBe(true);
  });

  it('formats cents as currency', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(1234)).toBe('$12.34');
  });
});
