import SwiftUI
import Combine

/// Stable identities shared by sidebar links, notification taps, and the detail pane.
public enum WorkspaceSelection: Hashable {
    case session(String)
    case document(String)
}

@MainActor
final class WorkspaceNavigationState: ObservableObject {
    @Published var hostDeviceId: String?
    @Published private(set) var project: Project?
    @Published private(set) var selection: WorkspaceSelection?
    @Published var compactColumn: NavigationSplitViewColumn = .sidebar
    private var composeStates: [String: SessionComposeState] = [:]

    init(project: Project? = nil) {
        self.project = project
    }

    func chooseProject(_ project: Project?) {
        selection = nil
        self.project = project
        compactColumn = .sidebar
    }

    func select(_ selection: WorkspaceSelection?) {
        self.selection = selection
        if selection != nil { compactColumn = .detail }
    }

    func composeState(for sessionId: String) -> SessionComposeState {
        if let existing = composeStates[sessionId] { return existing }
        let state = SessionComposeState()
        composeStates[sessionId] = state
        return state
    }

    func clearAccount() {
        hostDeviceId = nil
        composeStates.removeAll()
        chooseProject(nil)
    }

    func openSession(_ sessionId: String, database: DatabaseManager?) {
        let plan = SessionNavigation.plan(for: sessionId, in: database)
        hostDeviceId = (try? database?.session(byId: sessionId))?.hostDeviceId
        project = plan.project
        select(.session(sessionId))
    }

    /// A late sync response must not replace a newer sidebar choice.
    func adoptResolvedSession(_ session: Session, database: DatabaseManager?) {
        guard selection == .session(session.id) else { return }
        hostDeviceId = session.hostDeviceId
        project = SessionNavigation.plan(for: session.id, in: database).project
    }
}

/// Keep the same split view and selection mounted as SwiftUI expands/collapses columns.
struct WorkspaceNavigationView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var navigation: WorkspaceNavigationState
    @State private var hosts: [DeviceInfo] = []
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    private var selection: Binding<WorkspaceSelection?> {
        Binding(get: { navigation.selection }, set: { navigation.select($0) })
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $navigation.compactColumn) {
            Group {
                if let project = navigation.project {
                    SessionListView(project: project, selection: selection, hostDeviceId: navigation.hostDeviceId)
                        .id(project.id)
                        .toolbar {
                            ToolbarItem(placement: .navigation) {
                                Button {
                                    navigation.chooseProject(nil)
                                } label: {
                                    Label("Projects", systemImage: "folder")
                                }
                                .accessibilityIdentifier("Choose Project")
                            }
                        }
                } else {
                    ProjectListView { project in
                        navigation.chooseProject(project)
                        appState.configureVoiceAgent(forProject: project.id)
                        AnalyticsManager.shared.capture("mobile_project_selected")
                    }
                }
            }
            .safeAreaInset(edge: .top) {
                Picker("Machine", selection: Binding(get: {navigation.hostDeviceId}, set: { navigation.hostDeviceId = $0; navigation.select(nil) })) {
                    Text("Choose a machine").tag(String?.none)
                    ForEach(hosts, id: \.deviceId) { device in
                        Text(device.name).tag(Optional(device.deviceId))
                    }
                    if let host = navigation.hostDeviceId, !hosts.contains(where: { $0.deviceId == host }) {
                        Text("Remote machine · Offline").tag(Optional(host))
                    }
                }
                .padding(.horizontal)
            }
            .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 360)
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
        .onReceive(appState.syncManager?.$connectedDevices.eraseToAnyPublisher() ?? Just([]).eraseToAnyPublisher()) { devices in
            hosts = devices.filter { $0.type == "desktop" || $0.type == "headless" }
            if navigation.hostDeviceId == nil { navigation.hostDeviceId = hosts.first(where: {$0.type == "desktop"})?.deviceId ?? hosts.first?.deviceId }
        }
        .onChange(of: appState.databaseManager.map(ObjectIdentifier.init)) { previous, _ in
            // Initial database hydration must retain a cold-launch notification intent.
            if previous != nil { navigation.clearAccount() }
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let database = appState.databaseManager {
            switch navigation.selection {
            case .session(let sessionId):
                PendingSessionView(sessionId: sessionId, database: database, composeState: navigation.composeState(for: sessionId)) { session in
                    navigation.adoptResolvedSession(session, database: database)
                }
                .id(sessionId)
            case .document(let documentId):
                #if canImport(UIKit)
                if let document = try? database.document(byId: documentId) {
                    DocumentEditorView(document: document)
                        .id(documentId)
                }
                #endif
            case nil:
                ContentUnavailableView("Select a session or file", systemImage: "sidebar.left")
            }
        }
    }
}
