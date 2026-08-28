import SwiftUI

struct ProductionWorkspaceView: View {
    @Environment(AppModel.self) private var model

    @State private var provider: CredentialProvider?
    @State private var operation = "generate"
    @State private var prompt = ""
    @State private var generatedName = ""
    @State private var spendLimitCents = 100

    @State private var assetPath = ""
    @State private var packageName = ""
    @State private var packageVersion = "1.0.0"
    @State private var packageLicense = ""
    @State private var approvalRequest: ApprovalRequest?

    var body: some View {
        WorkspaceScaffold(section: .production) {
            MaterialCard(title: "Environment", systemImage: "wrench.and.screwdriver") {
                Text("Confirm the local CLI and optional provider tools before starting production work.")
                    .foregroundStyle(.secondary)

                FormActions {
                    Button("Refresh Capabilities") {
                        Task { await model.refreshCapabilities() }
                    }

                    Button("Run Doctor") {
                        Task { await model.runDoctor() }
                    }
                }
                .disabled(model.executionState.isRunning)
            }

            MaterialCard(title: "Generate with a provider", systemImage: "sparkles") {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 12) {
                    GridRow {
                        Text("Provider")
                        HStack {
                            Picker("Provider", selection: $provider) {
                                Text("Choose a provider").tag(nil as CredentialProvider?)
                                ForEach(CredentialProvider.allCases) { candidate in
                                    Label(candidate.displayName, systemImage: candidate.systemImage)
                                        .tag(Optional(candidate))
                                }
                            }
                            .labelsHidden()

                            if let provider {
                                let isConfigured = model.credentialState(for: provider).isConfigured
                                Label(
                                    isConfigured ? "Configured" : "Credential missing",
                                    systemImage: isConfigured ? "checkmark.circle.fill" : "exclamationmark.circle"
                                )
                                .font(.caption)
                                .foregroundStyle(isConfigured ? Color.green : Color.orange)
                            }
                        }
                    }

                    GridRow {
                        Text("Operation")
                        Picker("Operation", selection: $operation) {
                            ForEach(availableOperations, id: \.self) { candidate in
                                Text(candidate).tag(candidate)
                            }
                        }
                        .labelsHidden()
                    }

                    GridRow {
                        Text("Asset name")
                        TextField("harbor-beacon", text: $generatedName)
                    }

                    GridRow(alignment: .top) {
                        Text("Prompt")
                        TextField("Describe the asset and its production constraints", text: $prompt, axis: .vertical)
                            .lineLimit(3...7)
                    }

                    GridRow {
                        Text("Spend ceiling")
                        HStack {
                            TextField("Cents", value: $spendLimitCents, format: .number)
                                .frame(width: 100)
                            Stepper("", value: $spendLimitCents, in: 1...100_000, step: 25)
                                .labelsHidden()
                            Text("estimated cents")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .textFieldStyle(.roundedBorder)

                FormActions {
                    Button("Review Paid Generation…") {
                        Task { await prepareProviderApproval() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canGenerate || model.executionState.isRunning)
                    .accessibilityHint("Shows the provider and spending authority before submitting")
                }

                EvidenceNote(text: "A provider receipt proves submission and returned bytes only. Validate and package the downloaded asset before calling it game-ready.")
            }

            MaterialCard(title: "Inspect and package", systemImage: "shippingbox") {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 12) {
                    GridRow {
                        Text("Asset path")
                        TextField("/path/to/model.glb", text: $assetPath)
                    }

                    GridRow {
                        Text("Package name")
                        TextField("harbor-beacon", text: $packageName)
                    }

                    GridRow {
                        Text("Version")
                        TextField("1.0.0", text: $packageVersion)
                    }

                    GridRow {
                        Text("License")
                        TextField("SPDX identifier", text: $packageLicense)
                    }
                }
                .textFieldStyle(.roundedBorder)

                FormActions {
                    Button("Inspect") {
                        Task { await model.inspectAsset(path: assetPath) }
                    }
                    .disabled(assetPath.isEmpty || model.executionState.isRunning)

                    Button("Validate") {
                        Task { await model.validateAsset(path: assetPath) }
                    }
                    .disabled(assetPath.isEmpty || model.executionState.isRunning)

                    Button("Build Package…") {
                        Task { await preparePackageApproval() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canBuildPackage || model.executionState.isRunning)
                }

                EvidenceNote(text: "Package creation is a local write. The source remains unchanged, and the resulting receipt should bind hashes, license, validation, and provenance.")
            }

            WorkspaceResultCard(
                result: model.latestResult,
                emptyTitle: "No production result",
                emptyDescription: "Inspect an asset, validate it, or review a generation request to create a structured result."
            )
        }
        .task {
            if provider == nil {
                provider = CredentialProvider.allCases.first
            }
        }
        .onChange(of: provider) { _, _ in
            operation = availableOperations.first ?? "generate"
        }
        .sheet(item: $approvalRequest) { request in
            ApprovalSheet(request: request)
        }
    }

    private var canGenerate: Bool {
        provider != nil
            && !operation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !generatedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && spendLimitCents > 0
    }

    private var canBuildPackage: Bool {
        !assetPath.isEmpty
            && !packageName.isEmpty
            && !packageVersion.isEmpty
            && !packageLicense.isEmpty
    }

    private var availableOperations: [String] {
        switch provider {
        case .tripo:
            ["generate"]
        case .leonardo:
            ["image-generate", "sound-generate"]
        case nil:
            []
        }
    }

    private func prepareProviderApproval() async {
        guard let provider else { return }
        let submittedOperation = operation
        let submittedPrompt = prompt
        let submittedName = generatedName
        let submittedLimit = spendLimitCents
        let submittedOutputDirectory = model.outputDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let identity = await model.executableIdentityForApproval() else { return }

        approvalRequest = ApprovalRequest(
            title: "Approve paid generation",
            summary: "Submit one \(submittedOperation) request to \(provider.displayName).",
            details: [
                "Asset: \(submittedName)",
                "Estimated ceiling: \(submittedLimit) cents",
                "Prompt: \(submittedPrompt)",
                "Official provider host: https://\(provider.officialHostname)",
                "Executable: \(identity.canonicalPath)",
                "Executable SHA-256: \(identity.sha256)",
                "CLI version: \(identity.version)",
                "Result schema: \(identity.resultSchema)",
                "Capabilities schema: \(identity.capabilitiesSchema)",
                "Output workspace: \(submittedOutputDirectory)"
            ],
            authorities: [.providerSpend],
            confirmationTitle: "Approve and Submit"
        ) {
            await model.generateAsset(
                provider: provider,
                operation: submittedOperation,
                prompt: submittedPrompt,
                name: submittedName,
                spendLimitCents: submittedLimit,
                approved: true,
                expectedExecutableIdentity: identity,
                expectedOutputDirectory: submittedOutputDirectory
            )
        }
    }

    private func preparePackageApproval() async {
        let submittedPath = assetPath
        let submittedName = packageName
        let submittedVersion = packageVersion
        let submittedLicense = packageLicense
        let submittedOutputDirectory = model.outputDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let identity = await model.executableIdentityForApproval() else { return }

        approvalRequest = ApprovalRequest(
            title: "Build canonical package",
            summary: "Create a new local package and receipt from the selected asset.",
            details: [
                "Source: \(submittedPath)",
                "Package: \(submittedName) \(submittedVersion)",
                "License: \(submittedLicense)",
                "Executable: \(identity.canonicalPath)",
                "Executable SHA-256: \(identity.sha256)",
                "CLI version: \(identity.version)",
                "Result schema: \(identity.resultSchema)",
                "Capabilities schema: \(identity.capabilitiesSchema)",
                "Output workspace: \(submittedOutputDirectory)"
            ],
            authorities: [.processExecution],
            confirmationTitle: "Build Package"
        ) {
            await model.buildPackage(
                path: submittedPath,
                name: submittedName,
                version: submittedVersion,
                license: submittedLicense,
                confirmed: true,
                expectedExecutableIdentity: identity,
                expectedOutputDirectory: submittedOutputDirectory
            )
        }
    }
}
