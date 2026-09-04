import AppKit
import SwiftUI

/// Process entry point.
///
/// Splits the preview render out of the app's own launch: rendering needs a live
/// `NSApplication` and a spinning run loop for SwiftUI to lay out, but must not open the
/// real window or restore state.
@main
enum AnvilMain {
    static func main() {
        if let directory = PreviewRenderer.requestedOutputDirectory() {
            let application = NSApplication.shared
            // No Dock icon and no activation: this is a build-time tool, not a session.
            application.setActivationPolicy(.prohibited)
            application.finishLaunching()
            do {
                try PreviewRenderer.render(to: directory, scenes: PreviewScenes.all)
                exit(EXIT_SUCCESS)
            } catch {
                FileHandle.standardError.write(Data("\(error)\n".utf8))
                exit(EXIT_FAILURE)
            }
        }
        AnvilApp.main()
    }
}
