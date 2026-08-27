import Foundation
import Security

public enum CredentialProvider: String, CaseIterable, Identifiable, Hashable, Codable, Sendable {
    case tripo
    case leonardo

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .tripo:
            "Tripo"
        case .leonardo:
            "Leonardo"
        }
    }

    public var systemImage: String {
        switch self {
        case .tripo:
            "cube"
        case .leonardo:
            "paintpalette"
        }
    }

    public var environmentVariable: String {
        switch self {
        case .tripo:
            "TRIPO_API_KEY"
        case .leonardo:
            "LEONARDO_API_KEY"
        }
    }
}

public struct CredentialState: Identifiable, Hashable, Sendable {
    public let provider: CredentialProvider
    public let isConfigured: Bool

    public init(provider: CredentialProvider, isConfigured: Bool) {
        self.provider = provider
        self.isConfigured = isConfigured
    }

    public var id: CredentialProvider { provider }
}

public protocol CredentialStoring: Sendable {
    func credential(for provider: CredentialProvider) async throws -> String?
    func setCredential(_ credential: String, for provider: CredentialProvider) async throws
    func deleteCredential(for provider: CredentialProvider) async throws
    func isConfigured(_ provider: CredentialProvider) async throws -> Bool
}

public enum CredentialStoreError: Error, Equatable, Sendable, LocalizedError {
    case emptyCredential(CredentialProvider)
    case invalidCredentialEncoding(CredentialProvider)
    case invalidStoredCredential(CredentialProvider)
    case keychainFailure(provider: CredentialProvider, operation: String, status: OSStatus)

    public var errorDescription: String? {
        switch self {
        case let .emptyCredential(provider):
            "The \(provider.displayName) credential is empty."
        case let .invalidCredentialEncoding(provider):
            "The \(provider.displayName) credential could not be encoded."
        case let .invalidStoredCredential(provider):
            "The stored \(provider.displayName) credential is not valid UTF-8."
        case let .keychainFailure(provider, operation, status):
            "Keychain \(operation) failed for \(provider.displayName) (status \(status))."
        }
    }
}

public actor KeychainCredentialStore: CredentialStoring {
    private let service: String

    public init(service: String = "com.theisegoria.GameDevelopmentStudio") {
        self.service = service
    }

    public func credential(for provider: CredentialProvider) async throws -> String? {
        var query = baseQuery(for: provider)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw failure(provider: provider, operation: "read", status: status)
        }
        guard let data = result as? Data, let credential = String(data: data, encoding: .utf8) else {
            throw CredentialStoreError.invalidStoredCredential(provider)
        }
        return credential
    }

    public func setCredential(_ credential: String, for provider: CredentialProvider) async throws {
        guard !credential.isEmpty else { throw CredentialStoreError.emptyCredential(provider) }
        guard let data = credential.data(using: .utf8) else {
            throw CredentialStoreError.invalidCredentialEncoding(provider)
        }

        let query = baseQuery(for: provider)
        let attributes = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw failure(provider: provider, operation: "update", status: updateStatus)
        }

        var item = query
        item[kSecValueData as String] = data
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        if addStatus == errSecSuccess { return }

        // Another process may have inserted the item between update and add.
        if addStatus == errSecDuplicateItem {
            let retryStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if retryStatus == errSecSuccess { return }
            throw failure(provider: provider, operation: "update", status: retryStatus)
        }
        throw failure(provider: provider, operation: "add", status: addStatus)
    }

    public func deleteCredential(for provider: CredentialProvider) async throws {
        let status = SecItemDelete(baseQuery(for: provider) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw failure(provider: provider, operation: "delete", status: status)
        }
    }

    public func isConfigured(_ provider: CredentialProvider) async throws -> Bool {
        var query = baseQuery(for: provider)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess else {
            throw failure(provider: provider, operation: "inspect", status: status)
        }
        return true
    }

    private func baseQuery(for provider: CredentialProvider) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider.environmentVariable,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
    }

    private func failure(
        provider: CredentialProvider,
        operation: String,
        status: OSStatus
    ) -> CredentialStoreError {
        .keychainFailure(provider: provider, operation: operation, status: status)
    }
}

public actor InMemoryCredentialStore: CredentialStoring {
    private var credentials: [CredentialProvider: String]

    public init(credentials: [CredentialProvider: String] = [:]) {
        self.credentials = credentials
    }

    public func credential(for provider: CredentialProvider) async throws -> String? {
        credentials[provider]
    }

    public func setCredential(_ credential: String, for provider: CredentialProvider) async throws {
        guard !credential.isEmpty else { throw CredentialStoreError.emptyCredential(provider) }
        credentials[provider] = credential
    }

    public func deleteCredential(for provider: CredentialProvider) async throws {
        credentials.removeValue(forKey: provider)
    }

    public func isConfigured(_ provider: CredentialProvider) async throws -> Bool {
        credentials[provider]?.isEmpty == false
    }
}
