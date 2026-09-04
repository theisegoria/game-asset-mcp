import Foundation

/// A decoded `game_dev.doctor.v1` payload.
///
/// The CLI emits this from `game-dev doctor --json`. Anvil decodes it into named fields
/// rather than reading a generic tree, so a renamed or dropped check surfaces as a
/// decoding failure instead of an empty panel.
public struct DoctorReport: Equatable, Sendable {
    public static let schema = "game_dev.doctor.v1"

    public enum CheckStatus: String, Codable, Sendable, CaseIterable {
        case pass
        case warning
        case fail
        case unavailable
    }

    public struct Check: Equatable, Sendable, Identifiable {
        public let id: String
        public let status: CheckStatus
        public let detail: String
        /// Free-form per-check evidence. `workspace` carries every path Anvil needs
        /// (`jobsDir`, `durableJobsDir`, `packagesDir`, `catalogPath`, `runsDir`).
        public let evidence: [String: JSONValue]

        public init(
            id: String,
            status: CheckStatus,
            detail: String,
            evidence: [String: JSONValue] = [:]
        ) {
            self.id = id
            self.status = status
            self.detail = detail
            self.evidence = evidence
        }
    }

    public let version: String
    /// True when no check reported `.fail`. Warnings and unavailable checks do not
    /// make the toolchain unhealthy — several are expected on a clean install.
    public let healthy: Bool
    public let checks: [Check]
    /// The CLI's own statement of what `doctor` does *not* prove. Surfaced verbatim.
    public let evidenceCeiling: String?

    public init(version: String, healthy: Bool, checks: [Check], evidenceCeiling: String?) {
        self.version = version
        self.healthy = healthy
        self.checks = checks
        self.evidenceCeiling = evidenceCeiling
    }
}

extension DoctorReport {
    public enum DecodingFailure: Error, LocalizedError, Equatable {
        case unexpectedSchema(String?)
        case malformed(String)

        public var errorDescription: String? {
            switch self {
            case let .unexpectedSchema(found):
                "Expected a \(DoctorReport.schema) payload but received \(found ?? "no schema")."
            case let .malformed(field):
                "The doctor payload is missing or malformed at \(field)."
            }
        }
    }

    /// Decodes the `data` object of a `game_dev.result.v1` envelope for `doctor`.
    public init(data: JSONValue) throws {
        guard case let .object(root) = data else {
            throw DecodingFailure.malformed("root")
        }
        guard root["schema"]?.stringValue == Self.schema else {
            throw DecodingFailure.unexpectedSchema(root["schema"]?.stringValue)
        }
        guard let version = root["version"]?.stringValue else {
            throw DecodingFailure.malformed("version")
        }
        guard case let .bool(healthy)? = root["healthy"] else {
            throw DecodingFailure.malformed("healthy")
        }
        guard case let .array(rawChecks)? = root["checks"] else {
            throw DecodingFailure.malformed("checks")
        }

        var checks: [Check] = []
        checks.reserveCapacity(rawChecks.count)
        for (index, rawCheck) in rawChecks.enumerated() {
            guard case let .object(fields) = rawCheck,
                  let id = fields["id"]?.stringValue,
                  let rawStatus = fields["status"]?.stringValue,
                  let status = CheckStatus(rawValue: rawStatus),
                  let detail = fields["detail"]?.stringValue
            else {
                throw DecodingFailure.malformed("checks[\(index)]")
            }
            var evidence: [String: JSONValue] = [:]
            if case let .object(rawEvidence)? = fields["evidence"] {
                evidence = rawEvidence
            }
            checks.append(Check(id: id, status: status, detail: detail, evidence: evidence))
        }

        self.init(
            version: version,
            healthy: healthy,
            checks: checks,
            evidenceCeiling: root["evidenceCeiling"]?.stringValue
        )
    }

    /// The check ids the CLI emits today, in emission order. Used to spot a check that
    /// the CLI stopped reporting, which would otherwise just vanish from the UI.
    public static let expectedCheckIDs: [String] = [
        "platform",
        "node-runtime",
        "workspace",
        "tripo-credential",
        "leonardo-credential",
        "blender",
        "blender-normalizer",
        "blender-usd-exporter",
        "usdzip",
        "sqlite-catalog-runtime",
        "codex-skills",
        "helper-version",
        "metal-evidence"
    ]

    public var missingExpectedCheckIDs: [String] {
        let present = Set(checks.map(\.id))
        return Self.expectedCheckIDs.filter { !present.contains($0) }
    }
}
