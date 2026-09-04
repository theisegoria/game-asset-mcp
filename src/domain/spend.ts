/**
 * Cost estimation and the spend ledger's vocabulary.
 *
 * Two providers, two billing units: Tripo sells credits at $0.01 each, Leonardo
 * bills in USD "API Credit" and does not publish a per-call rate. Adding those
 * numbers together would produce a ceiling that means nothing, so everything
 * here is normalised to **US cents**.
 *
 * Where a provider documents a price we use it and say so. Where it does not,
 * we use a deliberately PESSIMISTIC figure and label it — a guard that
 * under-estimates an unknown cost is not a guard, and a caller deserves to know
 * which numbers are real.
 */

export type CostConfidence = 'documented' | 'estimated';

export interface CostEstimate {
  /** Pessimistic cost in US cents. */
  cents: number;
  confidence: CostConfidence;
  /** Human-readable basis, surfaced in the spend report. */
  basis: string;
}

/**
 * Per-call estimates keyed by tool name.
 *
 * Tripo figures are from its published API price list (1 credit = $0.01).
 * Leonardo does not publish per-generation rates, so those are pessimistic
 * placeholders flagged as estimates rather than quietly assumed to be cheap.
 */
const TOOL_COSTS: Record<string, CostEstimate> = {
  create_3d_asset: {
    cents: 30,
    confidence: 'documented',
    basis: 'Tripo image-to-3D with texture, 30 credits at $0.01',
  },
  texture_existing_asset: {
    cents: 20,
    confidence: 'documented',
    basis: 'Tripo HD texture, 20 credits at $0.01',
  },
  retopologize_asset: {
    cents: 30,
    confidence: 'documented',
    basis: 'Tripo smart retopology v2, 30 credits at $0.01',
  },
  rig_asset: {
    cents: 25,
    confidence: 'documented',
    basis: 'Tripo auto-rig, 25 credits at $0.01',
  },
  animate_asset: {
    cents: 10,
    confidence: 'documented',
    basis: 'Tripo animation retarget, 10 credits per animation at $0.01',
  },
  generate_asset_reference: {
    cents: 10,
    confidence: 'estimated',
    basis: 'Leonardo does not publish a per-image rate; pessimistic placeholder per image',
  },
  generate_reference_variations: {
    cents: 10,
    confidence: 'estimated',
    basis: 'Leonardo does not publish a per-image rate; pessimistic placeholder per image',
  },
  create_game_prop: {
    cents: 10,
    confidence: 'estimated',
    basis: 'Leonardo image generation; same placeholder as generate_asset_reference',
  },
  generate_sound_effect: {
    cents: 10,
    confidence: 'estimated',
    basis: 'Leonardo does not publish a per-clip rate; pessimistic placeholder per clip',
  },
};

/** Tools that can never cost money. Used to keep the two lists from drifting. */
export const FREE_TOOLS: ReadonlySet<string> = new Set([
  'preview_asset_prompt',
  'select_reference',
  'get_asset_job',
  'list_asset_jobs',
  'download_asset',
  'inspect_asset',
  'extract_pbr_trio',
  'normalize_mesh',
  'validate_game_asset',
  'get_spend_report',
  'batch_prepare_meshes',
  // Harness analysis: local arithmetic over sealed evidence. Free in the sense
  // this set means -- no provider is contacted -- even though
  // compare_capture_visuals writes heatmaps.
  'verify_capture_run',
  'analyze_capture_run',
  'compare_capture_visuals',
  'summarize_run_performance',
  'compare_run_performance',
  // Scenario execution runs the project's own binary. It contacts no provider,
  // so it is free in the only sense this set measures -- its risk is governed
  // by the separate execution authority, not by the spend ceiling.
  'plan_scenario_run',
  'run_scenario',
]);

export function isSpendingTool(tool: string): boolean {
  return Object.hasOwn(TOOL_COSTS, tool);
}

export function spendingToolNames(): string[] {
  return Object.keys(TOOL_COSTS).sort();
}

/**
 * Estimate one call. `units` multiplies for tools billed per image or per clip.
 *
 * An unknown tool is treated as spending, not free: assuming a new tool is free
 * is exactly how a guard silently stops guarding.
 */
export function estimateCost(tool: string, units = 1): CostEstimate {
  const multiplier = Number.isFinite(units) && units > 0 ? Math.ceil(units) : 1;
  const base = TOOL_COSTS[tool];
  if (!base) {
    return {
      cents: 50 * multiplier,
      confidence: 'estimated',
      basis: `unknown tool "${tool}" treated as spending at a pessimistic default`,
    };
  }
  return {
    cents: base.cents * multiplier,
    confidence: base.confidence,
    basis: multiplier > 1 ? `${base.basis} x${multiplier}` : base.basis,
  };
}

export interface SpendEntry {
  id: string;
  tool: string;
  /** What we charged against the ceiling before the call. */
  estimatedCents: number;
  confidence: CostConfidence;
  basis: string;
  /** What the provider actually reported, when it reports anything. */
  reportedCents?: number;
  assetJobId?: string;
  at: string;
}

export interface SpendSummary {
  limitCents?: number;
  spentCents: number;
  remainingCents?: number;
  callCount: number;
  /** True when any entry's cost was a placeholder rather than a published rate. */
  containsEstimates: boolean;
  byTool: { tool: string; calls: number; estimatedCents: number; reportedCents?: number }[];
}

export function summarize(entries: readonly SpendEntry[], limitCents?: number): SpendSummary {
  const byTool = new Map<string, { calls: number; estimatedCents: number; reportedCents: number; sawReported: boolean }>();
  let spent = 0;
  let containsEstimates = false;

  for (const entry of entries) {
    spent += entry.estimatedCents;
    if (entry.confidence === 'estimated') containsEstimates = true;
    const bucket = byTool.get(entry.tool) ?? {
      calls: 0,
      estimatedCents: 0,
      reportedCents: 0,
      sawReported: false,
    };
    bucket.calls += 1;
    bucket.estimatedCents += entry.estimatedCents;
    if (entry.reportedCents !== undefined) {
      bucket.reportedCents += entry.reportedCents;
      bucket.sawReported = true;
    }
    byTool.set(entry.tool, bucket);
  }

  return {
    ...(limitCents !== undefined ? { limitCents } : {}),
    spentCents: spent,
    ...(limitCents !== undefined ? { remainingCents: Math.max(0, limitCents - spent) } : {}),
    callCount: entries.length,
    containsEstimates,
    byTool: [...byTool.entries()]
      .map(([tool, bucket]) => ({
        tool,
        calls: bucket.calls,
        estimatedCents: bucket.estimatedCents,
        ...(bucket.sawReported ? { reportedCents: bucket.reportedCents } : {}),
      }))
      .sort((a, b) => b.estimatedCents - a.estimatedCents),
  };
}
