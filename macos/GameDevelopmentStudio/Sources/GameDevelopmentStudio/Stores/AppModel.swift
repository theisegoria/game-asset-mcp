import Foundation
import Observation
import OSLog

@MainActor
@Observable
public final class AppModel {
    public var selectedWorkspace: WorkspaceSection = .production
    public var searchText = ""
    public var inspectorPresented = true

    public var outputDirectory: String {
        didSet { defaults.set(outputDirectory, forKey: PreferenceKey.outputDirectory) }
    }

    public var cliExecutable: String {
        didSet { defaults.set(cliExecutable, forKey: PreferenceKey.cliExecutable) }
    }

    public private(set) var executionState: ExecutionState = .idle
    public private(set) var latestResult: CLIResultEnvelope?
    public private(set) var history: [CLIResultEnvelope] = []
    public private(set) var credentialStates: [CredentialProvider: CredentialState] = [:]

    @ObservationIgnored private let credentialStore: any CredentialStoring
    @ObservationIgnored private let suppliedClient: (any GameDevCLIClientProtocol)?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var currentExecution: Task<CLIExecutionResult, Error>?

    private static let logger = Logger(
        subsystem: "com.theisegoria.GameDevelopmentStudio",
        category: "CLI"
    )

    public init(
        credentialStore: any CredentialStoring = KeychainCredentialStore(),
        cliClient: (any GameDevCLIClientProtocol)? = nil,
        defaults: UserDefaults = .standard
    ) {
        self.credentialStore = credentialStore
        self.suppliedClient = cliClient
        self.defaults = defaults
        self.outputDirectory = defaults.string(forKey: PreferenceKey.outputDirectory)
            ?? Self.defaultOutputDirectory
        self.cliExecutable = defaults.string(forKey: PreferenceKey.cliExecutable) ?? ""

        for provider in CredentialProvider.allCases {
            credentialStates[provider] = CredentialState(provider: provider, isConfigured: false)
        }
    }

    public func credentialState(for provider: CredentialProvider) -> CredentialState {
        credentialStates[provider] ?? CredentialState(provider: provider, isConfigured: false)
    }

    public func refreshCredentialStates() async {
        for provider in CredentialProvider.allCases {
            do {
                credentialStates[provider] = CredentialState(
                    provider: provider,
                    isConfigured: try await credentialStore.isConfigured(provider)
                )
            } catch {
                Self.logger.error("Credential status failed for \(provider.rawValue, privacy: .public)")
                executionState = .failed(
                    summary: "Could not read credential status",
                    errorMessage: error.localizedDescription
                )
            }
        }
    }

    public func saveCredential(_ credential: String, for provider: CredentialProvider) async {
        let trimmed = credential.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            failLocally(summary: "Credential is empty", message: "Enter a credential before saving it to Keychain.")
            return
        }

        do {
            try await credentialStore.setCredential(trimmed, for: provider)
            credentialStates[provider] = CredentialState(provider: provider, isConfigured: true)
            executionState = .succeeded("\(provider.displayName) credential saved in Keychain")
            Self.logger.info("Saved credential metadata for \(provider.rawValue, privacy: .public)")
        } catch {
            failLocally(summary: "Could not save credential", message: error.localizedDescription)
        }
    }

    public func deleteCredential(for provider: CredentialProvider) async {
        do {
            try await credentialStore.deleteCredential(for: provider)
            credentialStates[provider] = CredentialState(provider: provider, isConfigured: false)
            executionState = .succeeded("\(provider.displayName) credential removed")
            Self.logger.info("Removed credential metadata for \(provider.rawValue, privacy: .public)")
        } catch {
            failLocally(summary: "Could not remove credential", message: error.localizedDescription)
        }
    }

    public func runDoctor() async {
        await execute(
            label: "Environment doctor",
            arguments: ["doctor"],
            credentialProviders: Set(CredentialProvider.allCases)
        )
    }

    public func refreshCapabilities() async {
        await execute(
            label: "Capability discovery",
            arguments: ["capabilities"],
            credentialProviders: Set(CredentialProvider.allCases)
        )
    }

    public func refreshCatalog(query: String) async {
        var arguments = ["catalog", "list"]
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { arguments += ["--query", trimmed] }
        await execute(label: "Catalog refresh", arguments: arguments)
    }

    public func inspectAsset(path: String) async {
        guard let path = required(path, label: "GLB path") else { return }
        await execute(label: "Asset inspection", arguments: ["asset", "inspect", path])
    }

    public func validateAsset(path: String) async {
        guard let path = required(path, label: "GLB path") else { return }
        await execute(label: "Asset validation", arguments: ["asset", "validate", path])
    }

    public func buildPackage(path: String, name: String, version: String, license: String) async {
        guard
            let path = required(path, label: "GLB path"),
            let name = required(name, label: "Package name"),
            let version = required(version, label: "Version"),
            let license = required(license, label: "SPDX license")
        else { return }

        await execute(
            label: "Package build",
            arguments: [
                "package", "build", path,
                "--name", name,
                "--version", version,
                "--license", license,
            ]
        )
    }

    public func vendorPackage(
        reference: String,
        project: String,
        destination: String,
        confirmed: Bool
    ) async {
        guard
            let reference = required(reference, label: "Package reference"),
            let project = required(project, label: "Project path")
        else { return }

        var arguments = ["vendor", "admit", reference, "--project", project]
        let destination = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        if !destination.isEmpty { arguments += ["--destination", destination] }
        if confirmed { arguments.append("--confirm") }

        await execute(
            label: confirmed ? "Package admission" : "Package admission plan",
            arguments: arguments
        )
    }

    public func generateAsset(
        provider: CredentialProvider,
        operation: String,
        prompt: String,
        name: String,
        spendLimitCents: Int,
        approved: Bool
    ) async {
        guard approved else {
            failLocally(
                summary: "Spend approval required",
                message: "Review the provider, request, and finite spend ceiling before starting this invocation."
            )
            return
        }
        guard spendLimitCents > 0 else {
            failLocally(summary: "Spend ceiling required", message: "Enter a spend ceiling greater than zero cents.")
            return
        }
        guard
            let prompt = required(prompt, label: "Asset brief"),
            let name = required(name, label: "Asset name")
        else { return }

        let normalizedOperation: String
        let request: Data

        do {
            switch (provider, operation) {
            case (.tripo, "generate"), (.tripo, "3d"):
                normalizedOperation = "generate"
                request = try JSONEncoder.gameDev.encode(
                    TripoPromptRequest(textPrompt: prompt, spec: .init(name: name, description: prompt))
                )
            case (.leonardo, "image-generate"), (.leonardo, "image"), (.leonardo, "reference"):
                normalizedOperation = "image-generate"
                request = try JSONEncoder.gameDev.encode(
                    LeonardoReferenceRequest(spec: .init(name: name, description: prompt))
                )
            case (.leonardo, "sound-generate"), (.leonardo, "sound"), (.leonardo, "audio"):
                normalizedOperation = "sound-generate"
                request = try JSONEncoder.gameDev.encode(
                    LeonardoSoundRequest(name: name, prompt: prompt, waitSeconds: 0)
                )
            default:
                failLocally(
                    summary: "Unsupported production route",
                    message: "The selected provider does not support \(operation)."
                )
                return
            }
        } catch {
            failLocally(summary: "Could not encode request", message: error.localizedDescription)
            return
        }

        await execute(
            label: "\(provider.displayName) \(normalizedOperation)",
            arguments: [
                "provider", provider.rawValue, normalizedOperation,
                "--request", "-",
                "--approve-spend",
                "--spend-limit-cents", String(spendLimitCents),
            ],
            standardInput: request,
            credentialProviders: [provider],
            timeout: .seconds(300)
        )
    }

    public func listScenarios(project: String) async {
        guard let project = required(project, label: "Project path") else { return }
        await execute(label: "Scenario discovery", arguments: ["scenario", "list", "--project", project])
    }

    public func planScenario(id: String, project: String) async {
        guard
            let id = required(id, label: "Scenario ID"),
            let project = required(project, label: "Project path")
        else { return }
        await execute(
            label: "Scenario plan",
            arguments: ["scenario", "plan", id, "--project", project]
        )
    }

    public func runScenario(
        id: String,
        project: String,
        allowGPU: Bool,
        allowPerformance: Bool,
        confirmed: Bool
    ) async {
        guard confirmed else {
            failLocally(
                summary: "Execution confirmation required",
                message: "Review the project command and declared capabilities before running the scenario."
            )
            return
        }
        guard
            let id = required(id, label: "Scenario ID"),
            let project = required(project, label: "Project path")
        else { return }

        var arguments = ["scenario", "run", id, "--project", project, "--confirm"]
        if allowGPU { arguments.append("--allow-gpu") }
        if allowPerformance { arguments.append("--allow-performance") }
        await execute(label: "Scenario run", arguments: arguments, timeout: .seconds(900))
    }

    public func analyzeCapture(reference: String) async {
        guard let reference = required(reference, label: "Run ID or path") else { return }
        await execute(label: "Visual analysis", arguments: ["visual", "analyze", reference])
    }

    public func compareVisuals(baseline: String, candidate: String, threshold: Int) async {
        guard
            let baseline = required(baseline, label: "Baseline run"),
            let candidate = required(candidate, label: "Candidate run")
        else { return }
        guard (0...255).contains(threshold) else {
            failLocally(summary: "Invalid threshold", message: "The pixel threshold must be between 0 and 255.")
            return
        }
        await execute(
            label: "Visual comparison",
            arguments: [
                "visual", "compare", baseline, candidate,
                "--threshold", String(threshold),
            ],
            timeout: .seconds(600)
        )
    }

    public func summarizePerformance(reference: String) async {
        guard let reference = required(reference, label: "Run ID or path") else { return }
        await execute(
            label: "Performance summary",
            arguments: ["performance", "summarize", reference]
        )
    }

    public func comparePerformance(baseline: String, candidate: String, stat: String) async {
        guard
            let baseline = required(baseline, label: "Baseline run"),
            let candidate = required(candidate, label: "Candidate run")
        else { return }
        let allowedStats = ["min", "max", "mean", "median", "p95", "p99"]
        guard allowedStats.contains(stat) else {
            failLocally(
                summary: "Unsupported statistic",
                message: "Choose one of: \(allowedStats.joined(separator: ", "))."
            )
            return
        }
        await execute(
            label: "Performance comparison",
            arguments: [
                "performance", "compare", baseline, candidate,
                "--stat", stat,
            ]
        )
    }

    public func cancelCurrentOperation() {
        guard let currentExecution else { return }
        Self.logger.notice("Cancelling current local CLI operation")
        currentExecution.cancel()
    }

    private func execute(
        label: String,
        arguments: [String],
        standardInput: Data? = nil,
        credentialProviders: Set<CredentialProvider> = [],
        timeout: Duration = .seconds(120)
    ) async {
        guard currentExecution == nil else {
            failLocally(
                summary: "Another operation is running",
                message: "Cancel or wait for the current operation before starting another one."
            )
            return
        }

        var credentials: [CredentialProvider: String] = [:]
        do {
            for provider in credentialProviders {
                if let credential = try await credentialStore.credential(for: provider) {
                    credentials[provider] = credential
                }
            }
        } catch {
            failLocally(summary: "Could not read Keychain", message: error.localizedDescription)
            return
        }

        var arguments = arguments
        let output = outputDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        if !output.isEmpty { arguments += ["--output-dir", output] }
        if !arguments.contains("--json") && !arguments.contains("--jsonl") {
            arguments.append("--json")
        }

        let invocation = CLIInvocation(
            arguments: arguments,
            standardInput: standardInput,
            workingDirectory: nil,
            environment: [:]
        )
        let client = makeClient()
        let task = Task<CLIExecutionResult, Error> {
            try await client.execute(invocation, credentials: credentials, timeout: timeout)
        }
        currentExecution = task
        executionState = .running(label)
        Self.logger.info("Started \(label, privacy: .public)")

        defer { currentExecution = nil }

        do {
            let result = try await task.value
            latestResult = result.envelope
            history.insert(result.envelope, at: 0)
            if history.count > 50 { history.removeLast(history.count - 50) }

            if result.envelope.ok {
                executionState = .succeeded(result.envelope.summary)
                Self.logger.info("Completed \(label, privacy: .public)")
            } else {
                executionState = .failed(
                    summary: result.envelope.summary,
                    errorMessage: result.envelope.details
                )
                Self.logger.error("CLI returned a structured failure for \(label, privacy: .public)")
            }
        } catch is CancellationError {
            executionState = .failed(summary: "Operation cancelled", errorMessage: "The local process was terminated.")
            Self.logger.notice("Cancelled \(label, privacy: .public)")
        } catch {
            executionState = .failed(summary: "\(label) failed", errorMessage: error.localizedDescription)
            Self.logger.error("Failed \(label, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    private func makeClient() -> any GameDevCLIClientProtocol {
        if let suppliedClient { return suppliedClient }

        let executable = cliExecutable.trimmingCharacters(in: .whitespacesAndNewlines)
        if executable.isEmpty {
            return GameDevCLIClient()
        }
        if executable.contains("/") {
            return GameDevCLIClient(executableURL: URL(fileURLWithPath: executable))
        }
        return GameDevCLIClient(executableName: executable)
    }

    private func required(_ value: String, label: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            failLocally(summary: "\(label) required", message: "Enter \(label.lowercased()) before continuing.")
            return nil
        }
        return trimmed
    }

    private func failLocally(summary: String, message: String) {
        executionState = .failed(summary: summary, errorMessage: message)
        Self.logger.error("Local validation stopped an operation: \(summary, privacy: .public)")
    }

    private enum PreferenceKey {
        static let outputDirectory = "gameDevelopmentStudio.outputDirectory"
        static let cliExecutable = "gameDevelopmentStudio.cliExecutable"
    }

    private static var defaultOutputDirectory: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Game Development Studio", isDirectory: true)
            .path
    }
}

private struct AssetOutputRequest: Encodable {
    let pbr = true
    let textureQuality = "standard"
    let format = "glb"
}

private struct ProductionAssetSpec: Encodable {
    let name: String
    let description: String
    let category = "other"
    let output = AssetOutputRequest()
}

private struct TripoPromptRequest: Encodable {
    let textPrompt: String
    let spec: ProductionAssetSpec
}

private struct LeonardoReferenceRequest: Encodable {
    let spec: ProductionAssetSpec
}

private struct LeonardoSoundRequest: Encodable {
    let name: String
    let prompt: String
    let waitSeconds: Int
}

private extension JSONEncoder {
    static var gameDev: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
