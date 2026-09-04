import Foundation

extension ComparisonPair.SemanticRegion {
    init(payload fields: [String: JSONValue]) throws {
        func number(_ key: String) -> Double {
            if case let .number(value)? = fields[key] { return value }
            return 0
        }
        guard let objectID = fields["objectId"]?.stringValue else {
            throw VisualComparison.DecodingFailure.missing("semanticRegions[].objectId")
        }
        self.init(
            objectID: objectID,
            pixels: Int(number("pixels")),
            meanAbsoluteError: number("meanAbsoluteError"),
            changedPixelRatio: number("changedPixelRatio"),
            pixelsRetained: Int(number("pixelsRetained")),
            pixelsLost: Int(number("pixelsLost")),
            pixelsGained: Int(number("pixelsGained"))
        )
    }
}

extension ComparisonPair {
    init(payload: JSONValue) throws {
        guard case let .object(fields) = payload else {
            throw VisualComparison.DecodingFailure.missing("pairs[]")
        }
        func optionalNumber(_ key: String) -> Double? {
            if case let .number(value)? = fields[key] { return value }
            return nil
        }
        func strings(_ key: String) -> [String] {
            guard case let .array(raw)? = fields[key] else { return [] }
            return raw.compactMap(\.stringValue)
        }
        guard let identity = fields["identity"]?.stringValue else {
            throw VisualComparison.DecodingFailure.missing("pairs[].identity")
        }
        guard let rawKind = fields["kind"]?.stringValue else {
            throw VisualComparison.DecodingFailure.missing("pairs[].kind")
        }
        // An attachment kind this build does not know is shown as custom rather than
        // refused: the pixels are still worth looking at, and the label says the viewer
        // does not interpret it.
        let kind = AttachmentKind(rawValue: rawKind) ?? .custom
        guard case let .bool(comparable)? = fields["comparable"] else {
            throw VisualComparison.DecodingFailure.missing("pairs[].comparable")
        }

        var regions: [SemanticRegion] = []
        if case let .array(raw)? = fields["semanticRegions"] {
            for entry in raw {
                if case let .object(regionFields) = entry {
                    regions.append(try SemanticRegion(payload: regionFields))
                }
            }
        }
        var window: SSIMWindow?
        if case let .object(raw)? = fields["worstSSIMWindow"],
           case let .number(x)? = raw["x"],
           case let .number(y)? = raw["y"],
           case let .number(ssim)? = raw["ssim"] {
            window = SSIMWindow(x: Int(x), y: Int(y), ssim: ssim)
        }

        self.init(
            identity: identity,
            kind: kind,
            comparable: comparable,
            baselinePath: fields["baselinePath"]?.stringValue ?? "",
            candidatePath: fields["candidatePath"]?.stringValue ?? "",
            width: optionalNumber("width").map(Int.init),
            height: optionalNumber("height").map(Int.init),
            meanAbsoluteError: optionalNumber("meanAbsoluteError"),
            rootMeanSquaredError: optionalNumber("rootMeanSquaredError"),
            maximumChannelDelta: optionalNumber("maximumChannelDelta"),
            changedPixelRatio: optionalNumber("changedPixelRatio"),
            meanLuminanceDelta: optionalNumber("meanLuminanceDelta"),
            meanAbsoluteEdgeDelta: optionalNumber("meanAbsoluteEdgeDelta"),
            meanSSIM: optionalNumber("meanSSIM"),
            worstSSIMWindow: window,
            semanticRegions: regions,
            objectsAppeared: strings("objectsAppeared"),
            objectsDisappeared: strings("objectsDisappeared"),
            heatmapPath: fields["heatmapPath"]?.stringValue,
            reason: fields["reason"]?.stringValue
        )
    }
}

extension VisualComparison {
    public static let schema = "game_dev.visual_comparison.v1"

    public enum DecodingFailure: Error, LocalizedError, Equatable {
        case notAnObject
        case unexpectedSchema(String?)
        case missing(String)
        case unknownVerdict(String)

        public var errorDescription: String? {
            switch self {
            case .notAnObject: "The comparison result is not an object."
            case let .unexpectedSchema(found):
                "Expected a \(VisualComparison.schema) result but received \(found ?? "no schema")."
            case let .missing(field): "The comparison result is missing \(field)."
            case let .unknownVerdict(found):
                "The comparison reports a verdict this version of Anvil does not recognize: \(found)."
            }
        }
    }

    /// Decodes the `data` of a `visual.compare` result.
    public init(payload: JSONValue) throws {
        guard case let .object(fields) = payload else { throw DecodingFailure.notAnObject }
        guard fields["schema"]?.stringValue == Self.schema else {
            throw DecodingFailure.unexpectedSchema(fields["schema"]?.stringValue)
        }
        guard let baseline = fields["baselineRunId"]?.stringValue else {
            throw DecodingFailure.missing("baselineRunId")
        }
        guard let candidate = fields["candidateRunId"]?.stringValue else {
            throw DecodingFailure.missing("candidateRunId")
        }
        guard let rawVerdict = fields["verdict"]?.stringValue else {
            throw DecodingFailure.missing("verdict")
        }
        // A verdict this build does not know is refused rather than mapped to a
        // neighbour: "changed" and "incomparable" mean different things, and guessing
        // between them would state a finding the harness did not make.
        guard let verdict = ComparisonVerdict(rawValue: rawVerdict) else {
            throw DecodingFailure.unknownVerdict(rawVerdict)
        }
        guard let ceiling = fields["evidenceCeiling"]?.stringValue, !ceiling.isEmpty else {
            throw DecodingFailure.missing("evidenceCeiling")
        }

        var threshold = 0
        if case let .number(value)? = fields["threshold"] { threshold = Int(value) }
        var pairs: [ComparisonPair] = []
        if case let .array(raw)? = fields["pairs"] {
            pairs = try raw.map(ComparisonPair.init(payload:))
        }
        func strings(_ key: String) -> [String] {
            guard case let .array(raw)? = fields[key] else { return [] }
            return raw.compactMap(\.stringValue)
        }
        var regionsCompared = false
        var heatmaps = false
        if case let .object(evidence)? = fields["evidence"] {
            if case let .bool(value)? = evidence["semanticObjectRegionsCompared"] { regionsCompared = value }
            if case let .bool(value)? = evidence["heatmapsGenerated"] { heatmaps = value }
        }

        self.init(
            baselineRunID: baseline,
            candidateRunID: candidate,
            threshold: threshold,
            pairs: pairs,
            verdict: verdict,
            summary: strings("summary"),
            unmatchedBaseline: strings("unmatchedBaseline"),
            unmatchedCandidate: strings("unmatchedCandidate"),
            outputPath: fields["outputPath"]?.stringValue,
            evidenceCeiling: ceiling,
            semanticObjectRegionsCompared: regionsCompared,
            heatmapsGenerated: heatmaps
        )
    }

    /// The evidence a comparison carries, in the shape the viewers require.
    ///
    /// A comparison is not a run, so it has no renderer class of its own; what it
    /// establishes is that two sealed runs were verified and compared deterministically.
    /// Everything about GPU execution or timing stays refused here, because a diff
    /// proves nothing about either.
    public var evidence: RunEvidence {
        RunEvidence(
            rendererClass: .unknown,
            softwareRasterizedLane: false,
            adapterReportedGpuExecution: false,
            adapterReportedGpuCompletionIdentity: false,
            adapterReportedHardwarePerformance: false,
            hardwarePerformanceEvidenceAdmitted: false,
            evidenceCeiling: evidenceCeiling
        )
    }
}
