import AnvilKit
import SwiftUI

/// Baseline-to-candidate diffs, with the pixels beside the numbers.
struct DiffViewer: View {
    let comparison: VisualComparison
    let ceiling: EvidenceCeiling
    let images: (ComparisonPair) -> (baseline: DecodedCapture?, candidate: DecodedCapture?, heatmap: DecodedCapture?)

    @State private var selectedPair: String?
    @State private var mode: Mode = .sideBySide
    @State private var wipe: Double = 0.5
    @State private var isolatedObject: String?

    enum Mode: String, CaseIterable, Identifiable {
        case sideBySide = "Side by side"
        case wipe = "Wipe"
        case heatmap = "Heatmap"
        var id: String { rawValue }
    }

    private var pair: ComparisonPair? {
        comparison.pairs.first { $0.identity == selectedPair } ?? comparison.pairs.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Anvil.Space.roomy) {
            verdictHeader
            if let pair {
                pairPicker
                viewer(for: pair)
                metrics(for: pair)
                if !pair.semanticRegions.isEmpty { regions(for: pair) }
            }
            if !comparison.summary.isEmpty { summary }
            if comparison.hasUnmatchedAttachments { unmatched }
            EvidenceCeilingNote(text: ceiling.text)
        }
    }

    // MARK: - Verdict

    private var verdictHeader: some View {
        HStack(alignment: .firstTextBaseline, spacing: Anvil.Space.regular) {
            StatusChip(
                label: comparison.verdict.label,
                symbolName: comparison.verdict.symbolName,
                tint: comparison.verdict.tint,
                isProminent: comparison.verdict == .changed
            )
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Anvil.Space.tight) {
                    Text(comparison.baselineRunID)
                    Image(systemName: "arrow.right").foregroundStyle(.tertiary)
                    Text(comparison.candidateRunID)
                }
                .font(.system(.callout, design: .monospaced))
                Text("Threshold \(comparison.threshold) · \(comparison.pairs.count) attachment\(comparison.pairs.count == 1 ? "" : "s") compared")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - Pair selection

    /// A row of chips, not a scroll view: a capture holds a handful of attachments, and a
    /// wrapping row keeps every one visible at once instead of hiding the tail.
    private var pairPicker: some View {
        HStack(spacing: Anvil.Space.tight) {
            Group {
                ForEach(comparison.pairs) { candidate in
                    Button {
                        selectedPair = candidate.identity
                        isolatedObject = nil
                    } label: {
                        HStack(spacing: Anvil.Space.tight) {
                            Image(systemName: candidate.verdict.symbolName)
                                .foregroundStyle(candidate.verdict.tint)
                            Text(candidate.kind.label)
                        }
                        .font(.callout)
                        .padding(.horizontal, Anvil.Space.snug)
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.plain)
                    .anvilPanel(
                        tint: candidate.identity == pair?.identity ? Anvil.Status.active : .clear,
                        radius: Anvil.Radius.chip
                    )
                    .accessibilityAddTraits(candidate.identity == pair?.identity ? .isSelected : [])
                }
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - The pictures

    @ViewBuilder
    private func viewer(for pair: ComparisonPair) -> some View {
        let loaded = images(pair)
        VStack(alignment: .leading, spacing: Anvil.Space.snug) {
            HStack {
                HStack(spacing: 2) {
                    ForEach(Mode.allCases) { candidate in
                        Button(candidate.rawValue) { mode = candidate }
                            .buttonStyle(.plain)
                            .font(.callout.weight(mode == candidate ? .semibold : .regular))
                            .padding(.horizontal, Anvil.Space.snug)
                            .padding(.vertical, 5)
                            .background(
                                mode == candidate ? Anvil.Status.active.opacity(0.22) : .clear,
                                in: RoundedRectangle(cornerRadius: Anvil.Radius.chip - 2, style: .continuous)
                            )
                            .accessibilityAddTraits(mode == candidate ? .isSelected : [])
                    }
                }
                .padding(2)
                .anvilPanel(radius: Anvil.Radius.chip)
                Spacer()
                if let width = pair.width, let height = pair.height {
                    Text("\(width) × \(height)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            if !pair.comparable {
                incomparable(pair)
            } else {
                switch mode {
                case .sideBySide:
                    HStack(spacing: Anvil.Space.snug) {
                        labelled("Baseline") {
                            AttachmentImage(capture: loaded.baseline, kind: pair.kind, ceiling: ceiling)
                        }
                        labelled("Candidate") {
                            AttachmentImage(capture: loaded.candidate, kind: pair.kind, ceiling: ceiling)
                        }
                    }
                case .wipe:
                    WipeView(
                        baseline: AttachmentImage(capture: loaded.baseline, kind: pair.kind, ceiling: ceiling),
                        candidate: AttachmentImage(capture: loaded.candidate, kind: pair.kind, ceiling: ceiling),
                        position: $wipe
                    )
                case .heatmap:
                    if loaded.heatmap != nil {
                        labelled("Where the pixels differ") {
                            AttachmentImage(capture: loaded.heatmap, kind: .custom, ceiling: ceiling)
                        }
                    } else {
                        NothingHere(
                            title: "No heatmap for this attachment",
                            message: "Run the comparison with an output directory to generate one.",
                            symbolName: "square.grid.3x3.square"
                        )
                    }
                }
            }

            Text(pair.kind.diagnosticPurpose)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Anvil.Space.regular)
        .anvilPanel()
    }

    private func labelled<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Anvil.Space.tight) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
                .clipShape(RoundedRectangle(cornerRadius: Anvil.Radius.chip, style: .continuous))
        }
        .frame(maxWidth: .infinity)
    }

    private func incomparable(_ pair: ComparisonPair) -> some View {
        VStack(alignment: .leading, spacing: Anvil.Space.tight) {
            Label("Not compared", systemImage: "questionmark.square.dashed")
                .font(.headline)
            Text(pair.reason ?? "The two attachments could not be measured against each other.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Nothing was measured, so this is not a difference. It usually means the two runs are not the same scenario or resolution.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Anvil.Space.regular)
        .anvilPanel(tint: Anvil.Status.inert, radius: Anvil.Radius.control)
    }

    // MARK: - Numbers

    private func metrics(for pair: ComparisonPair) -> some View {
        Panel("Measurements", symbolName: "ruler") {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 170), spacing: Anvil.Space.regular)],
                alignment: .leading,
                spacing: Anvil.Space.regular
            ) {
                metric("Changed pixels", pair.changedPixelRatio.map(percent), emphasis: (pair.changedPixelRatio ?? 0) > 0)
                metric("Mean absolute error", pair.meanAbsoluteError.map { format($0, 2) })
                metric("RMS error", pair.rootMeanSquaredError.map { format($0, 2) })
                metric("Max channel delta", pair.maximumChannelDelta.map { format($0, 0) })
                metric("Luminance shift", pair.meanLuminanceDelta.map { format($0, 2, signed: true) })
                metric("Edge delta", pair.meanAbsoluteEdgeDelta.map { format($0, 2) })
                metric("Structural similarity", pair.meanSSIM.map { format($0, 3) }, emphasis: (pair.meanSSIM ?? 1) < 0.9)
                if let window = pair.worstSSIMWindow {
                    metric("Least similar at", "(\(window.x), \(window.y)) · \(format(window.ssim, 3))")
                }
            }
            if let ssim = pair.meanSSIM, let luminance = pair.meanLuminanceDelta, let edge = pair.meanAbsoluteEdgeDelta {
                Text(reading(ssim: ssim, luminance: luminance, edge: edge))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func metric(_ label: String, _ value: String?, emphasis: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value ?? "—")
                .font(.system(.title3, design: .rounded, weight: .medium).monospacedDigit())
                .foregroundStyle(emphasis ? Anvil.Status.caution : .primary)
                .contentTransition(.numericText())
        }
    }

    /// One sentence a person can act on, derived from the shape of the numbers rather
    /// than their size. A reader should not have to know that low edge delta beside a
    /// large luminance shift means shading rather than geometry.
    private func reading(ssim: Double, luminance: Double, edge: Double) -> String {
        if ssim > 0.98 && abs(luminance) < 1 { return "Structurally the same frame." }
        if edge < 2 && abs(luminance) > 8 {
            return "Edges held while brightness moved: this reads as a shading or exposure change, not a geometry change."
        }
        if edge > 8 && ssim < 0.9 {
            return "Edges moved and structure diverged: geometry, camera or visibility changed, not only shading."
        }
        return "Mixed signal. Check the semantic breakdown and the least-similar window to localise it."
    }

    // MARK: - Semantic breakdown

    private func regions(for pair: ComparisonPair) -> some View {
        Panel("By object", symbolName: "square.stack.3d.up") {
            if !pair.objectsDisappeared.isEmpty {
                Label {
                    Text("Gone from the candidate: ") + Text(pair.objectsDisappeared.joined(separator: ", ")).font(.system(.callout, design: .monospaced))
                } icon: {
                    Image(systemName: "eye.slash").foregroundStyle(Anvil.Status.caution)
                }
                .font(.callout)
            }
            if !pair.objectsAppeared.isEmpty {
                Label {
                    Text("New in the candidate: ") + Text(pair.objectsAppeared.joined(separator: ", ")).font(.system(.callout, design: .monospaced))
                } icon: {
                    Image(systemName: "eye").foregroundStyle(Anvil.Status.active)
                }
                .font(.callout)
            }

            VStack(spacing: 1) {
                regionHeader
                ForEach(pair.rankedRegions.prefix(12)) { region in
                    regionRow(region)
                }
            }
            if pair.rankedRegions.count > 12 {
                Text("\(pair.rankedRegions.count - 12) more objects with smaller changes")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if isolatedObject != nil {
                Text("Isolating an object dims every other id in the object-ID buffer. Click again to clear.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var regionHeader: some View {
        HStack(spacing: Anvil.Space.regular) {
            Text("Object").frame(width: 120, alignment: .leading)
            Text("Pixels").frame(width: 80, alignment: .trailing)
            Text("Error").frame(width: 70, alignment: .trailing)
            Text("Changed").frame(width: 80, alignment: .trailing)
            Text("Coverage").frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, Anvil.Space.snug)
        .padding(.bottom, 4)
    }

    private func regionRow(_ region: ComparisonPair.SemanticRegion) -> some View {
        let isIsolated = isolatedObject == region.objectID
        return Button {
            isolatedObject = isIsolated ? nil : region.objectID
        } label: {
            HStack(spacing: Anvil.Space.regular) {
                Text(region.objectID)
                    .font(.system(.callout, design: .monospaced))
                    .frame(width: 120, alignment: .leading)
                Text(region.pixels.formatted())
                    .frame(width: 80, alignment: .trailing)
                Text(format(region.meanAbsoluteError, 1))
                    .foregroundStyle(region.meanAbsoluteError > 10 ? Anvil.Status.caution : .primary)
                    .frame(width: 70, alignment: .trailing)
                Text(percent(region.changedPixelRatio))
                    .frame(width: 80, alignment: .trailing)
                coverage(region)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.callout.monospacedDigit())
            .padding(.horizontal, Anvil.Space.snug)
            .padding(.vertical, 6)
            .background(isIsolated ? Anvil.Status.active.opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(region.objectID): \(percent(region.changedPixelRatio)) changed")
        .accessibilityAddTraits(isIsolated ? .isSelected : [])
    }

    private func coverage(_ region: ComparisonPair.SemanticRegion) -> some View {
        HStack(spacing: Anvil.Space.tight) {
            if region.pixelsLost > 0 {
                Text("−\(region.pixelsLost.formatted())").foregroundStyle(Anvil.Status.bad)
            }
            if region.pixelsGained > 0 {
                Text("+\(region.pixelsGained.formatted())").foregroundStyle(Anvil.Status.good)
            }
            if region.suggestsMovement {
                Text("moved").font(.caption).foregroundStyle(.secondary)
            } else if region.pixelsLost == 0 && region.pixelsGained == 0 {
                Text("same footprint").font(.caption).foregroundStyle(.tertiary)
            }
        }
        .font(.caption.monospacedDigit())
    }

    // MARK: - Sentences and gaps

    private var summary: some View {
        Panel("In words", symbolName: "text.quote") {
            ForEach(Array(comparison.summary.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Derived deterministically from the measurements by the harness. This describes what changed; it does not judge whether the change is wrong, and it does not establish why.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var unmatched: some View {
        Panel("Attachments in one run only", symbolName: "rectangle.on.rectangle.slash") {
            if !comparison.unmatchedBaseline.isEmpty {
                ValueRow(label: "Baseline only", value: comparison.unmatchedBaseline.joined(separator: ", "), isMonospaced: true)
            }
            if !comparison.unmatchedCandidate.isEmpty {
                ValueRow(label: "Candidate only", value: comparison.unmatchedCandidate.joined(separator: ", "), isMonospaced: true)
            }
            Text("Not a difference — nothing was measured. This usually means the two runs are not the same scenario.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Formatting

    private func percent(_ ratio: Double) -> String {
        if ratio == 0 { return "0%" }
        if ratio < 0.0001 { return "<0.01%" }
        return String(format: "%.2f%%", ratio * 100)
    }

    private func format(_ value: Double, _ places: Int, signed: Bool = false) -> String {
        let text = String(format: "%.\(places)f", value)
        return signed && value > 0 ? "+\(text)" : text
    }
}

/// Two images with a draggable divider. Pure SwiftUI, so it renders in previews.
private struct WipeView<Left: View, Right: View>: View {
    let baseline: Left
    let candidate: Right
    @Binding var position: Double
    @Environment(\.anvilFlattensSurfaces) private var isFlattened

    var body: some View {
        VStack(spacing: Anvil.Space.tight) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    candidate
                    baseline
                        .mask(alignment: .leading) {
                            Rectangle().frame(width: proxy.size.width * position)
                        }
                    Rectangle()
                        .fill(.white)
                        .frame(width: 2)
                        .shadow(radius: 2)
                        .offset(x: proxy.size.width * position - 1)
                }
                .gesture(
                    DragGesture(minimumDistance: 0).onChanged { value in
                        position = min(1, max(0, value.location.x / proxy.size.width))
                    }
                )
            }
            .aspectRatio(16 / 9, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: Anvil.Radius.chip, style: .continuous))

            HStack {
                Text("Baseline").font(.caption).foregroundStyle(.secondary)
                if isFlattened {
                    Capsule().fill(.quaternary).frame(height: 4)
                } else {
                    Slider(value: $position, in: 0...1).labelsHidden()
                }
                Text("Candidate").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

extension ComparisonVerdict {
    var symbolName: String {
        switch self {
        case .identical: "equal.circle.fill"
        case .withinTolerance: "checkmark.circle"
        case .changed: "exclamationmark.triangle.fill"
        case .incomparable: "questionmark.circle"
        }
    }

    var tint: Color {
        switch self {
        case .identical: Anvil.Status.good
        case .withinTolerance: Anvil.Status.good
        case .changed: Anvil.Status.caution
        case .incomparable: Anvil.Status.inert
        }
    }
}
