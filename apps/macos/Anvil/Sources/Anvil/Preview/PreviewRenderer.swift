import AppKit
import AnvilKit
import SwiftUI

/// Renders workspace views to PNG from an offscreen window.
///
/// Two reasons this exists rather than a screenshot: it needs no screen-capture
/// permission, and it renders a *named state* deterministically, so a design change is
/// compared against the same fixtures every time instead of whatever the app happened to
/// be showing.
///
/// `ImageRenderer` is not usable here. It draws only pure SwiftUI content and emits a
/// yellow "unsupported view" placeholder for anything AppKit-backed — which includes
/// `List`, and therefore the sidebar. Hosting the real view in an offscreen window and
/// caching its display renders the true hierarchy instead.
///
/// Invoked as `Anvil --render-previews <directory>`; renders and exits without showing UI.
@MainActor
enum PreviewRenderer {
    static func requestedOutputDirectory() -> URL? {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--render-previews") else { return nil }
        let path = arguments.count > index + 1 ? arguments[index + 1] : "anvil-previews"
        return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
    }

    struct Scene: Identifiable {
        let id: String
        let width: CGFloat
        let height: CGFloat
        let colorScheme: ColorScheme
        let content: AnyView

        init<V: View>(
            _ id: String,
            width: CGFloat = 1_280,
            height: CGFloat = 860,
            colorScheme: ColorScheme = .dark,
            @ViewBuilder content: () -> V
        ) {
            self.id = id
            self.width = width
            self.height = height
            self.colorScheme = colorScheme
            self.content = AnyView(content())
        }
    }

    static func render(to directory: URL, scenes: [Scene]) throws {
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        for scene in scenes {
            guard let data = png(for: scene) else {
                FileHandle.standardError.write(Data("could not render \(scene.id)\n".utf8))
                continue
            }
            let url = directory.appendingPathComponent("\(scene.id).png")
            try data.write(to: url)
            FileHandle.standardOutput.write(
                Data("wrote \(url.lastPathComponent) (\(data.count) bytes)\n".utf8)
            )
        }
    }

    private static func png(for scene: Scene) -> Data? {
        let host = scene.content
            .environment(\.anvilFlattensSurfaces, true)
            .environment(\.colorScheme, scene.colorScheme)
            .frame(width: scene.width, height: scene.height, alignment: .topLeading)
            // ImageRenderer composites onto transparency, and the window background is
            // part of the design, so paint it explicitly or every render lies about
            // contrast.
            .background(scene.colorScheme == .dark ? Color.black : Color.white)

        let renderer = ImageRenderer(content: host)
        renderer.scale = 2
        renderer.isOpaque = true
        guard let image = renderer.cgImage else { return nil }
        return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    }
}
