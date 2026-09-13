#if DEBUG
import Foundation

extension AppState {
    /// The real Files screen and transport, with an isolated in-memory account.
    public static func forDocumentSyncTesting(serverUrl: String) -> AppState {
        precondition(URL(string: serverUrl)?.host == "127.0.0.1", "Document fixtures must be local")
        let db = try! DatabaseManager()
        try! db.upsertProject(Project(id: "/test/network-files", name: "File sync fixture"))
        let crypto = CryptoManager(seed: "test-seed", userId: "test-user")
        let sync = DocumentSyncManager(crypto: crypto, database: db, serverUrl: serverUrl, userId: "test-user")
        sync.setAuth(authToken: "ui-test-token", authUserId: "test-user", orgId: "test-org")
        let state = AppState(databaseManager: db, documentSyncManager: sync)
        state.screenshotMode = true
        state.isConnected = true
        state.indexLoadState = .loaded
        return state
    }

    /// Deterministic delayed, empty index for testing the production list screens.
    public static func forLoadingScreenshots() -> AppState {
        let state = AppState(databaseManager: try! DatabaseManager())
        state.screenshotMode = true
        state.isConnected = true
        state.indexLoadState = .loading
        Task { @MainActor [weak state] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            state?.indexLoadState = .loaded
        }
        return state
    }
}
#endif
