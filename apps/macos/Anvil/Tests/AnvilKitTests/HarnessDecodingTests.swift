import Foundation
import Testing
@testable import AnvilKit

@Suite("Harness result decoding")
struct HarnessDecodingTests {
    private func comparisonPayload(verdict: String = "changed", kind: String = "color") -> JSONValue {
        .object([
            "schema": .string("game_dev.visual_comparison.v1"),
            "baselineRunId": .string("run_a"),
            "candidateRunId": .string("run_b"),
            "threshold": .number(4),
            "verdict": .string(verdict),
            "summary": .array([.string("7% changed.")]),
            "evidenceCeiling": .string("Pixels changed; cause not established."),
            "unmatchedCandidate": .array([.string("0001/color")]),
            "evidence": .object([
                "semanticObjectRegionsCompared": .bool(true),
                "heatmapsGenerated": .bool(true)
            ]),
            "pairs": .array([.object([
                "identity": .string("0000/color"),
                "kind": .string(kind),
                "comparable": .bool(true),
                "baselinePath": .string("/runs/a/frames/0000/color.png"),
                "candidatePath": .string("/runs/b/frames/0000/color.png"),
                "width": .number(1920), "height": .number(1080),
                "meanAbsoluteError": .number(6.4),
                "changedPixelRatio": .number(0.07),
                "meanSSIM": .number(0.87),
                "worstSSIMWindow": .object(["x": .number(10), "y": .number(20), "ssim": .number(0.2)]),
                "semanticRegions": .array([.object([
                    "objectId": .string("crate"), "pixels": .number(100),
                    "meanAbsoluteError": .number(50), "changedPixelRatio": .number(0.9),
                    "pixelsRetained": .number(0), "pixelsLost": .number(100), "pixelsGained": .number(0)
                ])]),
                "objectsDisappeared": .array([.string("crate")]),
                "heatmapPath": .string("/diff/0000-color.heatmap.png")
            ])])
        ])
    }

    @Test("A comparison result decodes with its regions, window and evidence flags")
    func comparisonDecodes() throws {
        let comparison = try VisualComparison(payload: comparisonPayload())
        #expect(comparison.verdict == .changed)
        #expect(comparison.threshold == 4)
        #expect(comparison.semanticObjectRegionsCompared)
        #expect(comparison.heatmapsGenerated)
        #expect(comparison.unmatchedCandidate == ["0001/color"])
        let pair = try #require(comparison.pairs.first)
        #expect(pair.kind == .color)
        #expect(pair.worstSSIMWindow?.ssim == 0.2)
        #expect(pair.semanticRegions.first?.objectID == "crate")
        #expect(pair.objectsDisappeared == ["crate"])
        #expect(pair.heatmapPath == "/diff/0000-color.heatmap.png")
    }

    @Test("An unknown verdict refuses the result rather than being mapped to a neighbour")
    func unknownVerdictIsRefused() {
        // "changed" and "incomparable" mean different things; guessing between them
        // would state a finding the harness did not make.
        #expect(throws: VisualComparison.DecodingFailure.unknownVerdict("dubious")) {
            _ = try VisualComparison(payload: comparisonPayload(verdict: "dubious"))
        }
    }

    @Test("An unknown attachment kind is shown as custom, not refused")
    func unknownKindIsCustom() throws {
        // The pixels are still worth looking at; the label says they are uninterpreted.
        let comparison = try VisualComparison(payload: comparisonPayload(kind: "velocity_v2"))
        #expect(comparison.pairs.first?.kind == .custom)
    }

    @Test("The wrong schema is refused")
    func wrongSchemaIsRefused() {
        #expect(throws: VisualComparison.DecodingFailure.unexpectedSchema("game_dev.run.v1")) {
            _ = try VisualComparison(payload: .object([
                "schema": .string("game_dev.run.v1"),
                "baselineRunId": .string("a"), "candidateRunId": .string("b"),
                "verdict": .string("identical"), "evidenceCeiling": .string("x")
            ]))
        }
    }

    @Test("A comparison's evidence keeps every GPU and timing claim refused")
    func comparisonEvidenceClaimsNothingAboutTheRenderer() throws {
        // A diff proves pixels changed. It proves nothing about how they were rendered.
        let comparison = try VisualComparison(payload: comparisonPayload())
        #expect(!comparison.evidence.mayPresentAsGpuExecution)
        #expect(!comparison.evidence.mayPresentHardwareTimings)
        #expect(comparison.evidence.rendererClass == .unknown)
        #expect(comparison.evidence.evidenceCeiling == "Pixels changed; cause not established.")
    }

    @Test("A capture analysis decodes rasters and float buffers together")
    func analysisDecodes() throws {
        let analysis = try CaptureAnalysis(payload: .object([
            "schema": .string("game_dev.visual_analysis.v1"),
            "runId": .string("run_a"), "runPath": .string("/runs/a"),
            "adapterId": .string("genome"), "scenarioId": .string("matrix"),
            "evidenceCeiling": .string("Decoded bytes; no review."),
            "rasters": .array([
                .object([
                    "frameIndex": .number(0), "kind": .string("color"),
                    "path": .string("/runs/a/frames/0000/color.png"),
                    "width": .number(64), "height": .number(64),
                    "channels": .object([
                        "minimum": .array([.number(0), .number(0), .number(0), .number(255)]),
                        "maximum": .array([.number(255), .number(200), .number(180), .number(255)]),
                        "mean": .array([.number(90), .number(80), .number(70), .number(255)])
                    ]),
                    "meanLuminance": .number(82.5), "alphaCoverage": .number(1)
                ]),
                .object([
                    "frameIndex": .number(0), "kind": .string("normal"),
                    "path": .string("/runs/a/frames/0000/normal.png"),
                    "width": .number(64), "height": .number(64),
                    "channels": .object([
                        "minimum": .array([.number(128), .number(128), .number(255), .number(255)]),
                        "maximum": .array([.number(128), .number(128), .number(255), .number(255)]),
                        "mean": .array([.number(128), .number(128), .number(255), .number(255)])
                    ]),
                    "meanLuminance": .number(150), "alphaCoverage": .number(1)
                ])
            ]),
            "floatRasters": .array([.object([
                "frameIndex": .number(0), "kind": .string("depth"),
                "path": .string("/runs/a/frames/0000/depth.bin"),
                "pixelFormat": .string("d32f"), "width": .number(64), "height": .number(64),
                "samples": .number(4096), "minimum": .number(0.1), "maximum": .number(0.9),
                "mean": .number(0.4), "nonFiniteSamples": .number(3)
            ])])
        ]))
        #expect(analysis.rasters.count == 2)
        #expect(analysis.floatRasters.count == 1)
        #expect(analysis.frameIndices == [0])
        // A normal buffer that is the same flat "up" everywhere was never written to.
        #expect(analysis.flatRasters.map(\.kind) == [.normal])
        #expect(analysis.floatRasters.first?.hasNonFiniteSamples == true)
        #expect(!analysis.evidence.mayPresentAsGpuExecution)
    }
}
