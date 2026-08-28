import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        TabView {
            GeneralSettingsPane()
                .environment(model)
                .tabItem {
                    Label("General", systemImage: "gearshape")
                }

            CredentialSettingsPane()
                .environment(model)
                .tabItem {
                    Label("Credentials", systemImage: "key")
                }
        }
        .frame(width: 620, height: 440)
        .scenePadding()
    }
}

private struct GeneralSettingsPane: View {
    @Environment(AppModel.self) private var model
    @AppStorage(AppearancePreference.storageKey)
    private var appearanceRawValue = AppearancePreference.defaultValue.rawValue

    var body: some View {
        @Bindable var model = model

        Form {
            Section("Appearance") {
                Picker("Appearance", selection: $appearanceRawValue) {
                    ForEach(AppearancePreference.allCases) { appearance in
                        Text(appearance.title)
                            .tag(appearance.rawValue)
                    }
                }
                .accessibilityHint("Choose Dark, System, or Light appearance for the studio and settings windows")
            }

            Section("Command-line tool") {
                TextField("CLI executable", text: $model.cliExecutable)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Game development CLI executable")

                Text("Use an absolute path or an executable name available in the app's launch environment.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Output workspace") {
                TextField("Output directory", text: $model.outputDirectory)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Output directory")

                Text("Jobs, canonical packages, capture bundles, comparisons, and receipts remain in this local workspace.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Environment check") {
                HStack {
                    Button("Refresh Capabilities") {
                        Task { await model.refreshCapabilities() }
                    }

                    Button("Run Doctor") {
                        Task { await model.runDoctor() }
                    }

                    Spacer()

                    if model.executionState.isRunning {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel("Environment check in progress")
                    }
                }
                .disabled(model.executionState.isRunning)

                if let error = model.executionState.errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .textSelection(.enabled)
                }
            }
        }
        .formStyle(.grouped)
        .accessibilityElement(children: .contain)
    }
}

private struct CredentialSettingsPane: View {
    @Environment(AppModel.self) private var model

    @State private var selectedProvider: CredentialProvider?
    @State private var credentialDraft = ""
    @State private var isSaving = false
    @State private var pendingDeletion: CredentialProvider?

    var body: some View {
        Form {
            Section("Provider") {
                Picker("Provider", selection: $selectedProvider) {
                    Text("Choose a provider").tag(nil as CredentialProvider?)
                    ForEach(CredentialProvider.allCases) { provider in
                        Label(provider.displayName, systemImage: provider.systemImage)
                            .tag(Optional(provider))
                    }
                }
                .onChange(of: selectedProvider) { _, _ in
                    credentialDraft = ""
                }

                if let selectedProvider {
                    HStack {
                        Label(
                            model.credentialState(for: selectedProvider).isConfigured ? "Configured" : "Not configured",
                            systemImage: model.credentialState(for: selectedProvider).isConfigured
                                ? "checkmark.circle.fill"
                                : "circle.dashed"
                        )
                        .foregroundStyle(
                            model.credentialState(for: selectedProvider).isConfigured ? .green : .secondary
                        )

                        Spacer()

                        if model.credentialState(for: selectedProvider).isConfigured {
                            Button("Delete…", role: .destructive) {
                                pendingDeletion = selectedProvider
                            }
                            .disabled(isSaving || model.executionState.isRunning)
                            .accessibilityLabel("Delete saved \(selectedProvider.displayName) credential")
                        }
                    }
                }
            }

            Section("Keychain credential") {
                    SecureField("Enter a new credential", text: $credentialDraft)
                        .textContentType(.password)
                        .privacySensitive()
                        .disabled(selectedProvider == nil || isSaving || model.executionState.isRunning)
                        .accessibilityHint("Saved values are never read back into this field")

                HStack {
                    Text("The app can replace or delete a saved value, but never reveals it.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Spacer()

                    Button {
                        saveCredential()
                    } label: {
                        if isSaving {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityLabel("Saving credential")
                        } else {
                            Text("Save to Keychain")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        selectedProvider == nil
                            || credentialDraft.isEmpty
                            || isSaving
                            || model.executionState.isRunning
                    )
                }
            }

            Section("Security boundary") {
                Text("Credentials are passed through the injected model to Keychain storage. They are never shown in results, copied into request files, or accepted as command arguments.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .task {
            await model.refreshCredentialStates()
            if selectedProvider == nil {
                selectedProvider = CredentialProvider.allCases.first
            }
        }
        .alert(
            "Delete saved credential?",
            isPresented: Binding(
                get: { pendingDeletion != nil },
                set: { if !$0 { pendingDeletion = nil } }
            ),
            presenting: pendingDeletion
        ) { provider in
            Button("Delete", role: .destructive) {
                deleteCredential(provider)
            }
            Button("Cancel", role: .cancel) {
                pendingDeletion = nil
            }
        } message: { provider in
            Text("This removes the saved \(provider.displayName) credential from Keychain. The value cannot be recovered from the app.")
        }
    }

    private func saveCredential() {
        guard let selectedProvider, !credentialDraft.isEmpty else { return }
        let value = credentialDraft
        credentialDraft = ""
        isSaving = true

        Task { @MainActor in
            await model.saveCredential(value, for: selectedProvider)
            isSaving = false
        }
    }

    private func deleteCredential(_ provider: CredentialProvider) {
        pendingDeletion = nil
        isSaving = true

        Task { @MainActor in
            await model.deleteCredential(for: provider)
            credentialDraft = ""
            isSaving = false
        }
    }
}
