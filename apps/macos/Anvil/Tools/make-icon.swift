// Renders the Anvil app icon master at 1024x1024.
// Reproducible: no external assets, no randomness.
// Run via `swift apps/macos/Anvil/Tools/make-icon.swift <out.png>`.
import AppKit
import CoreGraphics
import Foundation

let side = 1024.0
let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AnvilIcon.png"

guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let ctx = CGContext(data: nil, width: Int(side), height: Int(side),
                          bitsPerComponent: 8, bytesPerRow: 0, space: space,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fatalError("could not create bitmap context")
}

ctx.setAllowsAntialiasing(true)
ctx.interpolationQuality = .high

// macOS icon grid: artwork occupies the inner square with a continuous-corner squircle.
let inset = side * 0.088
let rect = CGRect(x: inset, y: inset, width: side - inset * 2, height: side - inset * 2)
let radius = rect.width * 0.2237

func squircle(_ r: CGRect, _ radius: CGFloat) -> CGPath {
    CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

// Background: deep graphite with a warm forge glow rising from the lower third.
ctx.saveGState()
ctx.addPath(squircle(rect, radius))
ctx.clip()

let bg = CGGradient(colorsSpace: space, colors: [
    CGColor(srgbRed: 0.157, green: 0.169, blue: 0.196, alpha: 1),
    CGColor(srgbRed: 0.086, green: 0.094, blue: 0.114, alpha: 1)
] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(bg, start: CGPoint(x: rect.minX, y: rect.maxY),
                       end: CGPoint(x: rect.maxX, y: rect.minY), options: [])

let glow = CGGradient(colorsSpace: space, colors: [
    CGColor(srgbRed: 1.0, green: 0.478, blue: 0.153, alpha: 0.42),
    CGColor(srgbRed: 0.86, green: 0.298, blue: 0.094, alpha: 0.12),
    CGColor(srgbRed: 1.0, green: 0.478, blue: 0.153, alpha: 0.0)
] as CFArray, locations: [0, 0.45, 1])!
ctx.drawRadialGradient(glow,
                       startCenter: CGPoint(x: rect.midX, y: rect.minY + rect.height * 0.13),
                       startRadius: 0,
                       endCenter: CGPoint(x: rect.midX, y: rect.minY + rect.height * 0.13),
                       endRadius: rect.width * 0.42, options: [])

// Anvil silhouette, drawn in the icon's own coordinate space.
let w = rect.width
// Scaled about the silhouette's optical centre so the artwork keeps a margin
// inside the squircle at every icon size.
let formScale = 0.925
func px(_ fx: CGFloat, _ fy: CGFloat) -> CGPoint {
    let sx = 0.5 + (fx - 0.5) * formScale
    let sy = 0.408 + (fy - 0.408) * formScale
    return CGPoint(x: rect.minX + w * sx, y: rect.minY + w * sy)
}

let anvil = CGMutablePath()
anvil.move(to: px(0.088, 0.610))                                  // horn tip
anvil.addCurve(to: px(0.300, 0.688),                              // upper horn sweep
               control1: px(0.170, 0.646), control2: px(0.232, 0.678))
anvil.addLine(to: px(0.836, 0.688))                               // face, out to the heel
anvil.addLine(to: px(0.836, 0.612))                               // heel face
anvil.addLine(to: px(0.760, 0.560))                               // heel undercut
anvil.addLine(to: px(0.636, 0.560))                               // underside of the overhang
anvil.addCurve(to: px(0.590, 0.452),                              // shoulder into the waist
               control1: px(0.602, 0.556), control2: px(0.590, 0.508))
anvil.addLine(to: px(0.578, 0.318))
anvil.addCurve(to: px(0.700, 0.216),                              // flare into the base
               control1: px(0.574, 0.262), control2: px(0.626, 0.228))
anvil.addLine(to: px(0.792, 0.202))
anvil.addLine(to: px(0.792, 0.128))                               // base plinth
anvil.addLine(to: px(0.208, 0.128))
anvil.addLine(to: px(0.208, 0.202))
anvil.addLine(to: px(0.300, 0.216))
anvil.addCurve(to: px(0.422, 0.318),
               control1: px(0.374, 0.228), control2: px(0.426, 0.262))
anvil.addLine(to: px(0.410, 0.452))
anvil.addCurve(to: px(0.364, 0.560),
               control1: px(0.410, 0.508), control2: px(0.398, 0.556))
anvil.addLine(to: px(0.252, 0.560))
anvil.addCurve(to: px(0.088, 0.610),                              // lower horn sweep
               control1: px(0.186, 0.560), control2: px(0.126, 0.580))
anvil.closeSubpath()

// Cast shadow under the anvil.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -w * 0.020), blur: w * 0.055,
              color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.55))
ctx.addPath(anvil)
ctx.setFillColor(CGColor(srgbRed: 0.93, green: 0.94, blue: 0.96, alpha: 1))
ctx.fillPath()
ctx.restoreGState()

// Brushed-steel gradient through the body.
ctx.saveGState()
ctx.addPath(anvil)
ctx.clip()
let steel = CGGradient(colorsSpace: space, colors: [
    CGColor(srgbRed: 0.976, green: 0.980, blue: 0.988, alpha: 1),
    CGColor(srgbRed: 0.784, green: 0.804, blue: 0.839, alpha: 1),
    CGColor(srgbRed: 0.918, green: 0.929, blue: 0.949, alpha: 1),
    CGColor(srgbRed: 0.612, green: 0.639, blue: 0.690, alpha: 1)
] as CFArray, locations: [0, 0.40, 0.68, 1])!
ctx.drawLinearGradient(steel, start: px(0.10, 0.72), end: px(0.86, 0.12),
                       options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])

// Forge light rising from the floor: a vertical ramp clipped to the body, so the
// base reads as hot steel rather than as a glow painted over the silhouette.
let heat = CGGradient(colorsSpace: space, colors: [
    CGColor(srgbRed: 1.0, green: 0.667, blue: 0.376, alpha: 0.95),
    CGColor(srgbRed: 0.988, green: 0.451, blue: 0.157, alpha: 0.62),
    CGColor(srgbRed: 0.902, green: 0.318, blue: 0.106, alpha: 0.0)
] as CFArray, locations: [0, 0.38, 1])!
ctx.drawLinearGradient(heat, start: px(0.5, 0.118), end: px(0.5, 0.360),
                       options: [.drawsBeforeStartLocation])
ctx.restoreGState()

// Bright top edge along the working face.
ctx.saveGState()
ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.9))
ctx.setLineWidth(w * 0.009)
ctx.setLineCap(.round)
ctx.move(to: px(0.312, 0.6845))
ctx.addLine(to: px(0.828, 0.6845))
ctx.strokePath()
ctx.restoreGState()

ctx.restoreGState()

// Outer hairline so the icon holds an edge on light desktops.
ctx.addPath(squircle(rect.insetBy(dx: 0.5, dy: 0.5), radius))
ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.10))
ctx.setLineWidth(2)
ctx.strokePath()

guard let image = ctx.makeImage() else { fatalError("could not render icon") }
let rep = NSBitmapImageRep(cgImage: image)
guard let data = rep.representation(using: .png, properties: [:]) else { fatalError("could not encode PNG") }
try data.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath) (\(data.count) bytes)")
