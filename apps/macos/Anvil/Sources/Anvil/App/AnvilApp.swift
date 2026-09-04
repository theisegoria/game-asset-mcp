import SwiftUI

@main
struct AnvilApp: App {
    @State private var model = AnvilModel()

    var body: some Scene {
        WindowGroup("Anvil", id: "anvil") {
            HealthWorkspace()
                .environment(model)
                .frame(minWidth: 720, minHeight: 520)
        }
        .defaultSize(width: 1_040, height: 760)
    }
}
