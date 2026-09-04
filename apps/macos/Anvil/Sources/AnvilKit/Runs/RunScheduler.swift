import Foundation

/// Serializes only the runs that genuinely conflict, and runs everything else at once.
///
/// The previous app used a single global mutex, which was safe but wrong in both
/// directions: it blocked a read-only inspection behind a long capture, and it hid the
/// real hazard, which is not concurrency in general but specific pairs — `catalog
/// rebuild` against `catalog admit`, or two `package build` calls racing for the same
/// content-addressed destination.
public actor RunScheduler {
    private var occupied: Set<LaneKey> = []
    private var waiting: [LaneKey: [CheckedContinuation<Void, Never>]] = [:]

    private struct LaneKey: Hashable {
        let value: String
    }

    public init() {}

    /// Runs `operation` once its lane is free. `.none` never waits.
    public func run<T: Sendable>(
        in lane: ExclusionLane,
        operation: @Sendable () async throws -> T
    ) async rethrows -> T {
        guard let key = Self.key(for: lane) else {
            return try await operation()
        }
        await acquire(key)
        defer { release(key) }
        return try await operation()
    }

    /// Whether a lane is currently held, for showing "waiting on another run" in the UI
    /// instead of an unexplained pause.
    public func isBusy(_ lane: ExclusionLane) -> Bool {
        guard let key = Self.key(for: lane) else { return false }
        return occupied.contains(key)
    }

    private func acquire(_ key: LaneKey) async {
        while occupied.contains(key) {
            await withCheckedContinuation { continuation in
                waiting[key, default: []].append(continuation)
            }
        }
        occupied.insert(key)
    }

    private func release(_ key: LaneKey) {
        occupied.remove(key)
        guard var queue = waiting[key], !queue.isEmpty else { return }
        let next = queue.removeFirst()
        waiting[key] = queue.isEmpty ? nil : queue
        next.resume()
    }

    private static func key(for lane: ExclusionLane) -> LaneKey? {
        switch lane {
        case .none: nil
        case .catalogIndex: LaneKey(value: "catalog")
        case .packageStore: LaneKey(value: "packages")
        case .workspaceWrite: LaneKey(value: "workspace")
        case .skillsRoot: LaneKey(value: "skills")
        case let .project(path): LaneKey(value: "project:\(path)")
        }
    }
}
