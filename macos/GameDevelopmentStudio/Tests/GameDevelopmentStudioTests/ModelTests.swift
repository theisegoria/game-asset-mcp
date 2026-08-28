import Foundation
import Testing
@testable import GameDevelopmentStudio

@Suite("App-facing models")
struct ModelTests {
    @Test("Appearance defaults to dark and maps to native color schemes")
    func appearancePreference() {
        #expect(AppearancePreference.defaultValue == .dark)
        #expect(AppearancePreference.storageKey == "gameDevelopmentStudio.appearance")
        #expect(AppearancePreference.allCases == [.dark, .system, .light])
        #expect(AppearancePreference.dark.title == "Dark")
        #expect(AppearancePreference.system.title == "System")
        #expect(AppearancePreference.light.title == "Light")
        #expect(AppearancePreference.dark.preferredColorSchemeName == "dark")
        #expect(AppearancePreference.system.preferredColorSchemeName == nil)
        #expect(AppearancePreference.light.preferredColorSchemeName == "light")
    }

    @Test("Workspace metadata is stable and complete")
    func workspaceMetadata() {
        #expect(WorkspaceSection.allCases == [.production, .library, .visualDebugging, .performance])
        #expect(WorkspaceSection.library.title == "Library & Vendoring")
        #expect(!WorkspaceSection.visualDebugging.subtitle.isEmpty)
        #expect(!WorkspaceSection.performance.systemImage.isEmpty)
    }

    @Test("Execution state exposes UI-safe projections")
    func executionState() {
        #expect(ExecutionState.idle.isRunning == false)
        #expect(ExecutionState.running("Capturing").isRunning)
        #expect(ExecutionState.succeeded("Done").summary == "Done")
        #expect(
            ExecutionState.failed(summary: "Failed", errorMessage: "Details").errorMessage
                == "Details"
        )
    }

    @Test("Success envelope decodes the exact game-dev wire contract")
    func successEnvelope() throws {
        let encoded = Data(
            """
            {
              "schema": "game_dev.result.v1",
              "operation": "package.build",
              "ok": true,
              "data": {
                "summary": "Package complete",
                "receiptPath": "/tmp/package/receipt.json",
                "completedAt": "2026-08-28T01:02:03.123Z",
                "count": 3,
                "verified": true
              }
            }
            """.utf8
        )

        let envelope = try JSONDecoder().decode(CLIResultEnvelope.self, from: encoded)
        #expect(envelope.schema == GameDevCLIClient.resultSchema)
        #expect(envelope.command == "package.build")
        #expect(envelope.status == .succeeded)
        #expect(envelope.summary == "Package complete")
        #expect(envelope.receiptPath == "/tmp/package/receipt.json")
        #expect(envelope.timestamp != envelope.receivedAt)
        #expect(envelope.formattedJSON.contains("\"count\" : 3"))
        #expect(!envelope.formattedJSON.contains("receivedAt"))
        #expect(!envelope.formattedJSON.contains("id"))
    }

    @Test("Failure envelope preserves error payload and approval status")
    func approvalEnvelope() throws {
        let encoded = Data(
            """
            {
              "schema": "game_dev.result.v1",
              "operation": "provider.tripo.generate",
              "ok": false,
              "error": {
                "error": "APPROVAL_REQUIRED",
                "message": "Explicit spend approval is required"
              }
            }
            """.utf8
        )

        let envelope = try JSONDecoder().decode(CLIResultEnvelope.self, from: encoded)
        #expect(envelope.ok == false)
        #expect(envelope.status == .approvalRequired)
        #expect(envelope.summary == "Explicit spend approval is required")
        #expect(envelope.data["error"]?.stringValue == "APPROVAL_REQUIRED")

        let roundTrip = try JSONEncoder().encode(envelope)
        let object = try #require(JSONSerialization.jsonObject(with: roundTrip) as? [String: Any])
        #expect(object["data"] == nil)
        #expect(object["error"] != nil)
    }

    @Test("Invocation description excludes stdin and environment values")
    func invocationDescriptionIsRedacted() {
        let secret = "top-secret-value"
        let invocation = CLIInvocation(
            arguments: ["provider", "tripo", "generate", "--api-key", secret],
            standardInput: Data("private prompt".utf8),
            environment: ["SAFE_NAME": secret]
        )

        #expect(invocation.description.contains("<redacted>"))
        #expect(invocation.description.contains("SAFE_NAME"))
        #expect(invocation.description.contains("standardInputBytes: 14"))
        #expect(!invocation.description.contains(secret))
        #expect(!invocation.description.contains("private prompt"))
    }
}
