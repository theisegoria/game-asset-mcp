import Foundation
import Observation
import OSLog

/// Every run Anvil knows about, live and historical.
///
/// Replaces the previous app's single `ExecutionState` and global operation token.
/// Several runs proceed at once; only runs sharing an exclusion lane wait for each other.
@MainActor
@Observable
public final class RunStore {
    public private(set) var runs: [Run] = []
    /// Runs whose persisted record would not decode. Surfaced rather than dropped: one
    /// of them could be a paid job still in flight.
    public private(set) var unreadableRunIDs: [String] = []

    @ObservationIgnored private let client: GameDevCLIClient
    @ObservationIgnored private let log: RunLog
    @ObservationIgnored private let scheduler = RunScheduler()
    @ObservationIgnored private var tasks: [RunID: Task<Void, Never>] = [:]
    @ObservationIgnored private static let logger = Logger(
        subsystem: "com.theisegoria.Anvil",
        category: "Runs"
    )

    public init(client: GameDevCLIClient, log: RunLog) {
        self.client = client
        self.log = log
    }

    // MARK: - History

    public func restore() {
        do {
            try log.prepare()
            let loaded = try log.loadAll()
            unreadableRunIDs = loaded.skipped
            runs = loaded.runs.map { run in
                var run = run
                // A run that was mid-flight when the app quit did not survive the quit.
                // Marking it failed is honest; leaving it "running" would show a spinner
                // for a process that no longer exists.
                if run.state.isActive {
                    run.state = .failed("Anvil quit while this run was in progress.")
                    run.finishedAt = run.finishedAt ?? Date()
                }
                return run
            }
            if !loaded.skipped.isEmpty {
                Self.logger.error(
                    "Skipped \(loaded.skipped.count, privacy: .public) unreadable run records"
                )
            }
        } catch {
            Self.logger.error("Could not restore runs: \(error.localizedDescription, privacy: .public)")
        }
    }

    public func events(for id: RunID) -> [GameDevEvent] {
        if let run = self[id], !run.events.isEmpty { return run.events }
        return (try? log.events(for: id)) ?? []
    }

    public subscript(id: RunID) -> Run? {
        runs.first { $0.id == id }
    }

    public var activeRuns: [Run] { runs.filter(\.state.isActive) }

    public func resumableRuns() -> [Run] { runs.filter(\.isResumable) }

    // MARK: - Starting work

    /// Starts a run for `spec`.
    ///
    /// A paid command requires an ``ApprovalGrant``; the authority flags it carries are
    /// the only way `--approve-spend` and `--spend-limit-cents` reach the command line.
    /// A paid spec without a grant is refused here rather than deeper down, so the
    /// refusal is testable in isolation.
    @discardableResult
    public func start(
        _ spec: CommandSpec,
        arguments: [String],
        outputDirectory: URL,
        credentials: [CredentialProvider: String] = [:],
        grant: ApprovalGrant? = nil,
        timeout: Duration? = nil
    ) throws -> RunID {
        if spec.spend.isPaid, grant == nil {
            throw RunStoreError.approvalRequired(spec.id)
        }

        let argv = try Self.commandLine(
            for: spec,
            arguments: arguments,
            outputDirectory: outputDirectory,
            grant: grant
        )

        var run = Run(
            commandID: spec.id,
            title: spec.title,
            arguments: argv,
            outputDirectory: outputDirectory,
            approval: grant.map(ApprovalRecord.init)
        )
        run.state = .queued
        runs.insert(run, at: 0)
        try? log.save(run)

        let id = run.id
        let invocation = CLIInvocation(
            arguments: argv,
            workingDirectory: nil,
            expectedOperation: spec.expectedOperation
        )
        tasks[id] = Task { [weak self] in
            await self?.execute(
                id: id,
                spec: spec,
                invocation: invocation,
                credentials: credentials,
                timeout: timeout
            )
        }
        return id
    }

    public func cancel(_ id: RunID) {
        tasks[id]?.cancel()
    }

    // MARK: - Execution

    private func execute(
        id: RunID,
        spec: CommandSpec,
        invocation: CLIInvocation,
        credentials: [CredentialProvider: String],
        timeout: Duration?
    ) async {
        await scheduler.run(in: spec.lane) { [client] in
            switch spec.transport {
            case .events:
                do {
                    for try await element in client.stream(
                        invocation,
                        credentials: credentials,
                        timeout: timeout
                    ) {
                        switch element {
                        case let .event(event):
                            await self.absorb(event, into: id)
                        case let .outcome(outcome):
                            await self.settle(id, with: outcome)
                        }
                    }
                } catch {
                    await self.fail(id, with: error)
                }
            case .result:
                do {
                    let result = try await client.execute(
                        invocation,
                        credentials: credentials,
                        timeout: timeout
                    )
                    await self.settle(
                        id,
                        envelope: result.envelope,
                        standardError: result.standardError
                    )
                } catch {
                    await self.fail(id, with: error)
                }
            }
        }
        tasks[id] = nil
    }

    private func absorb(_ event: GameDevEvent, into id: RunID) {
        guard let index = runs.firstIndex(where: { $0.id == id }) else { return }
        runs[index].absorb(event)
        try? log.append(event, to: id)
        if event.kind == .started { try? log.save(runs[index]) }
    }

    private func settle(_ id: RunID, with outcome: StreamedRunOutcome) {
        guard let index = runs.firstIndex(where: { $0.id == id }) else { return }
        runs[index].settle(outcome)
        try? log.save(runs[index])
    }

    private func settle(_ id: RunID, envelope: CLIResultEnvelope, standardError: String) {
        guard let index = runs.firstIndex(where: { $0.id == id }) else { return }
        runs[index].settle(envelope: envelope, standardError: standardError)
        try? log.save(runs[index])
    }

    private func fail(_ id: RunID, with error: any Error) {
        guard let index = runs.firstIndex(where: { $0.id == id }) else { return }
        if error is CancellationError {
            runs[index].state = .cancelled
        } else {
            runs[index].state = .failed(error.localizedDescription)
        }
        runs[index].finishedAt = Date()
        try? log.save(runs[index])
    }

    // MARK: - Command line construction

    /// Builds argv from a spec.
    ///
    /// Nothing else in Anvil concatenates a command line. The CLI now refuses unknown
    /// flags with a nearest-match suggestion, so a hand-typed flag fails at runtime; a
    /// parity test checks every flag this can emit against the CLI's known set, which
    /// turns that into a build failure instead.
    nonisolated static func commandLine(
        for spec: CommandSpec,
        arguments: [String],
        outputDirectory: URL,
        grant: ApprovalGrant?
    ) throws -> [String] {
        var argv = spec.path + arguments
        argv.append(contentsOf: ["--output-dir", outputDirectory.path])

        guard let grant else { return argv }

        for authority in Authority.allCases where grant.authorities.contains(authority) {
            // `--spend-limit-cents` is the value half of `--approve-spend`; the CLI
            // requires both together and refuses the pair otherwise.
            argv.append(authority.flag)
            if authority == .approveSpend {
                argv.append(contentsOf: ["--spend-limit-cents", String(grant.ceilingCents)])
            }
        }
        return argv
    }
}

public enum RunStoreError: Error, LocalizedError, Equatable {
    case approvalRequired(String)

    public var errorDescription: String? {
        switch self {
        case let .approvalRequired(command):
            "\(command) can spend money and cannot start without an explicit approval."
        }
    }
}

/// Minting an approval grant. Kept in one place so every call site is easy to audit.
public enum ApprovalAuthorization {
    /// Creates the grant that authorizes a charge.
    ///
    /// The only entry point to ``ApprovalGrant``. Call it from the confirm action of an
    /// approval sheet and nowhere else: a grant created anywhere a person did not click
    /// is precisely the thing the CLI's approval model exists to prevent.
    public static func grantFromHumanApproval(
        ceilingCents: Int,
        presentedEstimateCents: Int,
        presentedConfidence: CostConfidence,
        presentedBasis: String,
        authorities: Set<Authority>
    ) -> ApprovalGrant {
        ApprovalGrant(
            ceilingCents: ceilingCents,
            presentedEstimateCents: presentedEstimateCents,
            presentedConfidence: presentedConfidence,
            presentedBasis: presentedBasis,
            authorities: authorities
        )
    }
}
