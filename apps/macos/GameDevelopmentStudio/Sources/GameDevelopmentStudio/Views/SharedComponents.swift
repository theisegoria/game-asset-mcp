import SwiftUI

struct WorkspaceScaffold<Content: View>: View {
    @Environment(AppModel.self) private var model

    let section: WorkspaceSection
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                WorkspaceHeader(section: section)
                OperationStatusView(
                    state: model.executionState,
                    cancel: {
                        model.cancelCurrentOperation()
                    }
                )
                content
            }
            .frame(maxWidth: 980, alignment: .leading)
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .navigationTitle(section.title)
        .background(.background)
    }
}

struct WorkspaceHeader: View {
    let section: WorkspaceSection

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            Image(systemName: section.systemImage)
                .font(.system(size: 25, weight: .semibold))
                .symbolRenderingMode(.hierarchical)
                .frame(width: 52, height: 52)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(section.title)
                    .font(.title2.weight(.semibold))
                Text(section.subtitle)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 12)
        }
        .accessibilityElement(children: .combine)
    }
}

struct MaterialCard<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(title, systemImage: systemImage)
                .font(.headline)
                .symbolRenderingMode(.hierarchical)

            content
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(.separator.opacity(0.45), lineWidth: 0.5)
        }
    }
}

struct OperationStatusView: View {
    let state: ExecutionState
    let cancel: () -> Void

    var body: some View {
        if state.isRunning {
            HStack(spacing: 12) {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Operation in progress")

                VStack(alignment: .leading, spacing: 2) {
                    Text("Working")
                        .font(.headline)
                    Text(state.summary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer()

                Button("Cancel", role: .destructive, action: cancel)
                    .controlSize(.small)
                    .accessibilityHint("Requests cancellation of the current local operation")
            }
            .padding(14)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityElement(children: .contain)
        } else if let error = state.errorMessage {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 4) {
                    Text("The operation did not complete")
                        .font(.headline)
                    Text(error)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityElement(children: .combine)
        }
    }
}

struct WorkspaceResultCard: View {
    let result: CLIResultEnvelope?
    let emptyTitle: String
    let emptyDescription: String

    var body: some View {
        MaterialCard(title: "Latest result", systemImage: "doc.text.magnifyingglass") {
            if let result {
                ResultSummaryView(result: result, includeDetails: false)
            } else {
                ContentUnavailableView(
                    emptyTitle,
                    systemImage: "tray",
                    description: Text(emptyDescription)
                )
                .frame(maxWidth: .infinity, minHeight: 150)
            }
        }
    }
}

struct ResultSummaryView: View {
    let result: CLIResultEnvelope
    var includeDetails = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                StatusPill(status: result.status.rawValue)
                Text(result.command)
                    .font(.system(.body, design: .monospaced, weight: .medium))
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(result.timestamp, style: .time)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(result.summary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            if let receiptPath = result.receiptPath, !receiptPath.isEmpty {
                LabeledContent("Receipt") {
                    Text(receiptPath)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .lineLimit(2)
                }
            }

            if includeDetails {
                DisclosureGroup("Structured result") {
                    ScrollView(.horizontal) {
                        Text(result.formattedJSON)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .padding(.top, 8)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

struct StatusPill: View {
    let status: String

    private var color: Color {
        switch status.lowercased() {
        case "ok", "success", "succeeded", "complete", "completed": .green
        case "approvalrequired", "warning", "partial", "blocked": .orange
        case "error", "failed", "failure": .red
        default: .secondary
        }
    }

    private var displayStatus: String {
        switch status {
        case "approvalRequired": "Approval required"
        case "succeeded": "Succeeded"
        case "failed": "Failed"
        default: status.isEmpty ? "Result" : status.capitalized
        }
    }

    var body: some View {
        Text(displayStatus)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.12), in: Capsule())
            .accessibilityLabel("Status: \(displayStatus)")
    }
}

struct EvidenceNote: View {
    let text: String

    var body: some View {
        Label {
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "checkmark.shield")
                .foregroundStyle(.secondary)
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct FormActions<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 10) {
            content
            Spacer(minLength: 0)
        }
        .padding(.top, 4)
    }
}
