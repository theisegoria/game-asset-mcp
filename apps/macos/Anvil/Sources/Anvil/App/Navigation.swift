import AnvilKit
import SwiftUI

/// The sidebar's grouping of routes.
///
/// Grouped by what the person is doing rather than by which CLI family implements it:
/// `visual compare` and `compare_capture_visuals` are the same job to a user and belong
/// in the same place, even though one is a CLI branch and the other a registry tool.
enum NavigationGroup: String, CaseIterable, Identifiable {
    case workspace
    case create
    case assets
    case debug
    case activity
    case system

    var id: String { rawValue }

    var title: String {
        switch self {
        case .workspace: "Workspace"
        case .create: "Create"
        case .assets: "Assets"
        case .debug: "Debug"
        case .activity: "Activity"
        case .system: "System"
        }
    }

    var routes: [WorkspaceRoute] {
        switch self {
        case .workspace: [.overview, .setup]
        case .create: [.createPrompt, .createBrief, .createReferences, .create3D, .createAudio]
        case .assets: [.mesh, .library]
        case .debug: [.scenarios, .visual, .performance]
        case .activity: [.runs, .spend]
        case .system: [.mcp, .console]
        }
    }
}

extension WorkspaceRoute {
    var symbolName: String {
        switch self {
        case .overview: "waveform.path.ecg"
        case .setup: "wrench.and.screwdriver"
        case .createPrompt: "text.viewfinder"
        case .createBrief: "doc.text.magnifyingglass"
        case .createReferences: "photo.on.rectangle.angled"
        case .create3D: "cube.transparent"
        case .createAudio: "waveform"
        case .mesh: "grid"
        case .library: "shippingbox"
        case .scenarios: "film.stack"
        case .visual: "square.on.square.dashed"
        case .performance: "gauge.with.dots.needle.67percent"
        case .spend: "creditcard"
        case .runs: "list.bullet.rectangle"
        case .mcp: "app.connected.to.app.below.fill"
        case .console: "terminal"
        }
    }

    var subtitle: String {
        switch self {
        case .overview: "Toolchain health and what this runtime can do"
        case .setup: "Projects, adapters, skills and credentials"
        case .createPrompt: "See the prompt a spec produces before spending"
        case .createBrief: "Turn a brief into reference candidates"
        case .createReferences: "Generate, vary and choose reference images"
        case .create3D: "Reconstruct, texture, rig and animate"
        case .createAudio: "Generate sound effects and ambience"
        case .mesh: "Inspect, validate, normalize and split PBR planes"
        case .library: "Packages, the catalog, and vendoring into a project"
        case .scenarios: "Adapters, planned runs and sealed capture bundles"
        case .visual: "Capture buffers and baseline-to-candidate diffs"
        case .performance: "Metric distributions, comparisons and goals"
        case .spend: "What has been charged, and against which ceiling"
        case .runs: "Every run and durable job, live and historical"
        case .mcp: "Serve these tools to other AI clients"
        case .console: "Call any tool directly from its schema"
        }
    }

    /// Sidebar routes never show a raw command count; this is the short form used in the
    /// detail heading.
    var headingTitle: String { title }
}
