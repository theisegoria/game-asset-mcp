import Foundation
import Testing
@testable import AnvilKit

@Suite("JSON Lines event streaming", .serialized)
struct StreamingTests {
    private let python = URL(fileURLWithPath: "/usr/bin/python3")

    /// Builds a Python one-liner that prints the given event dictionaries as JSON Lines.
    private func emitter(_ events: [String], exitCode: Int = 0, stderr: String = "") -> String {
        let lines = events.joined(separator: ",")
        return """
        import json,sys
        for e in [\(lines)]:
            sys.stdout.write(json.dumps(e) + "\\n")
            sys.stdout.flush()
        sys.stderr.write(\(stderr.isEmpty ? "''" : "'\(stderr)'"))
        sys.exit(\(exitCode))
        """
    }

    private func event(
        _ type: String,
        sequence: Int,
        operation: String = "asset.normalize",
        jobID: String = "job_11111111-1111-1111-1111-111111111111",
        data: String = "{}"
    ) -> String {
        """
        {'schema':'game_dev.event.v1','event_id':'evt_\(sequence)',\
        'job_id':'\(jobID)','sequence':\(sequence),\
        'timestamp':'2026-09-04T10:00:0\(sequence).000Z','type':'\(type)',\
        'operation':'\(operation)','data':\(data)}
        """
    }

    private func collect(
        _ script: String,
        arguments: [String] = [],
        credentials: [CredentialProvider: String] = [:],
        timeout: Duration? = .seconds(10)
    ) async throws -> (events: [GameDevEvent], outcome: StreamedRunOutcome?) {
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        let invocation = CLIInvocation(
            arguments: ["-c", script] + arguments,
            expectedOperation: "asset.normalize"
        )
        var events: [GameDevEvent] = []
        var outcome: StreamedRunOutcome?
        for try await element in client.stream(
            invocation,
            credentials: credentials,
            timeout: timeout
        ) {
            switch element {
            case let .event(event): events.append(event)
            case let .outcome(value): outcome = value
            }
        }
        return (events, outcome)
    }

    @Test("A completed stream yields every event and a synthesized result envelope")
    func completedStream() async throws {
        let script = emitter([
            event("started", sequence: 0, data: "{'version':'1.0.2'}"),
            event("progress", sequence: 1, data: "{'phase':'unwrap','status':'running'}"),
            event(
                "artifact",
                sequence: 2,
                data: "{'kind':'usdz_preview','path':'/tmp/a.usdz','sha256':'abc'}"
            ),
            event(
                "completed",
                sequence: 3,
                data: "{'outputPath':'/tmp/a.glb','summary':'Normalized'}"
            )
        ])

        let (events, outcome) = try await collect(script)

        #expect(events.count == 4)
        #expect(events.map(\.kind) == [.started, .progress, .artifact, .completed])
        #expect(events[1].summary == "unwrap — running")

        let settled = try #require(outcome)
        #expect(settled.envelope.schema == GameDevCLIClient.resultSchema)
        #expect(settled.envelope.operation == "asset.normalize")
        #expect(settled.envelope.ok)
        #expect(settled.envelope.status == CLIResultStatus.succeeded)
        #expect(settled.envelope.data["outputPath"]?.stringValue == "/tmp/a.glb")
        #expect(settled.artifacts.count == 1)
        #expect(settled.artifacts.first?.kind == "usdz_preview")
        #expect(settled.artifacts.first?.sha256 == "abc")
        #expect(!settled.wasCancelled)
    }

    @Test("An approval_required terminal event produces an approval envelope, not a failure")
    func approvalTerminalEvent() async throws {
        let script = emitter([
            event("started", sequence: 0),
            event(
                "approval_required",
                sequence: 1,
                data: """
                {'error':'APPROVAL_REQUIRED','message':'needs approval',\
                'approval':{'requiredFlags':['--approve-spend']}}
                """
            )
        ], exitCode: 1)

        let (_, outcome) = try await collect(script)
        let settled = try #require(outcome)

        // The buffered transport reports this as status .approvalRequired; the streamed
        // transport must agree, or an approval would surface as a hard failure.
        #expect(settled.envelope.status == CLIResultStatus.approvalRequired)
        #expect(!settled.envelope.ok)
        #expect(settled.exitCode == 1)
    }

    @Test("A failed terminal event carrying CANCELLED is reported as cancellation")
    func cancellationIsRecognized() async throws {
        let script = emitter([
            event("started", sequence: 0),
            event("failed", sequence: 1, data: "{'error':'CANCELLED','message':'stopped'}")
        ], exitCode: 1)

        let (events, outcome) = try await collect(script)
        let settled = try #require(outcome)

        #expect(settled.wasCancelled)
        #expect(events.last?.isCancellation == true)
        #expect(settled.envelope.status == CLIResultStatus.failed)
    }

    @Test("An undecodable line fails the stream instead of being skipped")
    func malformedLineFailsTheStream() async throws {
        let script = """
        import sys
        sys.stdout.write('{"schema":"game_dev.event.v1","event_id":"evt_0",\
        "job_id":"job_1","sequence":0,"timestamp":"2026-09-04T10:00:00.000Z",\
        "type":"started","operation":"asset.normalize","data":{}}\\n')
        sys.stdout.write('this is not json\\n')
        sys.stdout.flush()
        sys.exit(0)
        """

        await #expect(throws: GameDevCLIClientError.self) {
            _ = try await collect(script)
        }
    }

    @Test("An unrecognized event type fails the stream rather than being dropped")
    func unknownEventTypeFails() async throws {
        let script = emitter([
            event("started", sequence: 0),
            event("teleported", sequence: 1)
        ])

        await #expect(throws: GameDevCLIClientError.self) {
            _ = try await collect(script)
        }
    }

    @Test("A stream that ends without a terminal event fails")
    func missingTerminalEventFails() async throws {
        let script = emitter([
            event("started", sequence: 0),
            event("progress", sequence: 1, data: "{'phase':'unwrap'}")
        ])

        await #expect(throws: GameDevCLIClientError.self) {
            _ = try await collect(script)
        }
    }

    @Test("A stream producing no output at all fails")
    func emptyStreamFails() async throws {
        await #expect(throws: GameDevCLIClientError.self) {
            _ = try await collect("import sys; sys.exit(0)")
        }
    }

    @Test("A single event line larger than the cap terminates the process")
    func oversizeLineIsBounded() async throws {
        let script = """
        import sys
        sys.stdout.write('{"schema":"game_dev.event.v1","data":"' + ('x' * 6000000))
        sys.stdout.flush()
        sys.stdout.write('"}\\n')
        sys.exit(0)
        """
        let client = GameDevCLIClient(
            executableURL: python,
            baseEnvironment: [:],
            maximumOutputBytesPerStream: 4 * 1024 * 1024
        )
        await #expect(throws: GameDevCLIClientError.self) {
            for try await _ in client.stream(
                CLIInvocation(arguments: ["-c", script]),
                credentials: [:],
                timeout: .seconds(20)
            ) {}
        }
    }

    @Test("Streaming refuses an invocation that already carries --json")
    func conflictingOutputFlagIsRefused() async throws {
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        await #expect(throws: GameDevCLIClientError.self) {
            for try await _ in client.stream(
                CLIInvocation(arguments: ["-c", "pass", "--json"]),
                credentials: [:],
                timeout: .seconds(5)
            ) {}
        }
    }

    @Test("Buffered execution still refuses an invocation that carries --jsonl")
    func bufferedRefusesEventStreamFlag() async throws {
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        await #expect(throws: GameDevCLIClientError.self) {
            _ = try await client.execute(
                CLIInvocation(arguments: ["-c", "pass", "--jsonl"]),
                credentials: [:],
                timeout: .seconds(5)
            )
        }
    }

    @Test("Both output flags together are refused before launch")
    func mutuallyExclusiveFlagsAreRefused() async throws {
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        await #expect(throws: GameDevCLIClientError.self) {
            for try await _ in client.stream(
                CLIInvocation(arguments: ["-c", "pass", "--json", "--jsonl"]),
                credentials: [:],
                timeout: .seconds(5)
            ) {}
        }
    }

    @Test("Credentials are redacted from streamed event payloads")
    func streamedEventsAreRedacted() async throws {
        // Supplying a credential makes this a sensitive operation, so it requires the
        // closed runtime rather than an arbitrary executable — the same rule the
        // buffered path enforces.
        let secret = "leonardo-secret-value-42"
        let executable = try makeClosedRuntimeFixture(body: #"""
            printf '{"schema":"game_dev.event.v1","event_id":"evt_0","job_id":"job_1","sequence":0,"timestamp":"2026-09-04T10:00:00.000Z","type":"progress","operation":"provider.leonardo.image-generate","data":{"message":"%s"}}\n' "$LEONARDO_API_KEY"
            printf '{"schema":"game_dev.event.v1","event_id":"evt_1","job_id":"job_1","sequence":1,"timestamp":"2026-09-04T10:00:01.000Z","type":"completed","operation":"provider.leonardo.image-generate","data":{"summary":"%s"}}\n' "$LEONARDO_API_KEY"
            printf 'diagnostic=%s' "$LEONARDO_API_KEY" >&2
            """#)
        defer { try? FileManager.default.removeItem(at: executable) }

        let client = GameDevCLIClient(executableURL: executable, baseEnvironment: [:])
        var events: [GameDevEvent] = []
        var outcome: StreamedRunOutcome?
        for try await element in client.stream(
            CLIInvocation(arguments: ["provider", "leonardo", "image-generate"]),
            credentials: [.leonardo: secret],
            timeout: .seconds(20)
        ) {
            switch element {
            case let .event(event): events.append(event)
            case let .outcome(value): outcome = value
            }
        }

        let settled = try #require(outcome)
        #expect(events.first?.data["message"]?.stringValue == "<redacted>")
        #expect(settled.envelope.summary == "<redacted>")
        #expect(!settled.envelope.formattedJSON.contains(secret))
        #expect(settled.standardError == "diagnostic=<redacted>")
    }

    @Test("A replayed follow stream with several sequence runs is accepted")
    func replayedSequencesAreNotRejected() async throws {
        // `job follow` replays events persisted by an earlier process verbatim, so one
        // stream legitimately carries more than one sequence run and more than one
        // job_id. Enforcing monotonicity here would break resume.
        let script = emitter([
            event("started", sequence: 0, jobID: "job_aaaa"),
            event("progress", sequence: 0, jobID: "job_bbbb"),
            event("completed", sequence: 1, jobID: "job_bbbb"),
            event("completed", sequence: 1, jobID: "job_aaaa", data: "{'summary':'followed'}")
        ])

        let (events, outcome) = try await collect(script)
        let settled = try #require(outcome)

        #expect(events.count == 4)
        #expect(Set(events.map(\.jobID)).count == 2)
        // The last terminal event wins, so a replayed earlier terminal does not end
        // the run prematurely.
        #expect(settled.envelope.data["summary"]?.stringValue == "followed")
    }
}
