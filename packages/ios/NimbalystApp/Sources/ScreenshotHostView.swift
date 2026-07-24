import SwiftUI
import NimbalystNative

#if DEBUG
/// Routes to the appropriate screen for screenshot capture.
/// Reads `--screenshot-screen=<name>` from launch arguments.
struct ScreenshotHostView: View {
    @EnvironmentObject var appState: AppState

    private var screenTarget: String {
        for arg in CommandLine.arguments {
            if arg.hasPrefix("--screenshot-screen=") {
                return arg.replacingOccurrences(of: "--screenshot-screen=", with: "")
            }
        }
        return "projects"
    }

    var body: some View {
        Group {
            switch screenTarget {
            case "projects":
                NavigationStack {
                    ProjectListView()
                }
            case "sessions":
                NavigationStack {
                    SessionListView(project: firstProject)
                }
            case "detail":
                NavigationStack {
                    SessionDetailView(session: detailSession)
                }
            case "settings":
                NavigationStack {
                    SettingsView()
                }
            case "pairing":
                PairingView()
            default:
                NavigationStack {
                    ProjectListView()
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    /// The first project (nimbalyst) for the sessions screenshot.
    private var firstProject: Project {
        let projects = (try? appState.databaseManager?.allProjects()) ?? []
        return projects.first ?? Project(id: "demo", name: "Demo")
    }

    /// The session with messages for the detail screenshot (sess-nim-1).
    private var detailSession: Session {
        if let db = appState.databaseManager,
           let session = try? db.session(byId: "sess-nim-1") {
            return session
        }
        return Session(id: "demo", projectId: "demo", titleDecrypted: "Demo Session")
    }
}
#endif
