import Foundation

/// One line of a `game_dev.event.v1` JSON Lines stream, as defined by
/// `src/cli/events.ts`.
///
/// The wire format mixes conventions deliberately: the envelope keys are snake_case
/// (`event_id`, `job_id`) while `data` payloads are camelCase. Explicit `CodingKeys`
/// encode that rather than a module-wide key strategy, which would corrupt `data`.
public struct GameDevEvent: Equatable, Sendable, Identifiable {
    public static let schema = "game_dev.event.v1"

    public enum Kind: String, Codable, Sendable, CaseIterable {
        case started
        case progress
        case artifact
        case warning
        case approvalRequired = "approval_required"
        case completed
        case failed
        case cancelled

        /// The three types that end a stream. Exactly one must arrive.
        public static let terminal: Set<Kind> = [.completed, .failed, .approvalRequired]

        public var isTerminal: Bool { Self.terminal.contains(self) }
    }

    public let eventID: String
    public let jobID: String
    public let sequence: Int
    public let timestamp: Date
    public let kind: Kind
    public let operation: String
    public let data: [String: JSONValue]

    public var id: String { eventID }

    public init(
        eventID: String,
        jobID: String,
        sequence: Int,
        timestamp: Date,
        kind: Kind,
        operation: String,
        data: [String: JSONValue]
    ) {
        self.eventID = eventID
        self.jobID = jobID
        self.sequence = sequence
        self.timestamp = timestamp
        self.kind = kind
        self.operation = operation
        self.data = data
    }
}

extension GameDevEvent: Decodable {
    private enum CodingKeys: String, CodingKey {
        case schema
        case eventID = "event_id"
        case jobID = "job_id"
        case sequence
        case timestamp
        case kind = "type"
        case operation
        case data
    }

    public enum DecodingFailure: Error, LocalizedError, Equatable {
        case unexpectedSchema(String)
        case unknownKind(String)
        case malformedTimestamp(String)

        public var errorDescription: String? {
            switch self {
            case let .unexpectedSchema(found):
                "Expected a \(GameDevEvent.schema) line but received schema \(found)."
            case let .unknownKind(found):
                "The runtime emitted an unrecognized event type: \(found)."
            case let .malformedTimestamp(found):
                "The runtime emitted an unparsable event timestamp: \(found)."
            }
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        let schema = try container.decode(String.self, forKey: .schema)
        guard schema == Self.schema else {
            throw DecodingFailure.unexpectedSchema(schema)
        }

        let rawKind = try container.decode(String.self, forKey: .kind)
        guard let kind = Kind(rawValue: rawKind) else {
            // Fail loudly rather than dropping the line. A type this build does not know
            // is a contract change, and silently skipping it would strand a stream that
            // ended on an unrecognized terminal event.
            throw DecodingFailure.unknownKind(rawKind)
        }

        let rawTimestamp = try container.decode(String.self, forKey: .timestamp)
        guard let timestamp = Self.parseTimestamp(rawTimestamp) else {
            throw DecodingFailure.malformedTimestamp(rawTimestamp)
        }

        self.init(
            eventID: try container.decode(String.self, forKey: .eventID),
            jobID: try container.decode(String.self, forKey: .jobID),
            sequence: try container.decode(Int.self, forKey: .sequence),
            timestamp: timestamp,
            kind: kind,
            operation: try container.decode(String.self, forKey: .operation),
            data: try container.decodeIfPresent([String: JSONValue].self, forKey: .data) ?? [:]
        )
    }

    /// The CLI writes `new Date().toISOString()`, which always carries milliseconds.
    /// Replayed durable events were written by an earlier process, so accept the
    /// fractionless form too rather than failing on a historically valid line.
    private static func parseTimestamp(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }
}

public extension GameDevEvent {
    /// Returns a copy with every known secret removed from `data`.
    ///
    /// Events are persisted to the run log and rendered in the UI, so they pass through
    /// the same redaction the buffered transport applies to a result envelope. Envelope
    /// fields are runtime-generated identifiers and cannot contain a credential.
    func redacting(_ secrets: [String]) -> GameDevEvent {
        guard !secrets.isEmpty else { return self }
        guard case let .object(redacted) = JSONValue.object(data).redacting(secrets) else {
            return self
        }
        return GameDevEvent(
            eventID: eventID,
            jobID: jobID,
            sequence: sequence,
            timestamp: timestamp,
            kind: kind,
            operation: operation,
            data: redacted
        )
    }

    /// Cancellation reaches the client as a `failed` event carrying this error code —
    /// the declared `cancelled` type is never emitted by the current CLI
    /// (`src/cli.ts:1271`). Both forms are treated as cancellation.
    static let cancellationErrorCode = "CANCELLED"

    var isCancellation: Bool {
        kind == .cancelled
            || (kind == .failed && data["error"]?.stringValue == Self.cancellationErrorCode)
    }

    /// `artifact` events carry `{ kind, path, ... }`; the extra fields differ per kind
    /// (`runId`/`manifestSha256` for a run bundle, `packageId` for a package, and so on).
    var artifact: RunArtifact? {
        guard kind == .artifact,
              let artifactKind = data["kind"]?.stringValue,
              let path = data["path"]?.stringValue
        else { return nil }
        return RunArtifact(
            kind: artifactKind,
            path: path,
            sha256: data["sha256"]?.stringValue,
            details: data.filter { !["kind", "path", "sha256"].contains($0.key) }
        )
    }

    /// A human-readable line for the run log. Falls back to the raw payload so a new
    /// `data` shape degrades to something readable rather than to nothing.
    var summary: String {
        if let message = data["message"]?.stringValue { return message }
        if let phase = data["phase"]?.stringValue {
            if let status = data["status"]?.stringValue { return "\(phase) — \(status)" }
            return phase
        }
        if let status = data["status"]?.stringValue { return status }
        if let artifact { return "\(artifact.kind) → \(artifact.path)" }
        if let error = data["error"]?.stringValue { return error }
        switch kind {
        case .started: return "Started \(operation)"
        case .completed: return "Completed \(operation)"
        default: return operation
        }
    }
}

/// A file the runtime reported writing during a run.
public struct RunArtifact: Equatable, Sendable, Identifiable {
    /// One of the kinds the CLI emits: `run_bundle`, `usdz_preview`, `asset_package`,
    /// `visual_comparison`, and the durable-job kinds `run_manifest`, `manifest`,
    /// `receipt`, `optimization_goal`, `codex_skill`.
    public let kind: String
    public let path: String
    public let sha256: String?
    public let details: [String: JSONValue]

    public var id: String { "\(kind):\(path)" }
    public var url: URL { URL(fileURLWithPath: path) }

    public init(
        kind: String,
        path: String,
        sha256: String? = nil,
        details: [String: JSONValue] = [:]
    ) {
        self.kind = kind
        self.path = path
        self.sha256 = sha256
        self.details = details
    }
}

extension RunArtifact: Hashable {
    // Identity is the kind and path the runtime reported, plus its digest when it gave
    // one. `details` carries per-kind extras whose values are not hashable and which do
    // not distinguish one artifact from another.
    public func hash(into hasher: inout Hasher) {
        hasher.combine(kind)
        hasher.combine(path)
        hasher.combine(sha256)
    }
}
