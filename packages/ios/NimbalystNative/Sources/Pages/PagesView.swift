#if canImport(UIKit)
import SwiftUI
import Combine
import UIKit
import WebKit

/// `UIApplication.beginBackgroundTask` for the flush coordinator.
@MainActor
final class UIKitBackgroundTasks: BackgroundTaskScheduling {
    func begin(name: String, expiration: @escaping @MainActor () -> Void) -> Int? {
        let id = UIApplication.shared.beginBackgroundTask(withName: name) {
            MainActor.assumeIsolated { expiration() }
        }
        return id == .invalid ? nil : id.rawValue
    }

    func end(_ id: Int) {
        UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: id))
    }
}

/// Hosts the controller's long-lived web view. The view is moved into each new
/// container, so SwiftUI remounting the detail never creates a second WKWebView.
private struct PagesWebViewHost: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .systemBackground
        attach(to: container)
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        if webView.superview !== container { attach(to: container) }
    }

    private func attach(to container: UIView) {
        webView.removeFromSuperview()
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }
}

/// A team's Wiki or Trackers from the web console, as a detail destination.
struct PagesView: View {
    let route: ConsoleRoute
    let onLeave: () -> Void
    /// A replacement the reader refused: re-select the page still on screen.
    let onKeepRoute: (ConsoleRoute) -> Void
    @EnvironmentObject private var appState: AppState

    var body: some View {
        if let controller = appState.currentPagesController() {
            PagesScreen(route: route, controller: controller, onLeave: onLeave, onKeepRoute: onKeepRoute)
        } else if appState.pagesAccount() == nil {
            ContentUnavailableView("Sign in to read team pages", systemImage: "person.crop.circle.badge.exclamationmark")
        } else if appState.pagesStoreBlocked {
            ContentUnavailableView {
                Label("Team pages aren't ready", systemImage: "externaldrive.badge.exclamationmark")
            } description: {
                Text("The previous team sign-in on this device could not be cleared yet.")
            } actions: {
                Button("Retry") { Task { await appState.preparePagesController() } }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            ProgressView()
                .task { await appState.preparePagesController() }
        }
    }
}

private struct PagesScreen: View {
    let route: ConsoleRoute
    @ObservedObject var controller: PagesWebController
    let onLeave: () -> Void
    let onKeepRoute: (ConsoleRoute) -> Void
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var isCompact: Bool { horizontalSizeClass == .compact }
    private var fallbackTitle: String { route.path.contains("/trackers") ? "Team Trackers" : "Team Wiki" }

    var body: some View {
        ZStack {
            PagesWebViewHost(webView: controller.webView)
                .opacity(isFailed ? 0 : 1)
            overlay
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if controller.lostEditsNotice { lostEditsBanner }
        }
        .navigationTitle(controller.title.isEmpty ? fallbackTitle : controller.title)
        .navigationBarTitleDisplayMode(.inline)
        // In a collapsed split view the system back pops the screen without
        // asking. Our button walks web history first and asks before leaving
        // unsynced edits.
        .navigationBarBackButtonHidden(isCompact)
        .toolbar {
            if isCompact || controller.canGoBack {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { if await controller.requestBack() { onLeave() } }
                    } label: {
                        Label("Back", systemImage: "chevron.backward")
                    }
                    .accessibilityIdentifier("pages-back")
                }
            }
            if controller.unsynced {
                ToolbarItem(placement: .topBarTrailing) {
                    Label("Not saved yet", systemImage: "icloud.slash")
                        .labelStyle(.titleAndIcon)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("pages-unsynced")
                }
            }
        }
        // Sidebar rows, links and pushes all replace the page through the leave guard.
        .task(id: route) { await controller.requestOpen(route) }
        .confirmationDialog(
            "Leave without saving?",
            isPresented: Binding(get: { controller.pendingLeave != nil }, set: { if !$0 { keepEditing() } }),
            titleVisibility: .visible
        ) {
            Button("Leave", role: .destructive) {
                guard let task = controller.confirmPendingLeave() else { return }
                Task { if await task.value { onLeave() } }
            }
            Button("Keep Editing", role: .cancel) { keepEditing() }
        } message: {
            Text("Your last changes have not reached the server.")
        }
        .alert(item: $controller.sheet) { sheet in alert(for: sheet) }
    }

    private func keepEditing() {
        if let kept = controller.cancelPendingLeave(), kept != route { onKeepRoute(kept) }
    }

    private var isFailed: Bool {
        if case .failed = controller.phase { return true }
        return false
    }

    @ViewBuilder
    private var overlay: some View {
        switch controller.phase {
        case .idle, .ready:
            EmptyView()
        case .loading:
            ProgressView().controlSize(.large)
        case .failed(let failure):
            failureView(failure)
        }
    }

    private func failureView(_ failure: PagesFailure) -> some View {
        let (title, symbol, message): (String, String, String) = {
            switch failure {
            case .offline:
                return ("Pages need a connection", "wifi.slash", "Connect to the internet to read your team's pages.")
            case .load(let detail):
                return ("Couldn't load this page", "exclamationmark.triangle", detail)
            case .server(let status):
                return ("Couldn't load this page", "exclamationmark.triangle", "The server returned an error (\(status)).")
            case .session(let detail):
                return ("Couldn't sign in to your team", "person.crop.circle.badge.exclamationmark", detail)
            }
        }()
        return ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(message)
        } actions: {
            Button("Retry") { controller.retry() }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("pages-retry")
        }
        .accessibilityIdentifier("pages-failure")
    }

    private var lostEditsBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.circle")
            Text("Your last edits may not have saved.")
                .font(.footnote)
            Spacer()
            Button {
                controller.lostEditsNotice = false
            } label: {
                Image(systemName: "xmark")
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.orange.opacity(0.15))
        .accessibilityIdentifier("pages-lost-edits")
    }

    private func alert(for sheet: PagesSheet) -> Alert {
        switch sheet {
        case .personalPages:
            return Alert(
                title: Text("Personal pages live on your desktop"),
                message: Text("Open this page in Nimbalyst on your computer."),
                dismissButton: .default(Text("OK"))
            )
        case .desktopOnly:
            return Alert(
                title: Text("Open this on your desktop"),
                message: Text("This link opens in Nimbalyst on your computer."),
                dismissButton: .default(Text("OK"))
            )
        case .orgAuthRequired:
            let origin = controller.environment.origin
            return Alert(
                title: Text("This team requires additional sign-in"),
                message: Text("Your team's security settings need a sign-in this app can't do yet. Open the console in Safari to continue."),
                primaryButton: .default(Text("Open in Safari")) { UIApplication.shared.open(origin) },
                secondaryButton: .cancel()
            )
        }
    }
}

// MARK: - Sidebar entry

/// Whether the chosen project has a team project, loaded from the team directory.
@MainActor
final class ConsoleProjectMappingModel: ObservableObject {
    @Published private(set) var mapping: ConsoleProjectMapping = .unmapped
    @Published private(set) var allMatches: [ConsoleTeamProjectMatch] = []
    /// The team directory could not be read, so "no team" is unknown, not an answer.
    @Published private(set) var discoveryFailed = false
    @Published private(set) var isLoading = false
    private var project: Project?
    private weak var appState: AppState?
    private var reconnect: AnyCancellable?

    /// A mapped project, or one whose mapping could not be checked (with Retry).
    var showsTeamTab: Bool { mapping != .unmapped || discoveryFailed }

    func load(project: Project, appState: AppState) async {
        if self.project?.id != project.id {
            mapping = .unmapped
            allMatches = []
            discoveryFailed = false
        }
        self.project = project
        self.appState = appState
        #if DEBUG
        if let fixture = appState.consolePagesFixtureMatch {
            allMatches = [fixture]
            mapping = .mapped(fixture)
            return
        }
        #endif
        guard let broker = appState.consoleBroker, let hash = project.gitRemoteHash, !hash.isEmpty else {
            allMatches = []
            mapping = .unmapped
            discoveryFailed = false
            return
        }
        observeReconnect(appState)
        isLoading = true
        let outcome = await broker.teams()
        guard self.project?.id == project.id else { return }
        isLoading = false
        switch outcome {
        case .loaded(let teams):
            discoveryFailed = false
            allMatches = ConsoleTeamResolver.matches(gitRemoteHash: hash, teams: teams)
            mapping = ConsoleTeamResolver.mapping(
                gitRemoteHash: hash,
                teams: teams,
                rememberedOrgId: broker.rememberedOrgId(forProjectId: project.id)
            )
        case .failed(let reason):
            // Keep a mapping already shown; otherwise say the check failed.
            if reason == "signed_out" || reason == "account_changed" { return }
            if mapping == .unmapped { discoveryFailed = true }
        }
    }

    func retry() async {
        guard let project, let appState else { return }
        await load(project: project, appState: appState)
    }

    /// A failed check is retried when the device comes back online.
    private func observeReconnect(_ appState: AppState) {
        guard reconnect == nil else { return }
        reconnect = appState.pagesReachability().$isOnline
            .removeDuplicates()
            .dropFirst()
            .filter { $0 }
            .sink { [weak self] _ in
                guard let self, self.discoveryFailed else { return }
                Task { await self.retry() }
            }
    }

    func choose(_ match: ConsoleTeamProjectMatch, appState: AppState) {
        guard let project else { return }
        appState.consoleBroker?.rememberOrgChoice(match.orgId, forProjectId: project.id)
        mapping = .mapped(match)
    }

    func chooseAgain() {
        if allMatches.count > 1 { mapping = .needsChoice(allMatches) }
    }
}

/// The Team tab: the team console's Wiki and Trackers for this project. Kept
/// apart from the local Wiki tab, which reads the project's own markdown.
struct TeamPagesList: View {
    @ObservedObject var model: ConsoleProjectMappingModel
    @Binding var selection: WorkspaceSelection?
    @EnvironmentObject private var appState: AppState

    var body: some View {
        List(selection: $selection) {
            switch model.mapping {
            case .mapped(let match):
                Section {
                    if let route = match.wikiRoute {
                        Label("Team Wiki", systemImage: "book.pages")
                            .tag(WorkspaceSelection.pages(route))
                            .accessibilityIdentifier("team-wiki-row")
                    }
                    if let route = match.trackersRoute {
                        Label("Team Trackers", systemImage: "checklist")
                            .tag(WorkspaceSelection.pages(route))
                            .accessibilityIdentifier("team-trackers-row")
                    }
                } header: {
                    Text(match.orgName)
                } footer: {
                    if model.allMatches.count > 1 {
                        Button("Use a different team") { model.chooseAgain() }
                            .font(.footnote)
                    }
                }
            case .needsChoice(let matches):
                Section {
                    ForEach(matches) { match in
                        Button(match.orgName) { model.choose(match, appState: appState) }
                    }
                } header: {
                    Text("Choose a team")
                } footer: {
                    Text("This project is shared with more than one team.")
                }
            case .unmapped:
                if model.discoveryFailed {
                    Section {
                        Button {
                            Task { await model.retry() }
                        } label: {
                            if model.isLoading {
                                ProgressView()
                            } else {
                                Label("Retry", systemImage: "arrow.clockwise")
                            }
                        }
                        .disabled(model.isLoading)
                        .accessibilityIdentifier("team-discovery-retry")
                    } header: {
                        Text("Couldn't check for a team project")
                    } footer: {
                        Text("Your teams could not be loaded. This retries when you're back online.")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}
#endif
