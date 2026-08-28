import Foundation
import CryptoKit
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
    case executableIdentityChanged
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
            "Credential-bearing and write or capture operations require a configured absolute executable path."
        case .executableNotRegular:
            "The configured game-dev executable must be an absolute executable regular file."
        case .executableIdentityChanged:
            "The configured game-dev executable changed after approval; review the operation again."
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
    public let canonicalPath: String
    public let sha256: String
    public let version: String
    public let resultSchema: String
    public let capabilitiesSchema: String

    public init(
        canonicalPath: String,
        sha256: String,
        version: String,
        resultSchema: String,
        capabilitiesSchema: String
    ) {
        self.canonicalPath = canonicalPath
        self.sha256 = sha256
        self.version = version
        self.resultSchema = resultSchema
        self.capabilitiesSchema = capabilitiesSchema
    }

    public var description: String {
        "path=\(canonicalPath), sha256=\(sha256), version=\(version), resultSchema=\(resultSchema), capabilitiesSchema=\(capabilitiesSchema)"
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
        let canonicalURL = try Self.canonicalExecutableURL(executableURL)

        let versionOutcome = try await runHandshakeProcess(
            executableURL: canonicalURL,
            arguments: ["--version"],
            timeout: timeout
        )
        guard versionOutcome.exitCode == 0,
              let version = Self.firstOutputLine(versionOutcome.standardOutput),
              !version.isEmpty
        else {
            throw GameDevCLIClientError.handshakeFailed("--version did not return a version")
        }

        let capabilitiesOutcome = try await runHandshakeProcess(
            executableURL: canonicalURL,
            arguments: ["capabilities", "--json"],
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
              envelope.data["version"]?.stringValue == version,
              envelope.data["protocols"]?["result"]?.stringValue == Self.resultSchema
        else {
            throw GameDevCLIClientError.handshakeFailed("capabilities identity or schema did not match the supported contract")
        }

        // Hash after the no-secret probes as well as before launching them. This
        // narrows the approval-to-use race and makes the returned identity the
        // one that is actually about to be used.
        let fileIdentity = try Self.fileIdentity(for: canonicalURL)

        return GameDevCLIExecutableIdentity(
            canonicalPath: fileIdentity.canonicalPath,
            sha256: fileIdentity.sha256,
            version: version,
            resultSchema: Self.resultSchema,
            capabilitiesSchema: Self.capabilitiesSchema
        )
    }

    public func execute(
        _ invocation: CLIInvocation,
        credentials: [CredentialProvider: String],
        timeout: Duration?
    ) async throws -> CLIExecutionResult {
        try Task.checkCancellation()
        let requiresTrustedExecutable = Self.requiresTrustedExecutable(
            arguments: invocation.arguments,
            credentials: credentials
        )
        try validate(
            invocation,
            credentials: credentials,
            timeout: timeout,
            requiresTrustedExecutable: requiresTrustedExecutable
        )

        let trustedExecutableURL: URL?
        if requiresTrustedExecutable {
            trustedExecutableURL = try Self.canonicalExecutableURL(executableURL)
            let currentIdentity = try Self.fileIdentity(for: trustedExecutableURL!)
            if let pinnedIdentity,
               pinnedIdentity.canonicalPath != currentIdentity.canonicalPath
                || pinnedIdentity.sha256 != currentIdentity.sha256 {
                throw GameDevCLIClientError.executableIdentityChanged
            }
            if pinnedIdentity == nil {
                let handshakeIdentity = try await noSecretHandshake(timeout: .seconds(5))
                // Keep the no-secret handshake and the launch bound to the
                // same canonical path and bytes. A caller that supplied a pin
                // has already performed the handshake during approval.
                if handshakeIdentity.canonicalPath != currentIdentity.canonicalPath
                    || handshakeIdentity.sha256 != currentIdentity.sha256 {
                    throw GameDevCLIClientError.executableIdentityChanged
                }
            }
        } else {
            trustedExecutableURL = nil
        }

        var arguments = invocation.arguments
        if !arguments.contains("--json") { arguments.append("--json") }

        var environment = baseEnvironment
        environment.merge(Self.sanitizedEnvironment(invocation.environment)) { _, invocationValue in invocationValue }
        for (provider, credential) in credentials where !credential.isEmpty {
            environment[provider.environmentVariable] = credential
        }

        let launchURL: URL
        let launchArguments: [String]
        if let executableURL {
            launchURL = trustedExecutableURL ?? executableURL
            launchArguments = arguments
        } else {
            launchURL = URL(fileURLWithPath: "/usr/bin/env")
            launchArguments = [executableName] + arguments
        }

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
            let secrets = credentials.values.filter { !$0.isEmpty }
            let reason = SecretRedactor.redact(String(describing: error), secrets: Array(secrets))
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

        let secrets = credentials.values.filter { !$0.isEmpty }
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
        requiresTrustedExecutable: Bool
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
        if invocation.arguments.contains("--jsonl") {
            throw GameDevCLIClientError.invalidInvocation("JSON Lines is not supported by the single-result app client")
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

    private static func canonicalExecutableURL(_ url: URL?) throws -> URL {
        guard let url,
              url.isFileURL,
              url.path.hasPrefix("/")
        else { throw GameDevCLIClientError.trustedExecutableRequired }

        let canonicalURL = url.standardizedFileURL.resolvingSymlinksInPath().standardizedFileURL
        guard canonicalURL.path.hasPrefix("/") else {
            throw GameDevCLIClientError.executableNotRegular
        }
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: canonicalURL.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  let permissions = attributes[.posixPermissions] as? NSNumber,
                  permissions.intValue & 0o111 != 0
            else { throw GameDevCLIClientError.executableNotRegular }
        } catch let error as GameDevCLIClientError {
            throw error
        } catch {
            throw GameDevCLIClientError.executableNotRegular
        }
        return canonicalURL
    }

    private static func fileIdentity(for url: URL) throws -> (canonicalPath: String, sha256: String) {
        let data: Data
        do {
            data = try Data(contentsOf: url, options: [.mappedIfSafe])
        } catch {
            throw GameDevCLIClientError.executableNotRegular
        }
        let digest = SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
        return (url.path, digest)
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

private struct RawProcessOutcome: Sendable {
    let exitCode: Int32
    let standardOutput: Data
    let standardError: Data
    let startedAt: Date
    let finishedAt: Date
}

private final class ManagedProcess: @unchecked Sendable {
    private let process: Process
    private let standardInputPipe = Pipe()
    private let standardOutputPipe = Pipe()
    private let standardErrorPipe = Pipe()
    private let standardInput: Data?
    private let maximumOutputBytesPerStream: Int
    private let stateQueue = DispatchQueue(label: "GameDevelopmentStudio.GameDevCLIClient.state")
    private let inputQueue = DispatchQueue(label: "GameDevelopmentStudio.GameDevCLIClient.input")
    private let forcedTerminationGrace: DispatchTimeInterval = .milliseconds(350)
    private let pipeDrainGrace: DispatchTimeInterval = .milliseconds(150)

    private var standardOutputReadSource: DispatchSourceRead?
    private var standardErrorReadSource: DispatchSourceRead?
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
        maximumOutputBytesPerStream: Int
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
    }

    func start() throws {
        let outputHandle = standardOutputPipe.fileHandleForReading
        let errorHandle = standardErrorPipe.fileHandleForReading
        startedAt = Date()
        do {
            try process.run()
        } catch {
            process.terminationHandler = nil
            try? standardInputPipe.fileHandleForWriting.close()
            try? outputHandle.close()
            try? errorHandle.close()
            throw error
        }

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

        // Observe the direct PID on a detached queue. Process.waitUntilExit()
        // can remain in Foundation's run-loop wait when several short-lived
        // NSTask instances are used in one suite. Polling isRunning gives us
        // the direct process boundary without waiting for inherited pipe
        // holders, while the readability handlers continue draining capped
        // output.
        DispatchQueue.global(qos: .utility).async { [weak self, process] in
            while process.isRunning {
                Thread.sleep(forTimeInterval: 0.005)
            }
            self?.stateQueue.async { [weak self] in
                self?.finish(process: process)
            }
        }

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
