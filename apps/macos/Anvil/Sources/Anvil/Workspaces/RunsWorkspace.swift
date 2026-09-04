import AnvilKit
import SwiftUI

/// Every run and durable job, live and historical.
///
/// The previous app had no surface for this at all: a paid provider job interrupted
/// mid-flight was unrecoverable from the GUI. Runs that stopped short and hold a durable
/// job id are offered for resume here.
struct RunsWorkspace: View {
    @Environment(\.anvilFlattensSurfaces) private var isFlattened
    let runs: [Run]
    let unreadableRunIDs: [String]
    @Binding var selection: RunID?

    private var needsAttention: [Run] { runs.filter { $0.state == .awaitingApproval } }
    private var active: [Run] { runs.filter(\.state.isActive) }
    private var settled: [Run] { runs.filter { $0.state.isTerminal && $0.state != .awaitingApproval } }

    var body: some View {
        ScrollView {
            GlassEffectContainer(spacing: Anvil.Space.regular) {
                content
            }
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(.background)
        .navigationTitle(WorkspaceRoute.runs.title)
    }

    /// The workspace without its scrolling chrome.
    ///
    /// Split out because `ImageRenderer` renders nothing inside a `ScrollView`, so the
    /// preview renderer draws this directly. It is the same view either way; only the
    /// container differs.
    @ViewBuilder
    var content: some View {
        VStack(alignment: .leading, spacing: Anvil.Space.roomy) {
                    WorkspaceHeading(
                        title: WorkspaceRoute.runs.title,
                        subtitle: WorkspaceRoute.runs.subtitle,
                        symbolName: WorkspaceRoute.runs.symbolName
                    )

                    if !unreadableRunIDs.isEmpty { unreadableNotice }

                    if runs.isEmpty {
                        Panel {
                            NothingHere(
                                title: "No runs yet",
                                message: "Anything you run from another workspace appears here, and stays after you quit.",
                                symbolName: "list.bullet.rectangle"
                            )
                        }
                    } else {
                        group("Needs approval", needsAttention, emptyMessage: nil)
                        group("In progress", active, emptyMessage: nil)
                        group("History", settled, emptyMessage: "Nothing has finished yet.")
                    }
                }
        .padding(Anvil.Space.roomy)
        .frame(maxWidth: Anvil.readableWidth, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .top)
    }

    /// A record that would not decode could be a paid job still in flight, so it is
    /// reported rather than quietly omitted from the list.
    private var unreadableNotice: some View {
        Panel("Unreadable run records", symbolName: "exclamationmark.triangle.fill") {
            Text(
                """
                \(unreadableRunIDs.count) record\(unreadableRunIDs.count == 1 ? "" : "s") \
                could not be read and \(unreadableRunIDs.count == 1 ? "is" : "are") not listed below. \
                One of them may be a paid job that is still running.
                """
            )
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            Text(unreadableRunIDs.joined(separator: "\n"))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func group(_ title: String, _ items: [Run], emptyMessage: String?) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: Anvil.Space.snug) {
                HStack(spacing: Anvil.Space.tight) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    Text("\(items.count)")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                }
                ForEach(items) { run in
                    RunRow(run: run, isSelected: run.id == selection)
                        .onTapGesture { selection = run.id }
                }
            }
        }
    }
}

private struct RunRow: View {
    @Environment(\.anvilFlattensSurfaces) private var isFlattened
    let run: Run
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Anvil.Space.snug) {
            HStack(alignment: .firstTextBaseline, spacing: Anvil.Space.snug) {
                StatusChip(
                    label: run.state.label,
                    symbolName: run.state.symbolName,
                    tint: run.state.tint,
                    isProminent: run.state == .awaitingApproval
                )
                Text(run.title)
                    .font(.body.weight(.medium))
                Text(run.commandID)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer(minLength: Anvil.Space.snug)
                if let duration = run.duration {
                    Text(formatted(duration))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            if let activity = run.latestActivity, run.state.isActive {
                HStack(spacing: Anvil.Space.tight) {
                    ActivityIndicator()
                    Text(activity)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            if case let .failed(message) = run.state {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: Anvil.Space.snug) {
                if let jobID = run.durableJobID {
                    Tag(symbolName: "arrow.trianglehead.clockwise", text: jobID)
                }
                ForEach(run.artifacts.prefix(3)) { artifact in
                    Tag(symbolName: "doc", text: artifact.kind)
                }
                if run.artifacts.count > 3 {
                    Text("+\(run.artifacts.count - 3)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let approval = run.approval {
                    Tag(
                        symbolName: "checkmark.shield",
                        text: "approved to \(money(approval.ceilingCents))"
                    )
                }
                Spacer(minLength: 0)
                if run.isResumable {
                    Button("Resume") {}
                        .anvilGlassButton(isFlattened: isFlattened)
                        .controlSize(.small)
                }
            }
        }
        .padding(Anvil.Space.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .anvilPanel(radius: Anvil.Radius.control)
        .overlay {
            if isSelected {
                RoundedRectangle(cornerRadius: Anvil.Radius.control, style: .continuous)
                    .strokeBorder(Anvil.Status.active, lineWidth: 2)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func money(_ cents: Int) -> String {
        "$\(cents / 100).\(String(format: "%02d", cents % 100))"
    }

    private func formatted(_ duration: Duration) -> String {
        let seconds = Double(duration.components.seconds)
        if seconds < 60 { return String(format: "%.1fs", seconds) }
        if seconds < 3_600 { return "\(Int(seconds) / 60)m \(Int(seconds) % 60)s" }
        return "\(Int(seconds) / 3_600)h \(Int(seconds) % 3_600 / 60)m"
    }
}

private struct Tag: View {
    @Environment(\.anvilFlattensSurfaces) private var isFlattened
    let symbolName: String
    let text: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: symbolName)
            Text(text)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, Anvil.Space.tight)
        .padding(.vertical, 3)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}
