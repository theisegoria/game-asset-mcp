import { estimateCost, isSpendingTool } from '../domain/spend.js';
import type { ToolResult } from '../tools/context.js';

/**
 * How a paid tool may be authorized over MCP.
 *
 * `off` leaves paid tools registered but refusing, so a model can discover them
 * and explain the situation instead of inventing a workaround.
 */
export type SpendMode = 'off' | 'elicit';

/** Resolves to true only when a human accepted the charge. */
export type ElicitApproval = (message: string) => Promise<boolean>;

export interface SpendGateOptions {
  mode: SpendMode;
  /** The ceiling from ASSET_SPEND_LIMIT_CENTS, absent when unset. */
  limitCents?: number | undefined;
  /**
   * Whether the connected client can ask a human at all. Separate from
   * `elicit` because "your client cannot prompt you" and "you said no" need
   * different remedies, and collapsing them sends the user looking for a
   * prompt that was never going to appear.
   *
   * Evaluated per call: capabilities are only known after initialize.
   */
  canElicit?: (() => boolean) | undefined;
  elicit?: ElicitApproval | undefined;
}

function refusal(tool: string, reason: string, remedy: string[]): ToolResult {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'APPROVAL_REQUIRED',
        message: 'Paid provider work requires explicit human approval and a spend ceiling.',
        tool,
        reason,
        approval: {
          transport: 'mcp',
          remedy,
          estimatedOnly: true,
          note:
            'The ceiling is a refusal guard based on published or pessimistic estimated prices; ' +
            'it is not an invoice.',
        },
      }, null, 2),
    }],
  };
}

/**
 * Units this call will be charged for, matching what the handler itself passes
 * to `ctx.charge`. Only the image tools bill per unit; everything else is one.
 */
export function unitsFor(args: unknown): number {
  if (args && typeof args === 'object' && 'numImages' in args) {
    const requested = (args as { numImages?: unknown }).numImages;
    if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 1) {
      return Math.floor(requested);
    }
  }
  return 1;
}

/**
 * The CLI's authority model is a human typing `--approve-spend
 * --spend-limit-cents N` per invocation. Over MCP there is no command line and
 * the MODEL writes every argument, so the governing rule is:
 *
 *   an argument the model can write can never constitute approval.
 *
 * There is deliberately no `approveSpend` input on any schema. Authority comes
 * only from the launch configuration a human wrote (`ASSET_SPEND_LIMIT_CENTS`
 * in the client's config file, which the model cannot reach) and, per call,
 * from an elicitation the human answers.
 *
 * Every path that is not an explicit human acceptance fails closed.
 */
export class SpendGate {
  constructor(private readonly options: SpendGateOptions) {}

  /** True when paid tools can ever succeed in this configuration. */
  enabled(): boolean {
    return this.options.mode === 'elicit' && this.options.limitCents !== undefined;
  }

  wrap<A>(
    name: string,
    handler: (args: A) => Promise<ToolResult>,
  ): (args: A) => Promise<ToolResult> {
    if (!isSpendingTool(name)) return handler;

    return async (args: A): Promise<ToolResult> => {
      if (this.options.mode === 'off') {
        return refusal(name, 'paid tools are disabled for this server', [
          'Set GAME_DEV_MCP_SPEND=elicit and ASSET_SPEND_LIMIT_CENTS in the MCP server ' +
          'configuration, then restart the server.',
        ]);
      }

      // The CLI treats an absent ceiling as unlimited, because a human still had
      // to type the whole command. Here nobody typed anything, so an absent
      // ceiling means "no authority granted" instead.
      if (this.options.limitCents === undefined) {
        return refusal(name, 'no spend ceiling is configured', [
          'Add ASSET_SPEND_LIMIT_CENTS to the env block of this server in your MCP client ' +
          'configuration, then restart the server.',
        ]);
      }

      if (!this.options.elicit || !(this.options.canElicit?.() ?? true)) {
        return refusal(name, 'this MCP client cannot ask you to approve a charge', [
          'Use a client that supports MCP elicitation, or run the paid operation through the ' +
          'CLI with --approve-spend --spend-limit-cents N.',
        ]);
      }

      const units = unitsFor(args);
      const estimate = estimateCost(name, units);
      const dollars = (estimate.cents / 100).toFixed(2);
      const accepted = await this.options
        .elicit(
          `${name} will spend up to about $${dollars} (${estimate.cents} cents` +
          `${units > 1 ? `, ${units} units` : ''}, ${estimate.confidence}).\n\n` +
          `Basis: ${estimate.basis}\n` +
          `Session ceiling: ${this.options.limitCents} cents.\n\n` +
          'This is a pessimistic pre-charge, not an invoice. Authorize this charge?',
        )
        // A throw, a transport error, or a timeout is not consent.
        .catch(() => false);

      if (!accepted) {
        return refusal(name, 'the charge was not authorized', [
          'Approve the elicitation prompt to run this tool.',
        ]);
      }

      return handler(args);
    };
  }
}
