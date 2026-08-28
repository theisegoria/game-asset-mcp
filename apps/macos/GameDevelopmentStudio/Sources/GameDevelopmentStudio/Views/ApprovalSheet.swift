import SwiftUI

struct ApprovalSheet: View {
    @Environment(\.dismiss) private var dismiss

    let request: ApprovalRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.orange)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 5) {
                    Text(request.title)
                        .font(.title2.weight(.semibold))
                    Text(request.summary)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                ForEach(request.authorities) { authority in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: authority.systemImage)
                            .frame(width: 20)
                            .foregroundStyle(.orange)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(authority.title)
                                .font(.headline)
                            Text(authority.explanation)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .padding(14)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

            if !request.details.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    Text("This invocation")
                        .font(.headline)
                    ForEach(request.details, id: \.self) { detail in
                        Label(detail, systemImage: "circle.fill")
                            .font(.callout)
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Text("Approval applies once to the values shown here. It is not saved as standing permission.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            HStack {
                Spacer()

                Button("Cancel") {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)

                Button {
                    confirm()
                } label: {
                    Text(request.confirmationTitle)
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 560)
    }

    private func confirm() {
        let action = request.action
        dismiss()

        Task { @MainActor in
            await action()
        }
    }
}
