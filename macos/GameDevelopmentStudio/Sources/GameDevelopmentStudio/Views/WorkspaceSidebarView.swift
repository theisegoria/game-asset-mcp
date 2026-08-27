import SwiftUI

struct WorkspaceSidebarView: View {
    @Binding var selection: WorkspaceSection
    let executionState: ExecutionState

    var body: some View {
        List(selection: $selection) {
            Section("Workspaces") {
                ForEach(WorkspaceSection.allCases) { section in
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(section.title)
                                .lineLimit(1)
                            Text(section.subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    } icon: {
                        Image(systemName: section.systemImage)
                            .symbolRenderingMode(.hierarchical)
                            .frame(width: 18)
                    }
                    .tag(section)
                    .accessibilityLabel(section.title)
                    .accessibilityHint(section.subtitle)
                }
            }

            if executionState.isRunning {
                Section("Current operation") {
                    HStack(spacing: 10) {
                        ProgressView()
                            .controlSize(.small)
                        Text(executionState.summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Studio")
    }
}
