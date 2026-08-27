import SwiftUI

struct ResultInspectorView: View {
    let latestResult: CLIResultEnvelope?
    let history: [CLIResultEnvelope]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Result Inspector")
                    .font(.title3.weight(.semibold))

                if let latestResult {
                    ResultSummaryView(result: latestResult)
                } else {
                    ContentUnavailableView(
                        "No result selected",
                        systemImage: "doc.text.magnifyingglass",
                        description: Text("Run or inspect a workflow to see its structured result and receipt.")
                    )
                    .frame(minHeight: 220)
                }

                Divider()

                Text("Recent activity")
                    .font(.headline)

                if history.isEmpty {
                    Text("Completed operations will appear here without exposing saved credential values.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(history.prefix(8))) { result in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(result.command)
                                    .font(.system(.caption, design: .monospaced, weight: .medium))
                                    .lineLimit(2)
                                HStack {
                                    StatusPill(status: result.status.rawValue)
                                    Spacer()
                                    Text(result.timestamp, style: .relative)
                                }
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 9)

                            if result.id != history.prefix(8).last?.id {
                                Divider()
                            }
                        }
                    }
                }
            }
            .padding(16)
        }
        .inspectorColumnWidth(min: 300, ideal: 360, max: 480)
    }
}
