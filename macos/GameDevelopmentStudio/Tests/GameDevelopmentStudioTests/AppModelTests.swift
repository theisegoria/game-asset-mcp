import Foundation
import Testing
@testable import GameDevelopmentStudio

@Suite("App model CLI orchestration", .serialized)
@MainActor
struct AppModelTests {
    @Test("Unapproved paid generation never invokes the CLI")
    func approvalStopsExecution() async {
        let client = RecordingCLIClient()
        let model = makeModel(client: client)

        await model.generateAsset(
            provider: .tripo,
            operation: "generate",
            prompt: "A lighthouse",
            name: "lighthouse",
            spendLimitCents: 25,
            approved: false
        )

        #expect(await client.records().isEmpty)
        #expect(model.executionState.summary == "Spend approval required")
    }

    @Test("Provider request uses stdin, global flags, and only the required credential")
    func providerRequestContract() async throws {
        let client = RecordingCLIClient()
        let store = InMemoryCredentialStore(credentials: [
            .tripo: "tripo-key",
            .leonardo: "leonardo-key",
        ])
        let model = makeModel(client: client, store: store)
        model.outputDirectory = "/tmp/game studio output"
        let prompt = "Stylized beacon; $(never-shell-this)"

        await model.generateAsset(
            provider: .tripo,
            operation: "generate",
            prompt: prompt,
            name: "harbor-beacon",
            spendLimitCents: 75,
            approved: true
        )

        let record = try #require(await client.records().first)
        #expect(record.invocation.arguments.starts(with: ["provider", "tripo", "generate"]))
        #expect(record.invocation.arguments.contains("--request"))
        #expect(record.invocation.arguments.contains("-"))
        #expect(record.invocation.arguments.contains("--approve-spend"))
        #expect(record.invocation.arguments.contains("75"))
        #expect(record.invocation.arguments.contains("--output-dir"))
        #expect(record.invocation.arguments.contains("--json"))
        let outputIndex = try #require(record.invocation.arguments.firstIndex(of: "--output-dir"))
        #expect(record.invocation.arguments[outputIndex + 1] == "/tmp/game studio output")
        #expect(record.invocation.arguments.last == "--json")
        #expect(!record.invocation.arguments.contains(where: { $0.contains(prompt) }))
        #expect(record.credentials == [.tripo: "tripo-key"])
        #expect(record.timeout == .seconds(300))

        let input = try #require(record.invocation.standardInput)
        let object = try #require(JSONSerialization.jsonObject(with: input) as? [String: Any])
        #expect(object["textPrompt"] as? String == prompt)
    }

    @Test("Vendoring is dry-run by default and confirmed only explicitly")
    func vendoringApprovalBoundary() async throws {
        let client = RecordingCLIClient()
        let model = makeModel(client: client)

        await model.vendorPackage(
            reference: "package-ref",
            project: "/tmp/game",
            destination: "Assets/Vendor",
            confirmed: false
        )
        await model.vendorPackage(
            reference: "package-ref",
            project: "/tmp/game",
            destination: "Assets/Vendor",
            confirmed: true
        )

        let records = await client.records()
        #expect(records.count == 2)
        #expect(!records[0].invocation.arguments.contains("--confirm"))
        #expect(records[1].invocation.arguments.contains("--confirm"))
    }

    @Test("Package-building local writes require app confirmation before invocation")
    func packageBuildApprovalBoundary() async throws {
        let client = RecordingCLIClient()
        let model = makeModel(client: client)

        await model.buildPackage(
            path: "/tmp/asset.glb",
            name: "asset",
            version: "1.0.0",
            license: "MIT",
            confirmed: false
        )
        #expect(await client.records().isEmpty)
        #expect(model.executionState.summary == "Package build confirmation required")

        await model.buildPackage(
            path: "/tmp/asset.glb",
            name: "asset",
            version: "1.0.0",
            license: "MIT",
            confirmed: true
        )
        let record = try #require(await client.records().first)
        #expect(record.invocation.arguments.starts(with: ["package", "build", "/tmp/asset.glb"]))
    }

    @Test("Scenario execution keeps GPU and performance capabilities separate")
    func scenarioCapabilities() async throws {
        let client = RecordingCLIClient()
        let model = makeModel(client: client)

        await model.runScenario(
            id: "capture-water",
            project: "/tmp/game",
            allowGPU: true,
            allowPerformance: false,
            confirmed: true
        )

        let record = try #require(await client.records().first)
        #expect(record.invocation.arguments.contains("--confirm"))
        #expect(record.invocation.arguments.contains("--allow-gpu"))
        #expect(!record.invocation.arguments.contains("--allow-performance"))
        #expect(record.timeout == .seconds(900))
    }

    @Test("Structured failures are retained in history and UI state")
    func structuredFailureHistory() async throws {
        let envelope = CLIResultEnvelope(
            schema: GameDevCLIClient.resultSchema,
            operation: "asset.inspect",
            ok: false,
            data: .object([
                "error": .string("INVALID_INPUT"),
                "message": .string("The mesh is invalid"),
            ]),
            error: .object([
                "error": .string("INVALID_INPUT"),
                "message": .string("The mesh is invalid"),
            ])
        )
        let client = RecordingCLIClient(envelope: envelope, exitCode: 1)
        let model = makeModel(client: client)

        await model.inspectAsset(path: "/tmp/broken.glb")

        #expect(model.latestResult?.id == envelope.id)
        #expect(model.history.map(\.id) == [envelope.id])
        #expect(model.executionState.summary == "The mesh is invalid")
        #expect(model.executionState.errorMessage?.contains("INVALID_INPUT") == true)
    }

    @Test("Cancelling AppModel work cancels its client task")
    func cancellation() async {
        let client = RecordingCLIClient(blockUntilCancelled: true)
        let model = makeModel(client: client)
        let operation = Task { await model.runDoctor() }

        for _ in 0..<100 {
            if !(await client.records()).isEmpty { break }
            await Task.yield()
        }
        model.cancelCurrentOperation()
        await operation.value

        #expect(model.executionState.summary == "Operation cancelled")
        #expect(model.executionState.errorMessage == "The local process was terminated.")
        #expect(await client.observedCancellation())
    }

    @Test("Busy reservation covers suspending credential lookup and admits one invocation")
    func busyReservationBeforeCredentialLookup() async {
        let client = RecordingCLIClient()
        let store = SuspendingCredentialStore()
        let model = makeModel(client: client, store: store)
        let operation = Task {
            await model.generateAsset(
                provider: .tripo,
                operation: "generate",
                prompt: "A lighthouse",
                name: "lighthouse",
                spendLimitCents: 25,
                approved: true
            )
        }

        for _ in 0..<100 {
            if await store.credentialRequestCount() >= 1 { break }
            await Task.yield()
        }

        #expect(await store.credentialRequestCount() == 1)
        #expect(model.executionState == ExecutionState.running("Tripo generate"))

        let rejected = Task { await model.refreshCapabilities() }
        await rejected.value

        #expect(model.executionState == ExecutionState.running("Tripo generate"))
        #expect(await client.records().isEmpty)
        #expect(await store.credentialRequestCount() == 1)

        await store.releaseCredentialLookups()
        await operation.value

        #expect(await client.records().count == 1)
        #expect(model.executionState.summary == "Completed")
    }

    @Test("Doctor and capability discovery never read provider credentials")
    func diagnosticsNeverReadProviderCredentials() async {
        let client = RecordingCLIClient()
        let store = InMemoryCredentialStore(credentials: [
            .tripo: "tripo-secret",
            .leonardo: "leonardo-secret",
        ])
        let model = makeModel(client: client, store: store)

        await model.runDoctor()
        await model.refreshCapabilities()

        let records = await client.records()
        #expect(records.count == 2)
        #expect(records.allSatisfy { $0.credentials.isEmpty })
    }

    @Test("Cancellation remains authoritative after a rejected concurrent start")
    func cancellationRemainsAuthoritative() async {
        let client = RecordingCLIClient(blockUntilCancelled: true)
        let model = makeModel(client: client)
        let operation = Task { await model.runDoctor() }

        for _ in 0..<100 {
            if !(await client.records()).isEmpty { break }
            await Task.yield()
        }

        #expect(model.executionState == ExecutionState.running("Environment doctor"))
        let rejected = Task { await model.refreshCatalog(query: "ignored while busy") }
        await rejected.value
        #expect(model.executionState == ExecutionState.running("Environment doctor"))

        model.cancelCurrentOperation()
        await operation.value

        #expect(await client.records().count == 1)
        #expect(await client.observedCancellation())
        #expect(model.executionState.summary == "Operation cancelled")
        #expect(model.executionState.errorMessage == "The local process was terminated.")

        model.cancelCurrentOperation()
        await Task.yield()
        #expect(model.executionState.summary == "Operation cancelled")
        #expect(model.executionState.errorMessage == "The local process was terminated.")
    }

    private func makeModel(
        client: RecordingCLIClient,
        store: any CredentialStoring = InMemoryCredentialStore()
    ) -> AppModel {
        let suite = "GameDevelopmentStudioTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let model = AppModel(credentialStore: store, cliClient: client, defaults: defaults)
        model.outputDirectory = "/tmp/game-development-studio-tests"
        return model
    }
}

private struct RecordedInvocation: Sendable {
    let invocation: CLIInvocation
    let credentials: [CredentialProvider: String]
    let timeout: Duration?
}

private actor RecordingCLIClient: GameDevCLIClientProtocol {
    private var captured: [RecordedInvocation] = []
    private var cancellationObserved = false
    private let envelope: CLIResultEnvelope?
    private let exitCode: Int32
    private let blockUntilCancelled: Bool

    init(
        envelope: CLIResultEnvelope? = nil,
        exitCode: Int32 = 0,
        blockUntilCancelled: Bool = false
    ) {
        self.envelope = envelope
        self.exitCode = exitCode
        self.blockUntilCancelled = blockUntilCancelled
    }

    func execute(
        _ invocation: CLIInvocation,
        credentials: [CredentialProvider: String],
        timeout: Duration?
    ) async throws -> CLIExecutionResult {
        captured.append(RecordedInvocation(
            invocation: invocation,
            credentials: credentials,
            timeout: timeout
        ))
        if blockUntilCancelled {
            do {
                try await Task.sleep(for: .seconds(60))
            } catch is CancellationError {
                cancellationObserved = true
                throw CancellationError()
            }
        }

        let resultEnvelope = envelope ?? CLIResultEnvelope(
            schema: GameDevCLIClient.resultSchema,
            operation: invocation.arguments.prefix(3).joined(separator: "."),
            ok: true,
            data: .object(["summary": .string("Completed")])
        )
        let now = Date()
        return CLIExecutionResult(
            invocation: invocation,
            envelope: resultEnvelope,
            exitCode: exitCode,
            standardOutput: resultEnvelope.formattedJSON,
            standardError: "",
            startedAt: now,
            finishedAt: now
        )
    }

    func records() -> [RecordedInvocation] { captured }
    func observedCancellation() -> Bool { cancellationObserved }
}

private actor SuspendingCredentialStore: CredentialStoring {
    private var credentialRequests = 0
    private var releaseImmediately = false
    private var pendingLookups: [CheckedContinuation<String?, Never>] = []

    func credential(for provider: CredentialProvider) async throws -> String? {
        credentialRequests += 1
        if releaseImmediately { return nil }

        return await withCheckedContinuation { continuation in
            pendingLookups.append(continuation)
        }
    }

    func setCredential(_ credential: String, for provider: CredentialProvider) async throws {}

    func deleteCredential(for provider: CredentialProvider) async throws {}

    func isConfigured(_ provider: CredentialProvider) async throws -> Bool {
        false
    }

    func credentialRequestCount() -> Int { credentialRequests }

    func releaseCredentialLookups() {
        releaseImmediately = true
        let pending = pendingLookups
        pendingLookups.removeAll()
        for continuation in pending {
            continuation.resume(returning: nil)
        }
    }
}
