#if os(iOS)
import Foundation

extension AppState {
    func observeSessionCreation(_ sync: SyncManager) {
        let voice = voiceAgent
        sync.onSessionCreated = { [weak self, weak voice, weak sync] requestId, sessionId in
            Task { @MainActor in
                guard let self, let sync, self.syncManager === sync else { return }
                if voice?.consumePendingCreateSession(requestId: requestId) == true {
                    voice?.activeSessionId = sessionId
                }
                await self.navigateWhenSessionAvailable(sessionId)
            }
        }
    }

    /// Keep navigation pending if the creation response precedes index ingestion.
    private func navigateWhenSessionAvailable(_ sessionId: String) async {
        guard let requestedDatabase = databaseManager else {
            voiceNavigationRequest = sessionId
            return
        }
        syncManager?.requestSessionIndexLookup(sessionId: sessionId)
        for _ in 0..<25 {
            guard !Task.isCancelled, databaseManager === requestedDatabase else { return }
            if (try? requestedDatabase.session(byId: sessionId)) != nil {
                voiceNavigationRequest = sessionId
                return
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        voiceNavigationRequest = sessionId
    }
}
#endif
