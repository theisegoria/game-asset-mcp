import AnvilKit
import SwiftUI

@MainActor
enum PreviewScenes {
    static var all: [PreviewRenderer.Scene] {
        [
            PreviewRenderer.Scene("01-runs-populated") {
                Shell(selection: .runs) {
                    RunsWorkspace(
                        runs: PreviewFixtures.runs(),
                        unreadableRunIDs: [],
                        selection: .constant(nil)
                    ).content
                }
            },
            PreviewRenderer.Scene("02-runs-empty", height: 560) {
                Shell(selection: .runs) {
                    RunsWorkspace(
                        runs: [],
                        unreadableRunIDs: [],
                        selection: .constant(nil)
                    ).content
                }
            },
            PreviewRenderer.Scene("03-runs-unreadable", height: 620) {
                Shell(selection: .runs) {
                    RunsWorkspace(
                        runs: Array(PreviewFixtures.runs().prefix(1)),
                        unreadableRunIDs: ["9B1F-…-4C2A", "0E7D-…-11BB"],
                        selection: .constant(nil)
                    ).content
                }
            },
            PreviewRenderer.Scene("05-diff-side-by-side", height: 1_500) {
                Shell(selection: .visual) {
                    VStack(alignment: .leading, spacing: Anvil.Space.roomy) {
                        WorkspaceHeading(
                            title: WorkspaceRoute.visual.title,
                            subtitle: WorkspaceRoute.visual.subtitle,
                            symbolName: WorkspaceRoute.visual.symbolName
                        )
                        DiffViewer(
                            comparison: PreviewFixtures.comparison(),
                            ceiling: PreviewFixtures.comparisonEvidence(),
                            images: { _ in
                                (PreviewFrames.baseline(), PreviewFrames.candidate(), PreviewFrames.heatmap())
                            }
                        )
                    }
                    .padding(Anvil.Space.roomy)
                    .frame(maxWidth: Anvil.readableWidth, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .top)
                }
            },
            PreviewRenderer.Scene("06-capture-inspector", height: 1_400) {
                Shell(selection: .visual) {
                    VStack(alignment: .leading, spacing: Anvil.Space.roomy) {
                        WorkspaceHeading(
                            title: WorkspaceRoute.visual.title,
                            subtitle: WorkspaceRoute.visual.subtitle,
                            symbolName: WorkspaceRoute.visual.symbolName
                        )
                        CaptureInspector(
                            analysis: PreviewFixtures.analysis(),
                            ceiling: EvidenceCeiling(PreviewFixtures.analysis().evidence),
                            image: { _ in PreviewFrames.baseline() }
                        )
                    }
                    .padding(Anvil.Space.roomy)
                    .frame(maxWidth: Anvil.readableWidth, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .top)
                }
            },
            PreviewRenderer.Scene("04-runs-light", colorScheme: .light) {
                Shell(selection: .runs) {
                    RunsWorkspace(
                        runs: PreviewFixtures.runs(),
                        unreadableRunIDs: [],
                        selection: .constant(nil)
                    ).content
                }
            }
        ]
    }
}

/// Approximates the window chrome for a render: sidebar plus detail.
///
/// The sidebar uses a stand-in rather than the app's `List`, because `ImageRenderer`
/// draws nothing for `List`. Rows are built from the same `NavigationGroup` and
/// `WorkspaceRoute` data the real sidebar uses, so grouping, ordering, symbols and
/// labels are the genuine article even though the container is not.
private struct Shell<Detail: View>: View {
    let selection: WorkspaceRoute
    @ViewBuilder let detail: Detail

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            SidebarStandIn(selection: selection)
                .frame(width: 248)
            Divider()
            detail
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct SidebarStandIn: View {
    let selection: WorkspaceRoute

    var body: some View {
        VStack(alignment: .leading, spacing: Anvil.Space.regular) {
            ForEach(NavigationGroup.allCases) { group in
                VStack(alignment: .leading, spacing: 1) {
                    Text(group.title.uppercased())
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, Anvil.Space.snug)
                        .padding(.bottom, 3)
                    ForEach(group.routes, id: \.self) { route in
                        HStack(spacing: Anvil.Space.snug) {
                            Image(systemName: route.symbolName)
                                .symbolRenderingMode(.hierarchical)
                                .frame(width: 18)
                            Text(route.title)
                                .font(.callout)
                            Spacer(minLength: 0)
                            if route == .runs {
                                Text("1")
                                    .font(.caption2.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Anvil.Status.caution, in: Capsule())
                            }
                        }
                        .foregroundStyle(route == selection ? Color.white : Color.primary)
                        .padding(.horizontal, Anvil.Space.snug)
                        .padding(.vertical, 5)
                        .background {
                            if route == selection {
                                RoundedRectangle(cornerRadius: 7, style: .continuous)
                                    .fill(Color.accentColor)
                            }
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Anvil.Space.snug)
        .padding(.vertical, Anvil.Space.regular)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}
