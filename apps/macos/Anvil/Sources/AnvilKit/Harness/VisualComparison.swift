import Foundation

/// The worst outcome across a comparison, or across one attachment pair.
public enum ComparisonVerdict: String, Sendable, Hashable, Codable, CaseIterable {
    case identical
    case withinTolerance = "within-tolerance"
    case changed
    /// The pair could not be compared at all — a resolution change, or an attachment
    /// present on one side only. Distinct from `changed`: nothing was measured, so
    /// reporting it as a difference would invent a finding.
    case incomparable

    public var label: String {
        switch self {
        case .identical: "Identical"
        case .withinTolerance: "Within tolerance"
        case .changed: "Changed"
        case .incomparable: "Not comparable"
        }
    }
}

/// One attachment compared between two sealed runs.
public struct ComparisonPair: Sendable, Hashable, Identifiable {
    public let identity: String
    public let kind: AttachmentKind
    public let comparable: Bool
    public let baselinePath: String
    public let candidatePath: String
    public let width: Int?
    public let height: Int?
    public let meanAbsoluteError: Double?
    public let rootMeanSquaredError: Double?
    public let maximumChannelDelta: Double?
    public let changedPixelRatio: Double?
    public let meanLuminanceDelta: Double?
    public let meanAbsoluteEdgeDelta: Double?
    /// Structural similarity, 1.0 for identical. Separates a uniform brightness shift
    /// from one object becoming unrecognisable — which a mean error cannot, because both
    /// can produce the same average.
    public let meanSSIM: Double?
    public let worstSSIMWindow: SSIMWindow?
    public let semanticRegions: [SemanticRegion]
    /// Object ids in the candidate that were not in the baseline.
    public let objectsAppeared: [String]
    /// Object ids in the baseline that are gone. Usually the actual finding.
    public let objectsDisappeared: [String]
    public let heatmapPath: String?
    /// Why a pair is not comparable, when it is not.
    public let reason: String?

    public var id: String { identity }

    public struct SSIMWindow: Sendable, Hashable, Codable {
        public let x: Int
        public let y: Int
        public let ssim: Double

        public init(x: Int, y: Int, ssim: Double) {
            self.x = x
            self.y = y
            self.ssim = ssim
        }
    }

    public struct SemanticRegion: Sendable, Hashable, Identifiable {
        public let objectID: String
        public let pixels: Int
        public let meanAbsoluteError: Double
        public let changedPixelRatio: Double
        /// Pixels this object still covers in the candidate.
        public let pixelsRetained: Int
        /// Pixels it covered in the baseline and no longer does.
        public let pixelsLost: Int
        /// Pixels it covers now and did not before.
        public let pixelsGained: Int

        public var id: String { objectID }

        public init(
            objectID: String,
            pixels: Int,
            meanAbsoluteError: Double,
            changedPixelRatio: Double,
            pixelsRetained: Int,
            pixelsLost: Int,
            pixelsGained: Int
        ) {
            self.objectID = objectID
            self.pixels = pixels
            self.meanAbsoluteError = meanAbsoluteError
            self.changedPixelRatio = changedPixelRatio
            self.pixelsRetained = pixelsRetained
            self.pixelsLost = pixelsLost
            self.pixelsGained = pixelsGained
        }

        /// True when this object moved rather than merely changed shade: it lost and
        /// gained coverage in comparable amounts.
        public var suggestsMovement: Bool {
            pixelsLost > 0 && pixelsGained > 0
        }
    }

    public init(
        identity: String,
        kind: AttachmentKind,
        comparable: Bool,
        baselinePath: String,
        candidatePath: String,
        width: Int? = nil,
        height: Int? = nil,
        meanAbsoluteError: Double? = nil,
        rootMeanSquaredError: Double? = nil,
        maximumChannelDelta: Double? = nil,
        changedPixelRatio: Double? = nil,
        meanLuminanceDelta: Double? = nil,
        meanAbsoluteEdgeDelta: Double? = nil,
        meanSSIM: Double? = nil,
        worstSSIMWindow: SSIMWindow? = nil,
        semanticRegions: [SemanticRegion] = [],
        objectsAppeared: [String] = [],
        objectsDisappeared: [String] = [],
        heatmapPath: String? = nil,
        reason: String? = nil
    ) {
        self.identity = identity
        self.kind = kind
        self.comparable = comparable
        self.baselinePath = baselinePath
        self.candidatePath = candidatePath
        self.width = width
        self.height = height
        self.meanAbsoluteError = meanAbsoluteError
        self.rootMeanSquaredError = rootMeanSquaredError
        self.maximumChannelDelta = maximumChannelDelta
        self.changedPixelRatio = changedPixelRatio
        self.meanLuminanceDelta = meanLuminanceDelta
        self.meanAbsoluteEdgeDelta = meanAbsoluteEdgeDelta
        self.meanSSIM = meanSSIM
        self.worstSSIMWindow = worstSSIMWindow
        self.semanticRegions = semanticRegions
        self.objectsAppeared = objectsAppeared
        self.objectsDisappeared = objectsDisappeared
        self.heatmapPath = heatmapPath
        self.reason = reason
    }

    /// This pair's own verdict, derived the same way the harness derives the overall one.
    public var verdict: ComparisonVerdict {
        guard comparable else { return .incomparable }
        guard let changed = changedPixelRatio else { return .incomparable }
        if changed == 0 { return .identical }
        return (meanAbsoluteError ?? 0) > 0 ? .changed : .withinTolerance
    }

    /// Regions worth looking at first: largest error, then largest area.
    public var rankedRegions: [SemanticRegion] {
        semanticRegions.sorted {
            $0.meanAbsoluteError != $1.meanAbsoluteError
                ? $0.meanAbsoluteError > $1.meanAbsoluteError
                : $0.pixels > $1.pixels
        }
    }
}

/// A diff between two sealed runs.
public struct VisualComparison: Sendable, Hashable {
    public let baselineRunID: String
    public let candidateRunID: String
    public let threshold: Int
    public let pairs: [ComparisonPair]
    public let verdict: ComparisonVerdict
    /// The same numbers, in sentences, derived deterministically by the harness — no
    /// model and no network. Shown verbatim: a caller should not have to know that a low
    /// edge delta beside a large luminance shift means shading rather than geometry.
    public let summary: [String]
    /// Attachments present in one run only. Not a difference — nothing was measured.
    public let unmatchedBaseline: [String]
    public let unmatchedCandidate: [String]
    public let outputPath: String?
    public let evidenceCeiling: String
    /// True when the harness compared object-id regions. False means the semantic
    /// breakdown is absent, not that nothing moved.
    public let semanticObjectRegionsCompared: Bool
    public let heatmapsGenerated: Bool

    public init(
        baselineRunID: String,
        candidateRunID: String,
        threshold: Int,
        pairs: [ComparisonPair],
        verdict: ComparisonVerdict,
        summary: [String],
        unmatchedBaseline: [String] = [],
        unmatchedCandidate: [String] = [],
        outputPath: String? = nil,
        evidenceCeiling: String,
        semanticObjectRegionsCompared: Bool = false,
        heatmapsGenerated: Bool = false
    ) {
        self.baselineRunID = baselineRunID
        self.candidateRunID = candidateRunID
        self.threshold = threshold
        self.pairs = pairs
        self.verdict = verdict
        self.summary = summary
        self.unmatchedBaseline = unmatchedBaseline
        self.unmatchedCandidate = unmatchedCandidate
        self.outputPath = outputPath
        self.evidenceCeiling = evidenceCeiling
        self.semanticObjectRegionsCompared = semanticObjectRegionsCompared
        self.heatmapsGenerated = heatmapsGenerated
    }

    /// What this comparison establishes, and what it does not.
    ///
    /// The harness records `artisticDefectsDiagnosed: false` and
    /// `causalAttributionEstablished: false` as literals it cannot set true. A diff says
    /// pixels changed; it never says why, and never that the change is wrong.
    public var provesCause: Bool { false }
    public var judgesQuality: Bool { false }

    /// Pairs that could not be compared, with the reason. Kept apart from changed pairs
    /// so an unmeasurable attachment is never counted as a difference.
    public var incomparablePairs: [ComparisonPair] {
        pairs.filter { !$0.comparable }
    }

    public var changedPairs: [ComparisonPair] {
        pairs.filter { $0.verdict == .changed }
    }

    /// True when either run held an attachment the other did not. Worth surfacing:
    /// it usually means the two runs are not the same scenario.
    public var hasUnmatchedAttachments: Bool {
        !unmatchedBaseline.isEmpty || !unmatchedCandidate.isEmpty
    }
}
