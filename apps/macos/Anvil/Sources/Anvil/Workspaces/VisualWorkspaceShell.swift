import AnvilKit
import SwiftUI

/// The Visual route: comparison and analysis runs, opened in their viewers.
///
/// Results are read from the run's own envelope and images from the paths the result
/// names, so nothing here is invented. If a run produced no heatmap, the viewer says so
/// rather than drawing one.
struct VisualWorkspace: View {
    let runs: [Run]
    @State private var selected: RunID?

    private static let comparisonCommands: Set<String> = ["visual.compare", "tool.compare_capture_visuals"]
    private static let analysisCommands: Set<String> = ["visual.analyze", "tool.analyze_capture_run"]

    private var visualRuns: [Run] {
        runs.filter { $0.state == .succeeded }
            .filter { Self.comparisonCommands.contains($0.commandID) || Self.analysisCommands.contains($0.commandID) }
    }

    private var current: Run? {
        visualRuns.first { $0.id == selected } ?? visualRuns.first
    }

    var body: some View {
        ScrollView {
            GlassEffectContainer(spacing: Anvil.Space.regular) {
                content
            }
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(.background)
        .navigationTitle(WorkspaceRoute.visual.title)
    }

    @ViewBuilder
    var content: some View {
        VStack(alignment: .leading, spacing: Anvil.Space.roomy) {
            WorkspaceHeading(
                title: WorkspaceRoute.visual.title,
                subtitle: WorkspaceRoute.visual.subtitle,
                symbolName: WorkspaceRoute.visual.symbolName
            )
            if visualRuns.isEmpty {
                Panel {
                    NothingHere(
                        title: "Nothing to look at yet",
                        message: "Analyse a sealed run or compare two of them from the Scenarios workspace. The result opens here with the frames beside the numbers.",
                        symbolName: WorkspaceRoute.visual.symbolName
                    )
                }
            } else {
                if visualRuns.count > 1 { runPicker }
                if let current { open(current) }
            }
        }
        .padding(Anvil.Space.roomy)
        .frame(maxWidth: Anvil.readableWidth, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .top)
    }

    private var runPicker: some View {
        HStack(spacing: Anvil.Space.tight) {
            ForEach(visualRuns) { run in
                Button {
                    selected = run.id
                } label: {
                    HStack(spacing: Anvil.Space.tight) {
                        Image(systemName: Self.comparisonCommands.contains(run.commandID) ? "square.on.square.dashed" : "viewfinder")
                        Text(run.title)
                        Text(run.createdAt, style: .relative).foregroundStyle(.secondary)
                    }
                    .font(.callout)
                    .padding(.horizontal, Anvil.Space.snug)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .anvilPanel(tint: run.id == current?.id ? Anvil.Status.active : .clear, radius: Anvil.Radius.chip)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func open(_ run: Run) -> some View {
        if let envelope = run.envelope {
            if Self.comparisonCommands.contains(run.commandID) {
                switch Result(catching: { try VisualComparison(payload: envelope.data) }) {
                case let .success(comparison):
                    DiffViewer(
                        comparison: comparison,
                        ceiling: EvidenceCeiling(comparison.evidence),
                        images: { pair in
                            (
                                DecodedCapture.load(Self.resolve(pair.baselinePath, near: run)),
                                DecodedCapture.load(Self.resolve(pair.candidatePath, near: run)),
                                pair.heatmapPath.map { DecodedCapture.load(Self.resolve($0, near: run)) } ?? nil
                            )
                        }
                    )
                case let .failure(error):
                    undecodable(run, error)
                }
            } else {
                switch Result(catching: { try CaptureAnalysis(payload: envelope.data) }) {
                case let .success(analysis):
                    CaptureInspector(
                        analysis: analysis,
                        ceiling: EvidenceCeiling(analysis.evidence),
                        image: { DecodedCapture.load(Self.resolve($0, near: run)) }
                    )
                case let .failure(error):
                    undecodable(run, error)
                }
            }
        } else {
            undecodable(run, nil)
        }
    }

    /// Result paths are absolute today. A relative one is resolved against the run's
    /// output directory rather than the process working directory, which would be
    /// wherever Anvil happened to be launched from.
    private static func resolve(_ path: String, near run: Run) -> URL {
        path.hasPrefix("/")
            ? URL(fileURLWithPath: path)
            : run.outputDirectory.appendingPathComponent(path)
    }

    private func undecodable(_ run: Run, _ error: (any Error)?) -> some View {
        Panel("Result could not be read", symbolName: "exclamationmark.triangle.fill") {
            Text(error?.localizedDescription ?? "The run finished but recorded no result envelope.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Anvil refuses to render a result it cannot fully decode rather than showing part of one. If the toolchain has changed shape, update Anvil.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
