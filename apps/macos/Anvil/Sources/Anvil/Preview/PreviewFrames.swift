import AnvilKit
import AppKit
import CoreGraphics
import Foundation

/// Synthesises small capture frames for preview renders.
///
/// Deterministic, so a design change is compared against the same pixels every time.
/// The scene is deliberately simple — three coloured boxes on a gradient — because the
/// point is to see the viewer's chrome around a picture, not to admire the picture.
@MainActor
enum PreviewFrames {
    static let size = CGSize(width: 480, height: 270)

    static func baseline() -> DecodedCapture? { render(shift: 0, missingBox: false, heat: false) }
    static func candidate() -> DecodedCapture? { render(shift: 22, missingBox: true, heat: false) }
    static func heatmap() -> DecodedCapture? { render(shift: 22, missingBox: true, heat: true) }

    private static func render(shift: CGFloat, missingBox: Bool, heat: Bool) -> DecodedCapture? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(
                  data: nil, width: Int(size.width), height: Int(size.height),
                  bitsPerComponent: 8, bytesPerRow: 0, space: space,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              )
        else { return nil }

        let rect = CGRect(origin: .zero, size: size)
        if heat {
            ctx.setFillColor(CGColor(gray: 0.08, alpha: 1))
            ctx.fill(rect)
            // Difference concentrated where the middle box moved and where one vanished.
            let hot = CGGradient(colorsSpace: space, colors: [
                CGColor(srgbRed: 1, green: 0.35, blue: 0.1, alpha: 1),
                CGColor(srgbRed: 1, green: 0.35, blue: 0.1, alpha: 0)
            ] as CFArray, locations: [0, 1])!
            ctx.drawRadialGradient(hot, startCenter: CGPoint(x: 250, y: 140), startRadius: 0,
                                   endCenter: CGPoint(x: 250, y: 140), endRadius: 70, options: [])
            ctx.setFillColor(CGColor(srgbRed: 1, green: 0.85, blue: 0.2, alpha: 0.9))
            ctx.fill(CGRect(x: 340, y: 60, width: 80, height: 80))
            return finish(ctx)
        }

        let sky = CGGradient(colorsSpace: space, colors: [
            CGColor(srgbRed: 0.16, green: 0.20, blue: 0.30, alpha: 1),
            CGColor(srgbRed: 0.05, green: 0.06, blue: 0.10, alpha: 1)
        ] as CFArray, locations: [0, 1])!
        ctx.drawLinearGradient(sky, start: CGPoint(x: 0, y: size.height), end: .zero, options: [])

        ctx.setFillColor(CGColor(srgbRed: 0.35, green: 0.55, blue: 0.85, alpha: 1))
        ctx.fill(CGRect(x: 60, y: 90, width: 90, height: 90))
        ctx.setFillColor(CGColor(srgbRed: 0.85, green: 0.45, blue: 0.25, alpha: 1))
        ctx.fill(CGRect(x: 200 + shift, y: 100, width: 100, height: 80))
        if !missingBox {
            ctx.setFillColor(CGColor(srgbRed: 0.5, green: 0.8, blue: 0.4, alpha: 1))
            ctx.fill(CGRect(x: 340, y: 60, width: 80, height: 80))
        }
        return finish(ctx)
    }

    private static func finish(_ ctx: CGContext) -> DecodedCapture? {
        guard let image = ctx.makeImage() else { return nil }
        return DecodedCapture(image: image, bitsPerComponent: 8, width: image.width, height: image.height)
    }
}
