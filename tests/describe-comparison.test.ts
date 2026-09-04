/**
 * Eight floats per attachment is a complete description and an unusable one.
 *
 * Knowing that a low edge delta beside a large luminance shift means shading
 * rather than geometry, or that a changed-pixel ratio near 1.0 with a tiny mean
 * error is a global tint rather than a broken frame, is exactly the expertise a
 * caller reaching for this tool does not have. Making every caller re-derive it
 * is how a diff harness gets read as "the number went up" and switched off.
 *
 * The narrator is a pure function of the statistics: deterministic, testable,
 * and available to a caller with no model at all.
 */

import { describe, expect, it } from 'vitest';
import { describePair, verdictFor } from '../src/harness/describe-comparison.js';
import type { VisualComparison } from '../src/harness/visual.js';

type Pair = VisualComparison['pairs'][number];

function pair(overrides: Partial<Pair> = {}): Pair {
  return {
    identity: 'frame0.color',
    kind: 'color',
    comparable: true,
    baselinePath: '/b.png',
    candidatePath: '/c.png',
    width: 64,
    height: 64,
    meanAbsoluteError: 0.05,
    rootMeanSquaredError: 0.08,
    maximumChannelDelta: 0.3,
    changedPixelRatio: 0.04,
    meanLuminanceDelta: 0,
    meanAbsoluteEdgeDelta: 0,
    ...overrides,
  };
}

describe('the verdict', () => {
  it('separates identical from within-tolerance', () => {
    expect(verdictFor(pair({ changedPixelRatio: 0, maximumChannelDelta: 0 }))).toBe('identical');
    // Pixels differ, but none by more than the threshold. That is a different
    // fact from "the images are the same bytes".
    expect(verdictFor(pair({ changedPixelRatio: 0, maximumChannelDelta: 0.01 })))
      .toBe('within-tolerance');
  });

  it('reports incomparable rather than guessing at a number', () => {
    expect(verdictFor(pair({ comparable: false, reason: 'extent mismatch' }))).toBe('incomparable');
  });
});

describe('what the narrator says', () => {
  it('leads with a disappeared object, not with a pixel ratio', () => {
    const lines = describePair(pair({
      changedPixelRatio: 0.25,
      objectsDisappeared: ['0x000002'],
    }));

    // The pixel ratio is true and uninformative; the missing object is the
    // finding, and it must not be buried.
    expect(lines.some((line) => line.includes('no longer appears'))).toBe(true);
    expect(lines.some((line) => line.includes('0x000002'))).toBe(true);
  });

  it('names the object responsible when one dominates the change', () => {
    const lines = describePair(pair({
      changedPixelRatio: 0.2,
      semanticRegions: [
        { objectId: '0x0043a1', pixels: 1000, meanAbsoluteError: 0.4, changedPixelRatio: 0.9, pixelsRetained: 1000, pixelsLost: 0, pixelsGained: 0 },
        { objectId: '0x000001', pixels: 1000, meanAbsoluteError: 0.01, changedPixelRatio: 0.01, pixelsRetained: 1000, pixelsLost: 0, pixelsGained: 0 },
      ],
    }));

    expect(lines.some((line) => line.includes('0x0043a1') && line.includes('accounts for'))).toBe(true);
  });

  it('distinguishes a shading change from geometry moving', () => {
    const shading = describePair(pair({
      changedPixelRatio: 0.5, meanAbsoluteEdgeDelta: 0.001, meanLuminanceDelta: -0.09,
    }));
    const geometry = describePair(pair({
      changedPixelRatio: 0.5, meanAbsoluteEdgeDelta: 0.08, meanLuminanceDelta: 0.001,
    }));

    expect(shading.some((line) => line.includes('shading or exposure'))).toBe(true);
    expect(geometry.some((line) => line.includes('silhouettes differ'))).toBe(true);
  });

  it('calls a whole-frame micro-change a tint rather than a defect', () => {
    const lines = describePair(pair({
      changedPixelRatio: 0.999, meanAbsoluteError: 0.002, maximumChannelDelta: 0.01,
    }));

    expect(lines.some((line) => line.includes('global tint'))).toBe(true);
  });

  it('phrases interpretation as consistency, never as cause', () => {
    const lines = describePair(pair({
      changedPixelRatio: 0.5, meanAbsoluteEdgeDelta: 0.001, meanLuminanceDelta: -0.09,
    })).join(' ');

    // The harness cannot establish cause and must not sound like it has.
    expect(lines).toContain('consistent with');
    expect(lines).not.toMatch(/\bbecause\b|\bcaused by\b/);
  });

  it('explains an incomparable pair instead of describing nothing', () => {
    const lines = describePair(pair({ comparable: false, reason: 'extent mismatch 64x64 versus 32x32' }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('extent mismatch');
  });

  it('says plainly when nothing exceeded the threshold', () => {
    const lines = describePair(pair({ changedPixelRatio: 0, maximumChannelDelta: 0.01 }));

    expect(lines[0]).toContain('no pixel differs by more than the threshold');
  });
});
