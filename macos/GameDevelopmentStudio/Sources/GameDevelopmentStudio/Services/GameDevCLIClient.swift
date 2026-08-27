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
    case inconsistentResult(exitCode: Int32, ok: Bool)

    public var errorDescription: String? {
        switch self {
        case let .invalidInvocation(reason):
            "Invalid game-dev invocation: \(reason)"
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
        case let .inconsistentResult(exitCode, ok):
            "game-dev returned contradictory status (exit \(exitCode), ok \(ok))."
        }
    }
}

public struct GameDevCLIClient: GameDevCLIClientProtocol, Sendable {
    public static let resultSchema = "game_dev.result.v1"

    private let executableURL: URL?
    private let executableName: String
    private let baseEnvironment: [String: String]
    private let maximumOutputBytesPerStream: Int
    private let maximumStandardInputBytes: Int

    public init(
        executableURL: URL? = nil,
        executableName: String = "game-dev",
        baseEnvironment: [String: String] = ProcessInfo.processInfo.environment,
        maximumOutputBytesPerStream: Int = 4 * 1024 * 1024,
        maximumStandardInputBytes: Int = 4 * 1024 * 1024
    ) {
        self.executableURL = executableURL
        self.executableName = executableName
        self.baseEnvironment = baseEnvironment
        self.maximumOutputBytesPerStream = max(1, maximumOutputBytesPerStream)
        self.maximumStandardInputBytes = max(1, maximumStandardInputBytes)
    }

    public func execute(
        _ invocation: CLIInvocation,
        credentials: [CredentialProvider: String],
        timeout: Duration?
    ) async throws -> CLIExecutionResult {
        try Task.checkCancellation()
        try validate(invocation, credentials: credentials, timeout: timeout)

        var arguments = invocation.arguments
        if !arguments.contains("--json") { arguments.append("--json") }

        var environment = baseEnvironment
        for provider in CredentialProvider.allCases {
            environment.removeValue(forKey: provider.environmentVariable)
        }
        environment.merge(invocation.environment) { _, invocationValue in invocationValue }
        for (provider, credential) in credentials where !credential.isEmpty {
            environment[provider.environmentVariable] = credential
        }

        let launchURL: URL
        let launchArguments: [String]
        if let executableURL {
            launchURL = executableURL
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
        timeout: Duration?
    ) throws {
        guard !executableName.isEmpty, !executableName.contains("\0") else {
            throw GameDevCLIClientError.invalidInvocation("the executable name is empty or contains a NUL byte")
        }
        if let executableURL, !executableURL.isFileURL {
            throw GameDevCLIClientError.invalidInvocation("the configured executable is not a file URL")
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

    private var standardOutput = Data()
    private var standardError = Data()
    private var completion: Result<RawProcessOutcome, any Error>?
    private var waiters: [CheckedContinuation<RawProcessOutcome, any Error>] = []
    private var pendingFailure: GameDevCLIClientError?
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

        outputHandle.readabilityHandler = { [weak self] handle in
            self?.stateQueue.async { [weak self] in
                self?.drainAvailableData(from: handle, stream: .standardOutput)
            }
        }
        errorHandle.readabilityHandler = { [weak self] handle in
            self?.stateQueue.async { [weak self] in
                self?.drainAvailableData(from: handle, stream: .standardError)
            }
        }
        process.terminationHandler = { [weak self] process in
            self?.stateQueue.async { [weak self] in
                self?.finish(process: process)
            }
        }

        startedAt = Date()
        do {
            try process.run()
        } catch {
            outputHandle.readabilityHandler = nil
            errorHandle.readabilityHandler = nil
            process.terminationHandler = nil
            try? standardInputPipe.fileHandleForWriting.close()
            try? outputHandle.close()
            try? errorHandle.close()
            throw error
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

    private func drainAvailableData(from handle: FileHandle, stream: ProcessOutputStream) {
        guard completion == nil else { return }
        append(handle.availableData, to: stream)
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
        guard completion == nil else { return }

        let outputHandle = standardOutputPipe.fileHandleForReading
        let errorHandle = standardErrorPipe.fileHandleForReading
        outputHandle.readabilityHandler = nil
        errorHandle.readabilityHandler = nil
        append(outputHandle.readDataToEndOfFile(), to: .standardOutput)
        append(errorHandle.readDataToEndOfFile(), to: .standardError)
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
