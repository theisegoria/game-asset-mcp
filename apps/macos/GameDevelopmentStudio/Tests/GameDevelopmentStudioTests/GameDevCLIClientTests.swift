import CryptoKit
import Darwin
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
        let executable = try makeHandshakeExecutable(body: #"""
            printf 'diagnostic=%s' "$TRIPO_API_KEY" >&2
            printf '{"schema":"game_dev.result.v1","operation":"provider.tripo.generate","ok":true,"data":{"message":"%s"}}\n' "$TRIPO_API_KEY"
            """#)
        defer { try? FileManager.default.removeItem(at: executable) }
        let secret = "tripo-super-secret-123"
        let client = GameDevCLIClient(executableURL: executable, baseEnvironment: [:])
        let result = try await client.execute(
            CLIInvocation(arguments: ["provider", "tripo", "generate"]),
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
        let executable = try makeHandshakeExecutable(body: #"""
            tripo=${TRIPO_API_KEY:-null}
            if [ -n "${LEONARDO_API_KEY:-}" ]; then leonardo=true; else leonardo=false; fi
            printf '{"schema":"game_dev.result.v1","operation":"provider.tripo.generate","ok":true,"data":{"tripo":"%s","leonardoPresent":%s}}\n' "$tripo" "$leonardo"
            """#)
        defer { try? FileManager.default.removeItem(at: executable) }
        let client = GameDevCLIClient(
            executableURL: executable,
            baseEnvironment: [
                "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin",
                "TRIPO_API_KEY": "inherited-tripo-secret",
                "LEONARDO_API_KEY": "inherited-leonardo-secret",
            ]
        )
        let result = try await client.execute(
            CLIInvocation(arguments: ["provider", "tripo", "generate"]),
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

    @Test("A structured response for a different operation fails closed")
    func unexpectedOperation() async throws {
        let executable = try makeHandshakeExecutable(body: #"""
            printf '%s\n' '{"schema":"game_dev.result.v1","operation":"catalog.list","ok":true,"data":{}}'
            """#)
        defer { try? FileManager.default.removeItem(at: executable) }
        let client = GameDevCLIClient(executableURL: executable, baseEnvironment: [:])

        do {
            _ = try await client.execute(
                CLIInvocation(arguments: ["doctor"]),
                credentials: [:],
                timeout: .seconds(5)
            )
            Issue.record("Expected unexpectedOperation")
        } catch let error as GameDevCLIClientError {
            #expect(error == .unexpectedOperation(expected: "doctor", actual: "catalog.list"))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @Test("Invalid JSON diagnostics redact JSON-escaped credential forms")
    func invalidJSONDiagnosticRedaction() async {
        let secret = "quoted\"secret\nline"
        let executable: URL
        do {
            executable = try makeHandshakeExecutable(body: #"""
                printf '%s\n' "$TRIPO_API_KEY"
                """#)
        } catch {
            Issue.record("Could not create executable fixture: \(error)")
            return
        }
        defer { try? FileManager.default.removeItem(at: executable) }
        let client = GameDevCLIClient(executableURL: executable, baseEnvironment: [:])
        do {
            _ = try await client.execute(
                CLIInvocation(arguments: ["provider", "tripo", "generate"]),
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

    @Test("Minimal child environment excludes base URLs, data roots, loader variables, and unrelated secrets")
    func sensitiveEnvironmentIsMinimal() async throws {
        let executable = try makeHandshakeExecutable(body: #"""
            if [ -n "${TRIPO_BASE_URL+x}" ]; then tripoBase=true; else tripoBase=false; fi
            if [ -n "${LEONARDO_BASE_URL+x}" ]; then leonardoBase=true; else leonardoBase=false; fi
            if [ -n "${GAME_DEV_DATA_ROOT+x}" ]; then dataRoot=true; else dataRoot=false; fi
            if [ -n "${ASSET_OUTPUT_DIR+x}" ]; then assetOutput=true; else assetOutput=false; fi
            if [ -n "${DYLD_INSERT_LIBRARIES+x}" ] || [ -n "${LD_PRELOAD+x}" ]; then loader=true; else loader=false; fi
            if [ -n "${UNRELATED_TOKEN+x}" ] || [ -n "${UNRELATED_API_TOKEN+x}" ]; then unrelatedSecret=true; else unrelatedSecret=false; fi
            if [ -n "${PATH+x}" ]; then path=true; else path=false; fi
            printf '{"schema":"game_dev.result.v1","operation":"provider.tripo.generate","ok":true,"data":{"tripoBase":%s,"leonardoBase":%s,"dataRoot":%s,"assetOutput":%s,"loader":%s,"unrelatedSecret":%s,"path":%s}}\n' "$tripoBase" "$leonardoBase" "$dataRoot" "$assetOutput" "$loader" "$unrelatedSecret" "$path"
            """#)
        defer { try? FileManager.default.removeItem(at: executable) }

        let client = GameDevCLIClient(
            executableURL: executable,
            baseEnvironment: [
                "PATH": "/usr/bin:/bin",
                "TRIPO_BASE_URL": "https://attacker.invalid",
                "LEONARDO_BASE_URL": "https://attacker.invalid",
                "GAME_DEV_DATA_ROOT": "/tmp/attacker-data",
                "ASSET_OUTPUT_DIR": "/tmp/attacker-assets",
                "DYLD_INSERT_LIBRARIES": "/tmp/injected.dylib",
                "UNRELATED_TOKEN": "unrelated-secret",
            ]
        )
        let result = try await client.execute(
            CLIInvocation(
                arguments: ["provider", "tripo", "generate"],
                environment: [
                    "TRIPO_BASE_URL": "https://invocation.invalid",
                    "GAME_DEV_DATA_ROOT": "/tmp/invocation-data",
                    "ASSET_OUTPUT_DIR": "/tmp/invocation-assets",
                    "LD_PRELOAD": "/tmp/invocation.dylib",
                    "UNRELATED_API_TOKEN": "another-secret",
                ]
            ),
            credentials: [.tripo: "explicit-provider-secret"],
            timeout: .seconds(5)
        )

        #expect(result.envelope.data["tripoBase"] == .bool(false))
        #expect(result.envelope.data["leonardoBase"] == .bool(false))
        #expect(result.envelope.data["dataRoot"] == .bool(false))
        #expect(result.envelope.data["assetOutput"] == .bool(false))
        #expect(result.envelope.data["loader"] == .bool(false))
        #expect(result.envelope.data["unrelatedSecret"] == .bool(false))
        #expect(result.envelope.data["path"] == .bool(true))
        #expect(!result.standardOutput.contains("attacker.invalid"))
        #expect(!result.standardOutput.contains("unrelated-secret"))
        #expect(!result.standardOutput.contains("explicit-provider-secret"))
    }

    @Test("Sensitive operations reject PATH lookup and require a canonical executable")
    func sensitiveOperationsRejectPATHLookup() async throws {
        let executable = try makeHandshakeExecutable(body: #"""
            printf '{"schema":"game_dev.result.v1","operation":"test.path","ok":true,"data":{}}\n'
            """#)
        defer { try? FileManager.default.removeItem(at: executable) }

        let client = GameDevCLIClient(
            executableName: executable.lastPathComponent,
            baseEnvironment: ["PATH": executable.deletingLastPathComponent().path]
        )
        do {
            _ = try await client.execute(
                CLIInvocation(arguments: ["provider", "tripo", "generate"]),
                credentials: [.tripo: "must-not-enter-path-lookup"],
                timeout: .seconds(5)
            )
            Issue.record("Expected trustedExecutableRequired")
        } catch let error as GameDevCLIClientError {
            #expect(error == .trustedExecutableRequired)
            #expect(!error.localizedDescription.contains("must-not-enter-path-lookup"))
        }
    }

    @Test("No-secret handshake binds the whole runtime and rejects a changed imported sibling")
    func handshakeAndIdentityPin() async throws {
        let launchMarker = FileManager.default.temporaryDirectory
            .appendingPathComponent("game-dev-runtime-launch-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: launchMarker) }
        let runtime = try makeHandshakeExecutable(body: """
            if [ -n "${TRIPO_API_KEY:-}" ]; then
                printf 'credential process launched' > "\(launchMarker.path)"
            fi
            printf '{"schema":"game_dev.result.v1","operation":"test.identity","ok":true,"data":{}}\n'
            """)
        defer { try? FileManager.default.removeItem(at: runtime) }

        let client = GameDevCLIClient(executableURL: runtime, baseEnvironment: [:])
        let identity = try await client.noSecretHandshake()
        #expect(identity.identitySchema == GameDevCLIRuntime.identitySchema)
        #expect(identity.runtimeRootCanonicalPath == runtime.resolvingSymlinksInPath().path)
        #expect(identity.runtimeTreeSHA256.count == 64)
        #expect(identity.entrypointSHA256.count == 64)
        #expect(identity.nodeSHA256.count == 64)
        #expect(!identity.nodeVersion.isEmpty)
        #expect(identity.cliVersion == "1.0.0")
        #expect(identity.resultSchema == GameDevCLIClient.resultSchema)
        #expect(identity.capabilitiesSchema == GameDevCLIClient.capabilitiesSchema)

        let pinned = client.pinned(to: identity)
        let importedSibling = runtime
            .appendingPathComponent("payload/app/dist/cli/arguments.js", isDirectory: false)
        let originalEntrypointHash = identity.entrypointSHA256
        try Data("export const changedAfterApproval = true;\n".utf8).write(to: importedSibling)
        #expect(try runtimeFileSHA256(runtime.appendingPathComponent("payload/app/dist/cli.js")) == originalEntrypointHash)
        do {
            _ = try await pinned.execute(
                CLIInvocation(arguments: ["provider", "tripo", "generate"]),
                credentials: [.tripo: "never-used-secret"],
                timeout: .seconds(5)
            )
            Issue.record("Expected runtimeIdentityChanged")
        } catch let error as GameDevCLIClientError {
            #expect(error == .runtimeIdentityChanged)
        }
        #expect(!FileManager.default.fileExists(atPath: launchMarker.path))
    }

    @Test("Handshake rejects a sibling mutation made by the probed runtime")
    func handshakeMutationRace() async throws {
        let runtime = try makeHandshakeExecutable(
            body: #"printf '{"schema":"game_dev.result.v1","operation":"test.identity","ok":true,"data":{}}\n'"#,
            mutateDuringCapabilities: true
        )
        defer { try? FileManager.default.removeItem(at: runtime) }
        let client = GameDevCLIClient(executableURL: runtime, baseEnvironment: [:])

        do {
            _ = try await client.noSecretHandshake()
            Issue.record("Expected runtimeIdentityChanged")
        } catch let error as GameDevCLIClientError {
            #expect(error == .runtimeIdentityChanged)
        }
    }

    @Test("Sensitive launch ignores PATH node and strips Node loader variables")
    func pinnedInterpreterIgnoresPATH() async throws {
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("game-dev-fake-node-\(UUID().uuidString)")
        let fakeBin = FileManager.default.temporaryDirectory
            .appendingPathComponent("game-dev-fake-bin-\(UUID().uuidString)", isDirectory: true)
        let fakeNode = fakeBin.appendingPathComponent("node")
        try FileManager.default.createDirectory(at: fakeBin, withIntermediateDirectories: false)
        defer {
            try? FileManager.default.removeItem(at: marker)
            try? FileManager.default.removeItem(at: fakeBin)
        }
        try Data("#!/bin/sh\nprintf used > \"\(marker.path)\"\nexit 99\n".utf8).write(to: fakeNode)
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: 0o755)],
            ofItemAtPath: fakeNode.path
        )

        let runtime = try makeHandshakeExecutable(body: #"""
            node_options=${NODE_OPTIONS:-absent}
            node_path=${NODE_PATH:-absent}
            node_cache=${NODE_COMPILE_CACHE:-absent}
            printf '{"schema":"game_dev.result.v1","operation":"provider.tripo.generate","ok":true,"data":{"nodeOptions":"%s","nodePath":"%s","nodeCache":"%s"}}\n' "$node_options" "$node_path" "$node_cache"
            """#)
        defer { try? FileManager.default.removeItem(at: runtime) }
        let client = GameDevCLIClient(
            executableURL: runtime,
            baseEnvironment: [
                "PATH": fakeBin.path,
                "NODE_OPTIONS": "--require=/tmp/attacker.js",
                "NODE_PATH": "/tmp/attacker-modules",
                "NODE_COMPILE_CACHE": "/tmp/attacker-cache",
            ]
        )
        let result = try await client.execute(
            CLIInvocation(arguments: ["provider", "tripo", "generate"]),
            credentials: [.tripo: "test-only-provider-value"],
            timeout: .seconds(5)
        )

        #expect(!FileManager.default.fileExists(atPath: marker.path))
        #expect(result.envelope.data["nodeOptions"]?.stringValue == "absent")
        #expect(result.envelope.data["nodePath"]?.stringValue == "absent")
        #expect(result.envelope.data["nodeCache"]?.stringValue == "absent")
    }

    @Test("Global output flags preserve capabilities and doctor envelope identity")
    func globalOutputFlagPreservesSingleSegmentOperations() async throws {
        let executable = try makeHandshakeExecutable(body: #"""
            operation="$1"
            printf '{"schema":"game_dev.result.v1","operation":"%s","ok":true,"data":{}}\n' "$operation"
            """#)
        defer { try? FileManager.default.removeItem(at: executable) }

        let client = GameDevCLIClient(executableURL: executable, baseEnvironment: [:])
        for operation in ["capabilities", "doctor"] {
            let result = try await client.execute(
                CLIInvocation(arguments: [
                    operation,
                    "--output-dir", FileManager.default.temporaryDirectory.path,
                ]),
                credentials: [:],
                timeout: .seconds(5)
            )
            #expect(result.envelope.operation == operation)
        }
    }

    @Test("Direct child exit does not wait for descendants holding output pipes")
    func descendantPipeHolderDoesNotHang() async throws {
        let script = #"import json,subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(2)']); print(json.dumps({'schema':'game_dev.result.v1','operation':'test.pipe-holder','ok':True,'data':{}}))"#
        let client = GameDevCLIClient(executableURL: python, baseEnvironment: [:])
        let clock = ContinuousClock()
        let started = clock.now
        let result = try await client.execute(
            CLIInvocation(arguments: ["-c", script]),
            credentials: [:],
            timeout: .seconds(5)
        )

        #expect(result.envelope.operation == "test.pipe-holder")
        #expect(started.duration(to: clock.now) < .seconds(2))
    }

    private func makeHandshakeExecutable(
        body: String,
        mutateDuringCapabilities: Bool = false
    ) throws -> URL {
        let runtime = FileManager.default.temporaryDirectory
            .appendingPathComponent("game-dev-runtime-test-\(UUID().uuidString)", isDirectory: true)
        let payload = runtime.appendingPathComponent("payload", isDirectory: true)
        let nodeBin = payload.appendingPathComponent("node/bin", isDirectory: true)
        let nodeLib = payload.appendingPathComponent("node/lib", isDirectory: true)
        let dist = payload.appendingPathComponent("app/dist", isDirectory: true)
        let cliModules = dist.appendingPathComponent("cli", isDirectory: true)
        for directory in [runtime, payload, nodeBin, nodeLib, dist, cliModules] {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: NSNumber(value: 0o755)]
            )
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: 0o755)],
                ofItemAtPath: directory.path
            )
        }

        let node = nodeBin.appendingPathComponent("node", isDirectory: false)
        try Data("""
        #!/bin/sh
        if [ "$1" = "--version" ]; then
            printf 'v-test-node\\n'
            exit 0
        fi
        exec /bin/sh "$@"
        """.utf8).write(to: node)
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: 0o755)],
            ofItemAtPath: node.path
        )
        let fixtureLibrary = nodeLib.appendingPathComponent("fixture.dylib", isDirectory: false)
        try Data("test-only pinned library closure\n".utf8).write(to: fixtureLibrary)

        let executable = dist.appendingPathComponent("cli.js", isDirectory: false)
        let capabilityMutation = mutateDuringCapabilities
            ? #"printf 'export const mutatedDuringHandshake = true;\n' > "$(dirname "$0")/cli/arguments.js""#
            : ""
        let script = """
        if [ "$1" = "--version" ]; then
            printf '1.0.0\\n'
            exit 0
        fi
        if [ "$1" = "capabilities" ]; then
            previous=''
            output_dir=''
            for argument in "$@"; do
                if [ "$previous" = "--output-dir" ]; then
                    output_dir="$argument"
                    break
                fi
                previous="$argument"
            done
            if [ -z "$output_dir" ] || [ ! -d "$output_dir" ]; then
                exit 41
            fi
            \(capabilityMutation)
            printf '%s\\n' '{"schema":"game_dev.result.v1","operation":"capabilities","ok":true,"data":{"schema":"game_dev.capabilities.v1","name":"game-development-studio","version":"1.0.0","protocols":{"result":"game_dev.result.v1"}}}'
            exit 0
        fi
        \(body)
        """
        try Data(script.utf8).write(to: executable)
        try Data("export const requestCache = new WeakMap();\n".utf8)
            .write(to: cliModules.appendingPathComponent("arguments.js"))

        for file in [fixtureLibrary, executable, cliModules.appendingPathComponent("arguments.js")] {
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: 0o644)],
                ofItemAtPath: file.path
            )
        }
        try writeRuntimeRoster(runtime: runtime, payload: payload)
        return runtime
    }

    private func writeRuntimeRoster(runtime: URL, payload: URL) throws {
        guard let enumerator = FileManager.default.enumerator(
            at: payload,
            includingPropertiesForKeys: nil
        ) else {
            throw CocoaError(.fileReadUnknown)
        }
        let canonicalPayloadPath = payload.resolvingSymlinksInPath().standardizedFileURL.path
        var entries: [[String: Any]] = []
        for case let url as URL in enumerator {
            let canonicalURLPath = url.resolvingSymlinksInPath().standardizedFileURL.path
            let relative = String(canonicalURLPath.dropFirst(canonicalPayloadPath.count + 1))
            var information = stat()
            guard Darwin.lstat(url.path, &information) == 0 else {
                throw CocoaError(.fileReadUnknown)
            }
            let isDirectory = information.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR)
            entries.append([
                "mode": String(format: "%04o", information.st_mode & 0o7777),
                "path": relative,
                "sha256": isDirectory ? NSNull() : try runtimeFileSHA256(url),
                "size": isDirectory ? 0 : Int(information.st_size),
                "type": isDirectory ? "directory" : "file",
            ])
        }
        entries.sort {
            let lhs = $0["path"] as! String
            let rhs = $1["path"] as! String
            return lhs.utf8.lexicographicallyPrecedes(rhs.utf8)
        }
        let canonicalEntries = try JSONSerialization.data(
            withJSONObject: entries,
            options: [.sortedKeys, .withoutEscapingSlashes]
        )
        let treeSHA256 = SHA256.hash(data: canonicalEntries)
            .map { String(format: "%02x", $0) }
            .joined()
        let manifest: [String: Any] = [
            "entries": entries,
            "payloadRoot": "payload",
            "schema": GameDevCLIRuntime.rosterSchema,
            "treeSha256": treeSHA256,
        ]
        var manifestData = try JSONSerialization.data(
            withJSONObject: manifest,
            options: [.sortedKeys, .withoutEscapingSlashes]
        )
        manifestData.append(0x0A)
        try manifestData.write(to: runtime.appendingPathComponent("runtime-roster.json"))
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: 0o644)],
            ofItemAtPath: runtime.appendingPathComponent("runtime-roster.json").path
        )
    }

    private func runtimeFileSHA256(_ url: URL) throws -> String {
        SHA256.hash(data: try Data(contentsOf: url))
            .map { String(format: "%02x", $0) }
            .joined()
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
