import Foundation

/// Where a command lives in Anvil's interface. Every spec names one, and a parity test
/// asserts the mapping is total in both directions, so "every feature is surfaced" is a
/// checked claim rather than an intention.
public enum WorkspaceRoute: String, CaseIterable, Sendable, Hashable {
    case overview
    case setup
    case createPrompt
    case createBrief
    case createReferences
    case create3D
    case createAudio
    case mesh
    case library
    case scenarios
    case visual
    case performance
    case spend
    case runs
    case mcp
    case console

    public var title: String {
        switch self {
        case .overview: "Overview"
        case .setup: "Setup"
        case .createPrompt: "Prompt Lab"
        case .createBrief: "Brief"
        case .createReferences: "References"
        case .create3D: "3D"
        case .createAudio: "Audio"
        case .mesh: "Mesh"
        case .library: "Library"
        case .scenarios: "Scenarios"
        case .visual: "Visual"
        case .performance: "Performance"
        case .spend: "Spend"
        case .runs: "Runs"
        case .mcp: "MCP"
        case .console: "Console"
        }
    }
}

/// Authorities the CLI requires as explicit flags. Each is a separate decision: holding
/// `--confirm` never implies permission to drive the GPU or to record timings.
public enum Authority: String, CaseIterable, Sendable, Hashable, Codable {
    case confirm
    case approveSpend
    case allowGPU
    case allowPerformance

    public var flag: String {
        switch self {
        case .confirm: "--confirm"
        case .approveSpend: "--approve-spend"
        case .allowGPU: "--allow-gpu"
        case .allowPerformance: "--allow-performance"
        }
    }
}

/// Whether a command can spend money, and how well the estimate is known.
/// Mirrors `src/domain/spend.ts`; an unknown tool is pessimistically treated as paid.
public enum SpendClass: Sendable, Hashable {
    case free
    case paid(cents: Int, confidence: CostConfidence, basis: String)

    public var isPaid: Bool {
        if case .paid = self { true } else { false }
    }
}

public enum CostConfidence: String, Sendable, Hashable, Codable {
    /// Published by the provider.
    case documented
    /// Anvil's and the CLI's best guess; a refusal guard, not an invoice.
    case estimated
}

/// Operations that must not overlap. The old app used one global mutex, which hid the
/// real hazard: `catalog rebuild` against `catalog admit`, or two `package build` calls
/// into the same directory. Everything not sharing a lane runs concurrently.
public enum ExclusionLane: Sendable, Hashable {
    case none
    case catalogIndex
    case packageStore
    case workspaceWrite
    case project(String)
    case skillsRoot
}

/// How the runtime reports: one `game_dev.result.v1` object, or a `game_dev.event.v1`
/// stream. Set per command from what the CLI actually supports for that form.
public enum CommandTransport: Sendable, Hashable {
    case result
    case events
}

/// A value the command accepts on the command line.
public struct ArgumentSpec: Sendable, Hashable, Identifiable {
    public enum Kind: Sendable, Hashable {
        case boolean
        case text
        case integer(minimum: Int?, maximum: Int?)
        case path
        case directory
        /// A JSON body delivered on stdin via `--request -`.
        case jsonRequest
        case choice([String])
    }

    public enum Placement: Sendable, Hashable {
        case positional
        /// A `--flag`; the name excludes the leading dashes and must appear in the
        /// CLI's `KNOWN_FLAGS`, which now refuses anything it does not recognize.
        case flag(String)
    }

    public let id: String
    public let label: String
    public let placement: Placement
    public let kind: Kind
    public let isRequired: Bool
    public let help: String?

    public init(
        id: String,
        label: String,
        placement: Placement,
        kind: Kind,
        isRequired: Bool = false,
        help: String? = nil
    ) {
        self.id = id
        self.label = label
        self.placement = placement
        self.kind = kind
        self.isRequired = isRequired
        self.help = help
    }

    /// The flag name without dashes, or `nil` for a positional.
    public var flagName: String? {
        if case let .flag(name) = placement { name } else { nil }
    }

    public static func positional(
        _ id: String,
        _ label: String,
        kind: Kind = .text,
        required: Bool = true,
        help: String? = nil
    ) -> ArgumentSpec {
        ArgumentSpec(
            id: id,
            label: label,
            placement: .positional,
            kind: kind,
            isRequired: required,
            help: help
        )
    }

    public static func flag(
        _ name: String,
        _ label: String,
        kind: Kind = .text,
        required: Bool = false,
        help: String? = nil
    ) -> ArgumentSpec {
        ArgumentSpec(
            id: name,
            label: label,
            placement: .flag(name),
            kind: kind,
            isRequired: required,
            help: help
        )
    }
}

/// One thing Anvil can run: a CLI command form, or a registry tool invoked through
/// `tool call`.
///
/// Views bind to a spec and build argv through it rather than concatenating strings.
/// That matters because the CLI now refuses unknown flags with a nearest-match
/// suggestion, so a speculative flag fails at runtime — this makes it fail at test time
/// instead.
public struct CommandSpec: Sendable, Hashable, Identifiable {
    public let id: String
    public let path: [String]
    public let title: String
    public let summary: String
    public let arguments: [ArgumentSpec]
    public let transport: CommandTransport
    public let authorities: Set<Authority>
    public let spend: SpendClass
    public let lane: ExclusionLane
    public let route: WorkspaceRoute
    /// Set when this spec invokes a registry tool, whose real JSON Schema is harvested
    /// from MCP `tools/list` rather than transcribed here.
    public let registryTool: String?
    /// True when the CLI creates a durable job for this form (`needsDurableJob`), so the
    /// run is resumable and appears under `job list`.
    public let createsDurableJob: Bool

    public init(
        id: String,
        path: [String],
        title: String,
        summary: String,
        arguments: [ArgumentSpec] = [],
        transport: CommandTransport = .result,
        authorities: Set<Authority> = [],
        spend: SpendClass = .free,
        lane: ExclusionLane = .none,
        route: WorkspaceRoute,
        registryTool: String? = nil,
        createsDurableJob: Bool = false
    ) {
        self.id = id
        self.path = path
        self.title = title
        self.summary = summary
        self.arguments = arguments
        self.transport = transport
        self.authorities = authorities
        self.spend = spend
        self.lane = lane
        self.route = route
        self.registryTool = registryTool
        self.createsDurableJob = createsDurableJob
    }

    /// Every flag this spec can put on a command line.
    public var flagNames: [String] { arguments.compactMap(\.flagName) }

    /// The `operation` string the runtime reports for this form, used to check that a
    /// result belongs to the invocation that asked for it.
    public var expectedOperation: String {
        if let registryTool { return "tool.\(registryTool)" }
        return path.prefix(2).joined(separator: ".")
    }
}
