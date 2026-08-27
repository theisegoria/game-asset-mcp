import Foundation
import Testing
@testable import GameDevelopmentStudio

@Suite("Local game-dev process client", .serialized)
struct GameDevCLIClientTests {
    private let python = URL(fileURLWithPath: "/usr/bin/python3")

    @Test("Arguments are passed literally without shell interpolation")
    func argumentsAreLiteral() async throws {
        let script = #"import json,sys; print(json.dumps({'schema':'game_dev.result.v1','operation':'test.args','ok':True,'data':{'arguments':sys.argv[1:]}}))"#
        let literal = #"; $(touch /tmp/should-never-exist) && $HOME `id`"#
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        let result = try await client.execute(
            CLIInvocation(arguments: ["-c", script, literal]),
            credentials: [:],
            timeout: .seconds(5)
        )

        guard case let .array(arguments)? = result.envelope.data["arguments"] else {
            Issue.record("Missing argument array")
            return
        }
        #expect(arguments.contains(.string(literal)))
        #expect(arguments.contains(.string("--json")))
        #expect(result.succeeded)
    }

    @Test("Standard input is delivered byte-for-byte and closed")
    func standardInputIsNotAnArgument() async throws {
        let script = #"import json,sys; payload=sys.stdin.buffer.read().decode('utf-8'); print(json.dumps({'schema':'game_dev.result.v1','operation':'test.stdin','ok':True,'data':{'payload':payload,'arguments':sys.argv[1:]}}))"#
        let request = #"{"prompt":"$(touch /tmp/not-a-command); `id`","name":"asset"}"#
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        let invocation = CLIInvocation(
            arguments: ["-c", script, "--request", "-"],
            standardInput: Data(request.utf8)
        )

        let result = try await client.execute(invocation, credentials: [:], timeout: .seconds(5))
        #expect(result.envelope.data["payload"]?.stringValue == request)
        #expect(!invocation.arguments.contains(request))
        #expect(result.succeeded)
    }

    @Test("Credential environment is injected and all returned text is redacted")
    func credentialInjectionAndRedaction() async throws {
        let script = #"import json,os,sys; key=os.environ['TRIPO_API_KEY']; sys.stderr.write('diagnostic='+key); print(json.dumps({'schema':'game_dev.result.v1','operation':'test.redaction','ok':True,'data':{'message':key}}))"#
        let secret = "tripo-super-secret-123"
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        let result = try await client.execute(
            CLIInvocation(arguments: ["-c", script]),
            credentials: [.tripo: secret],
            timeout: .seconds(5)
        )

        #expect(result.envelope.summary == "<redacted>")
        #expect(result.standardError == "diagnostic=<redacted>")
        #expect(!result.standardOutput.contains(secret))
        #expect(!result.standardError.contains(secret))
        #expect(!result.description.contains(secret))
    }

    @Test("Provider keys are stripped from inherited environment and only explicit credentials win")
    func inheritedCredentialEnvironmentIsStripped() async throws {
        let script = #"import json,os; print(json.dumps({'schema':'game_dev.result.v1','operation':'test.environment','ok':True,'data':{'tripo':os.environ.get('TRIPO_API_KEY'),'leonardoPresent':'LEONARDO_API_KEY' in os.environ}}))"#
        let client = GameDevCLIClient(
            executableURL: python,
            baseEnvironment: [
                "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin",
                "TRIPO_API_KEY": "inherited-tripo-secret",
                "LEONARDO_API_KEY": "inherited-leonardo-secret",
            ]
        )
        let result = try await client.execute(
            CLIInvocation(arguments: ["-c", script]),
            credentials: [.tripo: "explicit-tripo-secret"],
            timeout: .seconds(5)
        )

        #expect(result.envelope.data["tripo"]?.stringValue == "<redacted>")
        #expect(result.envelope.data["leonardoPresent"] == .bool(false))
        #expect(!result.standardOutput.contains("inherited-tripo-secret"))
        #expect(!result.standardOutput.contains("inherited-leonardo-secret"))
        #expect(!result.standardOutput.contains("explicit-tripo-secret"))
    }

    @Test("Invocation environment cannot bypass explicit credential injection")
    func invocationCredentialEnvironmentIsRejected() async {
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        do {
            _ = try await client.execute(
                CLIInvocation(
                    arguments: ["-c", "print('unused')"],
                    environment: ["TRIPO_API_KEY": "bypass-secret"]
                ),
                credentials: [:],
                timeout: .seconds(5)
            )
            Issue.record("Expected invalidInvocation")
        } catch let error as GameDevCLIClientError {
            guard case let .invalidInvocation(reason) = error else {
                Issue.record("Expected invalidInvocation, got \(error)")
                return
            }
            #expect(reason == "provider credentials must use the explicit credentials parameter")
            #expect(!error.localizedDescription.contains("bypass-secret"))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("Credential values are rejected if copied into arguments")
    func credentialCannotBeAnArgument() async {
        let secret = "do-not-put-me-in-argv"
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        do {
            _ = try await client.execute(
                CLIInvocation(arguments: ["-c", "print('unused')", secret]),
                credentials: [.leonardo: secret],
                timeout: .seconds(5)
            )
            Issue.record("Expected credentialInArguments")
        } catch let error as GameDevCLIClientError {
            #expect(error == .credentialInArguments(.leonardo))
            #expect(!error.localizedDescription.contains(secret))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("Nonzero structured failures remain inspectable results")
    func structuredFailure() async throws {
        let script = #"import json,sys; print(json.dumps({'schema':'game_dev.result.v1','operation':'test.failure','ok':False,'error':{'error':'INVALID_INPUT','message':'Bad request'}})); sys.exit(1)"#
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        let result = try await client.execute(
            CLIInvocation(arguments: ["-c", script]),
            credentials: [:],
            timeout: .seconds(5)
        )

        #expect(result.exitCode == 1)
        #expect(result.envelope.ok == false)
        #expect(result.envelope.status == .failed)
        #expect(result.envelope.summary == "Bad request")
        #expect(result.succeeded == false)
    }

    @Test("Nonzero exit with an ok envelope fails closed")
    func inconsistentExitAndEnvelope() async {
        let script = #"import json,sys; print(json.dumps({'schema':'game_dev.result.v1','operation':'test.inconsistent','ok':True,'data':{}})); sys.exit(7)"#
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        do {
            _ = try await client.execute(
                CLIInvocation(arguments: ["-c", script]),
                credentials: [:],
                timeout: .seconds(5)
            )
            Issue.record("Expected inconsistentResult")
        } catch let error as GameDevCLIClientError {
            #expect(error == .inconsistentResult(exitCode: 7, ok: true))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("Unexpected schemas fail closed")
    func unexpectedSchema() async {
        let script = #"print('{\"schema\":\"unknown.v1\",\"operation\":\"test\",\"ok\":true,\"data\":{}}')"#
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        do {
            _ = try await client.execute(
                CLIInvocation(arguments: ["-c", script]),
                credentials: [:],
                timeout: .seconds(5)
            )
            Issue.record("Expected unexpectedSchema")
        } catch let error as GameDevCLIClientError {
            #expect(error == .unexpectedSchema("unknown.v1"))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("Invalid JSON diagnostics redact JSON-escaped credential forms")
    func invalidJSONDiagnosticRedaction() async {
        let secret = "quoted\"secret\nline"
        let script = #"import json,os; print(json.dumps(os.environ['TRIPO_API_KEY']))"#
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        do {
            _ = try await client.execute(
                CLIInvocation(arguments: ["-c", script]),
                credentials: [.tripo: secret],
                timeout: .seconds(5)
            )
            Issue.record("Expected invalidJSON")
        } catch let error as GameDevCLIClientError {
            guard case let .invalidJSON(_, diagnostic) = error else {
                Issue.record("Expected invalidJSON, got \(error)")
                return
            }
            #expect(diagnostic.contains("<redacted>"))
            #expect(!diagnostic.contains("quoted"))
            #expect(!error.localizedDescription.contains("quoted"))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("Output is bounded and terminates a noisy process")
    func outputLimit() async {
        let script = #"import sys,time; sys.stdout.write('x'*8192); sys.stdout.flush(); time.sleep(5)"#
        let client = GameDevCLIClient(
            executableURL: python,
            baseEnvironment: [:],
            maximumOutputBytesPerStream: 256
        )
        do {
            _ = try await client.execute(
                CLIInvocation(arguments: ["-c", script]),
                credentials: [:],
                timeout: .seconds(5)
            )
            Issue.record("Expected outputLimitExceeded")
        } catch let error as GameDevCLIClientError {
            #expect(error == .outputLimitExceeded(stream: .standardOutput, limit: 256))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("Timeout terminates the child process")
    func timeout() async {
        let script = "import time; time.sleep(30)"
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        let clock = ContinuousClock()
        let started = clock.now
        do {
            _ = try await client.execute(
                CLIInvocation(arguments: ["-c", script]),
                credentials: [:],
                timeout: .milliseconds(100)
            )
            Issue.record("Expected timedOut")
        } catch let error as GameDevCLIClientError {
            #expect(error == .timedOut(.milliseconds(100)))
            #expect(started.duration(to: clock.now) < .seconds(3))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("Timeout force-kills a child that ignores SIGTERM")
    func timeoutForceKillsTermIgnoringChild() async {
        let script = "import signal,time; signal.signal(signal.SIGTERM, lambda *_: None); time.sleep(30)"
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        let clock = ContinuousClock()
        let started = clock.now
        do {
            _ = try await client.execute(
                CLIInvocation(arguments: ["-c", script]),
                credentials: [:],
                timeout: .milliseconds(250)
            )
            Issue.record("Expected timedOut")
        } catch let error as GameDevCLIClientError {
            #expect(error == .timedOut(.milliseconds(250)))
            #expect(started.duration(to: clock.now) < .seconds(3))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("Task cancellation terminates the child and surfaces CancellationError")
    func cancellation() async {
        let script = "import time; time.sleep(30)"
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        let task = Task {
            try await client.execute(
                CLIInvocation(arguments: ["-c", script]),
                credentials: [:],
                timeout: nil
            )
        }
        try? await Task.sleep(for: .milliseconds(100))
        let clock = ContinuousClock()
        let cancelledAt = clock.now
        task.cancel()

        do {
            _ = try await task.value
            Issue.record("Expected cancellation")
        } catch is CancellationError {
            #expect(cancelledAt.duration(to: clock.now) < .seconds(3))
        } catch {
            Issue.record("Expected CancellationError, got \(error)")
        }
    }

    @Test("The default resolver can launch through usr bin env")
    func environmentResolver() async throws {
        let script = #"print('{\"schema\":\"game_dev.result.v1\",\"operation\":\"test.env\",\"ok\":true,\"data\":{}}')"#
        let client = GameDevCLIClient(executableName: "python3", baseEnvironment: ProcessInfo.processInfo.environment)
        let result = try await client.execute(
            CLIInvocation(arguments: ["-c", script]),
            credentials: [:],
            timeout: .seconds(5)
        )
        #expect(result.envelope.operation == "test.env")
    }
}
