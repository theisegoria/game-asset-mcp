import Foundation
import Testing
@testable import AnvilKit

/// Tests for the claims the interface is allowed to make.
///
/// These are not model-plumbing tests. Each one corresponds to a specific way a
/// well-meaning UI would overstate its evidence, which is the failure mode this
/// toolchain is built to avoid.
@Suite("Evidence and capture contracts")
struct EvidenceTests {
    private func evidence(
        renderer: RendererClass,
        softwareLane: Bool,
        gpu: Bool = false,
        completionIdentity: Bool = false,
        hardwareTiming: Bool = false,
        admitted: Bool = false,
        refused: [String] = []
    ) -> RunEvidence {
        RunEvidence(
            rendererClass: renderer,
            softwareRasterizedLane: softwareLane,
            adapterReportedGpuExecution: gpu,
            adapterReportedGpuCompletionIdentity: completionIdentity,
            adapterReportedHardwarePerformance: hardwareTiming,
            hardwarePerformanceEvidenceAdmitted: admitted,
            refusedAdapterClaims: refused,
            evidenceCeiling: "This run does not prove GPU execution."
        )
    }

    // MARK: - The software downgrade

    @Test("A software lane may not be presented as GPU execution, whatever the adapter claimed")
    func softwareLaneRefusesGpuPresentation() {
        // The adapter claimed everything at once; the harness refused it. The interface
        // must show the refusal, not the claim.
        let refused = evidence(
            renderer: .software,
            softwareLane: true,
            gpu: true,
            completionIdentity: true,
            hardwareTiming: true,
            admitted: false,
            refused: ["gpu execution", "gpu completion identity", "hardware performance"]
        )
        #expect(!refused.mayPresentAsGpuExecution)
        #expect(!refused.mayPresentHardwareTimings)
        // Recorded by the harness rather than reconstructed here by diffing the
        // capture manifest against the run.
        #expect(refused.refusedClaims == ["gpu execution", "gpu completion identity", "hardware performance"])
    }

    @Test("A refused claim is surfaced rather than silently dropped")
    func refusedClaimsAreVisible() {
        // An adapter asserting hardware execution from a CPU renderer is a defect in the
        // adapter. Dropping the claim quietly would hide it from the person who could fix it.
        let refused = evidence(
            renderer: .software,
            softwareLane: true,
            gpu: true,
            refused: ["gpu execution"]
        )
        #expect(refused.refusedClaims == ["gpu execution"])

        let honest = evidence(renderer: .software, softwareLane: true)
        #expect(honest.refusedClaims.isEmpty, "A software lane that claimed nothing has nothing to report")
    }

    @Test("A hardware run may be presented as GPU execution only when one was reported")
    func hardwareRequiresAReport() {
        #expect(evidence(renderer: .hardware, softwareLane: false, gpu: true).mayPresentAsGpuExecution)
        #expect(!evidence(renderer: .hardware, softwareLane: false, gpu: false).mayPresentAsGpuExecution)
    }

    @Test("An undeclared renderer is a real state, not a failure")
    func unknownIsNotAFailure() {
        let unknown = evidence(renderer: .unknown, softwareLane: false)
        #expect(!unknown.mayPresentAsGpuExecution)
        #expect(unknown.refusedClaims.isEmpty, "Nothing was claimed, so nothing was refused")
        // The wording must not read as an error; nobody made a claim.
        #expect(unknown.rendererSummary.contains("did not declare"))
        #expect(!unknown.rendererSummary.lowercased().contains("fail"))
    }

    @Test("Timings are admitted only when the harness admitted them")
    func timingsFollowTheHarness() {
        #expect(evidence(renderer: .hardware, softwareLane: false, admitted: true).mayPresentHardwareTimings)
        #expect(!evidence(renderer: .hardware, softwareLane: false, admitted: false).mayPresentHardwareTimings)
    }

    // MARK: - Decoding

    @Test("Evidence decodes from a run manifest block")
    func decodesFromRunManifest() throws {
        let decoded = try RunEvidence(runManifestEvidence: .object([
            "rendererClass": .string("software"),
            "softwareRasterizedLane": .bool(true),
            "adapterReportedGpuExecution": .bool(false),
            "adapterReportedGpuCompletionIdentity": .bool(false),
            "adapterReportedHardwarePerformance": .bool(false),
            "hardwarePerformanceEvidenceAdmitted": .bool(false),
            "refusedAdapterClaims": .array([.string("gpu execution")]),
            "evidenceCeiling": .string("Software lane. No GPU evidence.")
        ]))
        #expect(decoded.rendererClass == .software)
        #expect(decoded.softwareRasterizedLane)
        #expect(decoded.refusedClaims == ["gpu execution"])
    }

    @Test("A missing evidence field fails rather than defaulting")
    func missingEvidenceFieldFails() {
        // Defaulting a missing flag to false would look safe and read as a finding.
        // Refusing to decode says "this run cannot be described", which is the truth.
        #expect(throws: RunEvidence.EvidenceDecodingFailure.missing("softwareRasterizedLane")) {
            _ = try RunEvidence(runManifestEvidence: .object([
                "rendererClass": .string("hardware"),
                "evidenceCeiling": .string("x")
            ]))
        }
    }

    @Test("An evidence ceiling always accompanies the evidence it describes")
    func ceilingTravelsWithEvidence() {
        let value = evidence(renderer: .software, softwareLane: true)
        let ceiling = EvidenceCeiling(value)
        #expect(ceiling.text == value.evidenceCeiling)
        #expect(!ceiling.text.isEmpty)
    }

    // MARK: - Authorities

    @Test("A software-raster scenario does not require GPU authority")
    func softwareRasterDoesNotDemandGpu() throws {
        // Demanding GPU authority for lavapipe would train people to grant it for runs
        // that never touch a GPU.
        let plan = try ScenarioPlan(planPayload: .object([
            "runId": .string("run_1"),
            "runPath": .string("/tmp/run_1"),
            "scenarioId": .string("ci-regression"),
            "executable": .string("/usr/bin/true"),
            "capabilities": .array([.string("cpu"), .string("software-raster"), .string("vulkan")]),
            "requiredAuthorizations": .array([.string("confirm")])
        ]))
        #expect(plan.requiredAuthorizations == [.confirm])
        #expect(!plan.requiredAuthorizations.contains(.allowGPU))
        #expect(plan.isSoftwareLane)
        #expect(plan.graphicsLanes.contains(.vulkan))
    }

    @Test("Authorities come from the plan, never from capabilities")
    func authoritiesAreNotDerived() throws {
        // A scenario naming an API lane does not thereby need GPU authority; only the
        // plan knows, because only the harness decides.
        let plan = try ScenarioPlan(planPayload: .object([
            "runId": .string("run_2"),
            "runPath": .string("/tmp/run_2"),
            "scenarioId": .string("metal-matrix"),
            "executable": .string("/usr/bin/true"),
            "capabilities": .array([.string("gpu"), .string("metal"), .string("performance")]),
            "requiredAuthorizations": .array([
                .string("confirm"), .string("gpu"), .string("performance")
            ])
        ]))
        #expect(plan.requiredAuthorizations == [.confirm, .allowGPU, .allowPerformance])
    }

    @Test("An unrecognized authority refuses the plan instead of dropping it")
    func unknownAuthorityRefusesThePlan() {
        // Silently omitting an authority would show someone less than they are agreeing to.
        #expect(throws: ScenarioPlan.PlanDecodingFailure.unknownAuthorization("network")) {
            _ = try ScenarioPlan(planPayload: .object([
                "runId": .string("run_3"),
                "runPath": .string("/tmp/run_3"),
                "scenarioId": .string("future"),
                "executable": .string("/usr/bin/true"),
                "requiredAuthorizations": .array([.string("confirm"), .string("network")])
            ]))
        }
    }

    @Test("A declared graphics environment survives into the plan for approval")
    func environmentIsVisibleForApproval() throws {
        let plan = try ScenarioPlan(planPayload: .object([
            "runId": .string("run_4"),
            "runPath": .string("/tmp/run_4"),
            "scenarioId": .string("lavapipe"),
            "executable": .string("/usr/bin/true"),
            "requiredAuthorizations": .array([.string("confirm")]),
            "environment": .object([
                "LIBGL_ALWAYS_SOFTWARE": .string("1"),
                "VK_ICD_FILENAMES": .string("/usr/share/vulkan/icd.d/lvp_icd.json")
            ])
        ]))
        // It changes which driver runs, so it changes what the run means; a person
        // approving the run is approving this too.
        #expect(plan.environment["LIBGL_ALWAYS_SOFTWARE"] == "1")
        #expect(plan.environment.keys.allSatisfy(GraphicsEnvironment.allowed.contains))
    }

    // MARK: - Attachment kinds

    @Test("Every attachment kind the harness can emit is described")
    func everyAttachmentKindIsDescribed() {
        for kind in AttachmentKind.allCases {
            #expect(!kind.label.isEmpty, "\(kind.rawValue) has no label")
            #expect(
                kind.diagnosticPurpose.count > 20,
                "\(kind.rawValue) has no explanation of what it lets someone rule out"
            )
        }
    }

    @Test("Anvil knows exactly the attachment kinds the contract defines")
    func attachmentKindsMatchTheContract() {
        // Kept in step with src/harness/contracts.ts by hand, so drift shows up here
        // rather than as an attachment the viewer silently cannot open.
        let expected: Set<String> = [
            "color", "depth", "normal", "object_id", "material_id", "motion", "overdraw",
            "albedo", "wireframe", "uv_checker", "mipmap_level", "stencil",
            "shader_complexity", "light_complexity", "custom"
        ]
        #expect(Set(AttachmentKind.allCases.map(\.rawValue)) == expected)
    }

    @Test("Engine-authored heuristics are marked so their cost model travels with them")
    func heuristicsAreMarked() {
        // A shader-cost image without its cost model is a picture of numbers that mean
        // nothing.
        #expect(AttachmentKind.shaderComplexity.isEngineAuthoredHeuristic)
        #expect(AttachmentKind.lightComplexity.isEngineAuthoredHeuristic)
        #expect(!AttachmentKind.color.isEngineAuthoredHeuristic)
        #expect(!AttachmentKind.wireframe.isEngineAuthoredHeuristic)
    }

    @Test("Semantic and linear buffers are distinguished from colour")
    func colorimetryIsClassified() {
        // Resampling an identifier buffer through a gamma curve destroys its meaning,
        // and averaging a normal map bends the vectors.
        #expect(AttachmentKind.objectID.isSemantic)
        #expect(AttachmentKind.materialID.isSemantic)
        #expect(!AttachmentKind.color.isSemantic)

        #expect(AttachmentKind.normal.isLinearData)
        #expect(AttachmentKind.depth.isLinearData)
        #expect(!AttachmentKind.color.isLinearData)
        #expect(!AttachmentKind.albedo.isLinearData)
    }

    @Test("Anvil knows exactly the scenario capabilities the contract defines")
    func capabilitiesMatchTheContract() {
        let expected: Set<String> = [
            "cpu", "project-write", "gpu", "performance",
            "metal", "vulkan", "webgpu", "opengl", "software-raster"
        ]
        #expect(Set(ScenarioCapability.allCases.map(\.rawValue)) == expected)
    }

    @Test("There is no histogram attachment kind, deliberately")
    func histogramIsNotAnAttachment() {
        // A histogram is a statistic derived from the colour buffer, not a render
        // output. Accepting one would let an engine report a histogram that disagrees
        // with its own pixels; Anvil computes it from the decoded bytes instead.
        #expect(AttachmentKind(rawValue: "histogram") == nil)
    }

    // MARK: - Float attachments

    @Test("Row stride is honoured, because real APIs pad")
    func rowStrideIsHonoured() {
        // wgpu aligns copy rows to 256 bytes. Reading width * bytesPerPixel walks into
        // the padding and reports it as data.
        let padded = FloatFormat(
            pixelFormat: .r32f,
            width: 60,
            height: 40,
            rowStride: 256
        )
        #expect(padded.isPadded)
        #expect(padded.byteOffset(ofRow: 3) == 768)
        // Multiplying by width would have given 720, landing mid-row.
        #expect(padded.byteOffset(ofRow: 3) != 3 * padded.width * padded.pixelFormat.bytesPerPixel)

        let tight = FloatFormat(pixelFormat: .r32f, width: 64, height: 40, rowStride: 256)
        #expect(!tight.isPadded)
    }

    @Test("Non-finite samples are surfaced as a defect, not smoothed over")
    func nonFiniteSamplesAreFlagged() {
        let broken = FloatRasterAnalysis(
            frameIndex: 0,
            kind: .depth,
            path: "frames/0000/depth.bin",
            pixelFormat: .d32f,
            width: 100,
            height: 100,
            samples: 10_000,
            minimum: 0.1,
            maximum: 0.98,
            mean: 0.42,
            nonFiniteSamples: 37
        )
        // The range looks perfectly healthy; the frame is not.
        #expect(broken.hasNonFiniteSamples)
        let diagnosis = try? #require(broken.nonFiniteDiagnosis)
        #expect(diagnosis?.contains("uninitialised clear") == true)

        let clean = FloatRasterAnalysis(
            frameIndex: 0,
            kind: .depth,
            path: "frames/0000/depth.bin",
            pixelFormat: .d32f,
            width: 100,
            height: 100,
            samples: 10_000,
            minimum: 0.1,
            maximum: 0.98,
            mean: 0.42,
            nonFiniteSamples: 0
        )
        #expect(!clean.hasNonFiniteSamples)
        #expect(clean.nonFiniteDiagnosis == nil)
    }

    @Test("A probe value is measured from the float buffer, never from the preview")
    func measurementComesFromTheBuffer() {
        // The preview is lossy by construction: a visualisation, not the measurement.
        // Reading a hover value off it would report the picture instead of the data.
        let raster = FloatRasterAnalysis(
            frameIndex: 0,
            kind: .depth,
            path: "frames/0000/depth.bin",
            previewPath: "frames/0000/depth.png",
            pixelFormat: .d32f,
            width: 8,
            height: 8,
            samples: 64,
            minimum: 0,
            maximum: 1,
            mean: 0.5,
            nonFiniteSamples: 0
        )
        #expect(raster.isMeasurementSource)
        #expect(raster.previewPath != nil, "The preview is for looking at, and is cited as such")
    }

    @Test("A float raster decodes from an analysis entry")
    func floatRasterDecodes() throws {
        let decoded = try FloatRasterAnalysis(payload: .object([
            "frameIndex": .number(2),
            "kind": .string("depth"),
            "path": .string("frames/0002/depth.bin"),
            "previewPath": .string("frames/0002/depth.png"),
            "pixelFormat": .string("r16f"),
            "width": .number(1_920),
            "height": .number(1_080),
            "samples": .number(2_073_600),
            "minimum": .number(0.0),
            "maximum": .number(1.0),
            "mean": .number(0.734),
            "nonFiniteSamples": .number(0)
        ]))
        #expect(decoded.pixelFormat == .r16f)
        #expect(decoded.kind == .depth)
        #expect(decoded.previewPath == "frames/0002/depth.png")
        #expect(!decoded.hasNonFiniteSamples)
    }

    @Test("Every float pixel format states its size")
    func pixelFormatSizes() {
        #expect(FloatPixelFormat.r16f.bytesPerPixel == 2)
        #expect(FloatPixelFormat.r32f.bytesPerPixel == 4)
        #expect(FloatPixelFormat.d32f.bytesPerPixel == 4)
        #expect(FloatPixelFormat.r32u.bytesPerPixel == 4)
        #expect(FloatPixelFormat.rgba32f.bytesPerPixel == 16)
    }
}
