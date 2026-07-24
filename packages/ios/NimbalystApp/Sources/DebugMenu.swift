#if DEBUG
import SwiftUI
import NimbalystNative

struct DebugMenu: View {
    @EnvironmentObject var appState: AppState
    @State private var showingConfirmation = false
    @State private var message: String?

    var body: some View {
        List {
            Section("Test Data") {
                Button {
                    Task {
                        do {
                            try await appState.addMockTranscriptSession()
                            message = "✅ Mock session created! Navigate to Projects > Transcript Test Project"
                        } catch {
                            message = "❌ Error: \(error.localizedDescription)"
                        }
                    }
                } label: {
                    Label("Add Mock Transcript Session", systemImage: "text.bubble.fill")
                }
            }

            Section("Database") {
                if let db = appState.databaseManager {
                    Button {
                        Task {
                            do {
                                let projects = try db.allProjects()
                                let sessionCount = projects.reduce(0) { $0 + $1.sessionCount }
                                message = "Database: \(projects.count) projects, ~\(sessionCount) sessions"
                            } catch {
                                message = "❌ Error: \(error.localizedDescription)"
                            }
                        }
                    } label: {
                        Label("Check Database Stats", systemImage: "chart.bar.fill")
                    }
                } else {
                    Text("Database not initialized (pair first)")
                        .foregroundStyle(.secondary)
                }
            }

            if let message = message {
                Section {
                    Text(message)
                        .font(.footnote)
                }
            }
        }
        .navigationTitle("Debug Menu")
    }
}
#endif
