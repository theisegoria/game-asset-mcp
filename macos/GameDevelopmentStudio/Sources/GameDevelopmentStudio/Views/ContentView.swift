import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @SceneStorage("studio.inspector.visible") private var isInspectorPresented = true
    @State private var splitVisibility = NavigationSplitViewVisibility.all
    @FocusState private var isSearchFocused: Bool

    var body: some View {
        @Bindable var model = model

        NavigationSplitView(columnVisibility: $splitVisibility) {
            WorkspaceSidebarView(
                selection: $model.selectedWorkspace,
                executionState: model.executionState
            )
            .navigationSplitViewColumnWidth(min: 220, ideal: 250, max: 310)
        } detail: {
            WorkspaceDetailView(section: model.selectedWorkspace)
        }
        .navigationSplitViewStyle(.balanced)
        .searchable(
            text: $model.searchText,
            placement: .toolbar,
            prompt: "Search packages and receipts"
        )
        .searchFocused($isSearchFocused)
        .onSubmit(of: .search) {
            guard !model.executionState.isRunning else { return }
            Task { await model.refreshCatalog(query: model.searchText) }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await model.runDoctor() }
                } label: {
                    Label("Run Doctor", systemImage: "stethoscope")
                }
                .help("Check the local CLI and toolchain")
                .disabled(model.executionState.isRunning)

                if model.executionState.isRunning {
                    Button(role: .destructive) {
                        model.cancelCurrentOperation()
                    } label: {
                        Label("Cancel Operation", systemImage: "stop.circle")
                    }
                    .help("Cancel the current operation")
                }

                Button {
                    isInspectorPresented.toggle()
                } label: {
                    Label("Inspector", systemImage: "sidebar.trailing")
                }
                .help(isInspectorPresented ? "Hide result inspector" : "Show result inspector")
                .accessibilityLabel(isInspectorPresented ? "Hide result inspector" : "Show result inspector")
            }
        }
        .inspector(isPresented: $isInspectorPresented) {
            ResultInspectorView(
                latestResult: model.latestResult,
                history: model.history
            )
        }
        .focusedSceneValue(
            \.studioCommandActions,
            StudioCommandActions(
                runDoctor: { Task { await model.runDoctor() } },
                refreshCapabilities: { Task { await model.refreshCapabilities() } },
                refreshLibrary: { Task { await model.refreshCatalog(query: model.searchText) } },
                focusSearch: {
                    guard !model.executionState.isRunning else { return }
                    isSearchFocused = true
                },
                toggleInspector: { isInspectorPresented.toggle() },
                cancelOperation: model.cancelCurrentOperation,
                isOperationRunning: model.executionState.isRunning
            )
        )
        .task {
            await model.refreshCredentialStates()
        }
    }
}
