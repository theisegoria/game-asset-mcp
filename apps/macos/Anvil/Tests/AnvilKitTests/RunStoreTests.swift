import Foundation
import Testing
@testable import AnvilKit

@Suite("Run registry")
struct RunStoreTests {
    private func temporaryLog() throws -> RunLog {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("anvil-runs-\(UUID().uuidString)", isDirectory: true)
        let log = RunLog(root: root)
        try log.prepare()
        return log
    }

    // MARK: - Spend safety

    @Test("A paid command cannot start without an approval grant")
    @MainActor
    func paidCommandRequiresApproval() throws {
        let store = RunStore(
            client: GameDevCLIClient(executableName: "true", baseEnvironment: [:]),
            log: try temporaryLog()
        )
        let paid = try #require(CommandCatalog["tool.create_3d_asset"])
        #expect(paid.spend.isPaid)

        #expect(throws: RunStoreError.approvalRequired("tool.create_3d_asset")) {
            try store.start(
                paid,
                arguments: [],
                outputDirectory: FileManager.default.temporaryDirectory
            )
        }
        #expect(store.runs.isEmpty, "A refused run must not be recorded as attempted")
    }

    @Test("Spend flags cannot appear on a command line without a grant")
    func spendFlagsRequireAGrant() throws {
        let paid = try #require(CommandCatalog["tool.create_3d_asset"])
        let argv = try RunStore.commandLine(
            for: paid,
            arguments: [],
            outputDirectory: URL(fileURLWithPath: "/tmp/x"),
            grant: nil
        )
        #expect(!argv.contains("--approve-spend"))
        #expect(!argv.contains("--spend-limit-cents"))
    }

    @Test("A grant emits both halves of the spend authority together")
    func grantEmitsSpendFlags() throws {
        let paid = try #require(CommandCatalog["tool.create_3d_asset"])
        let grant = ApprovalAuthorization.grantFromHumanApproval(
            ceilingCents: 250,
            presentedEstimateCents: 30,
            presentedConfidence: .documented,
            presentedBasis: "Tripo image-to-3D with texture.",
            authorities: [.approveSpend]
        )
        let argv = try RunStore.commandLine(
            for: paid,
            arguments: [],
            outputDirectory: URL(fileURLWithPath: "/tmp/x"),
            grant: grant
        )
        // The CLI refuses --approve-spend without a ceiling, so they must travel together.
        let approveIndex = try #require(argv.firstIndex(of: "--approve-spend"))
        let limitIndex = try #require(argv.firstIndex(of: "--spend-limit-cents"))
        #expect(argv[limitIndex + 1] == "250")
        #expect(approveIndex < argv.count)
    }

    @Test("Authorities are separate: confirm never implies GPU or performance")
    func authoritiesAreSeparate() throws {
        let scenario = try #require(CommandCatalog["scenario.run"])
        let grant = ApprovalAuthorization.grantFromHumanApproval(
            ceilingCents: 0,
            presentedEstimateCents: 0,
            presentedConfidence: .documented,
            presentedBasis: "No charge.",
            authorities: [.confirm]
        )
        let argv = try RunStore.commandLine(
            for: scenario,
            arguments: ["demo"],
            outputDirectory: URL(fileURLWithPath: "/tmp/x"),
            grant: grant
        )
        #expect(argv.contains("--confirm"))
        #expect(!argv.contains("--allow-gpu"))
        #expect(!argv.contains("--allow-performance"))
    }

    @Test("The output directory is always pinned on the command line")
    func outputDirectoryIsAlwaysPassed() throws {
        for spec in CommandCatalog.all {
            let argv = try RunStore.commandLine(
                for: spec,
                arguments: [],
                outputDirectory: URL(fileURLWithPath: "/tmp/workspace"),
                grant: nil
            )
            let index = try #require(
                argv.firstIndex(of: "--output-dir"),
                "\(spec.id) would run against an unspecified workspace"
            )
            #expect(argv[index + 1] == "/tmp/workspace")
        }
    }

    // MARK: - Exclusion lanes

    @Test("Runs sharing a lane are serialized")
    func sameLaneSerializes() async {
        let scheduler = RunScheduler()
        let tracker = ConcurrencyTracker()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<6 {
                group.addTask {
                    await scheduler.run(in: .catalogIndex) {
                        await tracker.enter()
                        try? await Task.sleep(for: .milliseconds(20))
                        await tracker.leave()
                    }
                }
            }
        }
        #expect(await tracker.peak == 1, "catalog operations must not overlap")
        #expect(await tracker.total == 6)
    }

    @Test("Runs in different lanes proceed concurrently")
    func differentLanesOverlap() async {
        let scheduler = RunScheduler()
        let tracker = ConcurrencyTracker()
        let lanes: [ExclusionLane] = [
            .catalogIndex, .packageStore, .workspaceWrite, .skillsRoot, .project("a")
        ]
        await withTaskGroup(of: Void.self) { group in
            for lane in lanes {
                group.addTask {
                    await scheduler.run(in: lane) {
                        await tracker.enter()
                        try? await Task.sleep(for: .milliseconds(60))
                        await tracker.leave()
                    }
                }
            }
        }
        #expect(await tracker.peak > 1, "independent lanes must not block each other")
    }

    @Test("The unrestricted lane never blocks")
    func noneLaneNeverBlocks() async {
        let scheduler = RunScheduler()
        let tracker = ConcurrencyTracker()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<5 {
                group.addTask {
                    await scheduler.run(in: .none) {
                        await tracker.enter()
                        try? await Task.sleep(for: .milliseconds(50))
                        await tracker.leave()
                    }
                }
            }
        }
        #expect(await tracker.peak == 5)
    }

    // MARK: - Persistence

    @Test("A run round-trips through the log with its events")
    func runRoundTrips() throws {
        let log = try temporaryLog()
        var run = Run(
            commandID: "visual.compare",
            title: "Compare captures",
            arguments: ["visual", "compare", "a", "b"],
            outputDirectory: URL(fileURLWithPath: "/tmp/workspace")
        )
        let started = GameDevEvent(
            eventID: "evt_0",
            jobID: "job_abc",
            sequence: 0,
            timestamp: Date(timeIntervalSince1970: 1_770_000_000),
            kind: .started,
            operation: "visual.compare",
            data: ["version": .string("1.0.2")]
        )
        let artifactEvent = GameDevEvent(
            eventID: "evt_1",
            jobID: "job_abc",
            sequence: 1,
            timestamp: Date(timeIntervalSince1970: 1_770_000_001),
            kind: .artifact,
            operation: "visual.compare",
            data: [
                "kind": .string("visual_comparison"),
                "path": .string("/tmp/diff")
            ]
        )
        run.absorb(started)
        run.absorb(artifactEvent)

        try log.save(run)
        try log.append(started, to: run.id)
        try log.append(artifactEvent, to: run.id)

        let loaded = try log.loadAll()
        #expect(loaded.skipped.isEmpty)
        let restored = try #require(loaded.runs.first)
        #expect(restored.id == run.id)
        #expect(restored.durableJobID == "job_abc")
        #expect(restored.artifacts.map(\.kind) == ["visual_comparison"])
        #expect(restored.state == .running)

        let events = try log.events(for: run.id)
        #expect(events.count == 2)
        #expect(events.map(\.kind) == [.started, .artifact])
        #expect(events[0].data["version"]?.stringValue == "1.0.2")
    }

    @Test("An unreadable record is reported, never silently dropped")
    func unreadableRecordsAreReported() throws {
        let log = try temporaryLog()
        let run = Run(
            commandID: "doctor",
            title: "Doctor",
            arguments: ["doctor"],
            outputDirectory: URL(fileURLWithPath: "/tmp")
        )
        try log.save(run)

        let corrupt = log.root.appendingPathComponent("corrupt-run", isDirectory: true)
        try FileManager.default.createDirectory(at: corrupt, withIntermediateDirectories: true)
        try Data("{ not json".utf8).write(to: corrupt.appendingPathComponent("run.json"))

        let loaded = try log.loadAll()
        #expect(loaded.runs.count == 1)
        // A dropped record could be a paid job still in flight, so it has to surface.
        #expect(loaded.skipped == ["corrupt-run"])
    }

    @Test("A run interrupted by quitting is restored as failed, not as running")
    @MainActor
    func interruptedRunsAreNotLeftSpinning() throws {
        let log = try temporaryLog()
        var run = Run(
            commandID: "scenario.run",
            title: "Run a scenario",
            arguments: ["scenario", "run", "demo"],
            outputDirectory: URL(fileURLWithPath: "/tmp")
        )
        run.state = .running
        run.startedAt = Date()
        try log.save(run)

        let store = RunStore(
            client: GameDevCLIClient(executableName: "true", baseEnvironment: [:]),
            log: log
        )
        store.restore()

        let restored = try #require(store.runs.first)
        #expect(restored.state.isTerminal)
        #expect(store.activeRuns.isEmpty)
    }

    @Test("Only durable jobs that stopped short are offered for resume")
    func resumeEligibility() {
        func run(state: RunState, jobID: String?) -> Run {
            var value = Run(
                commandID: "provider.tripo",
                title: "Tripo",
                arguments: [],
                outputDirectory: URL(fileURLWithPath: "/tmp")
            )
            value.state = state
            value.durableJobID = jobID
            return value
        }
        #expect(run(state: .failed("x"), jobID: "job_1").isResumable)
        #expect(run(state: .awaitingApproval, jobID: "job_1").isResumable)
        #expect(!run(state: .succeeded, jobID: "job_1").isResumable)
        #expect(!run(state: .running, jobID: "job_1").isResumable)
        #expect(!run(state: .cancelled, jobID: "job_1").isResumable)
        // An asset job is a different namespace and is not resumable through `job resume`.
        #expect(!run(state: .failed("x"), jobID: "asset_1").isResumable)
        #expect(!run(state: .failed("x"), jobID: nil).isResumable)
    }
}

/// Records the maximum number of simultaneously executing blocks.
private actor ConcurrencyTracker {
    private(set) var current = 0
    private(set) var peak = 0
    private(set) var total = 0

    func enter() {
        current += 1
        total += 1
        peak = max(peak, current)
    }

    func leave() { current -= 1 }
}
