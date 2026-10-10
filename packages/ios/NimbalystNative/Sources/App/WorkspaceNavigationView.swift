import SwiftUI
import Combine

/// Stable identities shared by sidebar links, notification taps, and the detail pane.
public enum WorkspaceSelection: Hashable {
    case session(String)
    case document(String)
    /// A team console page (Team Wiki / Team Trackers), shown in `PagesView`.
    case pages(ConsoleRoute)
}

@MainActor
final class WorkspaceNavigationState: ObservableObject {
    @Published var hostDeviceId: String?
    @Published private(set) var project: Project?
    @Published private(set) var selection: WorkspaceSelection?
    @Published var compactColumn: NavigationSplitViewColumn = .sidebar
    @Published private(set) var hosts: [DeviceInfo] = []
    /// Outlives `hosts`, which is empty from foreground until the socket reconnects.
    /// Changes only alongside a `hosts` write, so it needs no publisher of its own.
    private var knownDesktopIds: Set<String> = []
    private var hostSubscription: AnyCancellable?
    private weak var hostSource: AnyObject?
    private var composeStates: [String: SessionComposeState] = [:]

    init(project: Project? = nil) {
        self.project = project
    }

    // Own this subscription outside View.body: a fresh AnyPublisher replays
    // presence on every render, and writing hosts schedules the next render.
    func observeHosts(source: AnyObject, publisher: AnyPublisher<[DeviceInfo], Never>) {
        guard hostSource !== source else { return }
        hostSource = source
        hostSubscription?.cancel()
        hostSubscription = publisher.sink { [weak self] devices in
            guard let self else { return }
            let roster = devices.filter { $0.type == "desktop" || $0.type == "headless" }
            for device in roster {
                if device.type == "desktop" { knownDesktopIds.insert(device.deviceId) }
                else { knownDesktopIds.remove(device.deviceId) }
            }
            hosts = roster
            adoptDefaultHost(from: hosts)
        }
    }

    /// Desktop-created sessions carry no hostDeviceId and are listed under a desktop.
    var includesUnattributedSessions: Bool {
        hostDeviceId.map(knownDesktopIds.contains) ?? false
    }

    func stopObservingHosts() {
        hostSubscription?.cancel()
        hostSubscription = nil
        hostSource = nil
        if !hosts.isEmpty { hosts = [] }
    }

    func adoptDefaultHost(from hosts: [DeviceInfo]) {
        // Re-subscribing during layout replays the current roster. Publishing
        // nil over nil here invalidates navigation and can prevent first paint.
        guard hostDeviceId == nil,
              let defaultHost = hosts.first(where: { $0.type == "desktop" }) ?? hosts.first else { return }
        hostDeviceId = defaultHost.deviceId
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

    /// A detail's own Back (Pages hides the system one): clear it and show the sidebar.
    func leaveDetail() {
        selection = nil
        compactColumn = .sidebar
    }

    func composeState(for sessionId: String) -> SessionComposeState {
        if let existing = composeStates[sessionId] { return existing }
        let state = SessionComposeState()
        composeStates[sessionId] = state
        return state
    }

    func clearAccount() {
        hostDeviceId = nil
        knownDesktopIds = []
        composeStates.removeAll()
        chooseProject(nil)
    }

    func openSession(_ sessionId: String, database: DatabaseManager?) {
        let plan = SessionNavigation.plan(for: sessionId, in: database)
        hostDeviceId = host(for: try? database?.session(byId: sessionId))
        project = plan.project
        select(.session(sessionId))
    }

    /// A late sync response must not replace a newer sidebar choice.
    func adoptResolvedSession(_ session: Session, database: DatabaseManager?) {
        guard selection == .session(session.id) else { return }
        hostDeviceId = host(for: session)
        project = SessionNavigation.plan(for: session.id, in: database).project
    }

    /// Desktop-created sessions carry no hostDeviceId and are listed under a desktop.
    /// Clearing the computer for them would unscope the list and end a voice conversation.
    private func host(for session: Session?) -> String? {
        if let owner = session?.hostDeviceId { return owner }
        if hosts.contains(where: { $0.deviceId == hostDeviceId && $0.type == "desktop" }) { return hostDeviceId }
        return hosts.first(where: { $0.type == "desktop" })?.deviceId ?? hostDeviceId
    }
}

/// Keep the same split view and selection mounted as SwiftUI expands/collapses columns.
struct WorkspaceNavigationView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var navigation: WorkspaceNavigationState
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    private var hosts: [DeviceInfo] { navigation.hosts }
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @ObservedObject private var consoleLinks = ConsoleLinkInbox.shared

    private var selection: Binding<WorkspaceSelection?> {
        Binding(get: { navigation.selection }, set: { navigation.select($0) })
    }

    var body: some View {
        #if os(iOS)
        GeometryReader { geometry in
            let isWide = geometry.size.width >= 700
            // Some iPhones remain compact in landscape despite having room
            // for both columns. Adapt the existing split view without replacing
            // its navigation tree or losing the selected session and draft.
            splitView
                .environment(\.horizontalSizeClass, isWide ? .regular : horizontalSizeClass)
                .task(id: isWide) {
                    guard isWide else { return }
                    // Let compact adaptation finish writing its collapsed state
                    // before restoring the wide layout. A newer resize cancels this.
                    await Task.yield()
                    guard !Task.isCancelled else { return }
                    columnVisibility = .all
                }
        }
        #else
        splitView
        #endif
    }

    private var splitView: some View {
        NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $navigation.compactColumn) {
            Group {
                if let project = navigation.project {
                    SessionListView(
                        project: project, selection: selection, hostDeviceId: navigation.hostDeviceId,
                        includeUnattributedSessions: navigation.includesUnattributedSessions
                    )
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
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    computerMenu
                }
            }
            .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 360)
        } detail: {
            // Keep the detail host stable across repeated programmatic selections.
            // Sidebar rows use List tags, not NavigationLinks: links also push
            // an implicit destination and can disappear the visible detail,
            // canceling its observers and session connection during navigation.
            NavigationStack {
                detail
            }
        }
        .navigationSplitViewStyle(.balanced)
        .task(id: appState.syncManager.map(ObjectIdentifier.init)) {
            if let manager = appState.syncManager {
                navigation.observeHosts(source: manager, publisher: manager.$connectedDevices.eraseToAnyPublisher())
            } else {
                navigation.stopObservingHosts()
            }
        }
        .onChange(of: appState.databaseManager.map(ObjectIdentifier.init)) { previous, _ in
            // Initial database hydration must retain a cold-launch notification intent.
            if previous != nil { navigation.clearAccount() }
        }
        // Universal links, nimbalyst://console, transcript links: select the page like a row.
        .onReceive(consoleLinks.routes) { route in
            // Act on the emitted value: `pending` still holds the previous one here.
            navigation.select(.pages(route))
            consoleLinks.acknowledge(route)
        }
        .alert("Personal pages live on your desktop", isPresented: $consoleLinks.personalPageRequested) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Open this page in Nimbalyst on your computer.")
        }
    }

    private var isDesktopConnected: Bool {
        if appState.screenshotMode { return true }
        return appState.syncManager?.connectedDevices.contains(where: { $0.type == "desktop" }) ?? false
    }

    private var computerMenu: some View {
        Menu {
            Picker("Machine", selection: Binding(
                get: { navigation.hostDeviceId },
                set: { navigation.hostDeviceId = $0; navigation.select(nil) }
            )) {
                Text("Choose a machine").tag(String?.none)
                ForEach(hosts, id: \.deviceId) { device in
                    Text(device.name).tag(Optional(device.deviceId))
                }
                if let host = navigation.hostDeviceId, !hosts.contains(where: { $0.deviceId == host }) {
                    Text("Remote machine · Offline").tag(Optional(host))
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 14))
                    .foregroundStyle(appState.isConnected ? .primary : .secondary)
                Circle()
                    .fill(isDesktopConnected ? Color.green : (appState.isConnected ? Color.orange : Color.gray))
                    .frame(width: 8, height: 8)
            }
        }
        .accessibilityLabel("Switch computer")
        .accessibilityIdentifier("Switch Computer")
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
                    // Wiki links select the target like a sidebar row, so the
                    // detail stack never pushes.
                    WikiAwareDocumentView(document: document) { navigation.select(.document($0)) }
                    .id(documentId)
                }
                #endif
            case .pages(let route):
                #if canImport(UIKit)
                PagesView(route: route, onLeave: { navigation.leaveDetail() }, onKeepRoute: { navigation.select(.pages($0)) })
                #endif
            case nil:
                ContentUnavailableView("Select a session or file", systemImage: "sidebar.left")
            }
        }
    }
}
