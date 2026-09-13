import SwiftUI
import Combine
import GRDB
import os

/// Navigation value for "open the session this push notification named".
///
/// Keyed by session id rather than by a `Session` record because the tapped
/// session very often has not synced to this device yet. Its destination is
/// registered at the navigation stack root so a push resolves at any depth,
/// without depending on `SessionListView` having rendered first.
public struct PendingSessionRoute: Hashable, Sendable {
    public let sessionId: String

    public init(sessionId: String) {
        self.sessionId = sessionId
    }
}

/// What to push onto the navigation stack to open a notification's session.
public struct SessionNavigationPlan: Equatable, Sendable {
    /// Pushed first when known, so Back lands on that project's session list.
    /// Nil when the session has not synced yet — navigation proceeds anyway.
    public let project: Project?
    public let route: PendingSessionRoute
}

public enum SessionNavigation {
    /// Build the navigation plan for a session named by a push notification.
    ///
    /// Always yields a route, including for a session this device has never
    /// seen. Requiring the session and project to be resolvable up front is what
    /// made notification taps during the post-launch sync window do nothing.
    @MainActor
    public static func plan(for sessionId: String, in database: DatabaseManager?) -> SessionNavigationPlan {
        var project: Project?
        if let db = database,
           let session = try? db.session(byId: sessionId),
           let found = try? db.writer.read({ db in try Project.fetchOne(db, id: session.projectId) }) {
            project = found
        }
        return SessionNavigationPlan(project: project, route: PendingSessionRoute(sessionId: sessionId))
    }
}

/// Holds a notification's "open this session" intent until the session row
/// actually arrives from sync.
///
/// A push payload carries only `sessionId`, and a notification about a
/// just-created session names a row this device has never seen. Looking it up
/// once at tap time and giving up meant the tap silently did nothing, which is
/// the whole of GitHub-side issue "notification tap never navigates".
@MainActor
public final class PendingSessionResolver: ObservableObject {
    /// The session, once it exists locally. Nil while sync is still catching up.
    @Published public private(set) var session: Session?
    /// True once we have waited long enough that the user deserves an explanation.
    /// Resolution continues regardless — a late arrival still opens the session.
    @Published public private(set) var didTimeOut = false

    public let sessionId: String

    private let database: DatabaseManager
    private var cancellable: AnyDatabaseCancellable?
    private var timeoutTask: Task<Void, Never>?

    /// How long to wait before telling the user the session has not synced yet.
    public static let syncTimeout: TimeInterval = 30

    public init(
        sessionId: String,
        database: DatabaseManager,
        timeout: TimeInterval = PendingSessionResolver.syncTimeout
    ) {
        self.sessionId = sessionId
        self.database = database

        // Resolve synchronously when the row is already here so the common
        // warm-launch path never flashes a loading state.
        session = try? database.session(byId: sessionId)
        guard session == nil else { return }

        startObserving()
        startTimeout(after: timeout)
    }

    deinit {
        cancellable?.cancel()
        timeoutTask?.cancel()
    }

    private func startObserving() {
        let id = sessionId
        let observation = ValueObservation.tracking { db in
            try Session.fetchOne(db, id: id)
        }
        cancellable = observation.start(
            in: database.writer,
            onError: { error in
                Logger(subsystem: "com.nimbalyst.app", category: "PendingSessionResolver")
                    .error("Observation failed for \(id): \(error.localizedDescription)")
            },
            onChange: { [weak self] session in
                guard let self, let session else { return }
                MainActor.assumeIsolated {
                    self.session = session
                    self.timeoutTask?.cancel()
                    self.cancellable?.cancel()
                    self.cancellable = nil
                }
            }
        )
    }

    private func startTimeout(after timeout: TimeInterval) {
        timeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            guard !Task.isCancelled, let self, self.session == nil else { return }
            self.didTimeOut = true
        }
    }
}

/// Renders the session a notification tap asked for, showing a loading state
/// while sync catches up rather than dropping the navigation on the floor.
public struct PendingSessionView: View {
    @EnvironmentObject var appState: AppState
    @StateObject private var resolver: PendingSessionResolver

    /// Called once the session resolves to align the sidebar project with the detail.
    private let onResolve: (Session) -> Void
    private let composeState: SessionComposeState?

    public init(
        sessionId: String,
        database: DatabaseManager,
        composeState: SessionComposeState? = nil,
        onResolve: @escaping (Session) -> Void = { _ in }
    ) {
        _resolver = StateObject(wrappedValue: PendingSessionResolver(sessionId: sessionId, database: database))
        self.onResolve = onResolve
        self.composeState = composeState
    }

    public var body: some View {
        Group {
            if let session = resolver.session {
                SessionDetailView(session: session, composeState: composeState)
                    .environmentObject(appState)
            } else {
                waitingView
            }
        }
        .onChange(of: resolver.session) { _, newValue in
            guard let session = newValue else { return }
            onResolve(session)
        }
        .onAppear {
            if let session = resolver.session {
                onResolve(session)
            } else {
                // Fetch the requested row before continuing background history.
                appState.syncManager?.requestSessionIndexLookup(sessionId: resolver.sessionId)
            }
        }
    }

    private var waitingView: some View {
        VStack(spacing: 16) {
            if resolver.didTimeOut {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 40))
                    .foregroundStyle(.secondary)
                Text("Still Syncing")
                    .font(.title3)
                Text("This session hasn't reached this device yet. It will open as soon as it arrives.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Retry Sync") {
                    appState.requestSync()
                    appState.syncManager?.requestSessionIndexLookup(sessionId: resolver.sessionId)
                }
                .buttonStyle(.bordered)
            } else {
                ProgressView()
                Text("Opening session…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("")
    }
}
