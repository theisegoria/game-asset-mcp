import AnvilKit
import SwiftUI

struct SidebarView: View {
    @Binding var selection: WorkspaceRoute
    let activeRunCount: Int
    let needsAttentionCount: Int

    var body: some View {
        List(selection: $selection) {
            ForEach(NavigationGroup.allCases) { group in
                Section(group.title) {
                    ForEach(group.routes, id: \.self) { route in
                        row(for: route)
                            .tag(route)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Anvil")
    }

    @ViewBuilder
    private func row(for route: WorkspaceRoute) -> some View {
        Label {
            HStack(spacing: Anvil.Space.tight) {
                Text(route.title)
                Spacer(minLength: 4)
                badge(for: route)
            }
        } icon: {
            Image(systemName: route.symbolName)
                .symbolRenderingMode(.hierarchical)
        }
        .help(route.subtitle)
    }

    /// Counts appear only where they change what someone would do next: work in flight,
    /// and work stopped waiting on a person.
    @ViewBuilder
    private func badge(for route: WorkspaceRoute) -> some View {
        if route == .runs {
            if needsAttentionCount > 0 {
                Text("\(needsAttentionCount)")
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Anvil.Status.caution, in: Capsule())
                    .contentTransition(.numericText())
                    .accessibilityLabel("\(needsAttentionCount) runs need approval")
            } else if activeRunCount > 0 {
                Text("\(activeRunCount)")
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                    .accessibilityLabel("\(activeRunCount) runs in progress")
            }
        }
    }
}
