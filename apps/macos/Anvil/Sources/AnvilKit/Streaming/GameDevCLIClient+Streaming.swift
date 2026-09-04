import Foundation

/// The outcome of a streamed invocation, reconstructed from the stream's terminal event.
///
/// `--jsonl` emits no `game_dev.result.v1` object: the terminal event
/// (`completed`, `failed` or `approval_required`) carries the result payload in its
/// `data`. Anvil synthesizes an equivalent envelope so callers of `execute` and
/// `stream` converge on one result type.
public enum RunStreamElement: Sendable {
    case event(GameDevEvent)
    /// Always the final element of a stream that completed. A stream that ends without
    /// it either threw or was cancelled.
    case outcome(StreamedRunOutcome)

    public var event: GameDevEvent? {
        if case let .event(event) = self { event } else { nil }
    }

    public var outcome: StreamedRunOutcome? {
        if case let .outcome(outcome) = self { outcome } else { nil }
    }
}

public struct StreamedRunOutcome: Sendable {
    public let envelope: CLIResultEnvelope
    public let terminalEvent: GameDevEvent
    public let artifacts: [RunArtifact]
    public let exitCode: Int32
    public let standardError: String
    public let startedAt: Date
    public let finishedAt: Date

    public var wasCancelled: Bool { terminalEvent.isCancellation }
}

extension GameDevCLIClient {
    /// Runs an invocation in `--jsonl` mode, yielding each `game_dev.event.v1` line as
    /// it arrives.
    ///
    /// Every trust check that `execute` performs is performed here too: both entry
    /// points share `prepareLaunch`, so a streaming call cannot skip runtime
    /// attestation, the environment allowlist, or the credential-in-argv refusal.
    ///
    /// The stream finishes after the process exits. It throws rather than finishing
    /// when the runtime emits an undecodable line, when no terminal event arrives, or
    /// when the process fails to start — a stream that simply ends is otherwise
    /// indistinguishable from one that succeeded.
    ///
    /// - Note: sequence numbers are *not* validated for monotonicity. `job follow`
    ///   replays events persisted by an earlier process verbatim
    ///   (`EventStream.replay`), so one follow stream legitimately carries several
    ///   independent sequence runs and more than one `job_id`.
    public func stream(
        _ invocation: CLIInvocation,
        credentials: [CredentialProvider: String],
        timeout: Duration?
    ) -> AsyncThrowingStream<RunStreamElement, any Error> {
        AsyncThrowingStream { continuation in
            let accumulator = StreamAccumulator()

            let task = Task {
                do {
                    let prepared = try await prepareLaunch(
                        invocation,
                        credentials: credentials,
                        timeout: timeout,
                        outputMode: .eventStream
                    )
                    defer { prepared.snapshot?.remove() }

                    let secrets = prepared.secrets
                    let execution = ManagedProcess(
                        executableURL: prepared.launchURL,
                        arguments: prepared.launchArguments,
                        environment: prepared.environment,
                        workingDirectory: invocation.workingDirectory,
                        standardInput: invocation.standardInput,
                        maximumOutputBytesPerStream: maximumEventLineBytes,
                        standardOutputLineSink: { line in
                            accumulator.ingest(line, secrets: secrets, into: continuation)
                        }
                    )
                    accumulator.attach(execution)

                    do {
                        try execution.start()
                    } catch {
                        let reason = SecretRedactor.redact(
                            String(describing: error),
                            secrets: secrets
                        )
                        throw GameDevCLIClientError.launchFailed(
                            executable: prepared.launchURL.lastPathComponent,
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

                    // A line that failed to decode outranks whatever the process did
                    // next. Stopping the child is *how* a decode failure is handled, so
                    // the resulting stop error would otherwise mask its own cause and
                    // surface as a bare cancellation.
                    let raw: RawProcessOutcome
                    do {
                        raw = try await execution.outcome()
                    } catch {
                        if let failure = accumulator.decodingFailure { throw failure }
                        throw error
                    }
                    if let failure = accumulator.decodingFailure { throw failure }

                    guard let terminal = accumulator.lastTerminalEvent else {
                        throw GameDevCLIClientError.invalidJSON(
                            exitCode: raw.exitCode,
                            diagnostic: accumulator.eventCount == 0
                                ? "the runtime produced no events"
                                : "the event stream ended without a terminal event"
                        )
                    }

                    let standardError = SecretRedactor.redact(
                        String(data: raw.standardError, encoding: .utf8) ?? "",
                        secrets: secrets
                    )
                    continuation.yield(.outcome(StreamedRunOutcome(
                        envelope: Self.envelope(from: terminal).redacting(secrets),
                        terminalEvent: terminal,
                        artifacts: accumulator.artifacts,
                        exitCode: raw.exitCode,
                        standardError: standardError,
                        startedAt: raw.startedAt,
                        finishedAt: raw.finishedAt
                    )))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { termination in
                if case .cancelled = termination {
                    accumulator.requestStop()
                }
                task.cancel()
            }
        }
    }

    /// Bound on a single JSON Lines record. Generous next to the largest terminal
    /// payload the CLI emits, and small enough that a runaway line is caught quickly.
    private var maximumEventLineBytes: Int { 4 * 1024 * 1024 }

    /// Rebuilds a `game_dev.result.v1` envelope from a terminal event.
    ///
    /// `failed` and `approval_required` payloads are the CLI's error body, so they are
    /// placed in both `data` and `error`: that is what the buffered decoder produces for
    /// the same run, which keeps `CLIResultEnvelope.status` — and therefore approval
    /// detection — identical across the two transports.
    static func envelope(from terminal: GameDevEvent) -> CLIResultEnvelope {
        let payload = JSONValue.object(terminal.data)
        let ok = terminal.kind == .completed
        return CLIResultEnvelope(
            schema: GameDevCLIClient.resultSchema,
            operation: terminal.operation,
            ok: ok,
            data: payload,
            error: ok ? nil : payload,
            receivedAt: terminal.timestamp
        )
    }
}

/// Collects stream state that is written from `stateQueue` and read from the consuming
/// task. `ManagedProcess` serializes sink calls, but the terminal read happens on
/// another thread, so the shared fields are lock-guarded.
private final class StreamAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var _decodingFailure: (any Error)?
    private var _lastTerminalEvent: GameDevEvent?
    private var _artifacts: [RunArtifact] = []
    private var _eventCount = 0
    private var _process: ManagedProcess?

    var decodingFailure: (any Error)? { lock.withLock { _decodingFailure } }
    var lastTerminalEvent: GameDevEvent? { lock.withLock { _lastTerminalEvent } }
    var artifacts: [RunArtifact] { lock.withLock { _artifacts } }
    var eventCount: Int { lock.withLock { _eventCount } }

    func attach(_ process: ManagedProcess) {
        lock.withLock { _process = process }
    }

    func requestStop() {
        let process = lock.withLock { _process }
        process?.requestStop(.cancelled)
    }

    func ingest(
        _ line: Data,
        secrets: [String],
        into continuation: AsyncThrowingStream<RunStreamElement, any Error>.Continuation
    ) {
        let event: GameDevEvent
        do {
            event = try JSONDecoder().decode(GameDevEvent.self, from: line)
        } catch {
            let diagnostic = SecretRedactor.redact(
                String(decoding: line.prefix(512), as: UTF8.self),
                secrets: secrets
            )
            lock.withLock {
                guard _decodingFailure == nil else { return }
                _decodingFailure = GameDevCLIClientError.invalidJSON(
                    exitCode: 0,
                    diagnostic: "undecodable event line: \(diagnostic)"
                )
            }
            requestStop()
            return
        }

        let redacted = event.redacting(secrets)
        lock.withLock {
            _eventCount += 1
            if redacted.kind.isTerminal { _lastTerminalEvent = redacted }
            if let artifact = redacted.artifact { _artifacts.append(artifact) }
        }
        continuation.yield(.event(redacted))
    }

}
