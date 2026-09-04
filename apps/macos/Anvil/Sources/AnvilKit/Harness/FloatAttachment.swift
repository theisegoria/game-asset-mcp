import Foundation

/// The pixel formats a binary attachment may declare.
public enum FloatPixelFormat: String, Sendable, Hashable, Codable, CaseIterable {
    case r16f
    case r32f
    case rgba32f
    case d32f
    case r32u

    public var label: String {
        switch self {
        case .r16f: "16-bit float"
        case .r32f: "32-bit float"
        case .rgba32f: "32-bit float, RGBA"
        case .d32f: "32-bit depth"
        case .r32u: "32-bit unsigned integer"
        }
    }

    public var bytesPerPixel: Int {
        switch self {
        case .r16f: 2
        case .r32f, .d32f, .r32u: 4
        case .rgba32f: 16
        }
    }
}

/// How to read a binary attachment's bytes.
///
/// Required whenever an attachment's encoding is binary: bytes with no format are
/// sealed, hashed and unreadable, so the contract refuses them. A format on a PNG is
/// refused as the contradiction it is.
public struct FloatFormat: Sendable, Hashable, Codable {
    public let pixelFormat: FloatPixelFormat
    public let width: Int
    public let height: Int
    /// Bytes per row, which is **not** `width * bytesPerPixel` when the API pads — wgpu
    /// aligns copy rows to 256 bytes. Reading by width walks into the padding and
    /// reports it as data.
    public let rowStride: Int
    public let colorSpace: ColorSpace

    public enum ColorSpace: String, Sendable, Hashable, Codable {
        case srgb
        case linear
    }

    public init(
        pixelFormat: FloatPixelFormat,
        width: Int,
        height: Int,
        rowStride: Int,
        colorSpace: ColorSpace = .linear
    ) {
        self.pixelFormat = pixelFormat
        self.width = width
        self.height = height
        self.rowStride = rowStride
        self.colorSpace = colorSpace
    }

    /// True when the rows carry padding beyond the pixel data.
    public var isPadded: Bool { rowStride > width * pixelFormat.bytesPerPixel }

    /// Byte offset of a row. Anything reading these buffers must go through this rather
    /// than multiplying by width.
    public func byteOffset(ofRow row: Int) -> Int { row * rowStride }
}

/// A binary attachment read at capture precision.
///
/// Binary attachments used to be skipped entirely — a float depth buffer was sealed,
/// hashed, and never looked at. These statistics come from the float buffer itself, not
/// from an 8-bit round trip, so they can be trusted next to a preview that cannot be.
public struct FloatRasterAnalysis: Sendable, Hashable, Identifiable {
    public let frameIndex: Int
    public let frameLabel: String?
    public let kind: AttachmentKind
    public let label: String?
    public let path: String
    /// The lossy PNG visualising this buffer, when the adapter linked one.
    public let previewPath: String?
    public let pixelFormat: FloatPixelFormat
    public let width: Int
    public let height: Int
    public let samples: Int
    public let minimum: Double
    public let maximum: Double
    public let mean: Double
    /// Counted, not skipped. A NaN in a depth buffer is a real defect — an
    /// uninitialised clear, a divide by a zero w — and a reader that dropped them would
    /// report a clean range for a broken frame.
    public let nonFiniteSamples: Int

    public var id: String { "\(frameIndex):\(path)" }

    public init(
        frameIndex: Int,
        frameLabel: String? = nil,
        kind: AttachmentKind,
        label: String? = nil,
        path: String,
        previewPath: String? = nil,
        pixelFormat: FloatPixelFormat,
        width: Int,
        height: Int,
        samples: Int,
        minimum: Double,
        maximum: Double,
        mean: Double,
        nonFiniteSamples: Int
    ) {
        self.frameIndex = frameIndex
        self.frameLabel = frameLabel
        self.kind = kind
        self.label = label
        self.path = path
        self.previewPath = previewPath
        self.pixelFormat = pixelFormat
        self.width = width
        self.height = height
        self.samples = samples
        self.minimum = minimum
        self.maximum = maximum
        self.mean = mean
        self.nonFiniteSamples = nonFiniteSamples
    }

    /// A frame carrying non-finite samples has a defect regardless of how its range
    /// reads, so the viewer flags it rather than leaving it to be noticed.
    public var hasNonFiniteSamples: Bool { nonFiniteSamples > 0 }

    /// What to say about the non-finite count, in terms of what usually causes it.
    public var nonFiniteDiagnosis: String? {
        guard hasNonFiniteSamples else { return nil }
        let share = samples > 0 ? Double(nonFiniteSamples) / Double(samples) * 100 : 0
        return String(
            format: """
            %d of %d samples are NaN or infinite (%.2f%%). In a depth buffer that usually \
            means an uninitialised clear or a divide by a zero w. The range below excludes them.
            """,
            nonFiniteSamples, samples, share
        )
    }

    /// Whether a pixel value shown to a person should come from this buffer rather than
    /// from the preview image.
    ///
    /// Always true when a float buffer exists. The preview is lossy by construction — a
    /// visualisation, not the measurement — so reading a probe value off it would report
    /// the picture instead of the data.
    public var isMeasurementSource: Bool { true }

    public init(payload: JSONValue) throws {
        guard case let .object(fields) = payload else {
            throw DecodingFailure.notAnObject
        }
        func number(_ key: String) throws -> Double {
            guard case let .number(value)? = fields[key] else {
                throw DecodingFailure.missing(key)
            }
            return value
        }
        guard let rawFormat = fields["pixelFormat"]?.stringValue,
              let pixelFormat = FloatPixelFormat(rawValue: rawFormat)
        else { throw DecodingFailure.missing("pixelFormat") }
        guard let rawKind = fields["kind"]?.stringValue,
              let kind = AttachmentKind(rawValue: rawKind)
        else { throw DecodingFailure.missing("kind") }
        guard let path = fields["path"]?.stringValue else {
            throw DecodingFailure.missing("path")
        }

        self.init(
            frameIndex: Int(try number("frameIndex")),
            frameLabel: fields["frameLabel"]?.stringValue,
            kind: kind,
            label: fields["label"]?.stringValue,
            path: path,
            previewPath: fields["previewPath"]?.stringValue,
            pixelFormat: pixelFormat,
            width: Int(try number("width")),
            height: Int(try number("height")),
            samples: Int(try number("samples")),
            minimum: try number("minimum"),
            maximum: try number("maximum"),
            mean: try number("mean"),
            nonFiniteSamples: Int(try number("nonFiniteSamples"))
        )
    }

    public enum DecodingFailure: Error, LocalizedError, Equatable {
        case notAnObject
        case missing(String)

        public var errorDescription: String? {
            switch self {
            case .notAnObject: "A float raster entry is not an object."
            case let .missing(field): "A float raster entry is missing \(field)."
            }
        }
    }
}
