/**
 * Turning a visual comparison into sentences.
 *
 * Eight floats per attachment is a complete description and an unusable one.
 * A caller -- a person skimming, or a model deciding what to do next -- has to
 * know that a low edge delta beside a large luminance delta suggests shading
 * rather than geometry, and that a changed-pixel ratio near 1.0 with a tiny
 * mean error is a global tint rather than a broken frame. Making every caller
 * re-derive that is how a diff harness ends up being read as "the number went
 * up" and switched off.
 *
 * This is a pure function of the numbers: templates, no model call, no network.
 * It stays deterministic, testable, and available to a caller that has no model
 * at all.
 *
 * It describes STATISTICS. It does not diagnose a cause, and the wording is
 * chosen to keep that line visible -- "consistent with" rather than "because".
 */

import type { VisualComparison } from './visual.js';

type Pair = VisualComparison['pairs'][number];

export type ComparisonVerdict = 'identical' | 'within-tolerance' | 'changed' | 'incomparable';

function percent(ratio: number): string {
  if (ratio === 0) return '0%';
  if (ratio < 0.0001) return '<0.01%';
  return `${(ratio * 100).toFixed(2)}%`;
}

export function verdictFor(pair: Pair): ComparisonVerdict {
  if (!pair.comparable) return 'incomparable';
  const changed = pair.changedPixelRatio ?? 0;
  const maximum = pair.maximumChannelDelta ?? 0;
  if (changed === 0 && maximum === 0) return 'identical';
  if (changed === 0) return 'within-tolerance';
  return 'changed';
}

/**
 * Describe one attachment pair in plain sentences, most significant first.
 */
export function describePair(pair: Pair): string[] {
  if (!pair.comparable) {
    return [`${pair.identity} could not be compared: ${pair.reason ?? 'unknown reason'}.`];
  }

  const lines: string[] = [];
  const changed = pair.changedPixelRatio ?? 0;
  const extent = pair.width !== undefined && pair.height !== undefined
    ? ` (${pair.width}x${pair.height})`
    : '';

  if (changed === 0) {
    lines.push(
      `${pair.identity}${extent}: no pixel differs by more than the threshold.`,
    );
  } else {
    lines.push(
      `${pair.identity}${extent}: ${percent(changed)} of pixels changed, ` +
      `mean absolute error ${(pair.meanAbsoluteError ?? 0).toFixed(4)}.`,
    );
  }

  // The headline finding when present. An object that stopped being drawn is a
  // different class of event from an object that changed colour, and burying it
  // under a pixel ratio is how it gets missed.
  const gone = pair.objectsDisappeared ?? [];
  const arrived = pair.objectsAppeared ?? [];
  if (gone.length > 0) {
    lines.push(
      `${gone.length} object${gone.length === 1 ? '' : 's'} present in the baseline ` +
      `no longer appear${gone.length === 1 ? 's' : ''}: ${gone.join(', ')}.`,
    );
  }
  if (arrived.length > 0) {
    lines.push(
      `${arrived.length} object${arrived.length === 1 ? '' : 's'} appear${arrived.length === 1 ? 's' : ''} ` +
      `only in the candidate: ${arrived.join(', ')}.`,
    );
  }

  const regions = pair.semanticRegions ?? [];
  const dominant = regions[0];
  if (dominant && changed > 0) {
    const totalChanged = regions.reduce(
      (sum, region) => sum + region.changedPixelRatio * region.pixels,
      0,
    );
    const share = totalChanged > 0
      ? (dominant.changedPixelRatio * dominant.pixels) / totalChanged
      : 0;
    if (share >= 0.5) {
      lines.push(
        `Object ${dominant.objectId} accounts for ${percent(share)} of the changed pixels.`,
      );
    }
    const moved = regions.filter((region) => region.pixelsLost > 0 && region.pixelsGained > 0);
    if (moved.length > 0) {
      lines.push(
        `${moved.length} object${moved.length === 1 ? '' : 's'} both lost and gained coverage, ` +
        'which is what a move or a reshape looks like rather than a recolour.',
      );
    }
  }

  // Interpretation of the SHAPE of the numbers, phrased as consistency rather
  // than cause. Silhouettes largely unchanged while brightness shifts is the
  // signature of a shading change; the converse is the signature of geometry
  // moving.
  // SSIM separates "everything shifted slightly" from "something here is
  // structurally different", which a mean error cannot.
  if (pair.meanSSIM !== undefined && changed > 0) {
    const worst = pair.worstSSIMWindow;
    if (pair.meanSSIM > 0.99 && worst && worst.ssim > 0.95) {
      lines.push(
        `Structural similarity is ${pair.meanSSIM.toFixed(4)} and no window falls below ` +
        `${worst.ssim.toFixed(4)}: the difference is spread thinly rather than concentrated in ` +
        'a structurally altered region.',
      );
    } else if (worst) {
      lines.push(
        `Structural similarity is ${pair.meanSSIM.toFixed(4)}, worst at (${worst.x}, ${worst.y}) ` +
        `where it drops to ${worst.ssim.toFixed(4)}.`,
      );
    }
  }

  const edge = pair.meanAbsoluteEdgeDelta ?? 0;
  const luminance = Math.abs(pair.meanLuminanceDelta ?? 0);
  if (changed > 0) {
    if (edge < 0.01 && luminance > 0.01) {
      lines.push(
        `Edges are almost unchanged (${edge.toFixed(4)}) while mean luminance moved ` +
        `${(pair.meanLuminanceDelta ?? 0).toFixed(4)}: consistent with a shading or exposure ` +
        'change rather than geometry moving.',
      );
    } else if (edge >= 0.01) {
      lines.push(
        `Edge delta is ${edge.toFixed(4)}: silhouettes differ, which is consistent with ` +
        'geometry, camera or visibility changing rather than shading alone.',
      );
    }
    if (changed > 0.98 && (pair.meanAbsoluteError ?? 0) < 0.01) {
      lines.push(
        'Nearly every pixel changed by a very small amount, which looks like a global tint ' +
        'or precision shift rather than a localized defect.',
      );
    }
  }

  return lines;
}

export interface ComparisonNarrative {
  verdict: ComparisonVerdict;
  summary: string[];
  evidence: {
    derivedFromStatistics: true;
    artisticDefectsDiagnosed: false;
    causeEstablished: false;
    humanVisualReviewPerformed: false;
  };
}

/** Describe a whole comparison, worst-affected attachment first. */
export function describeComparison(comparison: VisualComparison): ComparisonNarrative {
  const ranked = [...comparison.pairs].sort(
    (left, right) => (right.changedPixelRatio ?? 0) - (left.changedPixelRatio ?? 0),
  );
  const verdicts = ranked.map(verdictFor);
  const verdict: ComparisonVerdict = verdicts.includes('changed')
    ? 'changed'
    : verdicts.includes('incomparable')
      ? 'incomparable'
      : verdicts.includes('within-tolerance')
        ? 'within-tolerance'
        : 'identical';

  const summary = ranked.flatMap(describePair);
  if (summary.length === 0) {
    summary.push('No comparable attachments were found in both runs.');
  }
  return {
    verdict,
    summary,
    evidence: {
      derivedFromStatistics: true,
      artisticDefectsDiagnosed: false,
      causeEstablished: false,
      humanVisualReviewPerformed: false,
    },
  };
}
