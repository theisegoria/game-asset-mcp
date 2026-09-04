import Foundation
import Testing
@testable import AnvilKit

@Suite("Credential storage")
struct CredentialStoreTests {
    @Test("Provider metadata maps only to documented environment variables")
    func providerMetadata() {
        #expect(CredentialProvider.allCases == [.tripo, .leonardo])
        #expect(CredentialProvider.tripo.environmentVariable == "TRIPO_API_KEY")
        #expect(CredentialProvider.leonardo.environmentVariable == "LEONARDO_API_KEY")
        #expect(CredentialProvider.tripo.id == "tripo")
        #expect(!CredentialProvider.leonardo.systemImage.isEmpty)
    }

    @Test("In-memory store is an injectable semantic fake")
    func inMemoryRoundTrip() async throws {
        let store = InMemoryCredentialStore()
        #expect(try await store.isConfigured(.tripo) == false)
        #expect(try await store.credential(for: .tripo) == nil)

        try await store.setCredential("test-key", for: .tripo)
        #expect(try await store.isConfigured(.tripo))
        #expect(try await store.credential(for: .tripo) == "test-key")
        #expect(try await store.credential(for: .leonardo) == nil)

        try await store.deleteCredential(for: .tripo)
        #expect(try await store.isConfigured(.tripo) == false)
    }

    @Test("Empty credentials are rejected without exposing values")
    func emptyCredential() async {
        let store = InMemoryCredentialStore()
        do {
            try await store.setCredential("", for: .leonardo)
            Issue.record("Expected an empty-credential failure")
        } catch let error as CredentialStoreError {
            #expect(error == .emptyCredential(.leonardo))
            #expect(error.localizedDescription == "The Leonardo credential is empty.")
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("Credential state exposes configuration only")
    func stateMetadata() {
        let state = CredentialState(provider: .tripo, isConfigured: true)
        #expect(state.id == .tripo)
        #expect(state.isConfigured)
        #expect(String(describing: state).contains("test-key") == false)
    }
}
