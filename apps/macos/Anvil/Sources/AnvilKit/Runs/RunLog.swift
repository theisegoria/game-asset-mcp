import Foundation

/// On-disk persistence for runs, so history survives quitting the app.
///
/// One directory per run under Application Support: `run.json` for the record and
/// `events.jsonl` for the stream, appended as events arrive. Mirrors the runtime's own
/// durable-job layout deliberately — a run that is interrupted mid-flight is exactly the
/// case where the record has to already be on disk.
public struct RunLog: Sendable {
    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    public static func defaultRoot(
        bundleIdentifier: String = "com.theisegoria.Anvil"
    ) throws -> URL {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return support
            .appendingPathComponent(bundleIdentifier, isDirectory: true)
            .appendingPathComponent("runs", isDirectory: true)
    }

    private func directory(for id: RunID) -> URL {
        root.appendingPathComponent(id.description, isDirectory: true)
    }

    public func prepare() throws {
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: 0o700)]
        )
    }

    /// Writes the run record. Atomic, so a crash mid-write cannot leave a half-record
    /// that then fails to load and takes the run's history with it.
    public func save(_ run: Run) throws {
        let directory = directory(for: run.id)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: 0o700)]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(RunRecord(run))
        try data.write(to: directory.appendingPathComponent("run.json"), options: .atomic)
    }

    /// Appends one event. Opened for appending rather than rewritten, so the cost of a
    /// long stream does not grow with its length.
    public func append(_ event: GameDevEvent, to id: RunID) throws {
        let url = directory(for: id).appendingPathComponent("events.jsonl")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        var line = try encoder.encode(PersistedEvent(event))
        line.append(0x0A)

        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
        } else {
            try FileManager.default.createDirectory(
                at: directory(for: id),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: NSNumber(value: 0o700)]
            )
            try line.write(to: url, options: .atomic)
        }
    }

    /// Loads every persisted run, newest first.
    ///
    /// A run whose record will not decode is skipped rather than aborting the load, but
    /// it is reported: silently dropping one would hide a paid job that is still in
    /// flight, which is the single worst thing this store could do.
    public func loadAll() throws -> (runs: [Run], skipped: [String]) {
        guard FileManager.default.fileExists(atPath: root.path) else { return ([], []) }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        var runs: [Run] = []
        var skipped: [String] = []
        for entry in try FileManager.default.contentsOfDirectory(atPath: root.path).sorted() {
            let recordURL = root
                .appendingPathComponent(entry, isDirectory: true)
                .appendingPathComponent("run.json")
            guard let data = try? Data(contentsOf: recordURL) else { continue }
            guard let record = try? decoder.decode(RunRecord.self, from: data) else {
                skipped.append(entry)
                continue
            }
            runs.append(record.run)
        }
        return (runs.sorted { $0.createdAt > $1.createdAt }, skipped)
    }

    /// Reads a run's persisted events, for reopening a finished run's timeline without
    /// holding every event of every run in memory.
    public func events(for id: RunID) throws -> [GameDevEvent] {
        let url = directory(for: id).appendingPathComponent("events.jsonl")
        guard let data = try? Data(contentsOf: url) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return data.split(separator: 0x0A).compactMap { line in
            try? decoder.decode(PersistedEvent.self, from: Data(line)).event
        }
    }

    public func delete(_ id: RunID) throws {
        try FileManager.default.removeItem(at: directory(for: id))
    }
}

/// The persisted shape of a run. Separate from ``Run`` so the in-memory model can hold
/// the full event list while the record on disk stays small — events live in the
/// sidecar, not in `run.json`.
struct RunRecord: Codable {
    let id: RunID
    let commandID: String
    let title: String
    let arguments: [String]
    let outputDirectory: String
    let createdAt: Date
    let state: RunState
    let startedAt: Date?
    let finishedAt: Date?
    let durableJobID: String?
    let assetJobIDs: [String]
    let artifacts: [PersistedArtifact]
    let envelope: CLIResultEnvelope?
    let approval: ApprovalRecord?
    let standardErrorTail: String

    init(_ run: Run) {
        id = run.id
        commandID = run.commandID
        title = run.title
        arguments = run.arguments
        outputDirectory = run.outputDirectory.path
        createdAt = run.createdAt
        state = run.state
        startedAt = run.startedAt
        finishedAt = run.finishedAt
        durableJobID = run.durableJobID
        assetJobIDs = run.assetJobIDs
        artifacts = run.artifacts.map(PersistedArtifact.init)
        envelope = run.envelope
        approval = run.approval
        standardErrorTail = run.standardErrorTail
    }

    var run: Run {
        var value = Run(
            id: id,
            commandID: commandID,
            title: title,
            arguments: arguments,
            outputDirectory: URL(fileURLWithPath: outputDirectory),
            createdAt: createdAt,
            state: state,
            approval: approval
        )
        value.startedAt = startedAt
        value.finishedAt = finishedAt
        value.durableJobID = durableJobID
        value.assetJobIDs = assetJobIDs
        value.artifacts = artifacts.map(\.artifact)
        value.envelope = envelope
        value.standardErrorTail = standardErrorTail
        return value
    }
}

struct PersistedArtifact: Codable {
    let kind: String
    let path: String
    let sha256: String?

    init(_ artifact: RunArtifact) {
        kind = artifact.kind
        path = artifact.path
        sha256 = artifact.sha256
    }

    var artifact: RunArtifact {
        RunArtifact(kind: kind, path: path, sha256: sha256)
    }
}

/// `GameDevEvent` decodes the runtime's wire format but does not encode it; this writes
/// a round-trippable form for the local log.
struct PersistedEvent: Codable {
    let eventID: String
    let jobID: String
    let sequence: Int
    let timestamp: Date
    let kind: String
    let operation: String
    let data: [String: JSONValue]

    init(_ event: GameDevEvent) {
        eventID = event.eventID
        jobID = event.jobID
        sequence = event.sequence
        timestamp = event.timestamp
        kind = event.kind.rawValue
        operation = event.operation
        data = event.data
    }

    var event: GameDevEvent {
        GameDevEvent(
            eventID: eventID,
            jobID: jobID,
            sequence: sequence,
            timestamp: timestamp,
            kind: GameDevEvent.Kind(rawValue: kind) ?? .warning,
            operation: operation,
            data: data
        )
    }
}
