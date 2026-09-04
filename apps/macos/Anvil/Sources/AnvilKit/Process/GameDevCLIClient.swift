import Foundation
import Darwin

public protocol GameDevCLIClientProtocol: Sendable {
    func execute(
        _ invocation: CLIInvocation,
        credentials: [CredentialProvider: String],
        timeout: Duration?
    ) async throws -> CLIExecutionResult
}

public enum ProcessOutputStream: String, Equatable, Sendable {
    case standardOutput
    case standardError
}

public enum GameDevCLIClientError: Error, Equatable, Sendable, LocalizedError {
    case invalidInvocation(String)
    case trustedExecutableRequired
    case executableNotRegular
    case runtimeInvalid(String)
    case runtimeIdentityChanged
    case handshakeFailed(String)
    case credentialInArguments(CredentialProvider)
    case standardInputTooLarge(limit: Int)
    case launchFailed(executable: String, reason: String)
    case standardInputWriteFailed
    case timedOut(Duration)
    case cancelled
    case outputLimitExceeded(stream: ProcessOutputStream, limit: Int)
    case invalidUTF8(ProcessOutputStream)
    case invalidJSON(exitCode: Int32, diagnostic: String)
    case unexpectedSchema(String)
    case unexpectedOperation(expected: String, actual: String)
    case inconsistentResult(exitCode: Int32, ok: Bool)

    public var errorDescription: String? {
        switch self {
        case let .invalidInvocation(reason):
            "Invalid game-dev invocation: \(reason)"
        case .trustedExecutableRequired:
            "Credential-bearing and write or capture operations require a configured closed Studio runtime directory."
        case .executableNotRegular:
            "The configured game-dev executable must be an absolute executable regular file."
        case let .runtimeInvalid(reason):
            "The configured Studio runtime is not trusted: \(reason)"
        case .runtimeIdentityChanged:
            "The configured Studio runtime changed after approval; review the operation again."
        case let .handshakeFailed(reason):
            "The configured game-dev executable failed its no-secret identity handshake: \(reason)"
        case let .credentialInArguments(provider):
            "The \(provider.displayName) credential must be passed through the process environment, not an argument."
        case let .standardInputTooLarge(limit):
            "The game-dev request exceeds the \(limit)-byte standard-input limit."
        case let .launchFailed(executable, reason):
            "Could not launch \(executable): \(reason)"
        case .standardInputWriteFailed:
            "The game-dev process closed standard input before the request was written."
        case let .timedOut(timeout):
            "game-dev exceeded its timeout of \(timeout)."
        case .cancelled:
            "The game-dev operation was cancelled."
        case let .outputLimitExceeded(stream, limit):
            "game-dev \(stream.rawValue) exceeded the \(limit)-byte limit."
        case let .invalidUTF8(stream):
            "game-dev \(stream.rawValue) was not valid UTF-8."
        case let .invalidJSON(exitCode, diagnostic):
            "game-dev returned invalid JSON (exit \(exitCode)): \(diagnostic)"
        case let .unexpectedSchema(schema):
            "game-dev returned unsupported schema \(schema)."
        case let .unexpectedOperation(expected, actual):
            "game-dev returned operation \(actual) for a request that expected \(expected)."
        case let .inconsistentResult(exitCode, ok):
            "game-dev returned contradictory status (exit \(exitCode), ok \(ok))."
        }
    }
}

public struct GameDevCLIExecutableIdentity: Codable, Equatable, Sendable, CustomStringConvertible {
    public let identitySchema: String
    public let runtimeRootCanonicalPath: String
    public let runtimeTreeSHA256: String
    public let entrypointRelativePath: String
    public let entrypointSHA256: String
    public let nodeCanonicalPath: String
    public let nodeSHA256: String
    public let nodeVersion: String
    public let cliVersion: String
    public let resultSchema: String
    public let capabilitiesSchema: String

    public init(
        identitySchema: String,
        runtimeRootCanonicalPath: String,
        runtimeTreeSHA256: String,
        entrypointRelativePath: String,
        entrypointSHA256: String,
        nodeCanonicalPath: String,
        nodeSHA256: String,
        nodeVersion: String,
        cliVersion: String,
        resultSchema: String,
        capabilitiesSchema: String
    ) {
        self.identitySchema = identitySchema
        self.runtimeRootCanonicalPath = runtimeRootCanonicalPath
        self.runtimeTreeSHA256 = runtimeTreeSHA256
        self.entrypointRelativePath = entrypointRelativePath
        self.entrypointSHA256 = entrypointSHA256
        self.nodeCanonicalPath = nodeCanonicalPath
        self.nodeSHA256 = nodeSHA256
        self.nodeVersion = nodeVersion
        self.cliVersion = cliVersion
        self.resultSchema = resultSchema
        self.capabilitiesSchema = capabilitiesSchema
    }

    public var description: String {
        "schema=\(identitySchema), runtimeRoot=\(runtimeRootCanonicalPath), runtimeTreeSHA256=\(runtimeTreeSHA256), node=\(nodeCanonicalPath), nodeSHA256=\(nodeSHA256), nodeVersion=\(nodeVersion), cliVersion=\(cliVersion), resultSchema=\(resultSchema), capabilitiesSchema=\(capabilitiesSchema)"
    }

    public var approvalDetails: [String] {
        [
            "Runtime root: \(runtimeRootCanonicalPath)",
            "Runtime tree SHA-256: \(runtimeTreeSHA256)",
            "CLI entrypoint: \(entrypointRelativePath)",
            "CLI entrypoint SHA-256: \(entrypointSHA256)",
            "Node runtime: \(nodeCanonicalPath)",
            "Node SHA-256: \(nodeSHA256)",
            "Node version: \(nodeVersion)",
            "CLI version: \(cliVersion)",
            "Result schema: \(resultSchema)",
            "Capabilities schema: \(capabilitiesSchema)",
            "Binding: checked in a private snapshot after the no-secret handshake and again before launch.",
            "Evidence boundary: binds this one approval to the staged local Studio runtime; it does not authenticate a global install or attest external tools, provider behavior, spend, GPU work, pixels, performance, signing, or human review.",
        ]
    }
}

public extension CredentialProvider {
    var officialHostname: String {
        switch self {
        case .tripo:
            "api.tripo3d.ai"
        case .leonardo:
            "cloud.leonardo.ai"
        }
    }
}

public struct GameDevCLIClient: GameDevCLIClientProtocol, Sendable {
    public static let resultSchema = "game_dev.result.v1"
    public static let capabilitiesSchema = "game_dev.capabilities.v1"

    private let executableURL: URL?
    private let executableName: String
    private let baseEnvironment: [String: String]
    private let maximumOutputBytesPerStream: Int
    private let maximumStandardInputBytes: Int
    private let pinnedIdentity: GameDevCLIExecutableIdentity?

    public init(
        executableURL: URL? = nil,
        executableName: String = "game-dev",
        baseEnvironment: [String: String]? = nil,
        maximumOutputBytesPerStream: Int = 4 * 1024 * 1024,
        maximumStandardInputBytes: Int = 4 * 1024 * 1024
    ) {
        self.executableURL = executableURL
        self.executableName = executableName
        self.baseEnvironment = Self.sanitizedEnvironment(
            baseEnvironment ?? ProcessInfo.processInfo.environment
        )
        self.maximumOutputBytesPerStream = max(1, maximumOutputBytesPerStream)
        self.maximumStandardInputBytes = max(1, maximumStandardInputBytes)
        self.pinnedIdentity = nil
    }

    private init(
        executableURL: URL?,
        executableName: String,
        baseEnvironment: [String: String],
        maximumOutputBytesPerStream: Int,
        maximumStandardInputBytes: Int,
        pinnedIdentity: GameDevCLIExecutableIdentity?
    ) {
        self.executableURL = executableURL
        self.executableName = executableName
        self.baseEnvironment = baseEnvironment
        self.maximumOutputBytesPerStream = maximumOutputBytesPerStream
        self.maximumStandardInputBytes = maximumStandardInputBytes
        self.pinnedIdentity = pinnedIdentity
    }

    public func pinned(to identity: GameDevCLIExecutableIdentity) -> GameDevCLIClient {
        GameDevCLIClient(
            executableURL: executableURL,
            executableName: executableName,
            baseEnvironment: baseEnvironment,
            maximumOutputBytesPerStream: maximumOutputBytesPerStream,
            maximumStandardInputBytes: maximumStandardInputBytes,
            pinnedIdentity: identity
        )
    }

    public func noSecretHandshake(timeout: Duration = .seconds(5)) async throws -> GameDevCLIExecutableIdentity {
        guard let executableURL else { throw GameDevCLIClientError.trustedExecutableRequired }
        let sourceBefore = try GameDevCLIRuntime.measure(configuredURL: executableURL)
        let snapshot = try GameDevCLIRuntime.snapshot(
            source: sourceBefore,
            expectedTreeSHA256: sourceBefore.treeSHA256
        )
        defer { snapshot.remove() }

        let nodeVersionOutcome = try await runHandshakeProcess(
            executableURL: snapshot.measurement.nodeURL,
            arguments: ["--version"],
            timeout: timeout
        )
        guard nodeVersionOutcome.exitCode == 0,
              let nodeVersion = Self.firstOutputLine(nodeVersionOutcome.standardOutput),
              !nodeVersion.isEmpty
        else {
            throw GameDevCLIClientError.handshakeFailed("the pinned Node runtime did not return a version")
        }

        let versionOutcome = try await runHandshakeProcess(
            executableURL: snapshot.measurement.nodeURL,
            arguments: [snapshot.measurement.entrypointURL.path, "--version"],
            timeout: timeout
        )
        guard versionOutcome.exitCode == 0,
              let cliVersion = Self.firstOutputLine(versionOutcome.standardOutput),
              !cliVersion.isEmpty
        else {
            throw GameDevCLIClientError.handshakeFailed("the staged CLI did not return a version")
        }

        // The CLI initializes local stores before reporting capabilities. Use a
        // private, disposable workspace and never inject a provider credential
        // into any handshake process.
        let handshakeWorkspace = FileManager.default.temporaryDirectory
            .appendingPathComponent("game-development-studio-handshake-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: handshakeWorkspace,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: NSNumber(value: 0o700)]
            )
        } catch {
            throw GameDevCLIClientError.handshakeFailed("could not create the temporary capabilities workspace")
        }
        defer { try? FileManager.default.removeItem(at: handshakeWorkspace) }

        let capabilitiesOutcome = try await runHandshakeProcess(
            executableURL: snapshot.measurement.nodeURL,
            arguments: [
                snapshot.measurement.entrypointURL.path,
                "capabilities", "--json",
                "--output-dir", handshakeWorkspace.path,
            ],
            timeout: timeout
        )
        guard capabilitiesOutcome.exitCode == 0 else {
            throw GameDevCLIClientError.handshakeFailed("capabilities returned exit \(capabilitiesOutcome.exitCode)")
        }

        let envelope: CLIResultEnvelope
        do {
            envelope = try JSONDecoder().decode(CLIResultEnvelope.self, from: capabilitiesOutcome.standardOutput)
        } catch {
            throw GameDevCLIClientError.handshakeFailed("capabilities did not return the structured result schema")
        }
        guard envelope.schema == Self.resultSchema,
              envelope.operation == "capabilities",
              envelope.ok,
              envelope.data["schema"]?.stringValue == Self.capabilitiesSchema,
              envelope.data["name"]?.stringValue == "game-development-studio",
              envelope.data["version"]?.stringValue == cliVersion,
              envelope.data["protocols"]?["result"]?.stringValue == Self.resultSchema
        else {
            throw GameDevCLIClientError.handshakeFailed("capabilities identity or schema did not match the supported contract")
        }

        let snapshotAfter: GameDevCLIRuntimeMeasurement
        let sourceAfter: GameDevCLIRuntimeMeasurement
        do {
            snapshotAfter = try GameDevCLIRuntime.measure(configuredURL: snapshot.measurement.rootURL)
            sourceAfter = try GameDevCLIRuntime.measure(configuredURL: sourceBefore.rootURL)
        } catch {
            throw GameDevCLIClientError.runtimeIdentityChanged
        }
        guard snapshotAfter.treeSHA256 == sourceBefore.treeSHA256,
              sourceAfter.treeSHA256 == sourceBefore.treeSHA256,
              snapshotAfter.nodeSHA256 == sourceBefore.nodeSHA256,
              snapshotAfter.entrypointSHA256 == sourceBefore.entrypointSHA256,
              sourceAfter.nodeSHA256 == sourceBefore.nodeSHA256,
              sourceAfter.entrypointSHA256 == sourceBefore.entrypointSHA256
        else {
            throw GameDevCLIClientError.runtimeIdentityChanged
        }

        return GameDevCLIExecutableIdentity(
            identitySchema: GameDevCLIRuntime.identitySchema,
            runtimeRootCanonicalPath: sourceBefore.rootURL.path,
            runtimeTreeSHA256: sourceBefore.treeSHA256,
            entrypointRelativePath: GameDevCLIRuntime.entrypointRelativePath,
            entrypointSHA256: sourceBefore.entrypointSHA256,
            nodeCanonicalPath: sourceBefore.nodeURL.path,
            nodeSHA256: sourceBefore.nodeSHA256,
            nodeVersion: nodeVersion,
            cliVersion: cliVersion,
            resultSchema: Self.resultSchema,
            capabilitiesSchema: Self.capabilitiesSchema
        )
    }

    /// How the runtime is asked to report: one `game_dev.result.v1` object, or a
    /// `game_dev.event.v1` JSON Lines stream. The two are mutually exclusive.
    enum OutputMode: Sendable {
        case singleResult
        case eventStream

        var flag: String {
            switch self {
            case .singleResult: "--json"
            case .eventStream: "--jsonl"
            }
        }

        var opposite: OutputMode {
            switch self {
            case .singleResult: .eventStream
            case .eventStream: .singleResult
            }
        }

        var description: String {
            switch self {
            case .singleResult: "single-result"
            case .eventStream: "streaming"
            }
        }
    }

    /// Everything needed to launch, after every trust and validation check has passed.
    ///
    /// `snapshot` must outlive the process: it is the private 0700 copy of the runtime
    /// that the child actually executes. The caller owns removing it.
    struct PreparedLaunch {
        let launchURL: URL
        let launchArguments: [String]
        let environment: [String: String]
        let snapshot: GameDevCLIRuntimeSnapshot?
        let secrets: [String]
    }

    /// The single path through validation, runtime attestation, snapshotting, argv and
    /// environment construction. Both `execute` and `stream` go through it, so a
    /// streaming call cannot skip a check that a buffered call performs.
    func prepareLaunch(
        _ invocation: CLIInvocation,
        credentials: [CredentialProvider: String],
        timeout: Duration?,
        outputMode: OutputMode
    ) async throws -> PreparedLaunch {
        try Task.checkCancellation()
        let requiresTrustedExecutable = Self.requiresTrustedExecutable(
            arguments: invocation.arguments,
            credentials: credentials
        )
        try validate(
            invocation,
            credentials: credentials,
            timeout: timeout,
            requiresTrustedExecutable: requiresTrustedExecutable,
            outputMode: outputMode
        )

        var runtimeSnapshot: GameDevCLIRuntimeSnapshot?
        var succeeded = false
        defer { if !succeeded { runtimeSnapshot?.remove() } }

        if requiresTrustedExecutable {
            guard let executableURL else { throw GameDevCLIClientError.trustedExecutableRequired }
            var sourceMeasurement: GameDevCLIRuntimeMeasurement
            do {
                sourceMeasurement = try GameDevCLIRuntime.measure(configuredURL: executableURL)
            } catch {
                if pinnedIdentity != nil { throw GameDevCLIClientError.runtimeIdentityChanged }
                throw error
            }
            let approvedIdentity: GameDevCLIExecutableIdentity
            if let pinnedIdentity {
                approvedIdentity = pinnedIdentity
            } else {
                approvedIdentity = try await noSecretHandshake(timeout: .seconds(5))
                sourceMeasurement = try GameDevCLIRuntime.measure(configuredURL: executableURL)
            }
            guard GameDevCLIRuntime.identityMatches(sourceMeasurement, approvedIdentity) else {
                throw GameDevCLIClientError.runtimeIdentityChanged
            }
            runtimeSnapshot = try GameDevCLIRuntime.snapshot(
                source: sourceMeasurement,
                expectedTreeSHA256: approvedIdentity.runtimeTreeSHA256
            )
        }

        var arguments = invocation.arguments
        if !arguments.contains(outputMode.flag) { arguments.append(outputMode.flag) }

        var environment = baseEnvironment
        environment.merge(Self.sanitizedEnvironment(invocation.environment)) { _, invocationValue in invocationValue }
        for (provider, credential) in credentials where !credential.isEmpty {
            environment[provider.environmentVariable] = credential
        }

        let launchURL: URL
        let launchArguments: [String]
        if let runtimeSnapshot {
            let finalMeasurement: GameDevCLIRuntimeMeasurement
            do {
                finalMeasurement = try GameDevCLIRuntime.measure(
                    configuredURL: runtimeSnapshot.measurement.rootURL
                )
            } catch {
                throw GameDevCLIClientError.runtimeIdentityChanged
            }
            guard finalMeasurement.treeSHA256 == runtimeSnapshot.measurement.treeSHA256,
                  finalMeasurement.nodeSHA256 == runtimeSnapshot.measurement.nodeSHA256,
                  finalMeasurement.entrypointSHA256 == runtimeSnapshot.measurement.entrypointSHA256
            else {
                throw GameDevCLIClientError.runtimeIdentityChanged
            }
            launchURL = finalMeasurement.nodeURL
            launchArguments = [finalMeasurement.entrypointURL.path] + arguments
        } else if let executableURL, Self.looksLikeRuntime(configuredURL: executableURL) {
            let runtime = try GameDevCLIRuntime.measure(configuredURL: executableURL)
            launchURL = runtime.nodeURL
            launchArguments = [runtime.entrypointURL.path] + arguments
        } else if let executableURL {
            launchURL = executableURL
            launchArguments = arguments
        } else {
            launchURL = URL(fileURLWithPath: "/usr/bin/env")
            launchArguments = [executableName] + arguments
        }

        succeeded = true
        return PreparedLaunch(
            launchURL: launchURL,
            launchArguments: launchArguments,
            environment: environment,
            snapshot: runtimeSnapshot,
            secrets: credentials.values.filter { !$0.isEmpty }
        )
    }

    public func execute(
        _ invocation: CLIInvocation,
        credentials: [CredentialProvider: String],
        timeout: Duration?
    ) async throws -> CLIExecutionResult {
        let prepared = try await prepareLaunch(
            invocation,
            credentials: credentials,
            timeout: timeout,
            outputMode: .singleResult
        )
        defer { prepared.snapshot?.remove() }
        let launchURL = prepared.launchURL
        let launchArguments = prepared.launchArguments
        let environment = prepared.environment

        let execution = ManagedProcess(
            executableURL: launchURL,
            arguments: launchArguments,
            environment: environment,
            workingDirectory: invocation.workingDirectory,
            standardInput: invocation.standardInput,
            maximumOutputBytesPerStream: maximumOutputBytesPerStream
        )

        do {
            try execution.start()
        } catch {
            let reason = SecretRedactor.redact(String(describing: error), secrets: prepared.secrets)
            throw GameDevCLIClientError.launchFailed(
                executable: launchURL.lastPathComponent,
                reason: reason
            )
        }

        let timeoutTask: Task<Void, Never>? = timeout.map { duration in
            Task {
                do {
                    try await ContinuousClock().sleep(for: duration)
                } catch {
                    return
                }
                guard !Task.isCancelled else { return }
                execution.requestStop(.timedOut(duration))
            }
        }
        defer { timeoutTask?.cancel() }

        let raw = try await withTaskCancellationHandler {
            try await execution.outcome()
        } onCancel: {
            execution.requestStop(.cancelled)
        }

        let secrets = prepared.secrets
        guard let stdout = String(data: raw.standardOutput, encoding: .utf8) else {
            throw GameDevCLIClientError.invalidUTF8(.standardOutput)
        }
        guard let stderr = String(data: raw.standardError, encoding: .utf8) else {
            throw GameDevCLIClientError.invalidUTF8(.standardError)
        }

        let envelope: CLIResultEnvelope
        do {
            envelope = try JSONDecoder().decode(CLIResultEnvelope.self, from: raw.standardOutput)
        } catch {
            let diagnosticSource = stdout.isEmpty ? stderr : stdout
            let diagnostic = SecretRedactor.redact(
                String(diagnosticSource.prefix(512)),
                secrets: Array(secrets)
            )
            throw GameDevCLIClientError.invalidJSON(
                exitCode: raw.exitCode,
                diagnostic: diagnostic.isEmpty ? "no diagnostic output" : diagnostic
            )
        }

        guard envelope.schema == Self.resultSchema else {
            throw GameDevCLIClientError.unexpectedSchema(envelope.schema)
        }
        if let expectedOperation = invocation.expectedOperation,
           envelope.operation != expectedOperation {
            throw GameDevCLIClientError.unexpectedOperation(
                expected: expectedOperation,
                actual: envelope.operation
            )
        }
        guard (raw.exitCode == 0) == envelope.ok else {
            throw GameDevCLIClientError.inconsistentResult(
                exitCode: raw.exitCode,
                ok: envelope.ok
            )
        }

        let redactedEnvelope = envelope.redacting(Array(secrets))
        let redactedStandardError = SecretRedactor.redact(stderr, secrets: Array(secrets))
        return CLIExecutionResult(
            invocation: invocation,
            envelope: redactedEnvelope,
            exitCode: raw.exitCode,
            standardOutput: redactedEnvelope.formattedJSON + "\n",
            standardError: redactedStandardError,
            startedAt: raw.startedAt,
            finishedAt: raw.finishedAt
        )
    }

    private func validate(
        _ invocation: CLIInvocation,
        credentials: [CredentialProvider: String],
        timeout: Duration?,
        requiresTrustedExecutable: Bool,
        outputMode: OutputMode
    ) throws {
        guard !executableName.isEmpty, !executableName.contains("\0") else {
            throw GameDevCLIClientError.invalidInvocation("the executable name is empty or contains a NUL byte")
        }
        if let executableURL, !executableURL.isFileURL {
            throw GameDevCLIClientError.invalidInvocation("the configured executable is not a file URL")
        }
        if requiresTrustedExecutable, executableURL == nil {
            throw GameDevCLIClientError.trustedExecutableRequired
        }
        if invocation.arguments.contains(where: { $0.contains("\0") }) {
            throw GameDevCLIClientError.invalidInvocation("an argument contains a NUL byte")
        }
        // The CLI exits 2 when both are supplied, so the caller must pick exactly one.
        // Which one is decided by the entry point (`execute` vs `stream`), never by the
        // caller smuggling a flag into `arguments`.
        if invocation.arguments.contains("--json"), invocation.arguments.contains("--jsonl") {
            throw GameDevCLIClientError.invalidInvocation("--json and --jsonl are mutually exclusive")
        }
        if invocation.arguments.contains(outputMode.opposite.flag) {
            throw GameDevCLIClientError.invalidInvocation(
                "\(outputMode.opposite.flag) cannot be used with a \(outputMode.description) invocation"
            )
        }
        let providerEnvironmentVariables = Set(
            CredentialProvider.allCases.map(\.environmentVariable)
        )
        if invocation.environment.keys.contains(where: providerEnvironmentVariables.contains) {
            throw GameDevCLIClientError.invalidInvocation(
                "provider credentials must use the explicit credentials parameter"
            )
        }
        if let workingDirectory = invocation.workingDirectory, !workingDirectory.isFileURL {
            throw GameDevCLIClientError.invalidInvocation("the working directory is not a file URL")
        }
        if let standardInput = invocation.standardInput,
           standardInput.count > maximumStandardInputBytes {
            throw GameDevCLIClientError.standardInputTooLarge(limit: maximumStandardInputBytes)
        }
        if let timeout, timeout <= .zero {
            throw GameDevCLIClientError.invalidInvocation("the timeout must be greater than zero")
        }
        for (provider, credential) in credentials where !credential.isEmpty {
            if invocation.arguments.contains(where: { $0.contains(credential) }) {
                throw GameDevCLIClientError.credentialInArguments(provider)
            }
        }
    }

    private static let inheritedEnvironmentAllowlist: Set<String> = [
        "PATH",
        "HOME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
    ]

    private static func sanitizedEnvironment(_ environment: [String: String]) -> [String: String] {
        environment.filter { inheritedEnvironmentAllowlist.contains($0.key) }
    }

    private static func requiresTrustedExecutable(
        arguments: [String],
        credentials: [CredentialProvider: String]
    ) -> Bool {
        if credentials.values.contains(where: { !$0.isEmpty }) { return true }
        guard let family = arguments.first?.lowercased() else { return false }
        switch family {
        case "provider", "scenario":
            return family == "provider" || arguments.dropFirst().first == "run"
        case "package":
            return arguments.dropFirst().first == "build"
        case "asset":
            return arguments.dropFirst().first == "normalize"
                || arguments.dropFirst().first == "preview-usdz"
        case "catalog", "adapter", "vendor", "launch", "migrate", "performance", "skill":
            return arguments.contains("--confirm")
        default:
            return false
        }
    }

    private static func looksLikeRuntime(configuredURL: URL) -> Bool {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: configuredURL.path, isDirectory: &isDirectory),
           isDirectory.boolValue {
            return true
        }
        return configuredURL.standardizedFileURL.path.hasSuffix("/payload/app/dist/cli.js")
    }

    private static func firstOutputLine(_ data: Data) -> String? {
        String(decoding: data, as: UTF8.self)
            .split(whereSeparator: \.isNewline)
            .first
            .map(String.init)
    }

    private func runHandshakeProcess(
        executableURL: URL,
        arguments: [String],
        timeout: Duration
    ) async throws -> RawProcessOutcome {
        let execution = ManagedProcess(
            executableURL: executableURL,
            arguments: arguments,
            environment: baseEnvironment,
            workingDirectory: nil,
            standardInput: nil,
            maximumOutputBytesPerStream: maximumOutputBytesPerStream
        )
        try execution.start()

        let timeoutTask = Task {
            do {
                try await ContinuousClock().sleep(for: timeout)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            execution.requestStop(.timedOut(timeout))
        }
        defer { timeoutTask.cancel() }

        return try await withTaskCancellationHandler {
            try await execution.outcome()
        } onCancel: {
            execution.requestStop(.cancelled)
        }
    }
}

struct RawProcessOutcome: Sendable {
    let exitCode: Int32
    let standardOutput: Data
    let standardError: Data
    let startedAt: Date
    let finishedAt: Date
}

final class ManagedProcess: @unchecked Sendable {
    private let process: Process
    private let standardInputPipe = Pipe()
    private let standardOutputPipe = Pipe()
    private let standardErrorPipe = Pipe()
    private let standardInput: Data?
    private let maximumOutputBytesPerStream: Int
    /// When set, standard output is delivered a complete line at a time instead of
    /// being accumulated. In this mode `maximumOutputBytesPerStream` bounds a single
    /// line rather than the whole stream, because a JSON Lines stream is consumed
    /// incrementally and has no meaningful total size.
    private let standardOutputLineSink: (@Sendable (Data) -> Void)?
    private let stateQueue = DispatchQueue(label: "Anvil.GameDevCLIClient.state")
    private let inputQueue = DispatchQueue(label: "Anvil.GameDevCLIClient.input")
    private let forcedTerminationGrace: DispatchTimeInterval = .milliseconds(350)
    private let pipeDrainGrace: DispatchTimeInterval = .milliseconds(150)

    private var standardOutputReadSource: DispatchSourceRead?
    private var standardErrorReadSource: DispatchSourceRead?
    private var processExitSource: DispatchSourceProcess?
    private var standardOutput = Data()
    private var standardError = Data()
    private var completion: Result<RawProcessOutcome, any Error>?
    private var waiters: [CheckedContinuation<RawProcessOutcome, any Error>] = []
    private var pendingFailure: GameDevCLIClientError?
    private var finishScheduled = false
    private var startedAt = Date()

    init(
        executableURL: URL,
        arguments: [String],
        environment: [String: String],
        workingDirectory: URL?,
        standardInput: Data?,
        maximumOutputBytesPerStream: Int,
        standardOutputLineSink: (@Sendable (Data) -> Void)? = nil
    ) {
        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        process.environment = environment
        process.currentDirectoryURL = workingDirectory
        process.standardInput = standardInputPipe
        process.standardOutput = standardOutputPipe
        process.standardError = standardErrorPipe
        self.process = process
        self.standardInput = standardInput
        self.maximumOutputBytesPerStream = maximumOutputBytesPerStream
        self.standardOutputLineSink = standardOutputLineSink
    }

    func start() throws {
        let outputHandle = standardOutputPipe.fileHandleForReading
        let errorHandle = standardErrorPipe.fileHandleForReading
        startedAt = Date()
        process.terminationHandler = { [weak self] terminatedProcess in
            self?.stateQueue.async { [weak self] in
                self?.finish(process: terminatedProcess)
            }
        }
        do {
            try process.run()
        } catch {
            process.terminationHandler = nil
            try? standardInputPipe.fileHandleForWriting.close()
            try? outputHandle.close()
            try? errorHandle.close()
            throw error
        }

        // Foundation's termination callback is the primary completion path.
        // Keep a kernel process-exit source as an independent wake-up: GUI
        // launches have exhibited a delayed Foundation callback for a
        // shebang-launched Node process even after the direct PID disappeared.
        // Both paths converge on finish(), whose idempotent guard preserves a
        // single result.
        let exitSource = DispatchSource.makeProcessSource(
            identifier: process.processIdentifier,
            eventMask: .exit,
            queue: stateQueue
        )
        processExitSource = exitSource
        exitSource.setEventHandler { [weak self, process] in
            self?.finish(process: process)
        }
        exitSource.resume()

        let outputSource = DispatchSource.makeReadSource(
            fileDescriptor: outputHandle.fileDescriptor,
            queue: stateQueue
        )
        standardOutputReadSource = outputSource
        outputSource.setEventHandler { [weak self] in
            guard let self,
                  let source = self.standardOutputReadSource
            else { return }
            let availableBytes = source.data
            guard availableBytes > 0 else {
                self.quiesceReadSource(for: .standardOutput)
                return
            }
            self.drainAvailableData(
                from: outputHandle,
                stream: .standardOutput,
                availableBytes: availableBytes
            )
        }
        outputSource.resume()

        let errorSource = DispatchSource.makeReadSource(
            fileDescriptor: errorHandle.fileDescriptor,
            queue: stateQueue
        )
        standardErrorReadSource = errorSource
        errorSource.setEventHandler { [weak self] in
            guard let self,
                  let source = self.standardErrorReadSource
            else { return }
            let availableBytes = source.data
            guard availableBytes > 0 else {
                self.quiesceReadSource(for: .standardError)
                return
            }
            self.drainAvailableData(
                from: errorHandle,
                stream: .standardError,
                availableBytes: availableBytes
            )
        }
        errorSource.resume()

        inputQueue.async { [weak self] in
            self?.writeStandardInputAndClose()
        }
    }

    func outcome() async throws -> RawProcessOutcome {
        try await withCheckedThrowingContinuation { continuation in
            stateQueue.async { [weak self] in
                guard let self else {
                    continuation.resume(throwing: GameDevCLIClientError.cancelled)
                    return
                }
                if let completion {
                    continuation.resume(with: completion)
                } else {
                    waiters.append(continuation)
                }
            }
        }
    }

    func requestStop(_ failure: GameDevCLIClientError) {
        stateQueue.async { [weak self] in
            guard let self, completion == nil else { return }
            if pendingFailure == nil { pendingFailure = failure }
            terminateProcess()
        }
    }

    private func writeStandardInputAndClose() {
        let handle = standardInputPipe.fileHandleForWriting
        defer { try? handle.close() }
        guard let standardInput, !standardInput.isEmpty else { return }
        do {
            try handle.write(contentsOf: standardInput)
        } catch {
            requestStop(.standardInputWriteFailed)
        }
    }

    private func drainAvailableData(
        from handle: FileHandle,
        stream: ProcessOutputStream,
        availableBytes: UInt
    ) {
        guard completion == nil, pendingFailure == nil, availableBytes > 0 else { return }

        let maximumRead = min(
            UInt(maximumOutputBytesPerStream + 1),
            max(1, availableBytes)
        )
        var buffer = [UInt8](repeating: 0, count: Int(min(maximumRead, 64 * 1024)))
        let bytesRead = buffer.withUnsafeMutableBytes { rawBuffer -> Int in
            guard let baseAddress = rawBuffer.baseAddress else { return 0 }
            return Darwin.read(handle.fileDescriptor, baseAddress, rawBuffer.count)
        }
        if bytesRead == 0 {
            // A readable dispatch source is also signalled for EOF. Leaving
            // it armed after the descriptor reaches EOF causes an event
            // storm that can starve the bounded finish timer on a busy test
            // suite. The other pipe may still be held by a descendant; only
            // this stream is quiesced, and descriptor closure remains owned
            // by complete(process:).
            quiesceReadSource(for: stream)
            return
        }
        guard bytesRead > 0 else { return }
        append(Data(bytes: buffer, count: bytesRead), to: stream)
    }

    private func quiesceReadSource(for stream: ProcessOutputStream) {
        switch stream {
        case .standardOutput:
            standardOutputReadSource?.cancel()
            standardOutputReadSource = nil
        case .standardError:
            standardErrorReadSource?.cancel()
            standardErrorReadSource = nil
        }
    }

    private func append(_ data: Data, to stream: ProcessOutputStream) {
        guard !data.isEmpty else { return }
        if stream == .standardOutput, let standardOutputLineSink {
            appendStreamingStandardOutput(data, sink: standardOutputLineSink)
            return
        }
        let currentCount = stream == .standardOutput ? standardOutput.count : standardError.count
        let remaining = max(0, maximumOutputBytesPerStream - currentCount)
        let accepted = data.prefix(remaining)
        if stream == .standardOutput {
            standardOutput.append(contentsOf: accepted)
        } else {
            standardError.append(contentsOf: accepted)
        }
        if data.count > remaining, pendingFailure == nil {
            pendingFailure = .outputLimitExceeded(
                stream: stream,
                limit: maximumOutputBytesPerStream
            )
            terminateProcess()
        }
    }

    /// Splits standard output on newlines and hands each complete line to the sink,
    /// retaining only the trailing partial line. Runs on `stateQueue`, so the sink is
    /// serialized with every other state transition.
    private func appendStreamingStandardOutput(_ data: Data, sink: @Sendable (Data) -> Void) {
        standardOutput.append(data)
        let newline = UInt8(ascii: "\n")
        while let newlineIndex = standardOutput.firstIndex(of: newline) {
            let line = standardOutput[standardOutput.startIndex..<newlineIndex]
            standardOutput.removeSubrange(standardOutput.startIndex...newlineIndex)
            guard !line.isEmpty else { continue }
            sink(Data(line))
        }
        // A partial line larger than the cap is a protocol violation, not backpressure:
        // the runtime writes one compact JSON object per line.
        if standardOutput.count > maximumOutputBytesPerStream, pendingFailure == nil {
            pendingFailure = .outputLimitExceeded(
                stream: .standardOutput,
                limit: maximumOutputBytesPerStream
            )
            terminateProcess()
        }
    }

    private func terminateProcess() {
        guard process.isRunning else { return }
        let processIdentifier = process.processIdentifier
        process.terminate()
        stateQueue.asyncAfter(deadline: .now() + forcedTerminationGrace) { [weak self] in
            guard let self,
                  completion == nil,
                  process.isRunning,
                  process.processIdentifier == processIdentifier
            else { return }
            _ = Darwin.kill(processIdentifier, SIGKILL)
        }
    }

    private func finish(process: Process) {
        guard completion == nil, !finishScheduled else { return }
        finishScheduled = true

        // A descendant can retain either pipe after the direct child exits.
        // Keep the capped readability drains alive for a small grace period,
        // then close our descriptors without a blocking read-to-EOF. The
        // direct process' termination result (including cancellation/timeout)
        // remains authoritative regardless of inherited pipe holders.
        stateQueue.asyncAfter(deadline: .now() + pipeDrainGrace) { [weak self] in
            guard let self, completion == nil else { return }
            complete(process: process)
        }
    }

    private func complete(process: Process) {
        guard completion == nil else { return }

        let outputHandle = standardOutputPipe.fileHandleForReading
        let errorHandle = standardErrorPipe.fileHandleForReading
        standardOutputReadSource?.cancel()
        standardErrorReadSource?.cancel()
        standardOutputReadSource = nil
        standardErrorReadSource = nil
        processExitSource?.cancel()
        processExitSource = nil
        process.terminationHandler = nil
        try? outputHandle.close()
        try? errorHandle.close()

        let result: Result<RawProcessOutcome, any Error>
        if pendingFailure == .cancelled {
            result = .failure(CancellationError())
        } else if let pendingFailure {
            result = .failure(pendingFailure)
        } else {
            result = .success(RawProcessOutcome(
                exitCode: process.terminationStatus,
                standardOutput: standardOutput,
                standardError: standardError,
                startedAt: startedAt,
                finishedAt: Date()
            ))
        }
        completion = result
        let continuations = waiters
        waiters.removeAll(keepingCapacity: false)
        for continuation in continuations {
            continuation.resume(with: result)
        }
    }
}
