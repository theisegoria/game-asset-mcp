import SwiftUI

@main
struct GameDevelopmentStudioApp: App {
    @State private var model = AppModel()
    @AppStorage(AppearancePreference.storageKey)
    private var appearanceRawValue = AppearancePreference.defaultValue.rawValue

    private var preferredColorScheme: ColorScheme? {
        switch AppearancePreference(rawValue: appearanceRawValue) ?? .defaultValue {
        case .dark:
            .dark
        case .system:
            nil
        case .light:
            .light
        }
    }

    var body: some Scene {
        WindowGroup("Game Development Studio", id: "studio") {
            ContentView()
                .environment(model)
                .frame(minWidth: 980, minHeight: 640)
                .preferredColorScheme(preferredColorScheme)
        }
        .defaultSize(width: 1_340, height: 860)
        .commands {
            StudioCommands()
        }

        Settings {
            SettingsView()
                .environment(model)
                .preferredColorScheme(preferredColorScheme)
        }
    }
}
