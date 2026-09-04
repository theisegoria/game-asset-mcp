import AnvilKit
import SwiftUI

/// Toolchain health: the twelve `doctor` checks, the workspace paths they report, and
/// the CLI's own statement of what the report does not prove.
struct HealthWorkspace: View {
    @Environment(AnvilModel.self) private var model

    var body: some View {
        ScrollView {
            GlassEffectContainer(spacing: 18) {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    content
                }
                .padding(24)
                .frame(maxWidth: 900, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .top)
            }
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(.background)
        .navigationTitle("Anvil")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await model.refreshHealth() }
                } label: {
                    Label("Check Again", systemImage: "stethoscope")
                }
                .buttonStyle(.glass)
                .disabled(model.health.isChecking)
            }
        }
        .task {
            if case .idle = model.health { await model.refreshHealth() }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Toolchain health")
                    .font(.title2.weight(.semibold))
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            if model.health.isChecking {
                ProgressView().controlSize(.small)
            }
        }
    }

    private var subtitle: String {
        switch model.health {
        case .idle, .checking:
            "Running game-dev doctor against the bundled runtime"
        case let .ready(report):
            report.healthy
                ? "game-dev \(report.version) reports no failing checks"
                : "game-dev \(report.version) reports at least one failing check"
        case .failed:
            "The check could not complete"
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.health {
        case .idle, .checking:
            placeholder
        case let .failed(message):
            failure(message)
        case let .ready(report):
            report.checks.isEmpty ? AnyView(placeholder) : AnyView(checks(report))
        }
    }

    private var placeholder: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(0..<4, id: \.self) { _ in
                RoundedRectangle(cornerRadius: AnvilSurface.controlRadius, style: .continuous)
                    .fill(.quaternary)
                    .frame(height: 54)
            }
        }
        .redacted(reason: .placeholder)
    }

    private func failure(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("The check could not complete", systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.orange)
            Text(message)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .anvilPanel(tint: .orange)
    }

    private func checks(_ report: DoctorReport) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            summary(report)

            VStack(spacing: 8) {
                ForEach(report.checks) { check in
                    CheckRow(check: check)
                }
            }

            if !report.missingExpectedCheckIDs.isEmpty {
                Label(
                    "The runtime did not report: \(report.missingExpectedCheckIDs.joined(separator: ", "))",
                    systemImage: "questionmark.circle"
                )
                .font(.callout)
                .foregroundStyle(.secondary)
            }

            if let ceiling = report.evidenceCeiling {
                EvidenceCeilingNote(text: ceiling)
            }
        }
    }

    private func summary(_ report: DoctorReport) -> some View {
        let counts = Dictionary(grouping: report.checks, by: \.status).mapValues(\.count)
        return HStack(spacing: 8) {
            ForEach(DoctorReport.CheckStatus.allCases, id: \.self) { status in
                if let count = counts[status], count > 0 {
                    HStack(spacing: 6) {
                        Image(systemName: status.symbolName)
                            .foregroundStyle(status.tint)
                        Text("\(count) \(status.label)")
                            .font(.callout.weight(.medium))
                            .contentTransition(.numericText())
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .anvilChip(tint: status.tint)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

private struct CheckRow: View {
    let check: DoctorReport.Check
    @State private var isExpanded = false

    private var evidenceKeys: [String] { check.evidence.keys.sorted() }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: check.status.symbolName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(check.status.tint)
                    .frame(width: 20)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 3) {
                    Text(check.id)
                        .font(.system(.body, design: .monospaced, weight: .medium))
                    Text(check.detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 8)

                if !evidenceKeys.isEmpty {
                    Button {
                        withAnimation(.snappy(duration: 0.2)) { isExpanded.toggle() }
                    } label: {
                        Image(systemName: "chevron.right")
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(isExpanded ? "Hide evidence" : "Show evidence")
                }
            }
            .padding(14)

            if isExpanded, !evidenceKeys.isEmpty {
                Divider().padding(.horizontal, 14)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(evidenceKeys, id: \.self) { key in
                        LabeledContent(key) {
                            Text(check.evidence[key]?.displayText ?? "—")
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .lineLimit(3)
                                .truncationMode(.middle)
                        }
                    }
                }
                .padding(14)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .anvilPanel(radius: AnvilSurface.controlRadius)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(check.id): \(check.status.label). \(check.detail)")
    }
}

/// Renders the toolchain's own statement of what a result does not prove.
///
/// The CLI attaches an `evidenceCeiling` to results precisely so a caller cannot mistake
/// a report for a stronger claim than it is. Surfacing it verbatim is the GUI's side of
/// that bargain.
struct EvidenceCeilingNote: View {
    let text: String

    var body: some View {
        Label {
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "checkmark.shield")
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .anvilPanel(radius: AnvilSurface.controlRadius)
    }
}

private extension DoctorReport.CheckStatus {
    var label: String {
        switch self {
        case .pass: "passing"
        case .warning: "warning"
        case .fail: "failing"
        case .unavailable: "unavailable"
        }
    }

    var symbolName: String {
        switch self {
        case .pass: "checkmark.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .fail: "xmark.octagon.fill"
        case .unavailable: "minus.circle"
        }
    }

    var tint: Color {
        switch self {
        case .pass: .green
        case .warning: .orange
        case .fail: .red
        case .unavailable: .secondary
        }
    }
}

private extension AnvilModel.HealthState {
    var isChecking: Bool {
        if case .checking = self { true } else { false }
    }
}
