/**
 * Spend visibility.
 *
 * An agent that cannot see what it has spent will keep spending. This reports
 * the running total, the remaining headroom, and — importantly — whether the
 * figures rest on published prices or on pessimistic placeholders, so nobody
 * mistakes an estimate for a bill.
 */

import type { ToolRegistrar } from '../commands/registry.js';
import { spendingToolNames } from '../domain/spend.js';
import { formatCents } from '../storage/spend.js';
import { guard, ok, type ToolContext } from './context.js';

export function registerSpendTools(server: ToolRegistrar, ctx: ToolContext): void {
  server.registerTool(
    'get_spend_report',
    {
      title: 'Report what this session has spent',
      description:
        'FREE and fully local: no network call, no credits. Reports the estimated provider spend ' +
        'for this workspace, broken down by tool, plus the remaining headroom under ' +
        'ASSET_SPEND_LIMIT_CENTS if one is set. Figures are normalised to US cents because ' +
        'providers bill in different units. Costs marked "estimated" are pessimistic placeholders ' +
        'for providers that do not publish a per-call rate — treat them as a guard, not an invoice.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(ctx.logger, 'get_spend_report', async () => {
      const summary = ctx.spend.summary();
      return ok({
        schema: 'org.gamedebug.spend_report.v1',
        limit: summary.limitCents === undefined ? 'none' : formatCents(summary.limitCents),
        spent: formatCents(summary.spentCents),
        remaining:
          summary.remainingCents === undefined ? 'unlimited' : formatCents(summary.remainingCents),
        callCount: summary.callCount,
        byTool: summary.byTool.map((row) => ({
          tool: row.tool,
          calls: row.calls,
          estimated: formatCents(row.estimatedCents),
          ...(row.reportedCents !== undefined
            ? { providerReported: formatCents(row.reportedCents) }
            : {}),
        })),
        containsEstimates: summary.containsEstimates,
        spendingTools: spendingToolNames(),
        note: summary.containsEstimates
          ? 'Some entries use pessimistic placeholders because the provider does not publish a ' +
            'per-call rate. Actual charges may be lower; they should not be higher.'
          : 'Every entry used a published provider price.',
        ...(summary.limitCents === undefined
          ? {
              warning:
                'No ceiling is set. Set ASSET_SPEND_LIMIT_CENTS to make this harness refuse rather ' +
                'than overspend — a batch loop is where that matters most.',
            }
          : {}),
      });
    }),
  );
}
