import Foundation

enum SecretRedactor {
    static let placeholder = "<redacted>"

    static func redact(_ text: String, secrets: [String]) -> String {
        secrets
            .filter { !$0.isEmpty }
            .sorted { $0.count > $1.count }
            .reduce(text) { partial, secret in
                partial.replacingOccurrences(of: secret, with: placeholder)
            }
    }
}
