import CryptoKit
import Darwin
import Foundation

struct GameDevCLIRuntimeMeasurement: Equatable, Sendable {
    let rootURL: URL
    let payloadURL: URL
    let nodeURL: URL
    let entrypointURL: URL
    let treeSHA256: String
    let nodeSHA256: String
    let entrypointSHA256: String
}

struct GameDevCLIRuntimeSnapshot: Sendable {
    let containerURL: URL
    let measurement: GameDevCLIRuntimeMeasurement

    func remove() {
        try? FileManager.default.removeItem(at: containerURL)
    }
}

enum GameDevCLIRuntime {
    static let rosterSchema = "game_dev.cli_runtime_roster.v1"
    static let identitySchema = "game_dev.cli_runtime_identity.v1"
    static let rosterFilename = "runtime-roster.json"
    static let payloadDirectoryName = "payload"
    static let nodeRelativePath = "node/bin/node"
    static let entrypointRelativePath = "app/dist/cli.js"

    private static let maximumRosterBytes = 16 * 1024 * 1024
    fileprivate static let hexadecimal = CharacterSet(charactersIn: "0123456789abcdef")
    private static let allowedRootEntries = Set([rosterFilename, payloadDirectoryName])
    private static let allowedTopLevelPayloadEntries = Set(["app", "node"])
    private static let forbiddenExtensions = Set([
        "c", "cc", "cpp", "cts", "cxx", "d", "h", "hh", "hpp", "m", "map", "mm",
        "mts", "o", "pch", "swift", "ts", "tsx",
    ])

    static func measure(configuredURL: URL) throws -> GameDevCLIRuntimeMeasurement {
        let rootURL = try runtimeRoot(for: configuredURL)
        try validateRootDirectory(rootURL)

        let rosterURL = rootURL.appendingPathComponent(rosterFilename, isDirectory: false)
        let payloadURL = rootURL.appendingPathComponent(payloadDirectoryName, isDirectory: true)
        let rosterData = try boundedData(at: rosterURL, limit: maximumRosterBytes)
        let roster = try decodeRoster(rosterData)
        guard roster.schema == rosterSchema, roster.payloadRoot == payloadDirectoryName else {
            throw GameDevCLIClientError.runtimeInvalid("the runtime roster schema or payload root is unsupported")
        }
        guard roster.entries == roster.entries.sorted(by: entryPrecedes) else {
            throw GameDevCLIClientError.runtimeInvalid("runtime roster entries are not sorted by UTF-8 path bytes")
        }
        guard Set(roster.entries.map(\.path)).count == roster.entries.count else {
            throw GameDevCLIClientError.runtimeInvalid("the runtime roster contains duplicate paths")
        }

        var observedEntries: [RuntimeRosterEntry] = []
        let observedURLs = try enumeratePayload(payloadURL)
        observedEntries.reserveCapacity(observedURLs.count)
        for url in observedURLs {
            let relativePath = try relativePath(of: url, beneath: payloadURL)
            try validateRelativePath(relativePath)
            let entry = try observedEntry(for: url, relativePath: relativePath)
            try validateAllowedPayloadPath(relativePath, type: entry.type)
            observedEntries.append(entry)
        }
        observedEntries.sort(by: entryPrecedes)

        guard observedEntries == roster.entries else {
            let mismatch = zip(observedEntries, roster.entries)
                .first(where: { $0 != $1 })
                .map { observed, declared in
                    observed.path == declared.path
                        ? observed.path
                        : "observed \(observed.path), declared \(declared.path)"
                }
                ?? (observedEntries.count == roster.entries.count
                    ? "unknown entry"
                    : "entry count \(observedEntries.count), declared \(roster.entries.count)")
            throw GameDevCLIClientError.runtimeInvalid(
                "the runtime payload differs from its exact roster at \(mismatch)"
            )
        }
        let treeSHA256 = try canonicalEntriesSHA256(observedEntries)
        guard roster.treeSha256 == treeSHA256 else {
            throw GameDevCLIClientError.runtimeInvalid("the runtime tree digest does not match its payload")
        }

        let entriesByPath = Dictionary(uniqueKeysWithValues: observedEntries.map { ($0.path, $0) })
        guard let nodeEntry = entriesByPath[nodeRelativePath], nodeEntry.type == .file,
              nodeEntry.mode == "0755", let nodeSHA256 = nodeEntry.sha256
        else {
            throw GameDevCLIClientError.runtimeInvalid("the roster does not contain the executable pinned Node runtime")
        }
        guard entriesByPath["node/lib"]?.type == .directory,
              observedEntries.contains(where: { $0.type == .file && $0.path.hasPrefix("node/lib/") })
        else {
            throw GameDevCLIClientError.runtimeInvalid("the roster does not contain the pinned Node dynamic-library closure")
        }
        guard let entrypointEntry = entriesByPath[entrypointRelativePath], entrypointEntry.type == .file,
              entrypointEntry.mode == "0644", let entrypointSHA256 = entrypointEntry.sha256
        else {
            throw GameDevCLIClientError.runtimeInvalid("the roster does not contain the read-only CLI entrypoint")
        }

        let nodeURL = payloadURL.appendingPathComponent(nodeRelativePath, isDirectory: false)
        let entrypointURL = payloadURL.appendingPathComponent(entrypointRelativePath, isDirectory: false)
        return GameDevCLIRuntimeMeasurement(
            rootURL: rootURL,
            payloadURL: payloadURL,
            nodeURL: nodeURL,
            entrypointURL: entrypointURL,
            treeSHA256: treeSHA256,
            nodeSHA256: nodeSHA256,
            entrypointSHA256: entrypointSHA256
        )
    }

    static func snapshot(
        source: GameDevCLIRuntimeMeasurement,
        expectedTreeSHA256: String
    ) throws -> GameDevCLIRuntimeSnapshot {
        guard source.treeSHA256 == expectedTreeSHA256 else {
            throw GameDevCLIClientError.runtimeIdentityChanged
        }

        let containerURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("game-development-studio-runtime-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: containerURL,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: NSNumber(value: 0o700)]
            )
            let snapshotRoot = containerURL.appendingPathComponent("runtime", isDirectory: true)
            try FileManager.default.createDirectory(
                at: snapshotRoot,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: NSNumber(value: 0o700)]
            )
            try FileManager.default.copyItem(
                at: source.rootURL.appendingPathComponent(rosterFilename),
                to: snapshotRoot.appendingPathComponent(rosterFilename)
            )
            try FileManager.default.copyItem(
                at: source.payloadURL,
                to: snapshotRoot.appendingPathComponent(payloadDirectoryName, isDirectory: true)
            )

            let measuredSnapshot: GameDevCLIRuntimeMeasurement
            do {
                measuredSnapshot = try measure(configuredURL: snapshotRoot)
            } catch {
                throw GameDevCLIClientError.runtimeIdentityChanged
            }
            guard measuredSnapshot.treeSHA256 == source.treeSHA256,
                  measuredSnapshot.nodeSHA256 == source.nodeSHA256,
                  measuredSnapshot.entrypointSHA256 == source.entrypointSHA256
            else {
                throw GameDevCLIClientError.runtimeIdentityChanged
            }

            let sourceAfterCopy: GameDevCLIRuntimeMeasurement
            do {
                sourceAfterCopy = try measure(configuredURL: source.rootURL)
            } catch {
                throw GameDevCLIClientError.runtimeIdentityChanged
            }
            guard sourceAfterCopy.treeSHA256 == source.treeSHA256,
                  sourceAfterCopy.nodeSHA256 == source.nodeSHA256,
                  sourceAfterCopy.entrypointSHA256 == source.entrypointSHA256
            else {
                throw GameDevCLIClientError.runtimeIdentityChanged
            }

            return GameDevCLIRuntimeSnapshot(
                containerURL: containerURL,
                measurement: measuredSnapshot
            )
        } catch {
            try? FileManager.default.removeItem(at: containerURL)
            throw error
        }
    }

    static func identityMatches(
        _ measurement: GameDevCLIRuntimeMeasurement,
        _ identity: GameDevCLIExecutableIdentity
    ) -> Bool {
        identity.identitySchema == identitySchema
            && identity.runtimeRootCanonicalPath == measurement.rootURL.path
            && identity.runtimeTreeSHA256 == measurement.treeSHA256
            && identity.entrypointRelativePath == entrypointRelativePath
            && identity.entrypointSHA256 == measurement.entrypointSHA256
            && identity.nodeCanonicalPath == measurement.nodeURL.path
            && identity.nodeSHA256 == measurement.nodeSHA256
    }

    private static func runtimeRoot(for configuredURL: URL) throws -> URL {
        guard configuredURL.isFileURL, configuredURL.path.hasPrefix("/") else {
            throw GameDevCLIClientError.trustedExecutableRequired
        }
        let canonical = configuredURL.standardizedFileURL.resolvingSymlinksInPath().standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: canonical.path, isDirectory: &isDirectory) else {
            throw GameDevCLIClientError.runtimeInvalid("the configured runtime path does not exist")
        }
        if isDirectory.boolValue { return canonical }

        let components = canonical.pathComponents
        let suffix = [payloadDirectoryName, "app", "dist", "cli.js"]
        guard components.count >= suffix.count,
              Array(components.suffix(suffix.count)) == suffix
        else {
            throw GameDevCLIClientError.runtimeInvalid(
                "sensitive operations require a closed Studio runtime directory, not an arbitrary executable"
            )
        }
        return suffix.reduce(canonical) { partial, _ in partial.deletingLastPathComponent() }
            .standardizedFileURL
    }

    private static func validateRootDirectory(_ rootURL: URL) throws {
        let rootKind = try fileKind(at: rootURL)
        guard rootKind.type == .directory else {
            throw GameDevCLIClientError.runtimeInvalid("the configured runtime root is not a directory")
        }
        let names = try FileManager.default.contentsOfDirectory(atPath: rootURL.path)
        guard Set(names) == allowedRootEntries else {
            throw GameDevCLIClientError.runtimeInvalid("the runtime root must contain exactly payload and runtime-roster.json")
        }
        let payloadURL = rootURL.appendingPathComponent(payloadDirectoryName, isDirectory: true)
        let rosterURL = rootURL.appendingPathComponent(rosterFilename, isDirectory: false)
        guard try fileKind(at: payloadURL).type == .directory,
              try fileKind(at: rosterURL).type == .file
        else {
            throw GameDevCLIClientError.runtimeInvalid("the runtime root contains unsupported filesystem entries")
        }
        let payloadNames = try FileManager.default.contentsOfDirectory(atPath: payloadURL.path)
        guard Set(payloadNames) == allowedTopLevelPayloadEntries else {
            throw GameDevCLIClientError.runtimeInvalid("the runtime payload must contain exactly app and node")
        }
    }

    private static func decodeRoster(_ data: Data) throws -> RuntimeRoster {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["entries", "payloadRoot", "schema", "treeSha256"]),
              let rawEntries = object["entries"] as? [[String: Any]]
        else {
            throw GameDevCLIClientError.runtimeInvalid("the runtime roster is not canonical structured JSON")
        }
        for entry in rawEntries {
            guard Set(entry.keys) == Set(["mode", "path", "sha256", "size", "type"]) else {
                throw GameDevCLIClientError.runtimeInvalid("a runtime roster entry has unsupported fields")
            }
        }
        do {
            return try JSONDecoder().decode(RuntimeRoster.self, from: data)
        } catch {
            throw GameDevCLIClientError.runtimeInvalid("the runtime roster could not be decoded")
        }
    }

    private static func enumeratePayload(_ payloadURL: URL) throws -> [URL] {
        guard let enumerator = FileManager.default.enumerator(
            at: payloadURL,
            includingPropertiesForKeys: nil,
            options: [],
            errorHandler: { _, _ in false }
        ) else {
            throw GameDevCLIClientError.runtimeInvalid("the runtime payload could not be enumerated")
        }
        var urls: [URL] = []
        for case let url as URL in enumerator { urls.append(url) }
        return urls
    }

    private static func observedEntry(for url: URL, relativePath: String) throws -> RuntimeRosterEntry {
        let kind = try fileKind(at: url)
        switch kind.type {
        case .directory:
            guard kind.mode == "0755" else {
                throw GameDevCLIClientError.runtimeInvalid("runtime directory mode is not 0755: \(relativePath)")
            }
            return RuntimeRosterEntry(
                path: relativePath,
                type: .directory,
                mode: kind.mode,
                size: 0,
                sha256: nil
            )
        case .file:
            let expectedMode = relativePath == nodeRelativePath ? "0755" : "0644"
            guard kind.mode == expectedMode else {
                throw GameDevCLIClientError.runtimeInvalid("runtime file mode is not \(expectedMode): \(relativePath)")
            }
            guard kind.linkCount == 1 else {
                throw GameDevCLIClientError.runtimeInvalid("hard-linked runtime files are not permitted: \(relativePath)")
            }
            return RuntimeRosterEntry(
                path: relativePath,
                type: .file,
                mode: kind.mode,
                size: kind.size,
                sha256: try sha256File(url)
            )
        }
    }

    private static func relativePath(of url: URL, beneath rootURL: URL) throws -> String {
        let canonicalRootPath = rootURL.standardizedFileURL.resolvingSymlinksInPath().path
        let canonicalURLPath = url.standardizedFileURL.resolvingSymlinksInPath().path
        let rootPath = canonicalRootPath.hasSuffix("/") ? canonicalRootPath : canonicalRootPath + "/"
        guard canonicalURLPath.hasPrefix(rootPath) else {
            throw GameDevCLIClientError.runtimeInvalid("a runtime payload entry escaped its root")
        }
        return String(canonicalURLPath.dropFirst(rootPath.count))
    }

    private static func validateRelativePath(_ path: String) throws {
        guard !path.isEmpty,
              !path.hasPrefix("/"),
              !path.contains("\\"),
              !path.contains("\0"),
              path.precomposedStringWithCanonicalMapping == path
        else {
            throw GameDevCLIClientError.runtimeInvalid("the runtime roster contains an unsafe path")
        }
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw GameDevCLIClientError.runtimeInvalid("the runtime roster contains a path traversal")
        }
        for component in components {
            let basename = component.lowercased()
            guard basename != ".ds_store", !basename.hasPrefix("._"),
                  basename != ".env", !basename.hasPrefix(".env."),
                  !["key", "private_key", "privatekey", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]
                    .contains(basename),
                  !["pem", "key", "p12", "pfx", "mobileprovision", "provisionprofile"]
                    .contains((basename as NSString).pathExtension)
            else {
                throw GameDevCLIClientError.runtimeInvalid("the runtime contains a sensitive or platform-metadata name")
            }
        }
    }

    private static func validateAllowedPayloadPath(_ path: String, type: RuntimeEntryType) throws {
        let isAllowed = path == "app"
            || path == "node"
            || path == "node/bin"
            || path == nodeRelativePath
            || path == "node/lib"
            || (path.hasPrefix("node/lib/")
                && !path.dropFirst("node/lib/".count).contains("/"))
            || path == "app/package.json"
            || path == "app/LICENSE"
            || path == "app/PRIVACY.md"
            || path == "app/SECURITY.md"
            || path == "app/SUPPORT.md"
            || path == "app/TERMS.md"
            || path == "app/dist"
            || path.hasPrefix("app/dist/")
            || path == "app/scripts"
            || path == "app/scripts/blender_normalize.py"
            || path == "app/scripts/blender_usd_export.py"
            || path == "app/adapters"
            || path.hasPrefix("app/adapters/")
            || path == "app/skills"
            || path.hasPrefix("app/skills/")
            || path == "app/node_modules"
            || path.hasPrefix("app/node_modules/")
        guard isAllowed else {
            throw GameDevCLIClientError.runtimeInvalid("the runtime contains an unapproved payload path: \(path)")
        }

        if type == .file {
            let lowered = path.lowercased()
            let ext = (lowered as NSString).pathExtension
            if forbiddenExtensions.contains(ext) {
                throw GameDevCLIClientError.runtimeInvalid("the runtime contains source or build-intermediate material: \(path)")
            }
            if lowered.hasPrefix("app/dist/") && !lowered.hasSuffix(".js") {
                throw GameDevCLIClientError.runtimeInvalid("the compiled CLI tree may contain JavaScript files only")
            }
        }
    }

    private static func fileKind(at url: URL) throws -> RuntimeFileKind {
        var information = stat()
        guard Darwin.lstat(url.path, &information) == 0 else {
            throw GameDevCLIClientError.runtimeInvalid("a runtime filesystem entry could not be inspected")
        }
        let typeBits = information.st_mode & mode_t(S_IFMT)
        let type: RuntimeEntryType
        switch typeBits {
        case mode_t(S_IFREG): type = .file
        case mode_t(S_IFDIR): type = .directory
        case mode_t(S_IFLNK):
            throw GameDevCLIClientError.runtimeInvalid("symlinks are not permitted inside the runtime")
        default:
            throw GameDevCLIClientError.runtimeInvalid("special filesystem entries are not permitted inside the runtime")
        }
        return RuntimeFileKind(
            type: type,
            mode: String(format: "%04o", information.st_mode & 0o7777),
            size: type == .file ? Int(information.st_size) : 0,
            linkCount: Int(information.st_nlink)
        )
    }

    private static func boundedData(at url: URL, limit: Int) throws -> Data {
        let kind = try fileKind(at: url)
        guard kind.type == .file, kind.size <= limit else {
            throw GameDevCLIClientError.runtimeInvalid("the runtime roster is missing or too large")
        }
        do {
            return try Data(contentsOf: url, options: [.mappedIfSafe])
        } catch {
            throw GameDevCLIClientError.runtimeInvalid("the runtime roster could not be read")
        }
    }

    private static func canonicalEntriesSHA256(_ entries: [RuntimeRosterEntry]) throws -> String {
        let objects: [[String: Any]] = entries.map { entry in
            [
                "mode": entry.mode,
                "path": entry.path,
                "sha256": entry.sha256 ?? NSNull(),
                "size": entry.size,
                "type": entry.type.rawValue,
            ]
        }
        let data: Data
        do {
            data = try JSONSerialization.data(
                withJSONObject: objects,
                options: [.sortedKeys, .withoutEscapingSlashes]
            )
        } catch {
            throw GameDevCLIClientError.runtimeInvalid("the runtime roster could not be canonicalized")
        }
        return sha256(data)
    }

    private static func sha256File(_ url: URL) throws -> String {
        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: url)
        } catch {
            throw GameDevCLIClientError.runtimeInvalid("a runtime file could not be read")
        }
        defer { try? handle.close() }

        var hasher = SHA256()
        do {
            while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
                hasher.update(data: chunk)
            }
        } catch {
            throw GameDevCLIClientError.runtimeInvalid("a runtime file changed or became unreadable during hashing")
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func entryPrecedes(_ lhs: RuntimeRosterEntry, _ rhs: RuntimeRosterEntry) -> Bool {
        lhs.path.utf8.lexicographicallyPrecedes(rhs.path.utf8)
    }
}

private struct RuntimeRoster: Decodable {
    let schema: String
    let payloadRoot: String
    let entries: [RuntimeRosterEntry]
    let treeSha256: String

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schema = try container.decode(String.self, forKey: .schema)
        payloadRoot = try container.decode(String.self, forKey: .payloadRoot)
        entries = try container.decode([RuntimeRosterEntry].self, forKey: .entries)
        treeSha256 = try container.decode(String.self, forKey: .treeSha256)
        guard treeSha256.count == 64,
              treeSha256.unicodeScalars.allSatisfy(GameDevCLIRuntime.hexadecimal.contains)
        else {
            throw DecodingError.dataCorruptedError(
                forKey: .treeSha256,
                in: container,
                debugDescription: "treeSha256 must be a lower-case SHA-256"
            )
        }
    }

    private enum CodingKeys: String, CodingKey {
        case schema, payloadRoot, entries, treeSha256
    }
}

private struct RuntimeRosterEntry: Codable, Equatable {
    let path: String
    let type: RuntimeEntryType
    let mode: String
    let size: Int
    let sha256: String?

    init(path: String, type: RuntimeEntryType, mode: String, size: Int, sha256: String?) {
        self.path = path
        self.type = type
        self.mode = mode
        self.size = size
        self.sha256 = sha256
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decode(String.self, forKey: .path)
        type = try container.decode(RuntimeEntryType.self, forKey: .type)
        mode = try container.decode(String.self, forKey: .mode)
        size = try container.decode(Int.self, forKey: .size)
        sha256 = try container.decodeIfPresent(String.self, forKey: .sha256)

        guard mode == "0644" || mode == "0755", size >= 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .mode,
                in: container,
                debugDescription: "runtime roster mode or size is invalid"
            )
        }
        switch type {
        case .directory:
            guard size == 0, sha256 == nil else {
                throw DecodingError.dataCorruptedError(
                    forKey: .sha256,
                    in: container,
                    debugDescription: "directory entries cannot carry bytes or a digest"
                )
            }
        case .file:
            guard let sha256, sha256.count == 64,
                  sha256.unicodeScalars.allSatisfy(GameDevCLIRuntime.hexadecimal.contains)
            else {
                throw DecodingError.dataCorruptedError(
                    forKey: .sha256,
                    in: container,
                    debugDescription: "file entries require a lower-case SHA-256"
                )
            }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case path, type, mode, size, sha256
    }
}

private enum RuntimeEntryType: String, Codable {
    case directory
    case file
}

private struct RuntimeFileKind {
    let type: RuntimeEntryType
    let mode: String
    let size: Int
    let linkCount: Int
}
