import SwiftUI

@main
struct GameDevelopmentStudioApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup("Game Development Studio", id: "studio") {
            ContentView()
                .environment(model)
                .frame(minWidth: 980, minHeight: 640)
        }
        .defaultSize(width: 1_340, height: 860)
        .commands {
            StudioCommands()
        }

        Settings {
            SettingsView()
                .environment(model)
        }
    }
}
