import Foundation

/// Per-channel statistics for one decoded raster attachment.
public struct RasterAnalysis: Sendable, Hashable, Identifiable {
    public let frameIndex: Int
    public let frameLabel: String?
    public let kind: AttachmentKind
    public let label: String?
    public let path: String
    public let width: Int
    public let height: Int
    public let minimum: [Double]
    public let maximum: [Double]
    public let mean: [Double]
    public let meanLuminance: Double
    public let alphaCoverage: Double
    /// Present for semantic buffers: how many distinct ids the frame contains.
    public let uniqueSemanticIDs: Int?

    public var id: String { "\(frameIndex):\(path)" }

    public init(
        frameIndex: Int,
        frameLabel: String? = nil,
        kind: AttachmentKind,
        label: String? = nil,
        path: String,
        width: Int,
        height: Int,
        minimum: [Double],
        maximum: [Double],
        mean: [Double],
        meanLuminance: Double,
        alphaCoverage: Double,
        uniqueSemanticIDs: Int? = nil
    ) {
        self.frameIndex = frameIndex
        self.frameLabel = frameLabel
        self.kind = kind
        self.label = label
        self.path = path
        self.width = width
        self.height = height
        self.minimum = minimum
        self.maximum = maximum
        self.mean = mean
        self.meanLuminance = meanLuminance
        self.alphaCoverage = alphaCoverage
        self.uniqueSemanticIDs = uniqueSemanticIDs
    }

    /// True when every channel has the same value everywhere: a cleared-but-never-drawn
    /// attachment, which usually means a pass did not run.
    public var isFlat: Bool {
        zip(minimum, maximum).allSatisfy { $0 == $1 }
    }

    public var displayName: String {
        label.map { "\(kind.label) · \($0)" } ?? kind.label
    }

    init(payload: JSONValue) throws {
        guard case let .object(fields) = payload else {
            throw CaptureAnalysis.DecodingFailure.missing("rasters[]")
        }
        func number(_ key: String) throws -> Double {
            guard case let .number(value)? = fields[key] else {
                throw CaptureAnalysis.DecodingFailure.missing("rasters[].\(key)")
            }
            return value
        }
        func vector(_ key: String, in channels: [String: JSONValue]) -> [Double] {
            guard case let .array(raw)? = channels[key] else { return [] }
            return raw.compactMap { if case let .number(value) = $0 { value } else { nil } }
        }
        guard let rawKind = fields["kind"]?.stringValue else {
            throw CaptureAnalysis.DecodingFailure.missing("rasters[].kind")
        }
        guard let path = fields["path"]?.stringValue else {
            throw CaptureAnalysis.DecodingFailure.missing("rasters[].path")
        }
        var channels: [String: JSONValue] = [:]
        if case let .object(raw)? = fields["channels"] { channels = raw }
        var unique: Int?
        if case let .number(value)? = fields["uniqueSemanticIds"] { unique = Int(value) }

        self.init(
            frameIndex: Int(try number("frameIndex")),
            frameLabel: fields["frameLabel"]?.stringValue,
            kind: AttachmentKind(rawValue: rawKind) ?? .custom,
            label: fields["label"]?.stringValue,
            path: path,
            width: Int(try number("width")),
            height: Int(try number("height")),
            minimum: vector("minimum", in: channels),
            maximum: vector("maximum", in: channels),
            mean: vector("mean", in: channels),
            meanLuminance: try number("meanLuminance"),
            alphaCoverage: try number("alphaCoverage"),
            uniqueSemanticIDs: unique
        )
    }
}

/// Everything `visual analyze` measured about one sealed run.
public struct CaptureAnalysis: Sendable, Hashable {
    public static let schema = "game_dev.visual_analysis.v1"

    public let runID: String
    public let runPath: String
    public let adapterID: String
    public let scenarioID: String
    public let rasters: [RasterAnalysis]
    public let floatRasters: [FloatRasterAnalysis]
    public let evidenceCeiling: String

    public init(
        runID: String,
        runPath: String,
        adapterID: String,
        scenarioID: String,
        rasters: [RasterAnalysis],
        floatRasters: [FloatRasterAnalysis],
        evidenceCeiling: String
    ) {
        self.runID = runID
        self.runPath = runPath
        self.adapterID = adapterID
        self.scenarioID = scenarioID
        self.rasters = rasters
        self.floatRasters = floatRasters
        self.evidenceCeiling = evidenceCeiling
    }

    public enum DecodingFailure: Error, LocalizedError, Equatable {
        case notAnObject
        case unexpectedSchema(String?)
        case missing(String)

        public var errorDescription: String? {
            switch self {
            case .notAnObject: "The capture analysis is not an object."
            case let .unexpectedSchema(found):
                "Expected a \(CaptureAnalysis.schema) result but received \(found ?? "no schema")."
            case let .missing(field): "The capture analysis is missing \(field)."
            }
        }
    }

    /// Decodes the `data` of a `visual analyze` result.
    public init(payload: JSONValue) throws {
        guard case let .object(fields) = payload else { throw DecodingFailure.notAnObject }
        guard fields["schema"]?.stringValue == Self.schema else {
            throw DecodingFailure.unexpectedSchema(fields["schema"]?.stringValue)
        }
        func string(_ key: String) throws -> String {
            guard let value = fields[key]?.stringValue else { throw DecodingFailure.missing(key) }
            return value
        }
        var rasters: [RasterAnalysis] = []
        if case let .array(raw)? = fields["rasters"] {
            rasters = try raw.map(RasterAnalysis.init(payload:))
        }
        var floats: [FloatRasterAnalysis] = []
        if case let .array(raw)? = fields["floatRasters"] {
            floats = try raw.map(FloatRasterAnalysis.init(payload:))
        }
        self.init(
            runID: try string("runId"),
            runPath: try string("runPath"),
            adapterID: (try? string("adapterId")) ?? "",
            scenarioID: (try? string("scenarioId")) ?? "",
            rasters: rasters,
            floatRasters: floats,
            evidenceCeiling: try string("evidenceCeiling")
        )
    }

    /// Frame indices present, in order.
    public var frameIndices: [Int] {
        Array(Set(rasters.map(\.frameIndex) + floatRasters.map(\.frameIndex))).sorted()
    }

    public func rasters(inFrame index: Int) -> [RasterAnalysis] {
        rasters.filter { $0.frameIndex == index }
    }

    public func floatRasters(inFrame index: Int) -> [FloatRasterAnalysis] {
        floatRasters.filter { $0.frameIndex == index }
    }

    /// Attachments that look never-drawn. Worth calling out: a flat depth or normal
    /// buffer usually means a pass did not run, which the colour frame may hide.
    public var flatRasters: [RasterAnalysis] { rasters.filter(\.isFlat) }

    /// The evidence an analysis carries, for the viewers. Analysing a capture decodes
    /// its bytes; it establishes nothing about the renderer, so those claims stay refused.
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
