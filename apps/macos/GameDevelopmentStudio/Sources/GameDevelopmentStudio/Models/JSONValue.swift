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
