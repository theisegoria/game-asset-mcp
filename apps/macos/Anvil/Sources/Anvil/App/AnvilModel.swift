import AnvilKit
import Foundation
import Observation
import OSLog

/// Phase 0 application state: locate the bundled runtime and report toolchain health.
///
/// This is deliberately small. The concurrent run registry that replaces it lands in
/// Phase 1; nothing here should grow a second operation.
@MainActor
@Observable
final class AnvilModel {
    enum HealthState {
        case idle
        case checking
        case ready(DoctorReport)
        case failed(String)
    }

    private(set) var health: HealthState = .idle
    private(set) var runtimeDescription: String
    private(set) var outputDirectory: URL

    @ObservationIgnored private let client: GameDevCLIClient
    @ObservationIgnored private let runtimeURL: URL?
    @ObservationIgnored private static let logger = Logger(
        subsystem: "com.theisegoria.Anvil",
        category: "Health"
    )

    init() {
        let runtimeURL = AnvilRuntime.bundledRuntimeURL()
        self.runtimeURL = runtimeURL
        self.client = GameDevCLIClient(executableURL: runtimeURL)
        self.runtimeDescription = runtimeURL?.path ?? "not found in this app bundle"
        self.outputDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Anvil", isDirectory: true)
    }

    var hasRuntime: Bool { runtimeURL != nil }

    func refreshHealth() async {
        guard runtimeURL != nil else {
            health = .failed(
                """
                Anvil could not find its bundled game-dev runtime. Build the app with \
                script/build_and_run_anvil.sh, which stages the pinned Node runtime into \
                Contents/Resources/\(AnvilRuntime.resourceDirectoryName).
                """
            )
            return
        }

        health = .checking
        let invocation = CLIInvocation(
            arguments: ["doctor", "--output-dir", outputDirectory.path, "--json"],
            expectedOperation: "doctor"
        )
        do {
            let result = try await client.execute(
                invocation,
                credentials: [:],
                timeout: .seconds(60)
            )
            health = .ready(try DoctorReport(data: result.envelope.data))
        } catch {
            Self.logger.error("doctor failed: \(error.localizedDescription, privacy: .public)")
            health = .failed(error.localizedDescription)
        }
    }
}
