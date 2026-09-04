import Foundation

/// Anvil's identifier for one invocation. Distinct from both runtime job namespaces:
/// a run exists the moment the user asks for it, before the CLI has minted anything.
public struct RunID: Hashable, Sendable, Codable, CustomStringConvertible {
    public let rawValue: UUID
    public init(_ rawValue: UUID = UUID()) { self.rawValue = rawValue }
    public var description: String { rawValue.uuidString }
}

public enum RunState: Equatable, Sendable, Codable {
    case queued
    case running
    /// The runtime returned `APPROVAL_REQUIRED`. Not a failure: the run is waiting for a
    /// human decision and can be re-issued with the missing authorities.
    case awaitingApproval
    case succeeded
    case failed(String)
    case cancelled

    public var isTerminal: Bool {
        switch self {
        case .queued, .running: false
        case .awaitingApproval, .succeeded, .failed, .cancelled: true
        }
    }

    public var isActive: Bool { self == .queued || self == .running }
}

/// Proof that a human authorized a charge.
///
/// The GUI analogue of the CLI's rule that an argument a model can write can never
/// constitute approval: `--approve-spend` and `--spend-limit-cents` can only reach a
/// command line through a value of this type, and this type has no public initializer.
/// Only the approval sheet can mint one.
/// Deliberately NOT `Codable`. Making it decodable would mean a grant could be forged
/// by decoding JSON — including JSON read back off disk — which is exactly the property
/// this type exists to prevent. Persisted history uses ``ApprovalRecord`` instead, which
/// is inert: it records what was approved and cannot authorize anything.
public struct ApprovalGrant: Equatable, Sendable {
    public let ceilingCents: Int
    /// The estimate that was shown at the moment of approval, so the ledger records what
    /// the person was actually told rather than what the estimate later became.
    public let presentedEstimateCents: Int
    public let presentedConfidence: CostConfidence
    public let presentedBasis: String
    public let grantedAt: Date
    public let authorities: Set<Authority>

    /// Not public: constructing a grant is what approval *means*.
    init(
        ceilingCents: Int,
        presentedEstimateCents: Int,
        presentedConfidence: CostConfidence,
        presentedBasis: String,
        authorities: Set<Authority>,
        grantedAt: Date = Date()
    ) {
        self.ceilingCents = ceilingCents
        self.presentedEstimateCents = presentedEstimateCents
        self.presentedConfidence = presentedConfidence
        self.presentedBasis = presentedBasis
        self.authorities = authorities
        self.grantedAt = grantedAt
    }
}

/// The inert, persistable record of an approval that happened.
///
/// Carries what the person was shown at the moment they approved, so the audit trail
/// reflects what they were actually told rather than what the estimate later became.
public struct ApprovalRecord: Equatable, Sendable, Codable {
    public let ceilingCents: Int
    public let presentedEstimateCents: Int
    public let presentedConfidence: CostConfidence
    public let presentedBasis: String
    public let grantedAt: Date
    public let authorities: [String]

    public init(_ grant: ApprovalGrant) {
        ceilingCents = grant.ceilingCents
        presentedEstimateCents = grant.presentedEstimateCents
        presentedConfidence = grant.presentedConfidence
        presentedBasis = grant.presentedBasis
        grantedAt = grant.grantedAt
        authorities = grant.authorities.map(\.rawValue).sorted()
    }
}

/// One invocation and everything observed about it.
public struct Run: Identifiable, Sendable, Equatable {
    public let id: RunID
    public let commandID: String
    public let title: String
    public let arguments: [String]
    public let outputDirectory: URL
    public let createdAt: Date

    public var state: RunState
    public var startedAt: Date?
    public var finishedAt: Date?

    /// `job_<uuid>`, harvested from the event stream. Present when the CLI created a
    /// durable job, which is what makes the run resumable after a crash or quit.
    public var durableJobID: String?
    /// `asset_<uuid>` ids seen in payloads. A different namespace from `durableJobID`.
    public var assetJobIDs: [String]
    public var events: [GameDevEvent]
    public var artifacts: [RunArtifact]
    public var envelope: CLIResultEnvelope?
    public var approval: ApprovalRecord?
    public var standardErrorTail: String

    public init(
        id: RunID = RunID(),
        commandID: String,
        title: String,
        arguments: [String],
        outputDirectory: URL,
        createdAt: Date = Date(),
        state: RunState = .queued,
        approval: ApprovalRecord? = nil
    ) {
        self.id = id
        self.commandID = commandID
        self.title = title
        self.arguments = arguments
        self.outputDirectory = outputDirectory
        self.createdAt = createdAt
        self.state = state
        self.startedAt = nil
        self.finishedAt = nil
        self.durableJobID = nil
        self.assetJobIDs = []
        self.events = []
        self.artifacts = []
        self.envelope = nil
        self.approval = approval
        self.standardErrorTail = ""
    }

    public var duration: Duration? {
        guard let startedAt else { return nil }
        let end = finishedAt ?? Date()
        return .seconds(end.timeIntervalSince(startedAt))
    }

    /// The most recent thing worth showing next to a progress indicator.
    public var latestActivity: String? {
        events.last(where: { $0.kind == .progress || $0.kind == .artifact })?.summary
            ?? events.last?.summary
    }

    /// Whether this run can be handed to `job resume`. A durable job that ended without
    /// succeeding is resumable; one still running is not, because the CLI cannot prove
    /// the original worker stopped.
    public var isResumable: Bool {
        guard let durableJobID, durableJobID.hasPrefix("job_") else { return false }
        switch state {
        case .failed, .awaitingApproval: return true
        case .queued, .running, .succeeded, .cancelled: return false
        }
    }

    /// Folds one event into the run.
    public mutating func absorb(_ event: GameDevEvent) {
        events.append(event)
        if durableJobID == nil, event.jobID.hasPrefix("job_") {
            durableJobID = event.jobID
        }
        if let assetJobID = event.data["assetJobId"]?.stringValue,
           !assetJobIDs.contains(assetJobID) {
            assetJobIDs.append(assetJobID)
        }
        if let artifact = event.artifact, !artifacts.contains(artifact) {
            artifacts.append(artifact)
        }
        if event.kind == .started, startedAt == nil {
            startedAt = event.timestamp
            state = .running
        }
    }

    /// Applies a settled outcome. Cancellation is detected from the terminal event
    /// rather than from the exit code, because the CLI reports it as a `failed` event
    /// carrying `CANCELLED`.
    public mutating func settle(_ outcome: StreamedRunOutcome) {
        envelope = outcome.envelope
        standardErrorTail = String(outcome.standardError.suffix(8 * 1024))
        finishedAt = outcome.finishedAt
        if startedAt == nil { startedAt = outcome.startedAt }
        for artifact in outcome.artifacts where !artifacts.contains(artifact) {
            artifacts.append(artifact)
        }
        state = Self.state(for: outcome)
    }

    static func state(for outcome: StreamedRunOutcome) -> RunState {
        if outcome.wasCancelled { return .cancelled }
        switch outcome.envelope.status {
        case .succeeded: return .succeeded
        case .approvalRequired: return .awaitingApproval
        case .failed:
            let message = outcome.envelope.data["message"]?.stringValue
                ?? outcome.envelope.summary
            return .failed(message)
        }
    }

    /// Applies a buffered result, for commands the CLI does not stream.
    public mutating func settle(envelope settled: CLIResultEnvelope, standardError: String) {
        envelope = settled
        standardErrorTail = String(standardError.suffix(8 * 1024))
        finishedAt = Date()
        if startedAt == nil { startedAt = createdAt }
        switch settled.status {
        case .succeeded: state = .succeeded
        case .approvalRequired: state = .awaitingApproval
        case .failed:
            state = .failed(settled.data["message"]?.stringValue ?? settled.summary)
        }
    }
}
