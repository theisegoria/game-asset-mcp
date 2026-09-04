import AnvilKit
import CoreGraphics
import ImageIO
import SwiftUI

/// A decoded capture attachment.
///
/// Decoded with ImageIO at native bit depth, so a 16-bit PNG keeps its precision for
/// display rather than being folded to 8 bits on the way in. Display precision is not
/// measurement precision — a probe value still comes from the float buffer, never from
/// this image — but there is no reason for the picture to be worse than the file.
struct DecodedCapture: Sendable {
    let image: CGImage
    let bitsPerComponent: Int
    let width: Int
    let height: Int

    static func load(_ url: URL) -> DecodedCapture? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [
                  // Ask for the native format rather than a display-friendly 8-bit one.
                  kCGImageSourceShouldCache: false
              ] as CFDictionary)
        else { return nil }
        return DecodedCapture(
            image: image,
            bitsPerComponent: image.bitsPerComponent,
            width: image.width,
            height: image.height
        )
    }
}

/// Displays one capture attachment.
///
/// The initializer takes an ``EvidenceCeiling`` and there is no other way to construct
/// this view. That is the point: an image cannot reach the screen without the statement
/// of what it does not prove travelling with it. What a convention would eventually
/// lose, the compiler keeps.
struct AttachmentImage: View {
    let capture: DecodedCapture?
    let kind: AttachmentKind
    let ceiling: EvidenceCeiling

    init(capture: DecodedCapture?, kind: AttachmentKind, ceiling: EvidenceCeiling) {
        self.capture = capture
        self.kind = kind
        self.ceiling = ceiling
    }

    var body: some View {
        if let capture {
            Image(decorative: capture.image, scale: 1)
                .resizable()
                // Identifier buffers are categorical. Interpolating between two object
                // ids invents a third object that exists in neither frame.
                .interpolation(kind.isSemantic ? .none : .high)
                .aspectRatio(contentMode: .fit)
                .accessibilityLabel("\(kind.label) attachment, \(capture.width) by \(capture.height)")
        } else {
            missing
        }
    }

    private var missing: some View {
        ZStack {
            Rectangle().fill(.quaternary.opacity(0.3))
            VStack(spacing: Anvil.Space.tight) {
                Image(systemName: "photo.badge.exclamationmark")
                    .font(.title2)
                    .foregroundStyle(.tertiary)
                Text("Attachment could not be decoded")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .aspectRatio(16 / 9, contentMode: .fit)
        .accessibilityLabel("\(kind.label) attachment could not be decoded")
    }
}
