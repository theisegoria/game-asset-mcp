import Foundation

/// What a sealed run does and does not prove.
///
/// This type is the reason Anvil can show a picture without implying it is proof. The
/// toolchain records, for every run, that the harness alone proved neither GPU execution
/// nor hardware timing, and that no human reviewed the image — as literal `false` values
/// that cannot be set true. Anvil carries that across rather than re-deriving it.
///
/// Read this from `run.json`, never from the capture manifest. When a run declares a
/// software renderer the harness **overwrites** the adapter's GPU and timing claims
/// rather than recording them, so the manifest holds what the adapter asserted and the
/// run holds what survived. Showing the former would report a refused claim as a fact.
public struct RunEvidence: Sendable, Hashable, Codable {
    public let rendererClass: RendererClass
    /// True when the harness refused this run's GPU and timing claims.
    public let softwareRasterizedLane: Bool
    public let adapterReportedGpuExecution: Bool
    public let adapterReportedGpuCompletionIdentity: Bool
    public let adapterReportedHardwarePerformance: Bool
    public let hardwarePerformanceEvidenceAdmitted: Bool
    /// The toolchain's own words for what this run does not establish. Shown verbatim;
    /// never paraphrased, because a paraphrase is a new claim.
    public let evidenceCeiling: String

    public init(
        rendererClass: RendererClass,
        softwareRasterizedLane: Bool,
        adapterReportedGpuExecution: Bool,
        adapterReportedGpuCompletionIdentity: Bool,
        adapterReportedHardwarePerformance: Bool,
        hardwarePerformanceEvidenceAdmitted: Bool,
        evidenceCeiling: String
    ) {
        self.rendererClass = rendererClass
        self.softwareRasterizedLane = softwareRasterizedLane
        self.adapterReportedGpuExecution = adapterReportedGpuExecution
        self.adapterReportedGpuCompletionIdentity = adapterReportedGpuCompletionIdentity
        self.adapterReportedHardwarePerformance = adapterReportedHardwarePerformance
        self.hardwarePerformanceEvidenceAdmitted = hardwarePerformanceEvidenceAdmitted
        self.evidenceCeiling = evidenceCeiling
    }

    /// Decodes the `evidence` block of a `game_dev.run.v1` manifest.
    public init(runManifestEvidence value: JSONValue) throws {
        guard case let .object(fields) = value else {
            throw EvidenceDecodingFailure.notAnObject
        }
        func flag(_ key: String) throws -> Bool {
            guard case let .bool(value)? = fields[key] else {
                throw EvidenceDecodingFailure.missing(key)
            }
            return value
        }
        guard let rawClass = fields["rendererClass"]?.stringValue,
              let rendererClass = RendererClass(rawValue: rawClass)
        else { throw EvidenceDecodingFailure.missing("rendererClass") }
        guard let ceiling = fields["evidenceCeiling"]?.stringValue, !ceiling.isEmpty else {
            throw EvidenceDecodingFailure.missing("evidenceCeiling")
        }
        self.init(
            rendererClass: rendererClass,
            softwareRasterizedLane: try flag("softwareRasterizedLane"),
            adapterReportedGpuExecution: try flag("adapterReportedGpuExecution"),
            adapterReportedGpuCompletionIdentity: try flag("adapterReportedGpuCompletionIdentity"),
            adapterReportedHardwarePerformance: try flag("adapterReportedHardwarePerformance"),
            hardwarePerformanceEvidenceAdmitted: try flag("hardwarePerformanceEvidenceAdmitted"),
            evidenceCeiling: ceiling
        )
    }

    public enum EvidenceDecodingFailure: Error, LocalizedError, Equatable {
        case notAnObject
        case missing(String)

        public var errorDescription: String? {
            switch self {
            case .notAnObject: "The run manifest's evidence block is not an object."
            case let .missing(field): "The run manifest's evidence block is missing \(field)."
            }
        }
    }

    // MARK: - What the interface is permitted to say

    /// Whether the interface may describe this run as having executed on a GPU.
    ///
    /// False for a software lane even when the adapter claimed otherwise: those claims
    /// were refused, and the refusal is the finding.
    public var mayPresentAsGpuExecution: Bool {
        !softwareRasterizedLane && adapterReportedGpuExecution
    }

    /// Whether timings from this run may be shown as hardware measurements.
    public var mayPresentHardwareTimings: Bool {
        hardwarePerformanceEvidenceAdmitted
    }

    /// A claim the adapter made that the harness then refused, if any. Worth surfacing:
    /// an adapter asserting hardware execution from a CPU renderer is a defect in the
    /// adapter, and silently dropping the claim hides it.
    public var refusedClaims: [String] {
        guard softwareRasterizedLane else { return [] }
        var refused: [String] = []
        if adapterReportedGpuExecution { refused.append("GPU execution") }
        if adapterReportedGpuCompletionIdentity { refused.append("GPU completion identity") }
        if adapterReportedHardwarePerformance { refused.append("hardware timing") }
        return refused
    }

    /// One line stating what this run establishes about its renderer.
    public var rendererSummary: String {
        switch rendererClass {
        case .software:
            "Rendered on the CPU. GPU and timing claims were refused for this run."
        case .hardware:
            adapterReportedGpuExecution
                ? "The adapter reported GPU execution. The harness did not prove it independently."
                : "A hardware renderer was declared, but no GPU execution was reported."
        case .unknown:
            "The adapter did not declare a renderer, so this run establishes nothing about one."
        }
    }
}

/// A non-forgeable token saying an evidence ceiling has been read and will be shown.
///
/// Views that display a capture, a diff or a timing take one of these in their
/// initializer. There is no default value and no way to construct one except from a
/// run's own evidence, so an image cannot reach the screen without the statement of what
/// it does not prove travelling with it. The compiler enforces what a convention would
/// eventually lose.
public struct EvidenceCeiling: Sendable, Hashable {
    public let text: String
    public let evidence: RunEvidence

    public init(_ evidence: RunEvidence) {
        self.text = evidence.evidenceCeiling
        self.evidence = evidence
    }
}
