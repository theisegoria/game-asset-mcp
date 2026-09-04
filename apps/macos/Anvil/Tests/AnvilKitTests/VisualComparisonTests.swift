import Foundation
import Testing
@testable import AnvilKit

@Suite("Visual comparison model")
struct VisualComparisonTests {
    private func pair(
        comparable: Bool = true,
        changed: Double? = 0.05,
        error: Double? = 3
    ) -> ComparisonPair {
        ComparisonPair(
            identity: "0000/color",
            kind: .color,
            comparable: comparable,
            baselinePath: "a",
            candidatePath: "b",
            meanAbsoluteError: error,
            changedPixelRatio: changed
        )
    }

    @Test("An incomparable pair is never reported as changed")
    func incomparableIsNotADifference() {
        // Nothing was measured, so calling it a change would invent a finding.
        #expect(pair(comparable: false, changed: 0.9, error: 50).verdict == .incomparable)
    }

    @Test("Zero changed pixels is identical, whatever the error field says")
    func zeroChangeIsIdentical() {
        #expect(pair(changed: 0, error: 0).verdict == .identical)
    }

    @Test("Changed pixels with error is a change; without error is within tolerance")
    func changeVersusTolerance() {
        #expect(pair(changed: 0.05, error: 3).verdict == .changed)
        #expect(pair(changed: 0.05, error: 0).verdict == .withinTolerance)
    }

    @Test("Regions rank by error first, then by area")
    func regionRanking() {
        let regions: [ComparisonPair.SemanticRegion] = [
            .init(objectID: "big-quiet", pixels: 100_000, meanAbsoluteError: 0.5, changedPixelRatio: 0.01, pixelsRetained: 100_000, pixelsLost: 0, pixelsGained: 0),
            .init(objectID: "small-loud", pixels: 500, meanAbsoluteError: 60, changedPixelRatio: 0.9, pixelsRetained: 500, pixelsLost: 0, pixelsGained: 0),
            .init(objectID: "mid-loud", pixels: 5_000, meanAbsoluteError: 60, changedPixelRatio: 0.9, pixelsRetained: 5_000, pixelsLost: 0, pixelsGained: 0)
        ]
        let ranked = ComparisonPair(identity: "x", kind: .color, comparable: true, baselinePath: "a", candidatePath: "b", semanticRegions: regions).rankedRegions
        // The large quiet floor must not bury the small object that actually changed.
        #expect(ranked.map(\.objectID) == ["mid-loud", "small-loud", "big-quiet"])
    }

    @Test("Equal lost and gained coverage reads as movement")
    func movementIsDetected() {
        let moved = ComparisonPair.SemanticRegion(objectID: "barrel", pixels: 8_000, meanAbsoluteError: 30, changedPixelRatio: 0.4, pixelsRetained: 6_000, pixelsLost: 2_000, pixelsGained: 2_000)
        let recoloured = ComparisonPair.SemanticRegion(objectID: "wall", pixels: 8_000, meanAbsoluteError: 30, changedPixelRatio: 0.9, pixelsRetained: 8_000, pixelsLost: 0, pixelsGained: 0)
        #expect(moved.suggestsMovement)
        #expect(!recoloured.suggestsMovement)
    }

    @Test("A comparison never claims cause or quality")
    func comparisonNeverOverclaims() {
        // These mirror literal-false fields in the harness contract. A diff says pixels
        // changed; it does not say why, and it does not say the change is wrong.
        let comparison = VisualComparison(
            baselineRunID: "a", candidateRunID: "b", threshold: 0,
            pairs: [pair()], verdict: .changed, summary: [], evidenceCeiling: "x"
        )
        #expect(!comparison.provesCause)
        #expect(!comparison.judgesQuality)
    }

    @Test("Unmatched attachments are surfaced but kept apart from changes")
    func unmatchedIsNotAChange() {
        let comparison = VisualComparison(
            baselineRunID: "a", candidateRunID: "b", threshold: 0,
            pairs: [pair(changed: 0, error: 0)], verdict: .identical, summary: [],
            unmatchedCandidate: ["0001/color"], evidenceCeiling: "x"
        )
        #expect(comparison.hasUnmatchedAttachments)
        #expect(comparison.changedPairs.isEmpty)
    }
}
