import Foundation

/// Locates the closed CLI runtime that ships inside the Anvil app bundle.
///
/// Anvil never resolves `game-dev` through `PATH` for anything sensitive: the bundled
/// runtime is a content-addressed tree that ``GameDevCLIRuntime`` measures and pins, so
/// an operation that handles credentials or writes to a project can prove exactly which
/// bytes it executed.
public enum AnvilRuntime {
    /// Directory name of the staged runtime inside `Contents/Resources`.
    ///
    /// Deliberately *not* named after Anvil. `scripts/cli-runtime-payload.mjs` pins this
    /// name (`CLI_RUNTIME_ROOT_NAME`) and `tests/cli-runtime-payload.test.ts` asserts it,
    /// and the staged tree really is the Game Development Studio CLI runtime vendored
    /// into this app — the directory names the payload's provenance, not its host.
    /// Must match `RUNTIME_NAME` in `script/build_and_run_anvil.sh`.
    public static let resourceDirectoryName = "GameDevelopmentStudioRuntime"

    /// The runtime staged into this app bundle, or `nil` when running outside a bundle
    /// (for example from `swift run`, or in tests).
    public static func bundledRuntimeURL(in bundle: Bundle = .main) -> URL? {
        guard let resourceURL = bundle.resourceURL else { return nil }
        let candidate = resourceURL.appendingPathComponent(
            resourceDirectoryName,
            isDirectory: true
        )
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else { return nil }
        return candidate
    }
}
