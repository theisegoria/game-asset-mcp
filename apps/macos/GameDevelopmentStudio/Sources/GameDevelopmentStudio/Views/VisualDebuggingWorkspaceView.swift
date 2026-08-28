import SwiftUI

struct VisualDebuggingWorkspaceView: View {
    @Environment(AppModel.self) private var model

    @State private var projectPath = ""
    @State private var scenarioID = ""
    @State private var allowGPU = false
    @State private var allowPerformance = false
    @State private var plannedSignature: String?

    @State private var captureReference = ""
    @State private var baselineReference = ""
    @State private var candidateReference = ""
    @State private var threshold = 0.0
    @State private var approvalRequest: ApprovalRequest?

    var body: some View {
        WorkspaceScaffold(section: .visualDebugging) {
            MaterialCard(title: "Scenario", systemImage: "camera.metering.multispot") {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 12) {
                    GridRow {
                        Text("Project")
                        TextField("/path/to/game-project", text: $projectPath)
                    }

                    GridRow {
                        Text("Scenario")
                        TextField("Scenario identifier", text: $scenarioID)
                    }
                }
                .textFieldStyle(.roundedBorder)

                HStack(spacing: 18) {
                    Toggle("Authorize GPU lane", isOn: $allowGPU)
                        .accessibilityHint("Adds one-time GPU authority to the approval sheet")
                    Toggle("Collect performance evidence", isOn: $allowPerformance)
                        .accessibilityHint("Adds one-time hardware measurement authority to the approval sheet")
                }

                FormActions {
                    Button("List Scenarios") {
                        Task { await model.listScenarios(project: projectPath) }
                    }
                    .disabled(projectPath.isEmpty || model.executionState.isRunning)

                    Button("Plan Scenario") {
                        planScenario()
                    }
                    .disabled(!canPlanScenario || model.executionState.isRunning)

                    Button("Run Scenario…") {
                        Task { await prepareScenarioApproval() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!hasCurrentPlan || model.executionState.isRunning)
                }

                if canPlanScenario && !hasCurrentPlan {
                    Label("Plan the exact project, scenario, and authority combination before running.", systemImage: "info.circle")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }

            MaterialCard(title: "Analyze a sealed capture", systemImage: "waveform.path.ecg.rectangle") {
                TextField("Run ID or capture path", text: $captureReference)
                    .textFieldStyle(.roundedBorder)

                FormActions {
                    Button("Analyze Capture") {
                        Task { await model.analyzeCapture(reference: captureReference) }
                    }
                    .disabled(captureReference.isEmpty || model.executionState.isRunning)
                }

                EvidenceNote(text: "Decoded color, depth, normal, object-ID, material-ID, motion, and overdraw buffers are diagnostic measurements—not human visual approval or independent GPU proof.")
            }

            MaterialCard(title: "Compare sealed runs", systemImage: "rectangle.split.2x1") {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 12) {
                    GridRow {
                        Text("Baseline")
                        TextField("Baseline run ID or path", text: $baselineReference)
                    }

                    GridRow {
                        Text("Candidate")
                        TextField("Candidate run ID or path", text: $candidateReference)
                    }

                    GridRow {
                        Text("Threshold")
                        HStack {
                            Slider(value: $threshold, in: 0...255, step: 1)
                            Text(threshold, format: .number.precision(.fractionLength(0)))
                                .monospacedDigit()
                                .frame(width: 36, alignment: .trailing)
                        }
                    }
                }
                .textFieldStyle(.roundedBorder)

                FormActions {
                    Button("Compare Visuals") {
                        Task {
                            await model.compareVisuals(
                                baseline: baselineReference,
                                candidate: candidateReference,
                                threshold: Int(threshold)
                            )
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canCompare || model.executionState.isRunning)
                }
            }

            WorkspaceResultCard(
                result: model.latestResult,
                emptyTitle: "No capture selected",
                emptyDescription: "Plan a reproducible scenario or analyze a sealed run bundle to begin diagnosis."
            )
        }
        .onChange(of: scenarioSignature) { _, _ in
            plannedSignature = nil
        }
        .sheet(item: $approvalRequest) { request in
            ApprovalSheet(request: request)
        }
    }

    private var scenarioSignature: String {
        [projectPath, scenarioID, String(allowGPU), String(allowPerformance)].joined(separator: "\u{1F}")
    }

    private var canPlanScenario: Bool {
        !projectPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !scenarioID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var hasCurrentPlan: Bool {
        canPlanScenario && plannedSignature == scenarioSignature
    }

    private var canCompare: Bool {
        !baselineReference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !candidateReference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func planScenario() {
        let project = projectPath
        let scenario = scenarioID
        let signature = scenarioSignature
        let previousResultID = model.latestResult?.id

        Task { @MainActor in
            await model.planScenario(id: scenario, project: project)
            if !model.executionState.isRunning,
               model.executionState.errorMessage == nil,
               model.latestResult?.ok == true,
               model.latestResult?.id != previousResultID {
                plannedSignature = signature
            }
        }
    }

    private func prepareScenarioApproval() async {
        guard hasCurrentPlan else { return }
        let project = projectPath
        let scenario = scenarioID
        let gpu = allowGPU
        let performance = allowPerformance
        let submittedOutputDirectory = model.outputDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let identity = await model.executableIdentityForApproval() else { return }

        var authorities: [ApprovalAuthority] = [.processExecution]
        if gpu { authorities.append(.gpuCapture) }
        if performance { authorities.append(.performanceMeasurement) }

        approvalRequest = ApprovalRequest(
            title: "Approve scenario execution",
            summary: "Run one project-owned capture scenario with the authorities shown below.",
            details: [
                "Project: \(project)",
                "Scenario: \(scenario)",
                "GPU lane: \(gpu ? "authorized" : "not authorized")",
                "Performance capture: \(performance ? "authorized" : "not authorized")",
            ] + identity.approvalDetails + [
                "Output workspace: \(submittedOutputDirectory)",
            ],
            authorities: authorities,
            confirmationTitle: "Run Once"
        ) {
            await model.runScenario(
                id: scenario,
                project: project,
                allowGPU: gpu,
                allowPerformance: performance,
                confirmed: true,
                expectedExecutableIdentity: identity,
                expectedOutputDirectory: submittedOutputDirectory
            )
        }
    }
}
