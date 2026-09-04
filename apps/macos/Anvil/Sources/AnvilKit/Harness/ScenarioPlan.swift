import Foundation

/// A scenario resolved into exactly what a run would do, before it does it.
///
/// Anvil renders this in the approval sheet. Everything a person is being asked to
/// authorize has to be visible here — the executable and its arguments, the declared
/// environment, and the authorities the plan itself says it needs.
public struct ScenarioPlan: Sendable, Hashable {
    public let runID: String
    public let runPath: String
    public let adapterID: String
    public let scenarioID: String
    public let title: String
    public let executable: String
    public let arguments: [String]
    public let workingDirectory: String
    public let timeoutSeconds: Int
    public let capabilities: [ScenarioCapability]
    /// Graphics environment the scenario declares for its own process. Part of what is
    /// being approved: it changes which driver runs, so it changes what the run means.
    public let environment: [String: String]
    /// Taken from the plan, never derived from `capabilities`.
    ///
    /// The harness requires GPU authority for `gpu` or `metal` only — a scenario
    /// declaring `vulkan` or `software-raster` does not automatically need it. Deriving
    /// authorities here would ask for permissions the run does not require, which is how
    /// people learn to approve everything.
    public let requiredAuthorizations: [Authority]
    public let evidenceCeiling: String

    public init(
        runID: String,
        runPath: String,
        adapterID: String,
        scenarioID: String,
        title: String,
        executable: String,
        arguments: [String],
        workingDirectory: String,
        timeoutSeconds: Int,
        capabilities: [ScenarioCapability],
        environment: [String: String],
        requiredAuthorizations: [Authority],
        evidenceCeiling: String
    ) {
        self.runID = runID
        self.runPath = runPath
        self.adapterID = adapterID
        self.scenarioID = scenarioID
        self.title = title
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.timeoutSeconds = timeoutSeconds
        self.capabilities = capabilities
        self.environment = environment
        self.requiredAuthorizations = requiredAuthorizations
        self.evidenceCeiling = evidenceCeiling
    }

    /// Decodes the `data` of a `scenario.plan` result.
    public init(planPayload value: JSONValue) throws {
        guard case let .object(fields) = value else { throw PlanDecodingFailure.notAnObject }
        func string(_ key: String) throws -> String {
            guard let value = fields[key]?.stringValue else {
                throw PlanDecodingFailure.missing(key)
            }
            return value
        }

        var arguments: [String] = []
        if case let .array(raw)? = fields["arguments"] {
            arguments = raw.compactMap(\.stringValue)
        }
        var capabilities: [ScenarioCapability] = []
        if case let .array(raw)? = fields["capabilities"] {
            capabilities = raw.compactMap(\.stringValue).compactMap(ScenarioCapability.init(rawValue:))
        }
        var environment: [String: String] = [:]
        if case let .object(raw)? = fields["environment"] {
            for (key, value) in raw {
                if let text = value.stringValue { environment[key] = text }
            }
        }
        var authorities: [Authority] = []
        if case let .array(raw)? = fields["requiredAuthorizations"] {
            for name in raw.compactMap(\.stringValue) {
                switch name {
                case "confirm": authorities.append(.confirm)
                case "gpu": authorities.append(.allowGPU)
                case "performance": authorities.append(.allowPerformance)
                default:
                    // An authority this build does not know is not skipped: approving a
                    // run while silently omitting one of its requirements would show a
                    // person less than they are agreeing to.
                    throw PlanDecodingFailure.unknownAuthorization(name)
                }
            }
        }
        var timeout = 300
        if case let .number(value)? = fields["timeoutSeconds"] { timeout = Int(value) }

        self.init(
            runID: try string("runId"),
            runPath: try string("runPath"),
            adapterID: (try? string("adapterId")) ?? "",
            scenarioID: try string("scenarioId"),
            title: try (try? string("title")) ?? string("scenarioId"),
            executable: try string("executable"),
            arguments: arguments,
            workingDirectory: (try? string("workingDirectory")) ?? "",
            timeoutSeconds: timeout,
            capabilities: capabilities,
            environment: environment,
            requiredAuthorizations: authorities,
            evidenceCeiling: (try? string("evidenceCeiling")) ?? ""
        )
    }

    public enum PlanDecodingFailure: Error, LocalizedError, Equatable {
        case notAnObject
        case missing(String)
        case unknownAuthorization(String)

        public var errorDescription: String? {
            switch self {
            case .notAnObject: "The scenario plan is not an object."
            case let .missing(field): "The scenario plan is missing \(field)."
            case let .unknownAuthorization(name):
                "The plan requires an authority this version of Anvil does not recognize: \(name). Update Anvil rather than approving a run it cannot fully describe."
            }
        }
    }

    /// Graphics lanes this scenario names, for display next to the authorities.
    public var graphicsLanes: [ScenarioCapability] {
        capabilities.filter(\.isGraphicsLane)
    }

    /// True when this run is a software lane, and so will produce no GPU evidence
    /// whatever the adapter reports.
    public var isSoftwareLane: Bool {
        capabilities.contains(.softwareRaster)
    }
}
