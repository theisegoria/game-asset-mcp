import SwiftUI

struct WorkspaceDetailView: View {
    let section: WorkspaceSection

    @ViewBuilder
    var body: some View {
        switch section {
        case .production:
            ProductionWorkspaceView()
        case .library:
            LibraryVendoringWorkspaceView()
        case .visualDebugging:
            VisualDebuggingWorkspaceView()
        case .performance:
            PerformanceWorkspaceView()
        }
    }
}
