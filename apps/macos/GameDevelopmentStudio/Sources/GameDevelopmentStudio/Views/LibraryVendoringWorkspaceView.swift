import SwiftUI

struct LibraryVendoringWorkspaceView: View {
    @Environment(AppModel.self) private var model

    @State private var packageReference = ""
    @State private var projectPath = ""
    @State private var destination = "Assets/Vendor"
    @State private var plannedSignature: String?
    @State private var approvalRequest: ApprovalRequest?

    var body: some View {
        @Bindable var model = model

        WorkspaceScaffold(section: .library) {
            MaterialCard(title: "Package library", systemImage: "books.vertical") {
                Text("Search the derived catalogue, then verify the canonical package and its license before project admission.")
                    .foregroundStyle(.secondary)

                HStack(spacing: 10) {
                    TextField("Search packages", text: $model.searchText)
                        .textFieldStyle(.roundedBorder)
                        .disabled(model.executionState.isRunning)
                        .onSubmit {
                            guard !model.executionState.isRunning else { return }
                            Task { await model.refreshCatalog(query: model.searchText) }
                        }

                    Button("Refresh") {
                        Task { await model.refreshCatalog(query: model.searchText) }
                    }
                    .disabled(model.executionState.isRunning)
                }
            }

            MaterialCard(title: "Vendor into a project", systemImage: "arrow.down.doc") {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 12) {
                    GridRow {
                        Text("Package")
                        TextField("Package ID or canonical path", text: $packageReference)
                    }

                    GridRow {
                        Text("Project")
                        TextField("/path/to/game-project", text: $projectPath)
                    }

                    GridRow {
                        Text("Destination")
                        TextField("Project-relative directory", text: $destination)
                    }
                }
                .textFieldStyle(.roundedBorder)

                FormActions {
                    Button("Plan Admission") {
                        planAdmission()
                    }
                    .disabled(!canVendor || model.executionState.isRunning)

                    Button("Admit Package…") {
                        prepareAdmissionApproval()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!hasCurrentPlan || model.executionState.isRunning)
                    .accessibilityHint("Requires a current dry-run plan for these exact fields")
                }

                if canVendor && !hasCurrentPlan {
                    Label("Run a dry-run plan after every field change before admission can be approved.", systemImage: "info.circle")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                EvidenceNote(text: "Vendoring proves the copied package roster and receipt. It does not prove engine import, runtime rendering, target-GPU behavior, or artistic acceptance.")
            }

            WorkspaceResultCard(
                result: model.latestResult,
                emptyTitle: "Library is ready",
                emptyDescription: "Search the catalogue or plan a project admission. No project files are written by a plan."
            )
        }
        .onChange(of: vendorSignature) { _, _ in
            plannedSignature = nil
        }
        .sheet(item: $approvalRequest) { request in
            ApprovalSheet(request: request)
        }
    }

    private var vendorSignature: String {
        [packageReference, projectPath, destination].joined(separator: "\u{1F}")
    }

    private var canVendor: Bool {
        !packageReference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !projectPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !destination.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var hasCurrentPlan: Bool {
        canVendor && plannedSignature == vendorSignature
    }

    private func planAdmission() {
        let reference = packageReference
        let project = projectPath
        let selectedDestination = destination
        let signature = vendorSignature
        let previousResultID = model.latestResult?.id

        Task { @MainActor in
            await model.vendorPackage(
                reference: reference,
                project: project,
                destination: selectedDestination,
                confirmed: false
            )
            if !model.executionState.isRunning,
               model.executionState.errorMessage == nil,
               model.latestResult?.ok == true,
               model.latestResult?.id != previousResultID {
                plannedSignature = signature
            }
        }
    }

    private func prepareAdmissionApproval() {
        guard hasCurrentPlan else { return }
        let reference = packageReference
        let project = projectPath
        let selectedDestination = destination

        approvalRequest = ApprovalRequest(
            title: "Approve project admission",
            summary: "Copy one verified canonical package into the selected game project.",
            details: [
                "Package: \(reference)",
                "Project: \(project)",
                "Destination: \(selectedDestination)"
            ],
            authorities: [.processExecution],
            confirmationTitle: "Admit Package"
        ) {
            await model.vendorPackage(
                reference: reference,
                project: project,
                destination: selectedDestination,
                confirmed: true
            )
        }
    }
}
