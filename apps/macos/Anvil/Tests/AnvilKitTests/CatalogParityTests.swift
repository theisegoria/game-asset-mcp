import Foundation
import Testing
@testable import AnvilKit

/// The anti-drift lock.
///
/// The CLI is developed in the same repository and changes underneath Anvil. These tests
/// diff Anvil's catalog against the real `game-dev` binary, so a tool added, renamed or
/// removed upstream turns this build red instead of quietly leaving a feature
/// unreachable — or, worse, leaving Anvil emitting a flag the CLI now refuses.
@Suite("Command catalog parity with the CLI")
struct CatalogParityTests {
    /// The repository's built CLI, five directories up from this package.
    private static var cliEntrypoint: URL? {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // AnvilKitTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // Anvil
            .deletingLastPathComponent()  // macos
            .deletingLastPathComponent()  // apps
            .deletingLastPathComponent()  // repository root
        let entrypoint = repository.appendingPathComponent("dist/cli.js")
        return FileManager.default.fileExists(atPath: entrypoint.path) ? entrypoint : nil
    }

    /// Runs the repository CLI directly with the host's Node. These tests read metadata
    /// only — `capabilities` and `--help` — so they neither spend nor write.
    private func runCLI(_ arguments: [String]) throws -> String {
        guard let entrypoint = Self.cliEntrypoint else {
            throw CLIUnavailable()
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", entrypoint.path] + arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    private struct CLIUnavailable: Error {}

    // MARK: - 1. Every registry tool has a spec, and every tool spec exists upstream

    @Test("Anvil's tool specs match the runtime's registry exactly")
    func registryToolParity() throws {
        let output: String
        do {
            output = try runCLI(["capabilities", "--json"])
        } catch is CLIUnavailable {
            withKnownIssue("dist/cli.js is not built; run npm run build") {
                Issue.record("CLI not built")
            }
            return
        }

        let envelope = try JSONDecoder().decode(
            CLIResultEnvelope.self,
            from: Data(output.utf8)
        )
        guard case let .array(operations)? = envelope.data["localOperations"] else {
            Issue.record("capabilities did not report localOperations")
            return
        }

        let upstream = Set(operations.compactMap { $0["name"]?.stringValue })
        let declared = Set(CommandCatalog.byRegistryTool.keys)

        #expect(
            upstream.subtracting(declared).isEmpty,
            "The runtime registers tools Anvil does not surface: \(upstream.subtracting(declared).sorted())"
        )
        #expect(
            declared.subtracting(upstream).isEmpty,
            "Anvil declares tools the runtime does not register: \(declared.subtracting(upstream).sorted())"
        )
    }

    // MARK: - 2. Every flag Anvil can emit is one the CLI accepts

    @Test("Every declared flag appears in the CLI's known-flag set")
    func flagsAreKnownUpstream() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let source = repository.appendingPathComponent("src/cli/arguments.ts")
        guard let text = try? String(contentsOf: source, encoding: .utf8),
              let start = text.range(of: "KNOWN_FLAGS: ReadonlySet<string> = new Set(["),
              let end = text.range(of: "]);", range: start.upperBound..<text.endIndex)
        else {
            Issue.record("Could not read KNOWN_FLAGS from src/cli/arguments.ts")
            return
        }

        let known = Set(
            text[start.upperBound..<end.lowerBound]
                .split(whereSeparator: { ",\n \t".contains($0) })
                .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "'\"")) }
                .filter { !$0.isEmpty }
        )
        #expect(known.contains("confirm"), "KNOWN_FLAGS parse looks wrong: \(known.sorted())")

        let declared = CommandCatalog.declaredFlagNames.union(CommandCatalog.globalFlagNames)
        let unknown = declared.subtracting(known)
        #expect(
            unknown.isEmpty,
            "Anvil would emit flags the CLI now refuses: \(unknown.sorted())"
        )
    }

    // MARK: - 3. Every command form in HELP has a spec

    @Test("Anvil surfaces every command form the CLI documents")
    func commandFormParity() throws {
        let help: String
        do {
            help = try runCLI(["--help"])
        } catch is CLIUnavailable {
            withKnownIssue("dist/cli.js is not built; run npm run build") {
                Issue.record("CLI not built")
            }
            return
        }

        // Each usage line reads `game-dev <family> [<action>] ...`. Take the family and
        // the action when the action is a bare word rather than a placeholder.
        var upstreamForms: Set<String> = []
        for line in help.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("game-dev ") else { continue }
            let words = trimmed.dropFirst("game-dev ".count)
                .split(separator: " ")
                .map(String.init)
            guard let family = words.first, isBareWord(family) else { continue }
            if words.count > 1, isBareWord(words[1]) {
                upstreamForms.insert("\(family).\(words[1])")
            } else {
                upstreamForms.insert(family)
            }
        }
        #expect(upstreamForms.count > 30, "HELP parse looks wrong: \(upstreamForms.sorted())")

        // `launch` has no action word, and `tool call <name>` is one form in HELP that
        // Anvil also surfaces per tool.
        let declared = Set(CommandCatalog.cliCommands.map { spec -> String in
            spec.id == "launch.plan" ? "launch" : spec.id
        })

        let missing = upstreamForms.subtracting(declared)
        #expect(
            missing.isEmpty,
            "The CLI documents forms Anvil does not surface: \(missing.sorted())"
        )
    }

    private func isBareWord(_ word: String) -> Bool {
        !word.isEmpty && word.allSatisfy { $0.isLowercase || $0 == "-" }
    }

    // MARK: - 4. Route coverage is total in both directions

    @Test("Every command is reachable from a route, and every route has commands")
    func routeCoverageIsTotal() {
        for spec in CommandCatalog.all {
            #expect(
                WorkspaceRoute.allCases.contains(spec.route),
                "\(spec.id) names an unknown route"
            )
        }
        for route in WorkspaceRoute.allCases {
            #expect(
                !CommandCatalog.commands(in: route).isEmpty,
                "Route \(route.rawValue) surfaces no command, so it would render empty"
            )
        }
    }

    // MARK: - 5. Internal consistency

    @Test("Command identifiers are unique")
    func identifiersAreUnique() {
        let ids = CommandCatalog.all.map(\.id)
        #expect(Set(ids).count == ids.count, "Duplicate command identifiers in the catalog")
    }

    @Test("Paid commands require spend approval and declare a basis")
    func paidCommandsCarryApproval() {
        for spec in CommandCatalog.all where spec.spend.isPaid {
            #expect(
                spec.authorities.contains(.approveSpend),
                "\(spec.id) can spend but does not require --approve-spend"
            )
            guard case let .paid(cents, _, basis) = spec.spend else { continue }
            #expect(cents > 0, "\(spec.id) declares a non-positive cost")
            #expect(!basis.isEmpty, "\(spec.id) declares a cost with no stated basis")
        }
    }

    @Test("Free commands never request spend approval")
    func freeCommandsDoNotRequestApproval() {
        for spec in CommandCatalog.all where !spec.spend.isPaid {
            #expect(
                !spec.authorities.contains(.approveSpend),
                "\(spec.id) is free but would request spend approval"
            )
        }
    }

    @Test("Streaming is only claimed for forms the CLI documents as JSON Lines")
    func streamingCommandsAreSupportedUpstream() throws {
        let help: String
        do {
            help = try runCLI(["--help"])
        } catch is CLIUnavailable {
            return
        }
        // A form advertising `--jsonl` in HELP must be declared as streaming, or Anvil
        // would run it buffered and show no progress.
        for line in help.split(separator: "\n") where line.contains("--jsonl") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("game-dev ") else { continue }
            let words = trimmed.dropFirst("game-dev ".count).split(separator: " ").map(String.init)
            guard let family = words.first, isBareWord(family) else { continue }
            let id = words.count > 1 && isBareWord(words[1]) ? "\(family).\(words[1])" : family
            guard let spec = CommandCatalog.cliCommands.first(where: { $0.id == id }) else { continue }
            #expect(
                spec.transport == .events,
                "\(id) supports --jsonl upstream but Anvil declares it buffered"
            )
        }
    }
}
