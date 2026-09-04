import AnvilKit
import Foundation

/// Named states used by the preview renderer.
///
/// Deliberately not "happy path only": the states worth designing against are a run that
/// stopped for approval, one that failed, and a list that is empty — those are where a
/// layout usually falls apart.
enum PreviewFixtures {
    static let workspace = URL(fileURLWithPath: "/Users/dev/Anvil")

    static func doctorReport(healthy: Bool = true) -> DoctorReport {
        DoctorReport(
            version: "1.0.2",
            healthy: healthy,
            checks: [
                .init(id: "platform", status: .pass, detail: "darwin arm64"),
                .init(
                    id: "node-runtime",
                    status: .pass,
                    detail: "v25.2.1",
                    evidence: [
                        "executable": .string("/Applications/Anvil.app/Contents/Resources/…/node"),
                        "minimum": .string("22.5.0 (node:sqlite catalog)")
                    ]
                ),
                .init(
                    id: "workspace",
                    status: .pass,
                    detail: workspace.path,
                    evidence: [
                        "jobsDir": .string("\(workspace.path)/.jobs"),
                        "packagesDir": .string("\(workspace.path)/.game-dev/packages"),
                        "runsDir": .string("\(workspace.path)/.game-dev/runs"),
                        "catalogPath": .string("\(workspace.path)/.game-dev/catalog.sqlite3")
                    ]
                ),
                .init(id: "tripo-credential", status: .pass, detail: "configured; value redacted"),
                .init(id: "leonardo-credential", status: .unavailable, detail: "not configured"),
                .init(id: "blender", status: healthy ? .pass : .fail, detail: healthy ? "/Applications/Blender.app" : "not found on this system"),
                .init(id: "blender-normalizer", status: .pass, detail: "packaged"),
                .init(id: "blender-usd-exporter", status: .pass, detail: "packaged"),
                .init(id: "usdzip", status: .pass, detail: "/usr/bin/usdzip"),
                .init(id: "sqlite-catalog-runtime", status: .pass, detail: "node:sqlite available"),
                .init(id: "codex-skills", status: .warning, detail: "5 skills packaged, 0 installed"),
                .init(id: "helper-version", status: .pass, detail: "1.0.2"),
                .init(
                    id: "metal-evidence",
                    status: .warning,
                    detail: "doctor performs no GPU capture"
                )
            ],
            evidenceCeiling: """
            This report describes the local toolchain only. It does not execute a capture, \
            does not prove GPU execution, and performs no human visual review.
            """
        )
    }

    static func runs() -> [Run] {
        var running = Run(
            commandID: "scenario.run",
            title: "Run a scenario",
            arguments: ["scenario", "run", "gbuffer-matrix"],
            outputDirectory: workspace
        )
        running.state = .running
        running.startedAt = Date().addingTimeInterval(-47)
        running.durableJobID = "job_4f2c8a10-7d3e-4c1b-9a55-2e6f10bd77c1"
        running.events = [
            event(.started, 0, "scenario.run", ["version": .string("1.0.2")]),
            event(.progress, 1, "scenario.run", [
                "phase": .string("scenario_process"),
                "runId": .string("run_1770000000_9f2b"),
                "capabilities": .array([.string("gpu"), .string("metal")])
            ])
        ]

        var approval = Run(
            commandID: "tool.create_3d_asset",
            title: "Reconstruct in 3D",
            arguments: ["tool", "call", "create_3d_asset"],
            outputDirectory: workspace
        )
        approval.state = .awaitingApproval
        approval.startedAt = Date().addingTimeInterval(-320)
        approval.finishedAt = Date().addingTimeInterval(-318)
        approval.durableJobID = "job_88b1e0d2-1c44-4a90-8f21-77c0a9e33d10"

        var succeeded = Run(
            commandID: "visual.compare",
            title: "Compare captures",
            arguments: ["visual", "compare", "run_a", "run_b"],
            outputDirectory: workspace
        )
        succeeded.state = .succeeded
        succeeded.startedAt = Date().addingTimeInterval(-900)
        succeeded.finishedAt = Date().addingTimeInterval(-871)
        succeeded.durableJobID = "job_2a7f5b93-6e18-4d02-b3cc-91ae4f60ba22"
        succeeded.artifacts = [
            RunArtifact(kind: "visual_comparison", path: "\(workspace.path)/.game-dev/diff/run_b"),
            RunArtifact(kind: "receipt", path: "\(workspace.path)/.game-dev/diff/run_b/receipt.json"),
            RunArtifact(kind: "run_manifest", path: "\(workspace.path)/.game-dev/runs/run_b/run.json"),
            RunArtifact(kind: "manifest", path: "\(workspace.path)/.game-dev/runs/run_b/capture.json")
        ]

        var paid = Run(
            commandID: "tool.generate_asset_reference",
            title: "Generate references",
            arguments: ["tool", "call", "generate_asset_reference"],
            outputDirectory: workspace
        )
        paid.state = .succeeded
        paid.startedAt = Date().addingTimeInterval(-2_400)
        paid.finishedAt = Date().addingTimeInterval(-2_355)
        paid.approval = ApprovalRecord(
            ApprovalAuthorization.grantFromHumanApproval(
                ceilingCents: 500,
                presentedEstimateCents: 40,
                presentedConfidence: .estimated,
                presentedBasis: "Leonardo, per image.",
                authorities: [.approveSpend]
            )
        )

        var failed = Run(
            commandID: "asset.normalize",
            title: "Normalize a mesh",
            arguments: ["asset", "normalize", "crate.glb"],
            outputDirectory: workspace
        )
        failed.state = .failed("Blender exited before writing a result. The mesh has no faces after welding.")
        failed.startedAt = Date().addingTimeInterval(-5_000)
        failed.finishedAt = Date().addingTimeInterval(-4_700)
        failed.durableJobID = "job_9d0c11ff-4b7a-42e8-9c3d-08fa61b2e5c4"

        return [running, approval, succeeded, paid, failed]
    }

    private static func event(
        _ kind: GameDevEvent.Kind,
        _ sequence: Int,
        _ operation: String,
        _ data: [String: JSONValue]
    ) -> GameDevEvent {
        GameDevEvent(
            eventID: "evt_\(sequence)",
            jobID: "job_4f2c8a10-7d3e-4c1b-9a55-2e6f10bd77c1",
            sequence: sequence,
            timestamp: Date().addingTimeInterval(Double(sequence) - 47),
            kind: kind,
            operation: operation,
            data: data
        )
    }

    static func comparisonEvidence() -> EvidenceCeiling {
        EvidenceCeiling(RunEvidence(
            rendererClass: .hardware,
            softwareRasterizedLane: false,
            adapterReportedGpuExecution: true,
            adapterReportedGpuCompletionIdentity: true,
            adapterReportedHardwarePerformance: false,
            hardwarePerformanceEvidenceAdmitted: false,
            evidenceCeiling: """
            Two sealed runs were verified and their rasters compared deterministically. \
            This establishes that pixels changed and where; it does not establish why, \
            does not judge whether the change is a defect, and no human reviewed the frames.
            """
        ))
    }

    static func comparison() -> VisualComparison {
        VisualComparison(
            baselineRunID: "run_1770000000_a91f",
            candidateRunID: "run_1770000420_c3b8",
            threshold: 4,
            pairs: [
                ComparisonPair(
                    identity: "0000/color",
                    kind: .color,
                    comparable: true,
                    baselinePath: "frames/0000/color.png",
                    candidatePath: "frames/0000/color.png",
                    width: 1_920,
                    height: 1_080,
                    meanAbsoluteError: 6.42,
                    rootMeanSquaredError: 21.7,
                    maximumChannelDelta: 255,
                    changedPixelRatio: 0.0731,
                    meanLuminanceDelta: -1.8,
                    meanAbsoluteEdgeDelta: 11.3,
                    meanSSIM: 0.874,
                    worstSSIMWindow: .init(x: 1_360, y: 240, ssim: 0.21),
                    semanticRegions: [
                        .init(objectID: "crate_02", pixels: 6_400, meanAbsoluteError: 61.2, changedPixelRatio: 0.98, pixelsRetained: 0, pixelsLost: 6_400, pixelsGained: 0),
                        .init(objectID: "barrel_01", pixels: 8_000, meanAbsoluteError: 34.8, changedPixelRatio: 0.44, pixelsRetained: 6_240, pixelsLost: 1_760, pixelsGained: 1_760),
                        .init(objectID: "floor", pixels: 412_000, meanAbsoluteError: 0.9, changedPixelRatio: 0.012, pixelsRetained: 412_000, pixelsLost: 0, pixelsGained: 0),
                        .init(objectID: "crate_01", pixels: 8_100, meanAbsoluteError: 0.0, changedPixelRatio: 0, pixelsRetained: 8_100, pixelsLost: 0, pixelsGained: 0)
                    ],
                    objectsDisappeared: ["crate_02"],
                    heatmapPath: "diff/0000/color.heatmap.png"
                ),
                ComparisonPair(
                    identity: "0000/object_id",
                    kind: .objectID,
                    comparable: true,
                    baselinePath: "frames/0000/object_id.png",
                    candidatePath: "frames/0000/object_id.png",
                    width: 1_920,
                    height: 1_080,
                    meanAbsoluteError: 3.1,
                    changedPixelRatio: 0.041,
                    meanSSIM: 0.93
                ),
                ComparisonPair(
                    identity: "0000/depth",
                    kind: .depth,
                    comparable: false,
                    baselinePath: "frames/0000/depth.png",
                    candidatePath: "frames/0000/depth.png",
                    reason: "Baseline is 1920×1080 and candidate is 1280×720."
                )
            ],
            verdict: .changed,
            summary: [
                "7.31% of colour pixels changed beyond the threshold of 4.",
                "crate_02 is present in the baseline and absent from the candidate.",
                "barrel_01 lost and gained equal coverage, which reads as movement rather than a shading change.",
                "Edges moved and structure diverged (SSIM 0.87), so this is not only shading."
            ],
            unmatchedCandidate: ["0001/color"],
            outputPath: "/Users/dev/Anvil/.game-dev/diff/run_1770000420_c3b8",
            evidenceCeiling: comparisonEvidence().text,
            semanticObjectRegionsCompared: true,
            heatmapsGenerated: true
        )
    }

    static func analysis() -> CaptureAnalysis {
        func raster(_ kind: AttachmentKind, _ path: String, min: [Double], mean: [Double], max: [Double], lum: Double, ids: Int? = nil) -> RasterAnalysis {
            RasterAnalysis(frameIndex: 0, kind: kind, path: path, width: 1_920, height: 1_080,
                           minimum: min, maximum: max, mean: mean, meanLuminance: lum, alphaCoverage: 1, uniqueSemanticIDs: ids)
        }
        return CaptureAnalysis(
            runID: "run_1770000000_a91f",
            runPath: "\(workspace.path)/.game-dev/runs/run_1770000000_a91f",
            adapterID: "genome-game",
            scenarioID: "gbuffer-matrix",
            rasters: [
                raster(.color, "color", min: [3, 4, 9, 255], mean: [61, 68, 96, 255], max: [230, 178, 110, 255], lum: 71.2),
                raster(.objectID, "object_id", min: [0, 0, 0, 255], mean: [12, 3, 0, 255], max: [41, 0, 0, 255], lum: 6.1, ids: 4),
                raster(.normal, "normal", min: [128, 128, 255, 255], mean: [128, 128, 255, 255], max: [128, 128, 255, 255], lum: 150),
                raster(.wireframe, "wireframe", min: [0, 0, 0, 255], mean: [14, 14, 14, 255], max: [255, 255, 255, 255], lum: 14)
            ],
            floatRasters: [
                FloatRasterAnalysis(frameIndex: 0, kind: .depth, path: "depth.bin", previewPath: "depth.png",
                                    pixelFormat: .d32f, width: 1_920, height: 1_080, samples: 2_073_600,
                                    minimum: 0.0421, maximum: 0.9987, mean: 0.612, nonFiniteSamples: 37)
            ],
            evidenceCeiling: """
            Every raster attachment in this sealed run was decoded and measured. Float buffers were \
            read at capture precision. This establishes what the frames contain; it does not prove \
            GPU execution, does not judge the frames, and no human reviewed them.
            """
        )
    }
}
