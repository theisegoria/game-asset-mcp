import Foundation

public enum CLIResultStatus: String, Codable, Sendable {
    case succeeded
    case approvalRequired
    case failed
}

public struct CLIResultEnvelope: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let schema: String
    public let operation: String
    public let ok: Bool
    public let data: JSONValue
    public let error: JSONValue?
    public let receivedAt: Date

    private enum CodingKeys: String, CodingKey {
        case schema
        case operation
        case ok
        case data
        case error
    }

    public init(
        id: UUID = UUID(),
        schema: String,
        operation: String,
        ok: Bool,
        data: JSONValue,
        error: JSONValue? = nil,
        receivedAt: Date = Date()
    ) {
        self.id = id
        self.schema = schema
        self.operation = operation
        self.ok = ok
        self.data = data
        self.error = error
        self.receivedAt = receivedAt
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schema = try container.decode(String.self, forKey: .schema)
        operation = try container.decode(String.self, forKey: .operation)
        ok = try container.decode(Bool.self, forKey: .ok)
        let decodedData = try container.decodeIfPresent(JSONValue.self, forKey: .data)
        let decodedError = try container.decodeIfPresent(JSONValue.self, forKey: .error)
        data = decodedData ?? decodedError ?? .null
        error = decodedError
        id = UUID()
        receivedAt = Date()
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schema, forKey: .schema)
        try container.encode(operation, forKey: .operation)
        try container.encode(ok, forKey: .ok)
        if ok {
            try container.encode(data, forKey: .data)
        } else {
            try container.encode(error ?? data, forKey: .error)
        }
    }

    public var command: String { operation }

    public var status: CLIResultStatus {
        if ok { return .succeeded }
        if data["error"]?.stringValue == "APPROVAL_REQUIRED" {
            return .approvalRequired
        }
        return .failed
    }

    public var summary: String {
        if let summary = firstString(in: data, keys: ["summary", "message", "note"]) {
            return summary
        }
        switch status {
        case .succeeded:
            return "Completed \(operation)"
        case .approvalRequired:
            return "Approval required for \(operation)"
        case .failed:
            return "\(operation) failed"
        }
    }

    public var receiptPath: String? {
        firstString(in: data, keys: ["receiptPath", "receipt_path", "receipt"])
    }

    public var timestamp: Date {
        guard let raw = firstString(
            in: data,
            keys: ["completedAt", "createdAt", "updatedAt", "timestamp"]
        ) else { return receivedAt }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: raw) { return parsed }
        return ISO8601DateFormatter().date(from: raw) ?? receivedAt
    }

    public var formattedJSON: String {
        var object: [String: Any] = [
            "schema": schema,
            "operation": operation,
            "ok": ok,
        ]
        object[ok ? "data" : "error"] = (ok ? data : error ?? data).foundationObject()
        guard JSONSerialization.isValidJSONObject(object),
              let encoded = try? JSONSerialization.data(
                  withJSONObject: object,
                  options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
              )
        else { return "{}" }
        return String(decoding: encoded, as: UTF8.self)
    }

    public var details: String { formattedJSON }

    func redacting(_ secrets: [String]) -> CLIResultEnvelope {
        CLIResultEnvelope(
            id: id,
            schema: schema,
            operation: operation,
            ok: ok,
            data: data.redacting(secrets),
            error: error?.redacting(secrets),
            receivedAt: receivedAt
        )
    }

    private func firstString(in value: JSONValue, keys: Set<String>) -> String? {
        switch value {
        case let .object(object):
            for key in keys {
                if let string = object[key]?.stringValue { return string }
            }
            for key in object.keys.sorted() {
                if let nested = object[key], let string = firstString(in: nested, keys: keys) {
                    return string
                }
            }
            return nil
        case let .array(array):
            for nested in array {
                if let string = firstString(in: nested, keys: keys) { return string }
            }
            return nil
        case .string, .number, .bool, .null:
            return nil
        }
    }
}

public struct CLIInvocation: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public var arguments: [String]
    public var standardInput: Data?
    public var workingDirectory: URL?
    public var environment: [String: String]

    public init(
        arguments: [String],
        standardInput: Data? = nil,
        workingDirectory: URL? = nil,
        environment: [String: String] = [:]
    ) {
        self.arguments = arguments
        self.standardInput = standardInput
        self.workingDirectory = workingDirectory
        self.environment = environment
    }

    public var description: String {
        let environmentKeys = environment.keys.sorted().joined(separator: ", ")
        let workingDirectoryPath = workingDirectory?.path ?? "default"
        return "CLIInvocation(arguments: \(redactedArguments), standardInputBytes: \(standardInput?.count ?? 0), workingDirectory: \(workingDirectoryPath), environmentKeys: [\(environmentKeys)])"
    }

    public var debugDescription: String { description }

    private var redactedArguments: [String] {
        var result = arguments
        var shouldRedactNext = false
        for index in result.indices {
            if shouldRedactNext {
                result[index] = "<redacted>"
                shouldRedactNext = false
                continue
            }
            let normalized = result[index].lowercased()
            let sensitive = normalized.contains("secret")
                || normalized.contains("password")
                || normalized.contains("token")
                || normalized.contains("api-key")
                || normalized.contains("credential")
            if sensitive {
                if let equals = result[index].firstIndex(of: "=") {
                    result[index] = String(result[index][...equals]) + "<redacted>"
                } else {
                    shouldRedactNext = true
                }
            }
        }
        return result
    }
}

public struct CLIExecutionResult: Equatable, Identifiable, Sendable, CustomStringConvertible {
    public let id: UUID
    public let invocation: CLIInvocation
    public let envelope: CLIResultEnvelope
    public let exitCode: Int32
    public let standardOutput: String
    public let standardError: String
    public let startedAt: Date
    public let finishedAt: Date

    public init(
        id: UUID = UUID(),
        invocation: CLIInvocation,
        envelope: CLIResultEnvelope,
        exitCode: Int32,
        standardOutput: String,
        standardError: String,
        startedAt: Date,
        finishedAt: Date
    ) {
        self.id = id
        self.invocation = invocation
        self.envelope = envelope
        self.exitCode = exitCode
        self.standardOutput = standardOutput
        self.standardError = standardError
        self.startedAt = startedAt
        self.finishedAt = finishedAt
    }

    public var succeeded: Bool { exitCode == 0 && envelope.ok }

    public var duration: TimeInterval { finishedAt.timeIntervalSince(startedAt) }

    public var description: String {
        "CLIExecutionResult(operation: \(envelope.operation), status: \(envelope.status.rawValue), exitCode: \(exitCode), outputBytes: \(standardOutput.utf8.count), errorBytes: \(standardError.utf8.count))"
    }
}
