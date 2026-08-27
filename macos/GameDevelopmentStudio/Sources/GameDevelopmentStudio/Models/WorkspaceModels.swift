import Foundation

public enum WorkspaceSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case production
    case library
    case visualDebugging
    case performance

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .production:
            "Production"
        case .library:
            "Library & Vendoring"
        case .visualDebugging:
            "Visual Debugging"
        case .performance:
            "Performance"
        }
    }

    public var subtitle: String {
        switch self {
        case .production:
            "Generate, inspect, and package game-ready assets"
        case .library:
            "Verify provenance and vendor canonical packages"
        case .visualDebugging:
            "Inspect sealed captures, telemetry, and semantic buffers"
        case .performance:
            "Compare bounded runs against explicit goals"
        }
    }

    public var systemImage: String {
        switch self {
        case .production:
            "cube.transparent"
        case .library:
            "shippingbox"
        case .visualDebugging:
            "viewfinder"
        case .performance:
            "gauge.with.dots.needle.67percent"
        }
    }
}

public enum ExecutionState: Equatable, Sendable {
    case idle
    case running(String)
    case succeeded(String)
    case failed(summary: String, errorMessage: String)

    public var isRunning: Bool {
        if case .running = self { true } else { false }
    }

    public var summary: String {
        switch self {
        case .idle:
            "Ready"
        case let .running(summary), let .succeeded(summary):
            summary
        case let .failed(summary, _):
            summary
        }
    }

    public var errorMessage: String? {
        if case let .failed(_, errorMessage) = self { errorMessage } else { nil }
    }
}
