import SwiftUI

/// Anvil's surface treatment.
///
/// macOS 26's Liquid Glass APIs are verified present in the MacOSX26.5 SDK
/// (`GlassEffectContainer`, `glassEffect(_:in:)`, `glassEffectID(_:in:)`,
/// `buttonStyle(.glass)`), so they are used directly. Routing every surface through
/// this one file keeps the fallback — should a deployment target ever predate them —
/// a single edit rather than a sweep through every view.
enum AnvilSurface {
    /// Corner radius for panels that sit directly on the window background.
    static let panelRadius: CGFloat = 16
    /// Corner radius for controls and inline chips.
    static let controlRadius: CGFloat = 10
}

extension View {
    /// A raised panel: the default container for a group of related controls or readouts.
    func anvilPanel(radius: CGFloat = AnvilSurface.panelRadius) -> some View {
        self.glassEffect(.regular, in: .rect(cornerRadius: radius))
    }

    /// A tinted panel, for surfaces that carry a status the eye should land on first.
    func anvilPanel(tint: Color, radius: CGFloat = AnvilSurface.panelRadius) -> some View {
        self.glassEffect(.regular.tint(tint.opacity(0.18)), in: .rect(cornerRadius: radius))
    }

    /// An inline chip, used for statuses and counts.
    func anvilChip(tint: Color) -> some View {
        self.glassEffect(.regular.tint(tint.opacity(0.22)), in: .capsule)
    }
}
