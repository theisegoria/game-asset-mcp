import AnvilKit
import SwiftUI

struct ContentView: View {
    @Environment(AnvilModel.self) private var model
    @State private var route: WorkspaceRoute = .overview
    @State private var selectedRun: RunID?

    var body: some View {
        NavigationSplitView {
            SidebarView(
                selection: $route,
                activeRunCount: model.runs.activeRuns.count,
                needsAttentionCount: model.runs.runs.filter { $0.state == RunState.awaitingApproval }.count
            )
            .navigationSplitViewColumnWidth(min: 220, ideal: 248, max: 320)
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
        .task { await model.start() }
    }

    @ViewBuilder
    private var detail: some View {
        switch route {
        case .overview:
            HealthWorkspace()
        case .visual:
            VisualWorkspace(runs: model.runs.runs)
        case .runs:
            RunsWorkspace(
                runs: model.runs.runs,
                unreadableRunIDs: model.runs.unreadableRunIDs,
                selection: $selectedRun
            )
        default:
            ComingSoon(route: route)
        }
    }
}

/// Placeholder for a route whose bespoke surface has not landed yet.
///
/// States plainly which commands will live here rather than showing a blank pane, so the
/// gap between what the toolchain can do and what Anvil surfaces is visible rather than
/// hidden.
private struct ComingSoon: View {
    let route: WorkspaceRoute

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Anvil.Space.roomy) {
                WorkspaceHeading(
                    title: route.title,
                    subtitle: route.subtitle,
                    symbolName: route.symbolName
                )
                Panel("Not built yet", symbolName: "hammer") {
                    Text("These commands will be surfaced here:")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    ForEach(CommandCatalog.commands(in: route)) { spec in
                        HStack(alignment: .firstTextBaseline, spacing: Anvil.Space.snug) {
                            Text(spec.title)
                                .font(.callout.weight(.medium))
                                .frame(width: 220, alignment: .leading)
                            Text(spec.id)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                            Spacer(minLength: 0)
                            if let money = spec.spend.shortLabel {
                                StatusChip(
                                    label: money,
                                    symbolName: "creditcard",
                                    tint: Anvil.Status.caution
                                )
                            }
                        }
                    }
                }
            }
            .padding(Anvil.Space.roomy)
            .frame(maxWidth: Anvil.readableWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(.background)
        .navigationTitle(route.title)
    }
}
