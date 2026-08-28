import Foundation

enum ApprovalAuthority: String, Identifiable, CaseIterable {
    case providerSpend
    case processExecution
    case gpuCapture
    case performanceMeasurement

    var id: Self { self }

    var title: String {
        switch self {
        case .providerSpend: "Paid provider"
        case .processExecution: "Local process"
        case .gpuCapture: "GPU capture"
        case .performanceMeasurement: "Performance measurement"
        }
    }

    var systemImage: String {
        switch self {
        case .providerSpend: "creditcard"
        case .processExecution: "terminal"
        case .gpuCapture: "display"
        case .performanceMeasurement: "gauge.with.dots.needle.50percent"
        }
    }

    var explanation: String {
        switch self {
        case .providerSpend:
            "May submit work to a third-party provider and incur a real charge."
        case .processExecution:
            "Runs a project or local tool and may create files in the selected workspace."
        case .gpuCapture:
            "Runs a scenario on the declared GPU path; this authority applies to this invocation only."
        case .performanceMeasurement:
            "Collects hardware timing evidence for this invocation; it does not grant a standing benchmark loop."
        }
    }
}

struct ApprovalRequest: Identifiable {
    let id = UUID()
    let title: String
    let summary: String
    let details: [String]
    let authorities: [ApprovalAuthority]
    let confirmationTitle: String
    let action: @MainActor () async -> Void
}
