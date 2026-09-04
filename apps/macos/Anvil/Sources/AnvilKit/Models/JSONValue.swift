import Foundation

public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
            self = .number(Double(value))
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .object(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        case let .number(value):
            try container.encode(value)
        case let .bool(value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }

    public subscript(key: String) -> JSONValue? {
        guard case let .object(object) = self else { return nil }
        return object[key]
    }

    public var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    func redacting(_ secrets: [String]) -> JSONValue {
        switch self {
        case let .object(object):
            return .object(object.mapValues { $0.redacting(secrets) })
        case let .array(array):
            return .array(array.map { $0.redacting(secrets) })
        case let .string(string):
            return .string(SecretRedactor.redact(string, secrets: secrets))
        case .number, .bool, .null:
            return self
        }
    }

    func foundationObject() -> Any {
        switch self {
        case let .object(object):
            return object.mapValues { $0.foundationObject() }
        case let .array(array):
            return array.map { $0.foundationObject() }
        case let .string(string):
            return string
        case let .number(number):
            return number
        case let .bool(bool):
            return bool
        case .null:
            return NSNull()
        }
    }
}

public extension JSONValue {
    /// A compact single-line rendering, for showing a value in a label or table cell.
    /// Numbers that are whole are printed without a fractional part so a path count or
    /// byte size does not read as "1024.0".
    var displayText: String {
        switch self {
        case let .string(value):
            value
        case let .number(value):
            value == value.rounded() && abs(value) < 1e15
                ? String(Int64(value))
                : String(value)
        case let .bool(value):
            value ? "true" : "false"
        case .null:
            "null"
        case let .array(values):
            values.isEmpty ? "[]" : values.map(\.displayText).joined(separator: ", ")
        case let .object(fields):
            fields.isEmpty
                ? "{}"
                : fields.keys.sorted().map { "\($0): \(fields[$0]?.displayText ?? "—")" }
                    .joined(separator: ", ")
        }
    }
}
