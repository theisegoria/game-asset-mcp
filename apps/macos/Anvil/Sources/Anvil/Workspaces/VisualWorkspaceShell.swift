import AnvilKit
import SwiftUI

/// The Visual route: lists comparison runs and opens one in the diff viewer.
///
/// A comparison result is read from the run's envelope, and its images from the paths
/// the result names, so nothing here is invented — if the run did not produce a heatmap,
/// the viewer says so rather than drawing one.
struct VisualWorkspace: View {
    let runs: [Run]

    private var comparisons: [Run] {
        runs.filter { $0.commandID == "visual.compare" || $0.commandID == "tool.compare_capture_visuals" }
            .filter { $0.state == .succeeded }
    }

    var body: some View {
        ScrollView {
            GlassEffectContainer(spacing: Anvil.Space.regular) {
                VStack(alignment: .leading, spacing: Anvil.Space.roomy) {
                    WorkspaceHeading(
                        title: WorkspaceRoute.visual.title,
                        subtitle: WorkspaceRoute.visual.subtitle,
                        symbolName: WorkspaceRoute.visual.symbolName
                    )
                    if comparisons.isEmpty {
                        Panel {
                            NothingHere(
                                title: "No comparisons yet",
                                message: "Compare two sealed runs from the Scenarios workspace and the result opens here, with the frames beside the numbers.",
                                symbolName: WorkspaceRoute.visual.symbolName
                            )
                        }
                    } else {
                        Panel("Comparisons", symbolName: "square.on.square.dashed") {
                            ForEach(comparisons) { run in
                                ValueRow(label: run.title, value: run.arguments.dropFirst(2).prefix(2).joined(separator: " → "), isMonospaced: true)
                            }
                            Text("Opening a comparison in the viewer lands in the next iteration.")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                .padding(Anvil.Space.roomy)
                .frame(maxWidth: Anvil.readableWidth, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .top)
            }
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(.background)
        .navigationTitle(WorkspaceRoute.visual.title)
    }
}
