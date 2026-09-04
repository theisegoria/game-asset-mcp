import Foundation

/// Everything Anvil can run, in one place.
///
/// This exists even though every surface is hand-designed, because three things need a
/// single source of truth that hand-written views cannot provide: the command palette,
/// the run scheduler's exclusion lanes, and the parity tests that check Anvil's coverage
/// against the CLI it drives.
public enum CommandCatalog {
    public static let all: [CommandSpec] = cliCommands + toolCommands

    public static let byID: [String: CommandSpec] = Dictionary(
        uniqueKeysWithValues: all.map { ($0.id, $0) }
    )

    public static subscript(id: String) -> CommandSpec? { byID[id] }

    /// Specs surfaced by one workspace route, in declaration order.
    public static func commands(in route: WorkspaceRoute) -> [CommandSpec] {
        all.filter { $0.route == route }
    }

    /// Specs that invoke a registry tool, keyed by tool name.
    public static let byRegistryTool: [String: CommandSpec] = Dictionary(
        uniqueKeysWithValues: all.compactMap { spec in
            spec.registryTool.map { ($0, spec) }
        }
    )

    /// Every flag name any spec can emit. Compared against the CLI's `KNOWN_FLAGS`,
    /// which refuses anything it does not recognize.
    public static var declaredFlagNames: Set<String> {
        Set(all.flatMap(\.flagNames))
    }

    /// Flags the CLI accepts globally on any invocation, so they never appear on a spec.
    public static let globalFlagNames: Set<String> = [
        "output-dir", "approve-spend", "spend-limit-cents",
        "json", "jsonl", "version", "help", "confirm",
        "allow-gpu", "allow-performance"
    ]
}
