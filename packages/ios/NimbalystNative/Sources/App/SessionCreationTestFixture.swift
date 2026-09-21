#if DEBUG && os(iOS)
import Foundation

/// Exercise the real creation UI and callbacks without a paired account or network.
extension AppState {
    public static func forSessionCreationTesting() -> AppState {
        let database = try! DatabaseManager()
        let project = Project(id: "/test/session-creation", name: "Session creation fixture")
        try! database.upsertProject(project)
        let fixture = SessionCreationTestTransport(database: database, projectId: project.id)
        let sync = SyncManager(
            crypto: CryptoManager(seed: "test-seed", userId: "test-user"),
            database: database, serverUrl: "https://invalid.example", userId: "test-user",
            registerDeviceCallbacks: false,
            sender: { _, json, completion in fixture.send(json, completion: completion) }
        )
        fixture.sync = sync
        sync.isConnected = true
        sync.connectedDevices = [DeviceInfo(deviceId: "fixture-desktop", name: "Fixture desktop", type: "desktop",
                                           platform: "macos", appVersion: nil, connectedAt: 0, lastActiveAt: 0,
                                           isFocused: true, status: nil)]
        let state = AppState(databaseManager: database, syncManager: sync)
        state.screenshotMode = true
        state.isConnected = true
        return state
    }
}

@MainActor
private final class SessionCreationTestTransport {
    let database: DatabaseManager
    let projectId: String
    weak var sync: SyncManager?
    private var count = 0

    init(database: DatabaseManager, projectId: String) {
        self.database = database
        self.projectId = projectId
    }

    func send(_ json: String, completion: @escaping @MainActor @Sendable (Error?) -> Void) {
        completion(nil)
        guard let request = try? JSONDecoder().decode(CreateSessionRequestMessage.self, from: Data(json.utf8)) else { return }
        count += 1
        let sessionId = "created-session-\(count)"
        let title = "Created session \(count)"
        let number = count
        Task { @MainActor in
            // Deliver after the button has registered its request, as the network does.
            try? await Task.sleep(for: .milliseconds(100))
            try! database.upsertSession(Session(id: sessionId, projectId: projectId, titleDecrypted: title,
                                               provider: "claude-code", mode: "agent",
                                               agentRole: number == 3 ? "meta-agent" : nil,
                                               worktreeId: number == 2 ? "fixture-worktree" : nil,
                                               hostDeviceId: "fixture-desktop"))
            if number == 3 {
                try! database.upsertSession(Session(id: "child-session", projectId: projectId, titleDecrypted: "Child session",
                                                   parentSessionId: sessionId, createdBySessionId: sessionId,
                                                   hostDeviceId: "fixture-desktop"))
            }
            let response = CreateSessionResponseBroadcast(type: "createSessionResponseBroadcast",
                response: CreateSessionResponse(requestId: request.request.requestId, success: true, sessionId: sessionId, error: nil),
                fromConnectionId: "fixture-desktop")
            sync?.handleIndexMessage(try! JSONEncoder().encode(response))
        }
    }
}
#endif
