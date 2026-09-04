import AnvilKit
import SwiftUI

/// A small status capsule. One component for every status in the app, so a colour or a
/// shape never means two different things in two places.
struct StatusChip: View {
    let label: String
    let symbolName: String
    let tint: Color
    var isProminent = false

    var body: some View {
        HStack(spacing: Anvil.Space.tight) {
            Image(systemName: symbolName)
                .font(.caption.weight(.semibold))
            Text(label)
                .font(.caption.weight(.medium))
        }
        .foregroundStyle(isProminent ? .white : tint)
        .padding(.horizontal, Anvil.Space.snug)
        .padding(.vertical, 5)
        .background {
            if isProminent {
                Capsule().fill(tint)
            }
        }
        .anvilChip(tint: isProminent ? .clear : tint)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label)")
    }
}

/// A titled panel. The default container for a group of controls or readouts.
struct Panel<Content: View>: View {
    var title: String?
    var symbolName: String?
    var accessory: AnyView?
    @ViewBuilder let content: Content

    init(
        _ title: String? = nil,
        symbolName: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.symbolName = symbolName
        self.accessory = nil
        self.content = content()
    }

    init<Accessory: View>(
        _ title: String,
        symbolName: String? = nil,
        @ViewBuilder accessory: () -> Accessory,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.symbolName = symbolName
        self.accessory = AnyView(accessory())
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Anvil.Space.regular) {
            if let title {
                HStack(spacing: Anvil.Space.snug) {
                    if let symbolName {
                        Image(systemName: symbolName)
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(.secondary)
                    }
                    Text(title)
                        .font(.headline)
                    Spacer(minLength: Anvil.Space.snug)
                    accessory
                }
            }
            content
        }
        .padding(Anvil.Space.regular)
        .frame(maxWidth: .infinity, alignment: .leading)
        .anvilPanel()
    }
}

/// A label and its value on one line, with the value selectable and monospaced when it
/// is an identifier or a path.
struct ValueRow: View {
    let label: String
    let value: String
    var isMonospaced = false
    var tint: Color?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Anvil.Space.regular) {
            Text(label)
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 148, alignment: .leading)
            Text(value)
                .font(isMonospaced ? .system(.callout, design: .monospaced) : .callout)
                .foregroundStyle(tint ?? .primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .truncationMode(.middle)
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A page heading: what this workspace is, and what it is for.
struct WorkspaceHeading: View {
    let title: String
    let subtitle: String
    var symbolName: String?

    var body: some View {
        HStack(alignment: .center, spacing: Anvil.Space.regular) {
            if let symbolName {
                Image(systemName: symbolName)
                    .font(.system(size: 22, weight: .medium))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .anvilPanel(radius: Anvil.Radius.control)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.title2.weight(.semibold))
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Anvil.Space.snug)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Shown where a list has nothing in it yet, saying what would put something there.
struct NothingHere: View {
    let title: String
    let message: String
    var symbolName = "tray"

    var body: some View {
        VStack(spacing: Anvil.Space.snug) {
            Image(systemName: symbolName)
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(.tertiary)
            Text(title)
                .font(.callout.weight(.medium))
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Anvil.Space.section)
        .accessibilityElement(children: .combine)
    }
}

/// A spinner in the app, a static glyph in a preview render.
///
/// `ProgressView` is AppKit-backed, so `ImageRenderer` substitutes its unsupported-view
/// placeholder for it. Swapping the indicator keeps preview renders readable without
/// changing what ships.
struct ActivityIndicator: View {
    @Environment(\.anvilFlattensSurfaces) private var isFlattened

    var body: some View {
        if isFlattened {
            Image(systemName: "progress.indicator")
                .font(.caption)
                .foregroundStyle(Anvil.Status.active)
        } else {
            ProgressView().controlSize(.small)
        }
    }
}
