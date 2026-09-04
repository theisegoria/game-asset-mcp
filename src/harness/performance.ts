import * as fs from 'node:fs/promises';
import path from 'node:path';
import { invalidInput, invalidState } from '../util/errors.js';
import { validateCaptureManifest } from './capture.js';
import {
  GAME_DEV_PERFORMANCE_COMPARISON_SCHEMA,
  GAME_DEV_PERFORMANCE_SUMMARY_SCHEMA,
  GAME_DEV_TELEMETRY_SCHEMA,
  telemetryEventSchema,
  type MetricStatistics,
  type TelemetryEvent,
} from './contracts.js';
import { verifyRunBundle } from './run-bundle.js';

const MAX_TELEMETRY_BYTES = 64 * 1024 * 1024;
const MAX_TELEMETRY_LINES = 250_000;
const MAX_PROFILE_BYTES = 32 * 1024 * 1024;
const MAX_PROFILE_MEASUREMENTS = 100_000;

type Aggregation = 'sample' | 'mean' | 'median' | 'p95' | 'p99' | 'min' | 'max';

interface Measurement {
  metric: string;
  unit: string;
  value: number;
  source: 'capture' | 'telemetry' | 'foreign-telemetry' | 'profile';
  /**
   * What this number already is. Telemetry and profile values are raw samples;
   * only a capture manifest can declare otherwise.
   */
  aggregation: Aggregation;
}

export interface PerformanceSummary {
  schema: typeof GAME_DEV_PERFORMANCE_SUMMARY_SCHEMA;
  runId: string;
  runPath: string;
  adapterId: string;
  scenarioId: string;
  metrics: MetricStatistics[];
  sources: Record<Measurement['source'], number>;
  /**
   * Metrics that arrived both raw and pre-aggregated. Usually an adapter
   * emitting the same quantity twice; the caller should know which series they
   * are reading rather than getting a silently merged one.
   */
  mixedAggregationMetrics: string[];
  hardwarePerformanceEvidenceAdmitted: boolean;
  evidenceCeiling: string;
}

export interface PerformanceComparison {
  schema: typeof GAME_DEV_PERFORMANCE_COMPARISON_SCHEMA;
  baselineRunId: string;
  candidateRunId: string;
  statistic: keyof Pick<MetricStatistics, 'min' | 'max' | 'mean' | 'median' | 'p95' | 'p99'>;
  metrics: Array<{
    metric: string;
    unit: string;
    baseline: number;
    candidate: number;
    delta: number;
    percentDelta: number | null;
    /**
     * Sample counts and dispersion, carried through from each summary.
     *
     * Without these a caller cannot tell a delta drawn from six samples from
     * one drawn from six thousand, which makes "is this regression real?"
     * unanswerable from the comparison alone -- and answering it wrongly is
     * how an optimization loop chases noise.
     */
    baselineSamples: number;
    candidateSamples: number;
    baselineStandardDeviation: number;
    candidateStandardDeviation: number;
    aggregation: MetricStatistics['aggregation'];
    /**
     * A rough screen for whether the delta stands out from run-to-run spread.
     *
     * NOT a hypothesis test, and deliberately not reported as one: it is a
     * two-standard-error comparison, it assumes samples are independent when
     * frame times are strongly autocorrelated, and it says nothing about
     * cause. It exists so a caller can tell "moved by more than the noise" from
     * "moved by less than the noise" instead of reading a bare delta and
     * guessing.
     */
    separability: 'separable' | 'within-noise' | 'underpowered';
    standardErrorOfDifference: number | null;
  }>;
  hardwarePerformanceComparisonAdmitted: boolean;
  evidenceCeiling: string;
}

function inferUnit(name: string): string | undefined {
  const lowered = name.toLowerCase();
  if (/(?:^|_)ns$/.test(lowered)) return 'ns';
  if (/(?:^|_)us$/.test(lowered)) return 'us';
  if (/(?:^|_)ms$/.test(lowered)) return 'ms';
  if (/(?:^|_)(?:seconds|secs|sec)$/.test(lowered)) return 's';
  if (/(?:^|_)(?:bytes|byte_count)$/.test(lowered)) return 'bytes';
  if (/(?:^|_)(?:count|frames|draws|dispatches|triangles)$/.test(lowered)) return 'count';
  if (/(?:^|_)(?:percent|percentage|ratio)$/.test(lowered)) return lowered.endsWith('ratio') ? 'ratio' : 'percent';
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function foreignTelemetryMeasurements(value: unknown): Measurement[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const event = value as Record<string, unknown>;
  if (typeof event.name !== 'string' || event.name.length === 0) return [];
  const measurements: Measurement[] = [];
  const directValue = finiteNumber(event.value);
  if (directValue !== undefined && typeof event.unit === 'string' && event.unit.length > 0) {
    measurements.push({ metric: event.name, unit: event.unit, value: directValue, source: 'foreign-telemetry', aggregation: 'sample' });
  }
  for (const [key, raw] of Object.entries(event)) {
    if (['ts', 'timestamp', 'timestamp_us', 'name', 'value', 'unit'].includes(key)) continue;
    const number = finiteNumber(raw);
    const unit = inferUnit(key);
    if (number !== undefined && unit !== undefined) {
      measurements.push({
        metric: `${event.name}.${key}`,
        unit,
        value: number,
        source: 'foreign-telemetry',
      aggregation: 'sample',
      });
    }
  }
  return measurements;
}

async function telemetryMeasurements(filePath: string, expectedRunId: string): Promise<Measurement[]> {
  const bytes = await fs.readFile(filePath);
  if (bytes.length > MAX_TELEMETRY_BYTES) throw invalidInput('telemetry artifact exceeds the byte ceiling', { filePath });
  const lines = bytes.toString('utf8').split('\n');
  if (lines.length > MAX_TELEMETRY_LINES + 1) throw invalidInput('telemetry artifact exceeds the line ceiling', { filePath });
  const measurements: Measurement[] = [];
  let lastSequence = -1;
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw invalidInput('telemetry artifact contains invalid JSONL', { filePath, line: index + 1 });
    }
    const standard = telemetryEventSchema.safeParse(value);
    if (standard.success) {
      const event: TelemetryEvent = standard.data;
      if (event.schema !== GAME_DEV_TELEMETRY_SCHEMA || event.runId !== expectedRunId) {
        throw invalidState('standard telemetry event does not join the run identity', { filePath, line: index + 1 });
      }
      if (event.sequence <= lastSequence) {
        throw invalidState('standard telemetry sequence is not strictly increasing', { filePath, line: index + 1 });
      }
      lastSequence = event.sequence;
      if (event.value !== undefined && event.unit !== undefined) {
        measurements.push({
          metric: `${event.category}.${event.name}`,
          unit: event.unit,
          value: event.value,
          source: 'telemetry',
      aggregation: 'sample',
        });
      }
      continue;
    }
    const foreign = foreignTelemetryMeasurements(value);
    if (foreign.length === 0) {
      throw invalidInput('telemetry line is neither game_dev.telemetry_event.v1 nor a supported foreign event', {
        filePath,
        line: index + 1,
      });
    }
    measurements.push(...foreign);
  }
  return measurements;
}

function flattenProfile(
  value: unknown,
  pathParts: string[],
  output: Measurement[],
  depth = 0,
): void {
  if (output.length >= MAX_PROFILE_MEASUREMENTS || depth > 16) return;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const leaf = pathParts.at(-1) ?? '';
    const unit = inferUnit(leaf);
    if (unit !== undefined) {
      output.push({ metric: `profile.${pathParts.join('.')}`, unit, value, source: 'profile', aggregation: 'sample' });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      flattenProfile(value[index], [...pathParts, String(index)], output, depth + 1);
      if (output.length >= MAX_PROFILE_MEASUREMENTS) break;
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    for (const [key, inner] of entries) {
      flattenProfile(inner, [...pathParts, key], output, depth + 1);
      if (output.length >= MAX_PROFILE_MEASUREMENTS) break;
    }
  }
}

async function profileMeasurements(filePath: string): Promise<Measurement[]> {
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_PROFILE_BYTES) return [];
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return [];
  }
  const measurements: Measurement[] = [];
  flattenProfile(value, [], measurements);
  return measurements;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0] ?? 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

export function statistics(
  metric: string,
  unit: string,
  values: number[],
  aggregation: Aggregation = 'sample',
): MetricStatistics {
  if (values.length === 0) throw invalidInput('cannot summarize an empty metric');
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / sorted.length;
  return {
    metric,
    unit,
    aggregation,
    // A group of reported p99s has a well-defined min, max and median -- of
    // the reported values. They are simply not statistics of the underlying
    // frame distribution, and this flag is what stops a consumer reading them
    // as though they were.
    preAggregated: aggregation !== 'sample',
    samples: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    mean,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    standardDeviation: Math.sqrt(variance),
  };
}

export async function summarizeRunPerformance(runPathInput: string): Promise<PerformanceSummary> {
  const verified = await verifyRunBundle(runPathInput);
  const measurements: Measurement[] = [];
  if (verified.manifest.captureManifest) {
    const capture = await validateCaptureManifest(verified.runPath, verified.manifest.captureManifest, {
      runId: verified.manifest.runId,
      adapterId: verified.manifest.adapterId,
      scenarioId: verified.manifest.scenarioId,
    });
    for (const measurement of capture.manifest.measurements) {
      measurements.push({
        metric: measurement.metric,
        unit: measurement.unit,
        value: measurement.value,
        source: 'capture',
        aggregation: measurement.aggregation,
      });
    }
    for (const relative of capture.manifest.telemetry) {
      measurements.push(...await telemetryMeasurements(path.resolve(verified.runPath, relative), verified.manifest.runId));
    }
    for (const relative of capture.manifest.profiles) {
      measurements.push(...await profileMeasurements(path.resolve(verified.runPath, relative)));
    }
  }

  // Keyed by aggregation as well as metric and unit. Without it, a capture
  // emitting both a p99 and per-frame samples for one metric pooled them into
  // one distribution and reported the median of a mixed bag.
  const grouped = new Map<string, { metric: string; unit: string; aggregation: Aggregation; values: number[] }>();
  const aggregationsByMetric = new Map<string, Set<Aggregation>>();
  const sources: PerformanceSummary['sources'] = {
    capture: 0,
    telemetry: 0,
    'foreign-telemetry': 0,
    profile: 0,
  };
  for (const measurement of measurements) {
    sources[measurement.source] += 1;
    const key = `${measurement.metric}\u0000${measurement.unit}\u0000${measurement.aggregation}`;
    const group = grouped.get(key)
      ?? { metric: measurement.metric, unit: measurement.unit, aggregation: measurement.aggregation, values: [] };
    group.values.push(measurement.value);
    grouped.set(key, group);
    const seen = aggregationsByMetric.get(measurement.metric) ?? new Set<Aggregation>();
    seen.add(measurement.aggregation);
    aggregationsByMetric.set(measurement.metric, seen);
  }
  const metrics = [...grouped.values()]
    .map((group) => statistics(group.metric, group.unit, group.values, group.aggregation))
    .sort((left, right) =>
      left.metric.localeCompare(right.metric)
      || left.unit.localeCompare(right.unit)
      || left.aggregation.localeCompare(right.aggregation));

  // Named rather than merged. A metric arriving both raw and pre-aggregated is
  // usually an adapter emitting the same thing twice, and the caller should
  // know which series they are reading.
  const mixedAggregationMetrics = [...aggregationsByMetric.entries()]
    .filter(([, seen]) => seen.size > 1)
    .map(([metric]) => metric)
    .sort();

  return {
    schema: GAME_DEV_PERFORMANCE_SUMMARY_SCHEMA,
    runId: verified.manifest.runId,
    runPath: verified.runPath,
    adapterId: verified.manifest.adapterId,
    scenarioId: verified.manifest.scenarioId,
    metrics,
    sources,
    mixedAggregationMetrics,
    hardwarePerformanceEvidenceAdmitted: verified.manifest.evidence.hardwarePerformanceEvidenceAdmitted,
    evidenceCeiling:
      'Statistics are deterministic reductions over sealed capture measurements, JSONL telemetry, and timing-shaped numeric profile fields. They prove neither hardware timing authority nor causal attribution unless the run separately admits native performance evidence.',
  };
}

/** Below this, spread is not estimated well enough to say anything. */
const MINIMUM_SAMPLES_FOR_SEPARABILITY = 8;

function separability(
  baseline: MetricStatistics,
  candidate: MetricStatistics,
  delta: number,
): { separability: 'separable' | 'within-noise' | 'underpowered'; standardErrorOfDifference: number | null } {
  // Pre-aggregated values are already a summary of a distribution the harness
  // never saw, so their spread describes the wrong thing.
  if (baseline.preAggregated || candidate.preAggregated) {
    return { separability: 'underpowered', standardErrorOfDifference: null };
  }
  if (
    baseline.samples < MINIMUM_SAMPLES_FOR_SEPARABILITY
    || candidate.samples < MINIMUM_SAMPLES_FOR_SEPARABILITY
  ) {
    return { separability: 'underpowered', standardErrorOfDifference: null };
  }

  const standardError = Math.sqrt(
    (baseline.standardDeviation ** 2) / baseline.samples
    + (candidate.standardDeviation ** 2) / candidate.samples,
  );
  if (!Number.isFinite(standardError)) {
    return { separability: 'underpowered', standardErrorOfDifference: null };
  }
  // Zero spread on both sides: any nonzero delta is real, any zero delta is no
  // change. Dividing would be a NaN presented as a verdict.
  if (standardError === 0) {
    return {
      separability: delta === 0 ? 'within-noise' : 'separable',
      standardErrorOfDifference: 0,
    };
  }
  return {
    separability: Math.abs(delta) > 2 * standardError ? 'separable' : 'within-noise',
    standardErrorOfDifference: standardError,
  };
}

export async function compareRunPerformance(
  baselineRunPath: string,
  candidateRunPath: string,
  statistic: PerformanceComparison['statistic'] = 'median',
): Promise<PerformanceComparison> {
  const [baseline, candidate] = await Promise.all([
    summarizeRunPerformance(baselineRunPath),
    summarizeRunPerformance(candidateRunPath),
  ]);
  if (baseline.adapterId !== candidate.adapterId || baseline.scenarioId !== candidate.scenarioId) {
    throw invalidInput('performance comparison requires runs from the same adapter scenario', {
      baseline: `${baseline.adapterId}/${baseline.scenarioId}`,
      candidate: `${candidate.adapterId}/${candidate.scenarioId}`,
    });
  }
  // Keyed by aggregation too: comparing a baseline p99 against a candidate raw
  // sample series would be arithmetic between two different quantities.
  const candidateByKey = new Map(candidate.metrics.map(
    (metric) => [`${metric.metric}\u0000${metric.unit}\u0000${metric.aggregation}`, metric],
  ));
  const metrics: PerformanceComparison['metrics'] = [];
  for (const baselineMetric of baseline.metrics) {
    const candidateMetric = candidateByKey.get(
      `${baselineMetric.metric}\u0000${baselineMetric.unit}\u0000${baselineMetric.aggregation}`,
    );
    if (!candidateMetric) continue;
    const baselineValue = baselineMetric[statistic];
    const candidateValue = candidateMetric[statistic];
    const delta = candidateValue - baselineValue;
    metrics.push({
      metric: baselineMetric.metric,
      unit: baselineMetric.unit,
      baseline: baselineValue,
      candidate: candidateValue,
      delta,
      percentDelta: baselineValue === 0 ? null : (delta / Math.abs(baselineValue)) * 100,
      baselineSamples: baselineMetric.samples,
      candidateSamples: candidateMetric.samples,
      baselineStandardDeviation: baselineMetric.standardDeviation,
      candidateStandardDeviation: candidateMetric.standardDeviation,
      aggregation: baselineMetric.aggregation,
      ...separability(baselineMetric, candidateMetric, delta),
    });
  }
  return {
    schema: GAME_DEV_PERFORMANCE_COMPARISON_SCHEMA,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    statistic,
    metrics,
    hardwarePerformanceComparisonAdmitted:
      baseline.hardwarePerformanceEvidenceAdmitted && candidate.hardwarePerformanceEvidenceAdmitted,
    evidenceCeiling:
      'The comparison reports arithmetic deltas only. Sample counts and standard deviations are ' +
      'carried through, and `separability` screens each delta against two standard errors of the ' +
      'difference. That screen is NOT a hypothesis test: it reports no p-value, it treats samples ' +
      'as independent when frame times are strongly autocorrelated, and it says nothing about ' +
      'cause. Treat `separable` as "larger than the observed spread", not as "statistically ' +
      'significant". Pre-aggregated series and series with too few samples report `underpowered` ' +
      'rather than a verdict the data cannot support. ' +
      'Direction, target, regression status, causal explanation, and optimization success require ' +
      'an explicit bounded goal; hardware claims require both runs to admit hardware-performance ' +
      'evidence.',
  };
}
