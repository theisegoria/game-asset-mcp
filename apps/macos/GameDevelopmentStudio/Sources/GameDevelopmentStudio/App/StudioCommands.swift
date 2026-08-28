import SwiftUI

struct StudioCommandActions {
    var runDoctor: () -> Void
    var refreshCapabilities: () -> Void
    var refreshLibrary: () -> Void
    var focusSearch: () -> Void
    var toggleInspector: () -> Void
    var cancelOperation: () -> Void
    var isOperationRunning: Bool
}

private struct StudioCommandActionsKey: FocusedValueKey {
    typealias Value = StudioCommandActions
}

extension FocusedValues {
    var studioCommandActions: StudioCommandActions? {
        get { self[StudioCommandActionsKey.self] }
        set { self[StudioCommandActionsKey.self] = newValue }
    }
}

struct StudioCommands: Commands {
    @FocusedValue(\.studioCommandActions) private var actions

    var body: some Commands {
        CommandMenu("Studio") {
            Button("Run Doctor") {
                actions?.runDoctor()
            }
            .keyboardShortcut("d", modifiers: [.command, .shift])
            .disabled(actions == nil || actions?.isOperationRunning == true)

            Button("Refresh Capabilities") {
                actions?.refreshCapabilities()
            }
            .keyboardShortcut("k", modifiers: [.command, .shift])
            .disabled(actions == nil || actions?.isOperationRunning == true)

            Button("Refresh Library") {
                actions?.refreshLibrary()
            }
            .keyboardShortcut("r", modifiers: [.command])
            .disabled(actions == nil || actions?.isOperationRunning == true)

            Divider()

            Button("Search") {
                actions?.focusSearch()
            }
            .keyboardShortcut("f", modifiers: [.command])
            .disabled(actions == nil || actions?.isOperationRunning == true)

            Button("Toggle Inspector") {
                actions?.toggleInspector()
            }
            .keyboardShortcut("i", modifiers: [.command, .option])
            .disabled(actions == nil)

            Divider()

            Button("Cancel Current Operation", role: .destructive) {
                actions?.cancelOperation()
            }
            .keyboardShortcut(".", modifiers: [.command])
            .disabled(actions?.isOperationRunning != true)
        }
    }
}
