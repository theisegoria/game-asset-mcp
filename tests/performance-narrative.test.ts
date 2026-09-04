/**
 * The point of this tool is that a model can debug its own renderer. A model
 * handed `{median: 12.4, p99: 41.2, standardDeviation: 9.1, hitchCount: 3}` has
 * to already know that a spread three quarters the size of the median means the
 * hitches dominate, and that optimising against the median would be optimising
 * the wrong number. That is precisely the knowledge the caller does not have,
 * so the numbers alone do not enable anything.
 */

import { describe, expect, it } from 'vitest';
import { statistics } from '../src/harness/performance.js';
import { describeSummary, describeComparison } from '../src/harness/describe-performance.js';
import type { PerformanceComparison, PerformanceSummary } from '../src/harness/performance.js';

function summary(metrics: PerformanceSummary['metrics'], overrides: Partial<PerformanceSummary> = {}): PerformanceSummary {
  return {
    schema: 'game_dev.performance_summary.v1',
    summary: [],
    runId: 'run_1',
    runPath: '/runs/run_1',
    adapterId: 'a',
    scenarioId: 's',
    metrics,
    sources: { capture: 0, telemetry: metrics.length, 'foreign-telemetry': 0, profile: 0 },
    mixedAggregationMetrics: [],
    warmupFramesExcluded: 0,
    warmupSamplesExcluded: 0,
    hardwarePerformanceEvidenceAdmitted: true,
    evidenceCeiling: '',
    ...overrides,
  } as PerformanceSummary;
}

describe('robust statistics an engine developer actually reads', () => {
  it('counts hitches instead of letting the median hide them', () => {
    // Nine steady frames and one stall. The median says everything is fine.
    const stats = statistics('render.frame_time', 'ms', [16, 16, 16, 16, 16, 16, 16, 16, 16, 400]);

    expect(stats.median).toBe(16);
    expect(stats.hitchCount).toBe(1);
    // The 1% low is what a player feels; p99 approximates it badly at low n.
    expect(stats.worst1PercentMean).toBe(400);
  });

  it('uses a robust spread that the stall does not dominate', () => {
    const stats = statistics('render.frame_time', 'ms', [16, 16, 16, 16, 16, 16, 16, 16, 16, 400]);

    // A standard deviation here describes neither the steady frames nor the
    // stall; the median absolute deviation describes the steady frames.
    expect(stats.medianAbsoluteDeviation).toBe(0);
    expect(stats.standardDeviation).toBeGreaterThan(100);
  });

  it('reports the worst sample rather than zero for a very short run', () => {
    expect(statistics('m', 'ms', [10, 30]).worst1PercentMean).toBe(30);
  });
});

describe('what the performance narrator says', () => {
  it('warns that spikes exist and that the median will not show them', () => {
    const lines = describeSummary(summary([
      statistics('render.frame_time', 'ms', [16, 16, 16, 16, 16, 16, 16, 16, 16, 400]),
    ]));

    expect(lines.join(' ')).toContain('exceeded twice the median');
    expect(lines.join(' ')).toContain('the median will not show them');
  });

  it('tells a caller with too few samples to capture more, not to conclude', () => {
    const lines = describeSummary(summary([statistics('render.frame_time', 'ms', [16, 18])]));

    expect(lines.join(' ')).toContain('too few to distinguish');
    expect(lines.join(' ')).toContain('Capture more frames');
  });

  it('says when warmup was excluded, so the numbers are interpretable', () => {
    const lines = describeSummary(summary(
      [statistics('render.frame_time', 'ms', [16, 16, 16])],
      { warmupFramesExcluded: 30, warmupSamplesExcluded: 30 },
    ));

    expect(lines[0]).toContain('first 30 frames as warmup');
  });

  it('flags a metric arriving both raw and pre-aggregated', () => {
    const lines = describeSummary(summary(
      [statistics('render.frame_time', 'ms', [16])],
      { mixedAggregationMetrics: ['render.frame_time'] },
    ));

    expect(lines.join(' ')).toContain('separate series, not one');
  });

  it('refuses to imply significance or cause in a comparison', () => {
    const comparison = {
      schema: 'game_dev.performance_comparison.v1',
      summary: [],
      baselineRunId: 'a', candidateRunId: 'b', statistic: 'median',
      metrics: [{
        metric: 'render.frame_time', unit: 'ms', baseline: 12, candidate: 18,
        delta: 6, percentDelta: 50, baselineSamples: 100, candidateSamples: 100,
        baselineStandardDeviation: 1, candidateStandardDeviation: 1,
        aggregation: 'sample' as const, separability: 'separable' as const,
        standardErrorOfDifference: 0.14,
      }],
      hardwarePerformanceComparisonAdmitted: true,
      evidenceCeiling: '',
    } as unknown as PerformanceComparison;

    const lines = describeComparison(comparison).join(' ');

    expect(lines).toContain('render.frame_time rose by 6.00ms');
    expect(lines).toContain('not a significance test');
    expect(lines).toContain('attributes no cause');
    expect(lines).not.toMatch(/\bbecause\b|\bcaused by\b/);
  });

  it('says plainly when nothing moved beyond the noise', () => {
    const comparison = {
      schema: 'game_dev.performance_comparison.v1',
      summary: [],
      baselineRunId: 'a', candidateRunId: 'b', statistic: 'median',
      metrics: [{
        metric: 'render.frame_time', unit: 'ms', baseline: 12, candidate: 12.1,
        delta: 0.1, percentDelta: 0.8, baselineSamples: 100, candidateSamples: 100,
        baselineStandardDeviation: 3, candidateStandardDeviation: 3,
        aggregation: 'sample' as const, separability: 'within-noise' as const,
        standardErrorOfDifference: 0.42,
      }],
      hardwarePerformanceComparisonAdmitted: true,
      evidenceCeiling: '',
    } as unknown as PerformanceComparison;

    expect(describeComparison(comparison)[0]).toContain('No metric moved by more than');
  });
});
