import SwiftUI

/// Anvil's surface treatment.
///
/// macOS 26's Liquid Glass APIs are verified present in the MacOSX26.5 SDK
/// (`GlassEffectContainer`, `glassEffect(_:in:)`, `glassEffectID(_:in:)`,
/// `buttonStyle(.glass)`), and are used directly in the running app.
///
/// They cannot be captured offscreen. Glass is a compositor effect, so `ImageRenderer`
/// draws literally nothing for it — measured, not assumed: a probe scored zero ink for
/// `.glassEffect`, `.buttonStyle(.glass)`, `ScrollView` and `List`, against non-zero for
/// text, stacks and materials. So the preview renderer substitutes a flat stand-in with
/// the same geometry, which keeps layout, spacing, hierarchy and colour verifiable even
/// though the material itself is only visible in the real window.
enum AnvilSurface {
    static let panelRadius: CGFloat = 16
    static let controlRadius: CGFloat = 10
}

private struct FlattenSurfacesKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True while rendering design previews, where glass cannot be composited.
    var anvilFlattensSurfaces: Bool {
        get { self[FlattenSurfacesKey.self] }
        set { self[FlattenSurfacesKey.self] = newValue }
    }
}

private struct AnvilPanelModifier: ViewModifier {
    @Environment(\.anvilFlattensSurfaces) private var isFlattened
    let radius: CGFloat
    let tint: Color?

    func body(content: Content) -> some View {
        if isFlattened {
            content
                .background(
                    (tint ?? Color.primary).opacity(tint == nil ? 0.06 : 0.16),
                    in: RoundedRectangle(cornerRadius: radius, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .strokeBorder(.separator.opacity(0.5), lineWidth: 0.5)
                }
        } else if let tint {
            content.glassEffect(
                .regular.tint(tint.opacity(0.18)),
                in: .rect(cornerRadius: radius)
            )
        } else {
            content.glassEffect(.regular, in: .rect(cornerRadius: radius))
        }
    }
}

private struct AnvilChipModifier: ViewModifier {
    @Environment(\.anvilFlattensSurfaces) private var isFlattened
    let tint: Color

    func body(content: Content) -> some View {
        if isFlattened {
            content.background(tint.opacity(0.16), in: Capsule())
        } else {
            content.glassEffect(.regular.tint(tint.opacity(0.22)), in: .capsule)
        }
    }
}

extension View {
    /// A raised panel: the default container for a group of related controls or readouts.
    func anvilPanel(radius: CGFloat = AnvilSurface.panelRadius) -> some View {
        modifier(AnvilPanelModifier(radius: radius, tint: nil))
    }

    /// A tinted panel, for surfaces carrying a status the eye should land on first.
    func anvilPanel(tint: Color, radius: CGFloat = AnvilSurface.panelRadius) -> some View {
        modifier(AnvilPanelModifier(radius: radius, tint: tint))
    }

    /// An inline chip, used for statuses and counts.
    func anvilChip(tint: Color) -> some View {
        modifier(AnvilChipModifier(tint: tint))
    }

    /// A button that reads as glass in the app and as a bordered control in previews.
    @ViewBuilder
    func anvilGlassButton(isFlattened: Bool) -> some View {
        if isFlattened {
            buttonStyle(.bordered)
        } else {
            buttonStyle(.glass)
        }
    }
}
