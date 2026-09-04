import CryptoKit
import Foundation
import Testing
@testable import AnvilKit

/// Builds a throwaway closed runtime tree that satisfies `GameDevCLIRuntime`'s roster,
/// mode and symlink rules, with `body` standing in for `dist/cli.js`.
///
/// Shared by the process and streaming suites: an operation that carries credentials
/// requires a measured runtime rather than an arbitrary executable, so any test of a
/// sensitive path needs one of these.
func makeClosedRuntimeFixture(
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

func writeRuntimeRoster(runtime: URL, payload: URL) throws {
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

func runtimeFileSHA256(_ url: URL) throws -> String {
    SHA256.hash(data: try Data(contentsOf: url))
        .map { String(format: "%02x", $0) }
        .joined()
}
