import Foundation

enum SecretRedactor {
    static let placeholder = "<redacted>"

    static func redact(_ text: String, secrets: [String]) -> String {
        variants(for: secrets)
            .sorted { $0.count > $1.count }
            .reduce(text) { partial, secret in
                partial.replacingOccurrences(of: secret, with: placeholder)
            }
    }

    private static func variants(for secrets: [String]) -> Set<String> {
        var variants = Set(secrets.filter { !$0.isEmpty })
        let encoder = JSONEncoder()
        for secret in secrets where !secret.isEmpty {
            if let encoded = try? encoder.encode(secret),
               let quoted = String(data: encoded, encoding: .utf8),
               quoted.count >= 2 {
                variants.insert(String(quoted.dropFirst().dropLast()))
            }
            if let percentEncoded = secret.addingPercentEncoding(
                withAllowedCharacters: .alphanumerics
            ), !percentEncoded.isEmpty {
                variants.insert(percentEncoded)
            }
        }
        return variants
    }
}
