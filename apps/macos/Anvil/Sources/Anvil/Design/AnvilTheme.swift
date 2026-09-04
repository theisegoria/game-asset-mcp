import AnvilKit
import SwiftUI

/// Spacing, radii and semantic colour for the whole app.
///
/// Every value is named for what it *is* rather than what it measures, so a change to
/// density is one edit here instead of a sweep through views.
enum Anvil {
    enum Space {
        static let hairline: CGFloat = 2
        static let tight: CGFloat = 6
        static let snug: CGFloat = 10
        static let regular: CGFloat = 16
        static let roomy: CGFloat = 24
        static let section: CGFloat = 32
    }

    enum Radius {
        static let chip: CGFloat = 8
        static let control: CGFloat = 10
        static let panel: CGFloat = 16
        static let sheet: CGFloat = 22
    }

    /// Status colour, used for run state, doctor checks and validation alike so one
    /// colour never means two things.
    enum Status {
        static let good = Color.green
        static let caution = Color.orange
        static let bad = Color.red
        static let inert = Color.secondary
        static let active = Color.accentColor
    }

    /// The measured width a reading column settles at. Wider than this and long prose
    /// or a JSON dump becomes hard to track across.
    static let readableWidth: CGFloat = 940
}

extension RunState {
    var label: String {
        switch self {
        case .queued: "Queued"
        case .running: "Running"
        case .awaitingApproval: "Needs approval"
        case .succeeded: "Succeeded"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        }
    }

    var symbolName: String {
        switch self {
        case .queued: "clock"
        case .running: "progress.indicator"
        case .awaitingApproval: "hand.raised.fill"
        case .succeeded: "checkmark.circle.fill"
        case .failed: "xmark.octagon.fill"
        case .cancelled: "slash.circle"
        }
    }

    var tint: Color {
        switch self {
        case .queued: Anvil.Status.inert
        case .running: Anvil.Status.active
        // Not a failure: the run is waiting on a human decision and can be re-issued.
        case .awaitingApproval: Anvil.Status.caution
        case .succeeded: Anvil.Status.good
        case .failed: Anvil.Status.bad
        case .cancelled: Anvil.Status.inert
        }
    }
}

extension SpendClass {
    /// A short money label. Costs are held in whole cents throughout, so this never
    /// does floating-point arithmetic on a price.
    var shortLabel: String? {
        guard case let .paid(cents, _, _) = self else { return nil }
        let dollars = cents / 100
        let remainder = cents % 100
        return "~$\(dollars).\(String(format: "%02d", remainder))"
    }

    var confidenceNote: String? {
        guard case let .paid(_, confidence, basis) = self else { return nil }
        switch confidence {
        case .documented:
            return "Published rate. \(basis)"
        case .estimated:
            // The distinction matters: an estimate is a refusal guard, not an invoice.
            return "Estimated, not published. \(basis)"
        }
    }
}
