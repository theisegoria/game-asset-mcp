/**
 * `aggregation` was declared in the capture contract and read nowhere.
 *
 * A capture emitting both a pre-aggregated p99 and per-frame samples for one
 * metric had them pooled into a single distribution, so the reported "median"
 * was the median of a mixed bag. Silently wrong, and inherited by every goal
 * evaluated against that summary -- the kind of defect that makes an
 * optimisation loop chase a number that does not mean what it says.
 */

import { describe, expect, it } from 'vitest';
import { statistics } from '../src/harness/performance.js';

describe('statistics carry what their values already were', () => {
  it('marks a raw sample series as not pre-aggregated', () => {
    const stats = statistics('render.frame_time', 'ms', [10, 12, 14], 'sample');

    expect(stats.aggregation).toBe('sample');
    expect(stats.preAggregated).toBe(false);
    expect(stats.median).toBe(12);
  });

  it('marks a reported p99 series as pre-aggregated', () => {
    // The numbers are still summarised -- min, max and median OF THE REPORTED
    // VALUES are well defined. They are simply not statistics of the frame
    // distribution, and this flag is what stops a consumer reading them as if
    // they were.
    const stats = statistics('render.frame_time', 'ms', [30, 33, 36], 'p99');

    expect(stats.aggregation).toBe('p99');
    expect(stats.preAggregated).toBe(true);
  });

  it('defaults to sample, so an un-annotated series is not silently flagged', () => {
    expect(statistics('m', 'ms', [1, 2]).aggregation).toBe('sample');
  });
});
