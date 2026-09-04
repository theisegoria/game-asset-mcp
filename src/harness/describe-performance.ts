/**
 * Turning performance numbers into sentences a caller can act on.
 *
 * The point of this tool is that a model can debug its own renderer, and a
 * model handed `{median: 12.4, p99: 41.2, standardDeviation: 9.1, hitchCount:
 * 3}` has to already know that a standard deviation three-quarters the size of
 * the median means the hitches dominate, and that acting on the median would
 * be optimising the wrong thing. That is exactly the knowledge the caller does
 * not have.
 *
 * Deterministic templates over the statistics: no model call, no network. The
 * wording never claims causality and never claims significance, because the
 * harness establishes neither.
 */

import type { PerformanceComparison, PerformanceSummary } from './performance.js';

function round(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
}

/** Describe one run's own numbers, worst-behaved metric first. */
export function describeSummary(summary: PerformanceSummary): string[] {
  const lines: string[] = [];
  if (summary.metrics.length === 0) {
    return ['This run reported no measurements, so there is nothing to summarize.'];
  }

  if (summary.warmupFramesExcluded > 0) {
    lines.push(
      `Excluded the first ${summary.warmupFramesExcluded} frames as warmup, ` +
      `dropping ${summary.warmupSamplesExcluded} samples.`,
    );
  }
  if (summary.mixedAggregationMetrics.length > 0) {
    lines.push(
      `${summary.mixedAggregationMetrics.join(', ')} arrived both raw and pre-aggregated. ` +
      'Those are separate series, not one: check the adapter is not reporting the same quantity twice.',
    );
  }

  const ranked = [...summary.metrics]
    .filter((metric) => !metric.preAggregated)
    .sort((left, right) => right.hitchCount - left.hitchCount);

  for (const metric of ranked.slice(0, 5)) {
    const parts = [
      `${metric.metric}: median ${round(metric.median)}${metric.unit}`,
      `p99 ${round(metric.p99)}${metric.unit}`,
      `over ${metric.samples} sample${metric.samples === 1 ? '' : 's'}`,
    ];
    lines.push(`${parts.join(', ')}.`);

    if (metric.hitchCount > 0) {
      lines.push(
        `  ${metric.hitchCount} sample${metric.hitchCount === 1 ? '' : 's'} exceeded twice the ` +
        `median, and the worst 1% average ${round(metric.worst1PercentMean)}${metric.unit}. ` +
        'Spikes like these are what a player feels; the median will not show them.',
      );
    }
    // A spread that dwarfs the middle means the median describes almost
    // nothing, and optimising against it is optimising the wrong number.
    if (metric.median > 0 && metric.medianAbsoluteDeviation > metric.median * 0.25) {
      lines.push(
        `  Spread is wide (median absolute deviation ${round(metric.medianAbsoluteDeviation)}` +
        `${metric.unit} against a median of ${round(metric.median)}${metric.unit}), so this run ` +
        'is not steady enough for the median alone to characterise it.',
      );
    }
    if (metric.samples < 8) {
      lines.push(
        `  Only ${metric.samples} sample${metric.samples === 1 ? '' : 's'}: too few to distinguish ` +
        'a real change from run-to-run variation. Capture more frames before drawing conclusions.',
      );
    }
  }

  if (!summary.hardwarePerformanceEvidenceAdmitted) {
    lines.push(
      'Hardware-performance evidence was not admitted for this run, so treat these as reported ' +
      'numbers rather than measured hardware timings.',
    );
  }
  return lines;
}

/** Describe a comparison, largest regression first. */
export function describeComparison(comparison: PerformanceComparison): string[] {
  if (comparison.metrics.length === 0) {
    return ['The two runs share no comparable metric, so no delta can be reported.'];
  }

  const lines: string[] = [];
  const separable = comparison.metrics.filter((metric) => metric.separability === 'separable');
  const underpowered = comparison.metrics.filter((metric) => metric.separability === 'underpowered');

  if (separable.length === 0) {
    lines.push(
      `No metric moved by more than the observed run-to-run spread (comparing ` +
      `${comparison.statistic}).`,
    );
  }

  for (const metric of [...separable].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
    const direction = metric.delta > 0 ? 'rose' : 'fell';
    const percentPart = metric.percentDelta === null
      ? ''
      : ` (${metric.percentDelta > 0 ? '+' : ''}${metric.percentDelta.toFixed(1)}%)`;
    lines.push(
      `${metric.metric} ${direction} by ${round(Math.abs(metric.delta))}${metric.unit}` +
      `${percentPart}, from ${round(metric.baseline)} to ${round(metric.candidate)}. ` +
      `That is larger than the observed spread across ${metric.baselineSamples} and ` +
      `${metric.candidateSamples} samples.`,
    );
  }

  if (underpowered.length > 0) {
    lines.push(
      `${underpowered.length} metric${underpowered.length === 1 ? '' : 's'} could not be judged: ` +
      `${underpowered.slice(0, 5).map((metric) => metric.metric).join(', ')}. ` +
      'Either too few samples, or values that arrived already aggregated. Capture more frames ' +
      'rather than reading the raw delta.',
    );
  }

  // The two things this output must never be mistaken for.
  lines.push(
    'This is a screen against observed spread, not a significance test, and it attributes no ' +
    'cause. To attribute one, change a single thing and re-capture.',
  );
  return lines;
}
