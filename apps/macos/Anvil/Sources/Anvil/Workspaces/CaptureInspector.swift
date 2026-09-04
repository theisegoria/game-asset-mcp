import AnvilKit
import SwiftUI

/// One sealed run's attachments, with the numbers the harness measured beside the image.
struct CaptureInspector: View {
    let analysis: CaptureAnalysis
    let ceiling: EvidenceCeiling
    let image: (String) -> DecodedCapture?

    @State private var frame: Int?
    @State private var selectedRaster: String?

    private var currentFrame: Int { frame ?? analysis.frameIndices.first ?? 0 }
    private var rasters: [RasterAnalysis] { analysis.rasters(inFrame: currentFrame) }
    private var floats: [FloatRasterAnalysis] { analysis.floatRasters(inFrame: currentFrame) }
    private var raster: RasterAnalysis? {
        rasters.first { $0.id == selectedRaster } ?? rasters.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Anvil.Space.roomy) {
            header
            if analysis.frameIndices.count > 1 { framePicker }
            attachmentPicker
            if let raster {
                viewer(raster)
                statistics(raster)
            }
            if !floats.isEmpty { floatPanel }
            if !analysis.flatRasters.isEmpty { flatWarning }
            EvidenceCeilingNote(text: ceiling.text)
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: Anvil.Space.regular) {
            VStack(alignment: .leading, spacing: 2) {
                Text(analysis.runID)
                    .font(.system(.callout, design: .monospaced, weight: .medium))
                Text("\(analysis.adapterID) · \(analysis.scenarioID) · \(analysis.rasters.count) raster\(analysis.rasters.count == 1 ? "" : "s"), \(analysis.floatRasters.count) float buffer\(analysis.floatRasters.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    private var framePicker: some View {
        HStack(spacing: Anvil.Space.tight) {
            Text("Frame").font(.caption).foregroundStyle(.secondary)
            ForEach(analysis.frameIndices, id: \.self) { index in
                Button(String(format: "%04d", index)) { frame = index; selectedRaster = nil }
                    .buttonStyle(.plain)
                    .font(.system(.callout, design: .monospaced, weight: index == currentFrame ? .semibold : .regular))
                    .padding(.horizontal, Anvil.Space.snug)
                    .padding(.vertical, 5)
                    .background(index == currentFrame ? Anvil.Status.active.opacity(0.22) : .clear,
                                in: RoundedRectangle(cornerRadius: Anvil.Radius.chip - 2, style: .continuous))
            }
            Spacer(minLength: 0)
        }
    }

    private var attachmentPicker: some View {
        HStack(spacing: Anvil.Space.tight) {
            ForEach(rasters) { candidate in
                Button {
                    selectedRaster = candidate.id
                } label: {
                    HStack(spacing: Anvil.Space.tight) {
                        if candidate.isFlat {
                            Image(systemName: "rectangle.dashed").foregroundStyle(Anvil.Status.caution)
                        }
                        Text(candidate.displayName)
                    }
                    .font(.callout)
                    .padding(.horizontal, Anvil.Space.snug)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .anvilPanel(tint: candidate.id == raster?.id ? Anvil.Status.active : .clear, radius: Anvil.Radius.chip)
                .accessibilityAddTraits(candidate.id == raster?.id ? .isSelected : [])
            }
            Spacer(minLength: 0)
        }
    }

    private func viewer(_ raster: RasterAnalysis) -> some View {
        VStack(alignment: .leading, spacing: Anvil.Space.snug) {
            HStack {
                Text(raster.displayName).font(.headline)
                Spacer()
                Text("\(raster.width) × \(raster.height)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            AttachmentImage(capture: image(raster.path), kind: raster.kind, ceiling: ceiling)
                .clipShape(RoundedRectangle(cornerRadius: Anvil.Radius.chip, style: .continuous))
            Text(raster.kind.diagnosticPurpose)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if raster.kind.isEngineAuthoredHeuristic {
                Label("Engine-authored estimate. The values are the engine's own cost model, not a rendered quantity.", systemImage: "function")
                    .font(.caption)
                    .foregroundStyle(Anvil.Status.caution)
            }
        }
        .padding(Anvil.Space.regular)
        .anvilPanel()
    }

    private func statistics(_ raster: RasterAnalysis) -> some View {
        Panel("Channels", symbolName: "slider.horizontal.3") {
            let names = ["R", "G", "B", "A"]
            HStack(spacing: Anvil.Space.regular) {
                Text("").frame(width: 24)
                Text("min").frame(width: 70, alignment: .trailing)
                Text("mean").frame(width: 70, alignment: .trailing)
                Text("max").frame(width: 70, alignment: .trailing)
                Spacer()
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            ForEach(0..<min(4, raster.minimum.count), id: \.self) { channel in
                HStack(spacing: Anvil.Space.regular) {
                    Text(names[channel]).font(.system(.callout, design: .monospaced, weight: .semibold)).frame(width: 24)
                    Text(String(format: "%.1f", raster.minimum[channel])).frame(width: 70, alignment: .trailing)
                    Text(String(format: "%.1f", raster.mean[channel])).frame(width: 70, alignment: .trailing)
                    Text(String(format: "%.1f", raster.maximum[channel])).frame(width: 70, alignment: .trailing)
                    RangeBar(minimum: raster.minimum[channel], mean: raster.mean[channel], maximum: raster.maximum[channel])
                }
                .font(.callout.monospacedDigit())
            }
            HStack(spacing: Anvil.Space.roomy) {
                ValueRow(label: "Mean luminance", value: String(format: "%.2f", raster.meanLuminance))
                ValueRow(label: "Alpha coverage", value: String(format: "%.1f%%", raster.alphaCoverage * 100))
                if let ids = raster.uniqueSemanticIDs {
                    ValueRow(label: "Distinct ids", value: ids.formatted())
                }
            }
        }
    }

    private var floatPanel: some View {
        Panel("Float buffers", symbolName: "number") {
            Text("Read at capture precision from the binary attachment, not from a preview image.")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(floats) { buffer in
                VStack(alignment: .leading, spacing: Anvil.Space.tight) {
                    HStack(spacing: Anvil.Space.snug) {
                        Text(buffer.label.map { "\(buffer.kind.label) · \($0)" } ?? buffer.kind.label)
                            .font(.callout.weight(.medium))
                        Text(buffer.pixelFormat.label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text("\(buffer.width) × \(buffer.height)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    HStack(spacing: Anvil.Space.roomy) {
                        ValueRow(label: "Range", value: String(format: "%.4g … %.4g", buffer.minimum, buffer.maximum), isMonospaced: true)
                        ValueRow(label: "Mean", value: String(format: "%.4g", buffer.mean), isMonospaced: true)
                    }
                    if let diagnosis = buffer.nonFiniteDiagnosis {
                        Label(diagnosis, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(Anvil.Status.bad)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(Anvil.Space.snug)
                .frame(maxWidth: .infinity, alignment: .leading)
                .anvilPanel(tint: buffer.hasNonFiniteSamples ? Anvil.Status.bad : .clear, radius: Anvil.Radius.control)
            }
        }
    }

    private var flatWarning: some View {
        Panel("Never drawn", symbolName: "rectangle.dashed") {
            Text("These attachments have the same value in every pixel. That is what a cleared-but-never-written buffer looks like, and it usually means a pass did not run — which the colour frame can hide.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(analysis.flatRasters) { flat in
                Text("\(String(format: "%04d", flat.frameIndex)) · \(flat.displayName)")
                    .font(.system(.callout, design: .monospaced))
            }
        }
    }
}

/// A min–mean–max bar on a 0…255 scale.
private struct RangeBar: View {
    let minimum: Double
    let mean: Double
    let maximum: Double

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary.opacity(0.4))
                Capsule()
                    .fill(Anvil.Status.active.opacity(0.5))
                    .frame(width: max(2, width * (maximum - minimum) / 255))
                    .offset(x: width * minimum / 255)
                Circle()
                    .fill(.primary)
                    .frame(width: 6, height: 6)
                    .offset(x: width * mean / 255 - 3)
            }
        }
        .frame(height: 8)
        .accessibilityHidden(true)
    }
}
