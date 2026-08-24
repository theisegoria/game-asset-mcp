/**
 * The spend ledger.
 *
 * The ceiling is checked and the charge is recorded BEFORE the provider call.
 * That ordering is the whole point: reserving afterwards would let a crash, a
 * timeout, or a concurrent call slip past the limit, and the entire reason this
 * exists is that a batch loop is where an unattended mistake becomes expensive.
 *
 * A reservation is therefore pessimistic by design. If the call then fails, the
 * reservation is released explicitly — but if the process dies mid-call, the
 * charge stands, because we cannot know whether the provider billed us.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AssetPipelineError } from '../util/errors.js';
import { estimateCost, summarize, type SpendEntry, type SpendSummary } from '../domain/spend.js';

interface LedgerFile {
  schemaVersion: 1;
  entries: SpendEntry[];
}

const LEDGER_NAME = 'spend-ledger.json';

export class SpendLedger {
  private entries: SpendEntry[] = [];

  private constructor(
    private readonly file: string,
    private readonly limitCents: number | undefined,
  ) {}

  static async open(dir: string, limitCents?: number): Promise<SpendLedger> {
    await fs.mkdir(dir, { recursive: true });
    const ledger = new SpendLedger(path.join(dir, LEDGER_NAME), limitCents);
    await ledger.load();
    return ledger;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as LedgerFile;
      this.entries = parsed.schemaVersion === 1 && Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      // A missing or unreadable ledger starts empty. It must never THROW: a
      // corrupt bookkeeping file should not make the whole server unusable.
      this.entries = [];
    }
  }

  private async persist(): Promise<void> {
    const payload: LedgerFile = { schemaVersion: 1, entries: this.entries };
    const tmp = `${this.file}.tmp-${randomUUID()}`;
    try {
      const handle = await fs.open(tmp, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  get limit(): number | undefined {
    return this.limitCents;
  }

  spentCents(): number {
    return this.entries.reduce((total, entry) => total + entry.estimatedCents, 0);
  }

  summary(): SpendSummary {
    return summarize(this.entries, this.limitCents);
  }

  /**
   * Charge the ceiling for one upcoming call, or refuse.
   *
   * Returns the entry id so the caller can reconcile or release it.
   */
  /**
   * Enforce the ceiling WITHOUT recording an entry.
   *
   * `reserve` both checks and charges, and it can only run once the job exists
   * — which is after the mesh has already been uploaded. So a caller at their
   * ceiling used to upload up to 256 MiB to the provider and only then be
   * refused, while the documentation promised the ceiling was enforced "before
   * contacting the provider". This is the check that makes that true; the
   * charge still happens once, later, at the billable call.
   */
  assertHeadroom(tool: string, units?: number): void {
    if (this.limitCents === undefined) return;
    const estimate = estimateCost(tool, units ?? 1);
    const spent = this.spentCents();
    if (spent + estimate.cents > this.limitCents) {
      throw new AssetPipelineError(
        'SPEND_LIMIT_EXCEEDED',
        `refusing ${tool} before contacting the provider: it would cost about ` +
          `${formatCents(estimate.cents)} and only ` +
          `${formatCents(Math.max(0, this.limitCents - spent))} of the ` +
          `${formatCents(this.limitCents)} session limit remains. ` +
          'Raise ASSET_SPEND_LIMIT_CENTS or start a new workspace.',
        {
          details: {
            tool,
            estimatedCents: estimate.cents,
            spentCents: spent,
            limitCents: this.limitCents,
            confidence: estimate.confidence,
            basis: estimate.basis,
          },
        },
      );
    }
  }

  async reserve(params: {
    tool: string;
    units?: number;
    assetJobId?: string;
  }): Promise<{ entryId: string; estimatedCents: number }> {
    const estimate = estimateCost(params.tool, params.units ?? 1);

    if (this.limitCents !== undefined) {
      const spent = this.spentCents();
      if (spent + estimate.cents > this.limitCents) {
        throw new AssetPipelineError(
          'SPEND_LIMIT_EXCEEDED',
          `refusing ${params.tool}: it would cost about ${formatCents(estimate.cents)} and only ` +
            `${formatCents(Math.max(0, this.limitCents - spent))} of the ` +
            `${formatCents(this.limitCents)} session limit remains. ` +
            'Raise ASSET_SPEND_LIMIT_CENTS or start a new workspace.',
          {
            details: {
              tool: params.tool,
              estimatedCents: estimate.cents,
              spentCents: spent,
              limitCents: this.limitCents,
              confidence: estimate.confidence,
              basis: estimate.basis,
            },
          },
        );
      }
    }

    const entry: SpendEntry = {
      id: randomUUID(),
      tool: params.tool,
      estimatedCents: estimate.cents,
      confidence: estimate.confidence,
      basis: estimate.basis,
      ...(params.assetJobId !== undefined ? { assetJobId: params.assetJobId } : {}),
      at: new Date().toISOString(),
    };
    this.entries.push(entry);
    await this.persist();
    return { entryId: entry.id, estimatedCents: estimate.cents };
  }

  /** Record what the provider actually charged, when it says. */
  async reconcile(entryId: string, reportedCents: number): Promise<void> {
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    entry.reportedCents = Math.max(0, Math.round(reportedCents));
    await this.persist();
  }

  /**
   * Drop a reservation whose call never reached the provider.
   *
   * Only safe when we know no request was sent — a refused validation, for
   * instance. After a network error the charge must STAND, because a failed
   * response does not prove the provider failed to bill.
   */
  async release(entryId: string): Promise<void> {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== entryId);
    if (this.entries.length !== before) await this.persist();
  }
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
