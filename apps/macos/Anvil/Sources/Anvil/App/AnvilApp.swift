import AnvilKit
import SwiftUI

struct AnvilApp: App {
    @State private var model = AnvilModel()

    var body: some Scene {
        WindowGroup("Anvil", id: "anvil") {
            ContentView()
                .environment(model)
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1_280, height: 860)
    }
}
