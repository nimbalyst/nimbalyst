import Foundation
import Combine
import os

/// Manages synchronization between the native app and the desktop via WebSocket.
/// Handles index room sync (projects + sessions) and session room sync (messages).
///
/// Architecture:
///   - Connects to the index room: `user:<userId>:index`
///   - Receives encrypted sessions and projects from the server
///   - Decrypts using CryptoManager and stores in SQLite via DatabaseManager
///   - SwiftUI views observe the database for reactive updates
@MainActor
public final class SyncManager: ObservableObject {
    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncManager")

    private let crypto: CryptoManager
    private let database: DatabaseManager
    private let indexClient: WebSocketClient = {
        let client = WebSocketClient()
        client.sendsDeviceAnnounce = true
        return client
    }()
    private let sessionClient = WebSocketClient()
    private let decoder = JSONDecoder()

    @Published public var isConnected = false
    @Published public var connectedDevices: [DeviceInfo] = []

    /// The session ID currently connected to the session room, if any.
    @Published public var activeSessionId: String?

    /// Available AI models synced from the desktop, for the model picker.
    @Published public var availableModels: [SyncedAvailableModel] = []

    /// The desktop's default model ID (e.g., "claude-code:opus").
    @Published public var desktopDefaultModel: String?

    /// When true, most or all encrypted data failed to decrypt, indicating
    /// the encryption key is wrong and the user needs to re-pair.
    @Published public var encryptionKeyMismatch = false

    /// Called when a session transitions from executing to idle (isExecuting: true -> false).
    /// Parameters: (sessionId, lastAssistantMessageSummary)
    public var onSessionCompleted: ((String, String) -> Void)?

    /// Called when settings are synced from the desktop (e.g., OpenAI API key, voice mode config).
    public var onSettingsSynced: ((SyncedSettings) -> Void)?

    /// Called with diagnostic info when session message sync completes (success or failure).
    /// Parameters: (sessionId, diagnostic).
    ///
    /// Deprecated: prefer `addSessionSyncDiagnosticHandler(sessionId:handler:)`,
    /// which is robust against the SwiftUI lifecycle race where an outgoing
    /// view's `onDisappear` nulls the single shared callback before the
    /// incoming view's `onAppear` has re-registered, causing sync diagnostics
    /// to be silently dropped for the newly-opened session. Kept as a fallback
    /// so any remaining single-callback consumers still fire.
    public var onSessionSyncDiagnostic: ((String, SessionSyncDiagnostic) -> Void)?

    /// Per-session diagnostic handlers. Multiple views (e.g., outgoing + incoming
    /// during navigation) can subscribe without stomping on each other.
    private var sessionSyncDiagnosticHandlers: [String: (SessionSyncDiagnostic) -> Void] = [:]

    /// Register a diagnostic handler for a specific session.
    /// Replaces any previous handler for the same sessionId.
    public func addSessionSyncDiagnosticHandler(
        sessionId: String,
        handler: @escaping (SessionSyncDiagnostic) -> Void
    ) {
        sessionSyncDiagnosticHandlers[sessionId] = handler
    }

    /// Remove the diagnostic handler for a specific session.
    public func removeSessionSyncDiagnosticHandler(sessionId: String) {
        sessionSyncDiagnosticHandlers.removeValue(forKey: sessionId)
    }

    /// Dispatch a diagnostic to both the per-session handler (if registered)
    /// and the legacy single-callback consumer.
    private func emitSessionSyncDiagnostic(_ sessionId: String, _ diagnostic: SessionSyncDiagnostic) {
        sessionSyncDiagnosticHandlers[sessionId]?(diagnostic)
        onSessionSyncDiagnostic?(sessionId, diagnostic)
    }

    private var serverUrl: String
    private var userId: String
    /// The Stytch user ID for room routing (from JWT sub claim). May differ from pairing userId.
    private var authUserId: String?
    private var authToken: String?
    /// The Stytch organization ID for org-scoped room IDs.
    private var orgId: String?

    /// Buffer for paginated sync responses before committing to DB.
    private var sessionSyncBuffer: [ServerMessageEntry] = []

    public init(crypto: CryptoManager, database: DatabaseManager, serverUrl: String, userId: String) {
        self.crypto = crypto
        self.database = database
        self.serverUrl = serverUrl
        self.userId = userId

        setupIndexClient()
        setupSessionClient()
        setupPushTokenForwarding()
    }

    // MARK: - Activity Tracking

    /// Report actual user interaction (touch, scroll, tap, etc.).
    /// Call this from views when the user actively interacts with the app.
    public func reportUserActivity() {
        indexClient.reportActivity()
    }

    /// Update whether the app is in the foreground.
    /// Coming to foreground counts as user activity.
    /// When returning to foreground, reconnects WebSockets if they were dropped while backgrounded.
    public func setAppInForeground(_ inForeground: Bool) {
        indexClient.setAppInForeground(inForeground)
        if inForeground {
            reconnectIfNeeded()
            // Defense in depth: even if the reconnect's onConnectionStateChanged
            // callback fires the sync request, also trigger one explicitly
            // here. Two sync requests are harmless (database appends are
            // idempotent on message ID), and this guarantees a catch-up
            // happens even if the reconnect callback chain ever changes.
            if activeSessionId != nil {
                requestSessionSync()
            }
        }
    }

    /// Reconnect the index WebSocket if it was dropped (e.g., by iOS suspending the app).
    /// Also reconnects the active session room if one was open.
    ///
    /// The session client is reconnected unconditionally (not gated on
    /// `isConnected`) because URLSessionWebSocketTask can hold a backgrounded
    /// task in `.running` state long after the underlying TCP connection has
    /// died, so `isConnected` would lie and the user would be left with a
    /// silently-dead transcript channel until they navigate away and back.
    /// Forcing a fresh socket here is cheap; missing transcript broadcasts
    /// is not. The session client also re-issues `requestSessionSync` on
    /// reconnect (via `onConnectionStateChanged`), so any broadcasts dropped
    /// while we were backgrounded are caught up via the syncResponse cursor.
    private func reconnectIfNeeded() {
        if !indexClient.isConnected {
            logger.info("[Reconnect] Index client disconnected, reconnecting...")
            indexClient.reconnect()
        }
        if let sessionId = activeSessionId {
            logger.info("[Reconnect] Forcing session client reconnect for \(sessionId)")
            sessionClient.reconnect()
        }
    }

    // MARK: - Connection

    /// Connect to the index room and begin syncing.
    /// The `authUserId` is the Stytch user ID from the JWT's `sub` claim, used for room ID construction.
    /// This may differ from the pairing `userId` (which can be an email or analytics ID).
    /// The `orgId` is the Stytch organization ID from B2B discovery, required for org-scoped room IDs.
    public func connect(authToken: String, authUserId: String? = nil, orgId: String) {
        self.authToken = authToken
        self.authUserId = authUserId
        self.orgId = orgId
        let roomId = "org:\(orgId):user:\(effectiveUserId):index"
        logger.info("[Connect] IndexRoom roomId=\(roomId), orgId=\(orgId), effectiveUserId=\(self.effectiveUserId), authUserId=\(authUserId ?? "nil"), pairingUserId=\(self.userId)")
        indexClient.connect(serverUrl: serverUrl, roomId: roomId, authToken: authToken)

        // If a session room is active, reconnect it with the fresh token.
        // Without this, the session client keeps the old JWT and the server
        // rejects reconnect attempts after the JWT expires.
        if let sessionId = activeSessionId {
            let sessionRoomId = "org:\(orgId):user:\(effectiveUserId):session:\(sessionId)"
            logger.info("[Connect] Reconnecting session room with fresh token: \(sessionRoomId)")
            sessionClient.connect(serverUrl: serverUrl, roomId: sessionRoomId, authToken: authToken)
        }
    }

    /// The user ID to use for room routing. Prefers authUserId (from JWT) over pairing userId.
    private var effectiveUserId: String {
        authUserId ?? userId
    }

    /// Disconnect from all rooms.
    public func disconnect() {
        leaveSessionRoom()
        indexClient.disconnect()
    }

    // MARK: - Session Room

    /// Join a session room to sync messages.
    public func joinSessionRoom(sessionId: String) {
        guard let authToken = authToken else {
            return
        }

        // Leave current session room if any
        if activeSessionId != nil {
            leaveSessionRoom()
        }

        activeSessionId = sessionId
        sessionSyncBuffer = []

        let roomId = "org:\(orgId ?? ""):user:\(effectiveUserId):session:\(sessionId)"
        sessionClient.connect(serverUrl: serverUrl, roomId: roomId, authToken: authToken)

        // If the session is already mid-turn when we join, start pings now.
        // The normal start path is the !executing -> executing transition in
        // handleMetadataBroadcast, but that only fires on a state change --
        // joining a session that's already running wouldn't trigger it.
        if let session = try? database.session(byId: sessionId), session.isExecuting {
            sessionClient.startPings()
        }
    }

    /// Leave the current session room.
    ///
    /// Pass `expectedSessionId` to scope the leave to a specific session.
    /// This prevents a SwiftUI lifecycle race where the outgoing view's
    /// `.onDisappear` fires AFTER the incoming view's `.task` has already
    /// joined a new room -- in that case, calling a bare `leaveSessionRoom()`
    /// would tear down the new session's socket and null out activeSessionId,
    /// leaving the new session stuck forever waiting for a sync response.
    public func leaveSessionRoom(expectedSessionId: String? = nil) {
        if let expectedSessionId = expectedSessionId,
           activeSessionId != expectedSessionId {
            logger.info("leaveSessionRoom: skipping stale leave for \(expectedSessionId) — active is \(self.activeSessionId ?? "nil")")
            return
        }
        sessionClient.disconnect()
        activeSessionId = nil
        sessionSyncBuffer = []
    }

    // MARK: - Index Client Setup

    private func setupIndexClient() {
        indexClient.onConnectionStateChanged = { [weak self] connected in
            Task { @MainActor in
                self?.isConnected = connected
                if connected {
                    self?.requestIndexSync()
                    if NotificationManager.shared.shouldRegisterForPush,
                       let token = NotificationManager.shared.deviceToken {
                        self?.registerPushToken(token)
                    } else {
                        self?.unregisterPushToken()
                    }
                }
            }
        }

        indexClient.onMessage = { [weak self] data in
            Task { @MainActor in
                self?.handleIndexMessage(data)
            }
        }
    }

    /// Request a full index sync (ignoring watermark). Called by AppState on pull-to-refresh.
    public func requestFullSync() {
        requestIndexSync(fullSync: true)
    }

    /// Request the index from the server.
    /// By default, sends the last sync watermark for incremental sync.
    /// Pass `fullSync: true` to request everything (e.g., pull-to-refresh).
    private func requestIndexSync(fullSync: Bool = false, attempt: Int = 0) {
        let since: Int? = fullSync ? nil : (try? database.syncState(forRoom: "index"))?.lastSyncedAt

        let request = IndexSyncRequest(projectId: nil, since: since)
        guard let data = try? JSONEncoder().encode(request),
              let json = String(data: data, encoding: .utf8) else { return }

        indexClient.sendRaw(json) { [weak self] error in
            guard let self = self, error != nil else { return }
            guard attempt < 3 else { return }

            self.logger.info("Index sync request failed, retrying (attempt \(attempt + 1))")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                self?.requestIndexSync(attempt: attempt + 1)
            }
        }
    }

    // MARK: - Message Handling

    private func handleIndexMessage(_ data: Data) {
        // First, determine the message type
        guard let envelope = try? decoder.decode(ServerMessage.self, from: data) else {
            logger.warning("Could not decode message type")
            return
        }

        switch envelope.type {
        case "indexSyncResponse":
            handleIndexSyncResponse(data)
        case "indexBroadcast":
            handleIndexBroadcast(data)
        case "indexDeleteBroadcast":
            handleIndexDeleteBroadcast(data)
        case "projectBroadcast":
            handleProjectBroadcast(data)
        case "createSessionResponseBroadcast":
            handleCreateSessionResponse(data)
        case "devicesList":
            handleDevicesList(data)
        case "deviceJoined":
            handleDeviceJoined(data)
        case "deviceLeft":
            handleDeviceLeft(data)
        case "settingsSyncBroadcast":
            handleSettingsSyncBroadcast(data)
        case "createWorktreeResponseBroadcast":
            // Response to our worktree creation request - the worktree session
            // will appear via indexBroadcast, so no special handling needed
            break
        case "error":
            handleServerError(data)
        default:
            logger.info("Unhandled message type: \(envelope.type)")
        }
    }

    // MARK: - Index Sync Response

    private func handleIndexSyncResponse(_ data: Data) {
        guard let response = try? decoder.decode(IndexSyncResponse.self, from: data) else {
            logger.error("Failed to decode index_sync_response")
            return
        }

        let isIncremental = response.since != nil
        if !isIncremental, let total = response.totalSessionCount, total != response.sessions.count {
            logger.warning("INDEX TRUNCATION DETECTED! Server COUNT(*)=\(total) but received \(response.sessions.count) sessions")
        }
        logger.info("Index sync received: \(response.sessions.count) sessions, \(response.projects.count) projects\(isIncremental ? " (incremental)" : "") (server total: \(response.totalSessionCount.map(String.init) ?? "unknown"))")

        // Heavy crypto + DB work runs off the main thread to avoid UI freezes
        let crypto = self.crypto
        let database = self.database
        Task.detached {
            // Process projects
            for serverProject in response.projects {
                Self.processServerProjectBackground(serverProject, crypto: crypto, database: database)
            }

            // Process sessions - track success/failure/skip counts
            var processedCount = 0
            var skippedCount = 0
            var failedDecryptCount = 0
            for serverSession in response.sessions {
                let result = Self.processServerSessionBackground(serverSession, crypto: crypto, database: database)
                switch result {
                case .updated: processedCount += 1
                case .skipped: skippedCount += 1
                case .failed: failedDecryptCount += 1
                }
            }
            if failedDecryptCount > 0 || skippedCount > 0 {
                let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncManager")
                logger.info("Session processing: \(processedCount) updated, \(skippedCount) unchanged, \(failedDecryptCount) failed")
            }

            // If the vast majority of sessions failed to decrypt, the encryption key is wrong.
            // This happens when the pairing encryption seed or userId salt is out of sync
            // with the desktop. The user needs to re-pair.
            let totalAttempted = processedCount + failedDecryptCount
            let isMismatch = totalAttempted > 5 && failedDecryptCount > (totalAttempted * 80 / 100)
            if isMismatch {
                let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncManager")
                logger.error("Encryption key mismatch detected: \(failedDecryptCount)/\(totalAttempted) sessions failed to decrypt")
                await MainActor.run { [weak self] in
                    self?.encryptionKeyMismatch = true
                }
            }

            // Recalculate project stats from session data (more reliable than server-side stats)
            do {
                try database.refreshAllProjectStats()
            } catch {
                let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncManager")
                logger.error("Failed to refresh project stats: \(error.localizedDescription)")
            }

            // Update sync state watermark using the max updatedAt from received sessions.
            // This ensures the `since` parameter on the next request matches server timestamps exactly.
            let maxUpdatedAt = response.sessions.map(\.updatedAt).max()
            if let watermark = maxUpdatedAt {
                let syncState = SyncState(roomId: "index", lastCursor: nil, lastSequence: 0, lastSyncedAt: watermark)
                try? database.updateSyncState(syncState)
            }
        }
    }

    // MARK: - Background Processing Helpers

    private enum SyncResult {
        case updated, skipped, failed
    }

    /// Process a server project entry on a background thread.
    private nonisolated static func processServerProjectBackground(_ entry: ServerProjectEntry, crypto: CryptoManager, database: DatabaseManager) {
        let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncManager")

        guard let projectId = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedProjectId,
            ivBase64: entry.projectIdIv
        ) else {
            logger.warning("Failed to decrypt project ID")
            return
        }

        // Decrypt project config if present
        var commandsJson: String? = nil
        if let encryptedConfig = entry.encryptedConfig,
           let configIv = entry.configIv,
           let configJson = crypto.decryptOrNil(encryptedBase64: encryptedConfig, ivBase64: configIv),
           let configData = configJson.data(using: .utf8),
           let config = try? JSONDecoder().decode(ProjectConfig.self, from: configData) {
            // Encode just the commands array as JSON for storage
            if let encoded = try? JSONEncoder().encode(config.commands),
               let jsonStr = String(data: encoded, encoding: .utf8) {
                commandsJson = jsonStr
            }
        }

        let name = (projectId as NSString).lastPathComponent
        let project = Project(
            id: projectId,
            name: name,
            sessionCount: entry.sessionCount ?? 0,
            lastUpdatedAt: entry.lastActivityAt,
            commandsJson: commandsJson,
            gitRemoteHash: entry.gitRemoteHash
        )

        do {
            try database.upsertProject(project)
            // Server's sessionCount includes archived sessions; recompute locally
            // so the displayed count matches what SessionListView actually shows.
            try database.refreshSessionCount(forProject: projectId)
        } catch {
            logger.error("Failed to upsert project: \(error.localizedDescription)")
        }
    }

    /// Process a server session entry on a background thread.
    @discardableResult
    private nonisolated static func processServerSessionBackground(_ entry: ServerSessionEntry, crypto: CryptoManager, database: DatabaseManager) -> SyncResult {
        let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncManager")

        let existing = try? database.session(byId: entry.sessionId)

        // Skip if the session hasn't changed since we last wrote it
        if let existing = existing, existing.updatedAt == entry.updatedAt {
            return .skipped
        }

        guard let projectId = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedProjectId,
            ivBase64: entry.projectIdIv
        ) else {
            logger.warning("Failed to decrypt project ID for session \(entry.sessionId)")
            return .failed
        }

        // Ensure the project exists
        if (try? database.writer.read({ db in try Project.fetchOne(db, id: projectId) })) == nil {
            let projectName = (projectId as NSString).lastPathComponent
            let project = Project(id: projectId, name: projectName, lastUpdatedAt: entry.updatedAt)
            try? database.upsertProject(project)
        }

        let titleDecrypted = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedTitle,
            ivBase64: entry.titleIv
        )

        var clientMeta: ClientMetadata?
        if let encryptedMeta = entry.encryptedClientMetadata,
           let metaIv = entry.clientMetadataIv,
           let metaJson = crypto.decryptOrNil(encryptedBase64: encryptedMeta, ivBase64: metaIv),
           let metaData = metaJson.data(using: .utf8) {
            clientMeta = try? JSONDecoder().decode(ClientMetadata.self, from: metaData)
        }

        // Encode tags array to JSON string for storage
        var tagsJson: String? = nil
        if let tags = clientMeta?.tags, !tags.isEmpty,
           let data = try? JSONEncoder().encode(tags) {
            tagsJson = String(data: data, encoding: .utf8)
        }

        let session = Session(
            id: entry.sessionId,
            projectId: projectId,
            titleEncrypted: entry.encryptedTitle,
            titleIv: entry.titleIv,
            titleDecrypted: titleDecrypted,
            // Preserve local provider/model/mode when the server omits them.
            // Older server rows can be missing these fields, and overwriting
            // with nil wipes the session's identity (e.g. the session-list
            // badge would lose "Opus 4.7" because the incoming entry had a
            // null model column). Matches the pattern used for every other
            // field below.
            provider: entry.provider ?? existing?.provider,
            model: entry.model ?? existing?.model,
            mode: entry.mode ?? existing?.mode,
            sessionType: entry.sessionType ?? existing?.sessionType,
            parentSessionId: entry.parentSessionId ?? existing?.parentSessionId,
            phase: clientMeta?.phase ?? existing?.phase,
            tagsJson: tagsJson ?? existing?.tagsJson,
            worktreeId: entry.worktreeId ?? existing?.worktreeId,
            isArchived: entry.isArchived ?? existing?.isArchived ?? false,
            isPinned: entry.isPinned ?? existing?.isPinned ?? false,
            branchedFromSessionId: entry.branchedFromSessionId ?? existing?.branchedFromSessionId,
            branchPointMessageId: entry.branchPointMessageId ?? existing?.branchPointMessageId,
            branchedAt: entry.branchedAt ?? existing?.branchedAt,
            isExecuting: entry.isExecuting ?? existing?.isExecuting ?? false,
            hasQueuedPrompts: clientMeta?.hasPendingPrompt ?? entry.hasPendingPrompt ?? existing?.hasQueuedPrompts ?? false,
            contextTokens: clientMeta?.currentContext?.tokens ?? existing?.contextTokens,
            contextWindow: clientMeta?.currentContext?.contextWindow ?? existing?.contextWindow,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            lastSyncedSeq: entry.messageCount ?? existing?.lastSyncedSeq ?? 0,
            lastReadAt: entry.lastReadAt ?? existing?.lastReadAt,
            lastMessageAt: entry.lastMessageAt ?? existing?.lastMessageAt,
            // "" from remote means "cleared" -> nil locally; nil means "not sent" -> keep existing
            draftInput: clientMeta?.draftInput != nil ? (clientMeta!.draftInput!.isEmpty ? nil : clientMeta!.draftInput!) : existing?.draftInput,
            draftUpdatedAt: clientMeta?.draftUpdatedAt ?? existing?.draftUpdatedAt
        )

        do {
            try database.upsertSession(session)
            try database.updateProjectLastActivity(projectId: projectId, activityAt: entry.updatedAt)

            // Decrypt and store queued prompts from remote for display
            if let encryptedPrompts = entry.encryptedQueuedPrompts, !encryptedPrompts.isEmpty {
                var decrypted: [QueuedPrompt] = []
                for ep in encryptedPrompts {
                    guard let plaintext = crypto.decryptOrNil(encryptedBase64: ep.encryptedPrompt, ivBase64: ep.iv) else {
                        continue
                    }
                    decrypted.append(QueuedPrompt(
                        id: ep.id,
                        sessionId: entry.sessionId,
                        promptTextEncrypted: ep.encryptedPrompt,
                        iv: ep.iv,
                        createdAt: ep.timestamp,
                        sentAt: nil,
                        promptTextDecrypted: plaintext,
                        source: ep.source ?? "desktop"
                    ))
                }
                try? database.replaceQueuedPrompts(forSession: entry.sessionId, with: decrypted)
            } else if entry.queuedPromptCount == 0 || entry.encryptedQueuedPrompts?.isEmpty == true {
                try? database.deleteRemoteQueuedPrompts(forSession: entry.sessionId)
            }

            return .updated
        } catch {
            logger.error("Failed to upsert session: \(error.localizedDescription)")
            return .failed
        }
    }

    // MARK: - Process Server Entries

    private func processServerProject(_ entry: ServerProjectEntry) {
        // Decrypt project ID (uses fixed IV for deterministic matching)
        guard let projectId = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedProjectId,
            ivBase64: entry.projectIdIv
        ) else {
            logger.warning("Failed to decrypt project ID")
            return
        }

        // Always use last path component as project name.
        // The server stores encrypted_project_id as the name placeholder,
        // so decrypting it gives the full workspace path (not a human-friendly name).
        let name = (projectId as NSString).lastPathComponent

        // Decrypt project config if present
        var commandsJson: String? = nil
        if let encryptedConfig = entry.encryptedConfig,
           let configIv = entry.configIv,
           let configJson = crypto.decryptOrNil(encryptedBase64: encryptedConfig, ivBase64: configIv),
           let configData = configJson.data(using: .utf8),
           let config = try? JSONDecoder().decode(ProjectConfig.self, from: configData) {
            if let encoded = try? JSONEncoder().encode(config.commands),
               let jsonStr = String(data: encoded, encoding: .utf8) {
                commandsJson = jsonStr
            }
        }

        let project = Project(
            id: projectId,
            name: name,
            sessionCount: entry.sessionCount ?? 0,
            lastUpdatedAt: entry.lastActivityAt,
            commandsJson: commandsJson,
            gitRemoteHash: entry.gitRemoteHash
        )

        do {
            try database.upsertProject(project)
            // Server's sessionCount includes archived sessions; recompute locally
            // so the displayed count matches what SessionListView actually shows.
            try database.refreshSessionCount(forProject: projectId)
        } catch {
            logger.error("Failed to upsert project: \(error.localizedDescription)")
        }
    }

    private func processServerSession(_ entry: ServerSessionEntry) {
        _ = processServerSessionWithResult(entry)
    }

    /// Process a server session entry, returning true on success, false on decrypt failure.
    @discardableResult
    private func processServerSessionWithResult(_ entry: ServerSessionEntry) -> Bool {
        // Decrypt project ID to find the parent project
        guard let projectId = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedProjectId,
            ivBase64: entry.projectIdIv
        ) else {
            logger.warning("Failed to decrypt project ID for session \(entry.sessionId)")
            return false
        }

        // Ensure the project exists (don't overwrite if it already has data from processServerProject)
        if (try? database.writer.read({ db in try Project.fetchOne(db, id: projectId) })) == nil {
            let projectName = (projectId as NSString).lastPathComponent
            let project = Project(id: projectId, name: projectName, lastUpdatedAt: entry.updatedAt)
            try? database.upsertProject(project)
        }

        // Decrypt session title
        let titleDecrypted = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedTitle,
            ivBase64: entry.titleIv
        )

        // Preserve local isExecuting/lastReadAt when the server entry doesn't include them
        let existing = try? database.session(byId: entry.sessionId)

        // Decrypt client metadata (context usage, etc.)
        var clientMeta: ClientMetadata?
        if let encryptedMeta = entry.encryptedClientMetadata,
           let metaIv = entry.clientMetadataIv,
           let metaJson = crypto.decryptOrNil(encryptedBase64: encryptedMeta, ivBase64: metaIv),
           let metaData = metaJson.data(using: .utf8) {
            clientMeta = try? JSONDecoder().decode(ClientMetadata.self, from: metaData)
        }

        // Encode tags array to JSON string for storage
        var tagsJson: String? = nil
        if let tags = clientMeta?.tags, !tags.isEmpty,
           let data = try? JSONEncoder().encode(tags) {
            tagsJson = String(data: data, encoding: .utf8)
        }

        let session = Session(
            id: entry.sessionId,
            projectId: projectId,
            titleEncrypted: entry.encryptedTitle,
            titleIv: entry.titleIv,
            titleDecrypted: titleDecrypted,
            // See processServerSessionBackground for why these fall back to
            // the existing values rather than overwriting with nil.
            provider: entry.provider ?? existing?.provider,
            model: entry.model ?? existing?.model,
            mode: entry.mode ?? existing?.mode,
            sessionType: entry.sessionType ?? existing?.sessionType,
            parentSessionId: entry.parentSessionId ?? existing?.parentSessionId,
            phase: clientMeta?.phase ?? existing?.phase,
            tagsJson: tagsJson ?? existing?.tagsJson,
            worktreeId: entry.worktreeId ?? existing?.worktreeId,
            isArchived: entry.isArchived ?? existing?.isArchived ?? false,
            isPinned: entry.isPinned ?? existing?.isPinned ?? false,
            branchedFromSessionId: entry.branchedFromSessionId ?? existing?.branchedFromSessionId,
            branchPointMessageId: entry.branchPointMessageId ?? existing?.branchPointMessageId,
            branchedAt: entry.branchedAt ?? existing?.branchedAt,
            isExecuting: entry.isExecuting ?? existing?.isExecuting ?? false,
            hasQueuedPrompts: clientMeta?.hasPendingPrompt ?? entry.hasPendingPrompt ?? existing?.hasQueuedPrompts ?? false,
            contextTokens: clientMeta?.currentContext?.tokens ?? existing?.contextTokens,
            contextWindow: clientMeta?.currentContext?.contextWindow ?? existing?.contextWindow,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            lastSyncedSeq: entry.messageCount ?? existing?.lastSyncedSeq ?? 0,
            lastReadAt: entry.lastReadAt ?? existing?.lastReadAt,
            lastMessageAt: entry.lastMessageAt ?? existing?.lastMessageAt,
            // "" from remote means "cleared" -> nil locally; nil means "not sent" -> keep existing
            draftInput: clientMeta?.draftInput != nil ? (clientMeta!.draftInput!.isEmpty ? nil : clientMeta!.draftInput!) : existing?.draftInput,
            draftUpdatedAt: clientMeta?.draftUpdatedAt ?? existing?.draftUpdatedAt
        )

        do {
            try database.upsertSession(session)
            // Update the project's lastUpdatedAt if this session is more recent
            try database.updateProjectLastActivity(projectId: projectId, activityAt: entry.updatedAt)

            // Decrypt and store queued prompts from remote for display
            if let encryptedPrompts = entry.encryptedQueuedPrompts, !encryptedPrompts.isEmpty {
                decryptAndStoreQueuedPrompts(sessionId: entry.sessionId, encryptedPrompts: encryptedPrompts)
            } else if entry.queuedPromptCount == 0 || entry.encryptedQueuedPrompts?.isEmpty == true {
                // Queue was cleared on remote -- remove synced prompts
                try? database.deleteRemoteQueuedPrompts(forSession: entry.sessionId)
            }

            return true
        } catch {
            logger.error("Failed to upsert session: \(error.localizedDescription)")
            return false
        }
    }

    /// Decrypt queued prompts from the server and store for local display.
    private func decryptAndStoreQueuedPrompts(sessionId: String, encryptedPrompts: [EncryptedQueuedPrompt]) {
        var decrypted: [QueuedPrompt] = []
        for ep in encryptedPrompts {
            guard let plaintext = crypto.decryptOrNil(encryptedBase64: ep.encryptedPrompt, ivBase64: ep.iv) else {
                continue
            }
            let qp = QueuedPrompt(
                id: ep.id,
                sessionId: sessionId,
                promptTextEncrypted: ep.encryptedPrompt,
                iv: ep.iv,
                createdAt: ep.timestamp,
                sentAt: nil,
                promptTextDecrypted: plaintext,
                source: ep.source ?? "desktop"
            )
            decrypted.append(qp)
        }
        try? database.replaceQueuedPrompts(forSession: sessionId, with: decrypted)
    }

    // MARK: - Real-time Broadcasts

    private func handleIndexBroadcast(_ data: Data) {
        guard let broadcast = try? decoder.decode(IndexBroadcast.self, from: data) else {
            logger.error("Failed to decode index_broadcast")
            return
        }
        processServerSession(broadcast.session)
    }

    private func handleIndexDeleteBroadcast(_ data: Data) {
        guard let broadcast = try? decoder.decode(IndexDeleteBroadcast.self, from: data) else {
            logger.error("Failed to decode index_delete_broadcast")
            return
        }
        logger.info("Session deleted: \(broadcast.sessionId)")

        do {
            // Look up project before deleting so we can refresh count
            let projectId = try database.session(byId: broadcast.sessionId)?.projectId
            try database.deleteSession(broadcast.sessionId)
            if let projectId {
                try database.refreshSessionCount(forProject: projectId)
            }
        } catch {
            logger.error("Failed to delete session: \(error.localizedDescription)")
        }
    }

    private func handleProjectBroadcast(_ data: Data) {
        guard let broadcast = try? decoder.decode(ProjectBroadcast.self, from: data) else {
            logger.error("Failed to decode project_broadcast")
            return
        }
        processServerProject(broadcast.project)
    }

    private func handleCreateSessionResponse(_ data: Data) {
        guard let broadcast = try? decoder.decode(CreateSessionResponseBroadcast.self, from: data) else {
            logger.error("Failed to decode create_session_response_broadcast")
            return
        }
        if broadcast.response.success {
            logger.info("Session created: \(broadcast.response.sessionId ?? "unknown")")
        } else {
            logger.error("Session creation failed: \(broadcast.response.error ?? "unknown error")")
        }
        // TODO: Notify UI of create session result
    }

    // MARK: - Device Presence

    private func handleDevicesList(_ data: Data) {
        struct DevicesListMessage: Codable {
            let devices: [DeviceInfo]
        }
        guard let msg = try? decoder.decode(DevicesListMessage.self, from: data) else { return }
        connectedDevices = msg.devices
    }

    private func handleDeviceJoined(_ data: Data) {
        struct DeviceJoinedMessage: Codable {
            let device: DeviceInfo
        }
        guard let msg = try? decoder.decode(DeviceJoinedMessage.self, from: data) else { return }
        if !connectedDevices.contains(where: { $0.deviceId == msg.device.deviceId }) {
            connectedDevices.append(msg.device)
        }
    }

    private func handleDeviceLeft(_ data: Data) {
        struct DeviceLeftMessage: Codable {
            let deviceId: String
        }
        guard let msg = try? decoder.decode(DeviceLeftMessage.self, from: data) else { return }
        connectedDevices.removeAll { $0.deviceId == msg.deviceId }
    }

    // MARK: - Settings Sync

    private func handleSettingsSyncBroadcast(_ data: Data) {
        guard let broadcast = try? decoder.decode(SettingsSyncBroadcast.self, from: data) else {
            logger.error("Failed to decode settingsSyncBroadcast")
            return
        }

        let payload = broadcast.settings
        logger.info("Received settings sync from device: \(payload.deviceId), version: \(payload.version)")

        // Decrypt the settings JSON using the shared encryption key
        guard let settingsJson = crypto.decryptOrNil(
            encryptedBase64: payload.encryptedSettings,
            ivBase64: payload.settingsIv
        ) else {
            logger.error("Failed to decrypt synced settings")
            return
        }

        guard let settingsData = settingsJson.data(using: .utf8),
              let settings = try? JSONDecoder().decode(SyncedSettings.self, from: settingsData) else {
            logger.error("Failed to parse decrypted settings JSON")
            return
        }

        logger.info("Decrypted settings: version=\(settings.version), hasOpenAIKey=\(settings.openaiApiKey != nil)")

        // Store the OpenAI API key in the Keychain
        if let apiKey = settings.openaiApiKey, !apiKey.isEmpty {
            try? KeychainManager.storeOpenAIApiKey(apiKey)
            logger.info("Stored OpenAI API key from desktop sync")
            NotificationCenter.default.post(name: .init("OpenAIApiKeySynced"), object: nil)
        }

        #if os(iOS)
        // Store voice mode settings if present
        if let voiceMode = settings.voiceMode {
            var currentSettings = VoiceModeSettings.load()
            if let voice = voiceMode.voice {
                currentSettings.voice = voice
            }
            if let delay = voiceMode.submitDelayMs {
                currentSettings.promptConfirmationDelay = TimeInterval(delay) / 1000.0
            }
            currentSettings.save()
        }
        #endif

        // Store available models from desktop for the model picker and persist
        if let models = settings.availableModels {
            availableModels = models
            ModelPreferences.saveAvailableModels(models, defaultModel: settings.defaultModel)
            logger.info("Synced \(models.count) available models from desktop")
        }
        if let defaultModel = settings.defaultModel {
            desktopDefaultModel = defaultModel
            logger.info("Desktop default model: \(defaultModel)")
        }

        // Persist the meta-agent alpha gate from desktop and notify gated UI.
        let metaAgentEnabled = settings.metaAgentEnabled ?? false
        FeaturePreferences.setMetaAgentEnabled(metaAgentEnabled)
        NotificationCenter.default.post(name: .init("MetaAgentEnabledSynced"), object: nil)
        logger.info("Meta Agent alpha gate from desktop: \(metaAgentEnabled)")

        onSettingsSynced?(settings)
    }

    // MARK: - Error Handling

    private func handleServerError(_ data: Data) {
        guard let error = try? decoder.decode(ServerError.self, from: data) else { return }
        logger.error("Server error [\(error.code)]: \(error.message)")
    }

    // MARK: - Session Client Setup

    private func setupSessionClient() {
        sessionClient.onConnectionStateChanged = { [weak self] connected in
            Task { @MainActor in
                guard let self = self else { return }
                self.logger.info("sessionClient connection state: \(connected) (activeSessionId=\(self.activeSessionId ?? "nil"))")
                if connected {
                    self.requestSessionSync()
                }
            }
        }

        sessionClient.onMessage = { [weak self] data in
            Task { @MainActor in
                self?.handleSessionMessage(data)
            }
        }
    }

    private func requestSessionSync(attempt: Int = 0) {
        guard let sessionId = activeSessionId else {
            logger.warning("requestSessionSync skipped: activeSessionId is nil (connection state fired without a target)")
            return
        }

        let localMessages = (try? database.messages(forSession: sessionId)) ?? []
        let localCount = localMessages.count
        let maxLocalSequence = localMessages.map(\.sequence).max() ?? 0
        let expectedCount = (try? database.session(byId: sessionId))?.lastSyncedSeq ?? 0
        let hasSparseLocalHistory = maxLocalSequence > localCount
        let isBelowExpectedCount = expectedCount > 0 && localCount < expectedCount

        // If the local cache has a high-sequence mobile message but is missing
        // earlier rows, a delta cursor would permanently skip the old transcript.
        let forceFullSync = hasSparseLocalHistory || isBelowExpectedCount

        let sinceSeq: Int?
        if forceFullSync {
            sinceSeq = nil
            logger.info("Session sync requesting full history for \(sessionId): localCount=\(localCount), maxLocalSequence=\(maxLocalSequence), expectedCount=\(expectedCount)")
        } else if let state = try? database.syncState(forRoom: sessionId) {
            sinceSeq = state.lastSequence > 0 ? state.lastSequence : nil
        } else {
            sinceSeq = nil
        }

        let request = SessionSyncRequest(sinceSeq: sinceSeq)
        guard let data = try? JSONEncoder().encode(request),
              let json = String(data: data, encoding: .utf8) else {
            logger.error("requestSessionSync failed to encode request for session \(sessionId)")
            return
        }

        // Always log the send attempt -- the stuck-at-"deferred initial load"
        // bug manifests when this line appears but no syncResponse ever returns,
        // so its presence/absence is a critical diagnostic signal.
        logger.info("requestSessionSync: sending sinceSeq=\(sinceSeq ?? -1) for session \(sessionId) (attempt \(attempt))")

        // Use completion-based send to detect failures and retry.
        // The WebSocket connection may not be fully established yet when this
        // is called (onConnectionStateChanged fires before the handshake completes).
        // Without a successful syncRequest, the server won't mark this connection
        // as synced and won't include it in message broadcasts.
        sessionClient.sendRaw(json) { [weak self] error in
            guard let self = self else { return }
            if let error = error {
                self.logger.warning("requestSessionSync send failed for \(sessionId): \(error.localizedDescription)")
                guard attempt < 3, self.activeSessionId == sessionId else { return }

                self.logger.info("Session sync request failed, retrying (attempt \(attempt + 1))")
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                    guard let self = self, self.activeSessionId == sessionId else { return }
                    self.requestSessionSync(attempt: attempt + 1)
                }
            } else {
                self.logger.debug("requestSessionSync: send acknowledged for \(sessionId)")
            }
        }
    }

    private func handleSessionMessage(_ data: Data) {
        guard let envelope = try? decoder.decode(ServerMessage.self, from: data) else {
            let rawPreview = String(data: data.prefix(200), encoding: .utf8) ?? "<binary>"
            logger.warning("Could not decode session message type — raw: \(rawPreview)")
            return
        }

        switch envelope.type {
        case "syncResponse":
            handleSessionSyncResponse(data)
        case "messageBroadcast":
            handleMessageBroadcast(data)
        case "metadataBroadcast":
            handleMetadataBroadcast(data)
        case "error":
            handleServerError(data)
        default:
            logger.info("Unhandled session message type: \(envelope.type)")
        }
    }

    // MARK: - Session Sync Response

    private func handleSessionSyncResponse(_ data: Data) {
        let response: SessionSyncResponse
        do {
            response = try decoder.decode(SessionSyncResponse.self, from: data)
            logger.info("handleSessionSyncResponse: \(response.messages.count) messages, hasMore=\(response.hasMore) for session \(self.activeSessionId ?? "nil")")
        } catch {
            let rawPreview = String(data: data.prefix(500), encoding: .utf8) ?? "<binary>"
            logger.error("Failed to decode session syncResponse: \(error.localizedDescription) — raw: \(rawPreview)")
            if let sessionId = activeSessionId {
                emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                    totalServerMessages: 0, decryptedCount: 0, storedCount: 0,
                    failedMessageIds: [], failedSequences: [],
                    error: "Sync response decode failed: \(error.localizedDescription)"
                ))
            }
            return
        }

        // Buffer messages for batch insert
        sessionSyncBuffer.append(contentsOf: response.messages)

        if response.hasMore, let cursor = response.cursor {
            // Request next page
            let sinceSeq = Int(cursor)
            let request = SessionSyncRequest(sinceSeq: sinceSeq)
            if let data = try? JSONEncoder().encode(request),
               let json = String(data: data, encoding: .utf8) {
                sessionClient.sendRaw(json)
            }
        } else {
            // All pages received - decrypt and store
            commitSessionMessages()
        }
    }

    private func commitSessionMessages() {
        guard let sessionId = activeSessionId else { return }

        let totalCount = sessionSyncBuffer.count
        var failedIds: [String] = []
        var failedSeqs: [Int] = []

        let messages = sessionSyncBuffer.compactMap { entry -> Message? in
            let msg = decryptServerMessage(entry, sessionId: sessionId)
            if msg == nil {
                failedIds.append(entry.id)
                failedSeqs.append(entry.sequence)
            }
            return msg
        }

        sessionSyncBuffer = []

        // Log decryption results
        if !failedIds.isEmpty {
            logger.error("Decryption failed for \(failedIds.count)/\(totalCount) messages in session \(sessionId). Failed sequences: \(failedSeqs.prefix(10))")
        }

        do {
            try database.appendMessages(messages)

            // Update sync watermark to max sequence
            if let maxSeq = messages.map(\.sequence).max() {
                let now = Int(Date().timeIntervalSince1970 * 1000)
                let syncState = SyncState(
                    roomId: sessionId,
                    lastCursor: nil,
                    lastSequence: maxSeq,
                    lastSyncedAt: now
                )
                try database.updateSyncState(syncState)
            }

            logger.info("Stored \(messages.count)/\(totalCount) messages for session \(sessionId)")

            // Report diagnostics
            if messages.isEmpty && totalCount > 0 {
                logger.error("All \(totalCount) messages failed decryption for session \(sessionId)")
                emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                    totalServerMessages: totalCount, decryptedCount: 0, storedCount: 0,
                    failedMessageIds: failedIds, failedSequences: failedSeqs,
                    error: "All \(totalCount) messages failed decryption"
                ))
            } else if messages.isEmpty && totalCount == 0 {
                logger.info("Session sync returned 0 messages for session \(sessionId) — transcript may not exist on server")
                emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                    totalServerMessages: 0, decryptedCount: 0, storedCount: 0,
                    failedMessageIds: [], failedSequences: [],
                    error: nil
                ))
            } else if !failedIds.isEmpty {
                emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                    totalServerMessages: totalCount, decryptedCount: messages.count,
                    storedCount: messages.count,
                    failedMessageIds: failedIds, failedSequences: failedSeqs,
                    error: "\(failedIds.count) of \(totalCount) messages failed decryption"
                ))
            } else {
                emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                    totalServerMessages: totalCount, decryptedCount: messages.count,
                    storedCount: messages.count,
                    failedMessageIds: [], failedSequences: [],
                    error: nil
                ))
            }
        } catch {
            logger.error("Failed to store session messages: \(error.localizedDescription)")
            emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                totalServerMessages: totalCount, decryptedCount: messages.count, storedCount: 0,
                failedMessageIds: failedIds, failedSequences: failedSeqs,
                error: "Database write failed: \(error.localizedDescription)"
            ))
        }
    }

    // MARK: - Real-time Session Messages

    private func handleMessageBroadcast(_ data: Data) {
        guard let broadcast = try? decoder.decode(MessageBroadcast.self, from: data),
              let sessionId = activeSessionId else {
            let rawPreview = String(data: data.prefix(200), encoding: .utf8) ?? "<binary>"
            logger.error("Failed to decode messageBroadcast — raw: \(rawPreview)")
            return
        }

        guard let message = decryptServerMessage(broadcast.message, sessionId: sessionId) else {
            // decryptServerMessage already logs the specific error
            return
        }

        do {
            try database.appendMessage(message)

            // Update sync watermark
            let now = Int(Date().timeIntervalSince1970 * 1000)
            let syncState = SyncState(
                roomId: sessionId,
                lastCursor: nil,
                lastSequence: message.sequence,
                lastSyncedAt: now
            )
            try database.updateSyncState(syncState)
        } catch {
            logger.error("Failed to store broadcast message: \(error.localizedDescription)")
        }
    }

    private func handleMetadataBroadcast(_ data: Data) {
        guard let broadcast = try? decoder.decode(MetadataBroadcast.self, from: data),
              let sessionId = activeSessionId else {
            return
        }

        // Update session metadata in the database
        do {
            if var session = try database.session(byId: sessionId) {
                let wasExecuting = session.isExecuting

                if let isExecuting = broadcast.metadata.isExecuting {
                    session.isExecuting = isExecuting
                }
                if let provider = broadcast.metadata.provider {
                    session.provider = provider
                }
                if let model = broadcast.metadata.model {
                    session.model = model
                }
                if let mode = broadcast.metadata.mode {
                    session.mode = mode
                }
                // Decrypt client metadata (context usage, pending prompt state, etc.)
                if let encryptedMeta = broadcast.metadata.encryptedClientMetadata,
                   let metaIv = broadcast.metadata.clientMetadataIv,
                   let metaJson = crypto.decryptOrNil(encryptedBase64: encryptedMeta, ivBase64: metaIv),
                   let metaData = metaJson.data(using: .utf8),
                   let clientMeta = try? JSONDecoder().decode(ClientMetadata.self, from: metaData) {
                    if let ctx = clientMeta.currentContext {
                        session.contextTokens = ctx.tokens
                        session.contextWindow = ctx.contextWindow
                    }
                    if let pending = clientMeta.hasPendingPrompt {
                        session.hasQueuedPrompts = pending
                    }
                    if let phase = clientMeta.phase {
                        session.phase = phase
                    }
                    if let tags = clientMeta.tags, !tags.isEmpty,
                       let tagData = try? JSONEncoder().encode(tags) {
                        session.tagsJson = String(data: tagData, encoding: .utf8)
                    }
                }
                // NOTE: Do NOT apply updatedAt from metadata broadcasts.
                // Metadata updates (read state, isExecuting, context) should not
                // change the sort timestamp. Only index sync and message appends
                // set updatedAt, ensuring the session list stays correctly sorted.
                try database.upsertSession(session)

                // Gate the session-client ping heartbeat on whether the AI is
                // currently producing output. Pings only matter while we're
                // expecting `messageBroadcast` events; running a 20s repeating
                // timer on an idle session kept the device awake on real
                // hardware. The transitions are:
                //   !executing -> executing : startPings (turn just began)
                //   executing -> !executing : stopPings  (turn just ended)
                if !wasExecuting && session.isExecuting {
                    sessionClient.startPings()
                } else if wasExecuting && !session.isExecuting {
                    sessionClient.stopPings()
                }

                // Detect execution completion (isExecuting: true -> false)
                if wasExecuting && !session.isExecuting {
                    let messages = try database.messages(forSession: sessionId)
                    let lastAssistant = messages.last { $0.source == "assistant" }
                    let summary = String((lastAssistant?.contentDecrypted ?? "Task completed").prefix(200))
                    onSessionCompleted?(sessionId, summary)
                }
            }
        } catch {
            logger.error("Failed to update session metadata: \(error.localizedDescription)")
        }
    }

    // MARK: - Message Decryption

    private func decryptServerMessage(_ entry: ServerMessageEntry, sessionId: String) -> Message? {
        let decrypted: String?
        do {
            decrypted = try crypto.decrypt(encryptedBase64: entry.encryptedContent, ivBase64: entry.iv)
        } catch {
            logger.error("Failed to decrypt message \(entry.id) seq=\(entry.sequence) in session \(sessionId): \(error.localizedDescription). encryptedContent length=\(entry.encryptedContent.count), iv length=\(entry.iv.count)")
            return nil
        }

        return Message(
            id: entry.id,
            sessionId: sessionId,
            sequence: entry.sequence,
            source: entry.source,
            direction: entry.direction,
            encryptedContent: entry.encryptedContent,
            iv: entry.iv,
            contentDecrypted: decrypted,
            metadataJson: nil,
            createdAt: entry.createdAt
        )
    }

    // MARK: - Draft Input Sync

    /// Update draft input for a session, persisting locally and pushing to sync.
    public func updateDraftInput(sessionId: String, draftInput: String) {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        logger.info("[Draft] updateDraftInput called: sessionId=\(sessionId), draftInput='\(draftInput.prefix(30))', draftUpdatedAt=\(now)")
        // Persist locally (including timestamp so GRDB observation carries it)
        try? database.updateSessionDraftInput(sessionId: sessionId, draftInput: draftInput.isEmpty ? nil : draftInput, draftUpdatedAt: now)

        // Push to sync via index update with encrypted client metadata
        guard let session = try? database.session(byId: sessionId) else {
            logger.warning("[Draft] Session not found in database: \(sessionId)")
            return
        }

        do {
            let clientMeta = ClientMetadata(
                currentContext: nil,
                hasPendingPrompt: nil,
                phase: session.phase,
                tags: session.tags.isEmpty ? nil : session.tags,
                draftInput: draftInput,  // Send "" explicitly when clearing so remote caches update
                draftUpdatedAt: now
            )
            let metaJson = try JSONEncoder().encode(clientMeta)
            guard let metaString = String(data: metaJson, encoding: .utf8) else { return }
            let encrypted = try crypto.encrypt(plaintext: metaString)

            let encryptedProjectId = try crypto.encryptProjectId(session.projectId)
            var indexEntry = IndexUpdateEntry(
                sessionId: sessionId,
                encryptedProjectId: encryptedProjectId,
                projectIdIv: CryptoManager.projectIdIvBase64,
                encryptedTitle: session.titleEncrypted,
                titleIv: session.titleIv,
                provider: session.provider ?? "claude-code",
                model: session.model,
                mode: session.mode,
                messageCount: (try? database.messages(forSession: sessionId).count) ?? 0,
                lastMessageAt: session.lastMessageAt ?? session.updatedAt,
                createdAt: session.createdAt,
                updatedAt: Int(Date().timeIntervalSince1970 * 1000),
                isExecuting: session.isExecuting,
                queuedPromptCount: nil,
                encryptedQueuedPrompts: nil
            )
            indexEntry.encryptedClientMetadata = encrypted.encrypted
            indexEntry.clientMetadataIv = encrypted.iv

            let indexMessage = IndexUpdateMessage(session: indexEntry)
            if let data = try? JSONEncoder().encode(indexMessage),
               let json = String(data: data, encoding: .utf8) {
                logger.info("[Draft] Sending indexUpdate via WebSocket, json length=\(json.count), hasClientMeta=\(indexEntry.encryptedClientMetadata != nil)")
                indexClient.sendRaw(json)
            } else {
                logger.error("[Draft] Failed to encode IndexUpdateMessage to JSON")
            }
        } catch {
            logger.error("[Draft] Failed to push draft input to sync: \(error.localizedDescription)")
        }
    }

    // MARK: - Send Prompt

    /// Send a prompt to the current session via the queued prompts system.
    /// Desktop picks up prompts from index_update broadcasts (not session room messages).
    public func sendPrompt(sessionId: String, text: String, attachments: [PendingAttachment] = []) async throws {
        logger.info("[SendPrompt] Starting: sessionId=\(sessionId), textLength=\(text.count), attachments=\(attachments.count), wsConnected=\(self.indexClient.isConnected), roomOrgId=\(self.orgId ?? "nil")")
        guard indexClient.isConnected else {
            logger.error("[SendPrompt] WebSocket not connected - cannot send prompt")
            throw SyncError.webSocketSendFailed("Not connected to sync server")
        }
        guard let session = try database.session(byId: sessionId) else {
            logger.error("[SendPrompt] Session not found: \(sessionId)")
            throw SyncError.sessionNotFound
        }

        let now = Int(Date().timeIntervalSince1970 * 1000)
        let promptId = UUID().uuidString

        // Encrypt the prompt text
        let encryptedPrompt = try crypto.encrypt(plaintext: text)

        // Encrypt image attachments
        var encryptedAttachments: [WireEncryptedAttachment]? = nil
        #if canImport(UIKit)
        if !attachments.isEmpty {
            encryptedAttachments = try attachments.compactMap { attachment in
                guard let compressed = ImageCompressor.compress(attachment.image) else { return nil }
                let encrypted = try crypto.encryptData(compressed.data)
                return WireEncryptedAttachment(
                    id: attachment.id,
                    filename: attachment.filename,
                    mimeType: "image/jpeg",
                    encryptedData: encrypted.encrypted,
                    iv: encrypted.iv,
                    size: compressed.data.count,
                    width: compressed.width,
                    height: compressed.height
                )
            }
        }
        #endif

        var queuedPrompt = EncryptedQueuedPrompt(
            id: promptId,
            encryptedPrompt: encryptedPrompt.encrypted,
            iv: encryptedPrompt.iv,
            timestamp: now,
            source: "keyboard"
        )
        queuedPrompt.encryptedAttachments = encryptedAttachments

        // Build the encrypted project ID for the index entry
        let encryptedProjectId = try crypto.encryptProjectId(session.projectId)

        // Send index_update with queued prompt via the index room
        let indexEntry = IndexUpdateEntry(
            sessionId: sessionId,
            encryptedProjectId: encryptedProjectId,
            projectIdIv: CryptoManager.projectIdIvBase64,
            encryptedTitle: session.titleEncrypted,
            titleIv: session.titleIv,
            provider: session.provider ?? "claude-code",
            model: session.model,
            mode: session.mode,
            messageCount: (try? database.messages(forSession: sessionId).count) ?? 0,
            lastMessageAt: now,
            createdAt: session.createdAt,
            updatedAt: now,
            isExecuting: session.isExecuting,
            queuedPromptCount: 1,
            encryptedQueuedPrompts: [queuedPrompt]
        )

        let indexMessage = IndexUpdateMessage(session: indexEntry)
        let data = try JSONEncoder().encode(indexMessage)
        guard let json = String(data: data, encoding: .utf8) else {
            throw SyncError.encodingFailed
        }

        // Send via WebSocket with completion handler to detect failures
        let sendResult = await withCheckedContinuation { continuation in
            indexClient.sendRaw(json) { error in
                continuation.resume(returning: error)
            }
        }
        if let sendError = sendResult {
            throw SyncError.webSocketSendFailed(sendError.localizedDescription)
        }

        // Store the prompt locally for immediate display in transcript
        let localSeq = try database.nextSequence(forSession: sessionId)
        let localMessage = Message(
            id: promptId,
            sessionId: sessionId,
            sequence: localSeq,
            source: "user",
            direction: "input",
            encryptedContent: encryptedPrompt.encrypted,
            iv: encryptedPrompt.iv,
            contentDecrypted: text,
            createdAt: now
        )
        try database.appendMessage(localMessage)
    }

    // MARK: - Interactive Prompt Responses

    /// Send a session_control message to the desktop via the index room.
    /// Used for interactive prompt responses (AskUserQuestion, ToolPermission, ExitPlanMode, GitCommit).
    public func sendSessionControlMessage(sessionId: String, messageType: String, payload: [String: Any]? = nil) {
        let controlPayload = SessionControlPayload(
            sessionId: sessionId,
            messageType: messageType,
            payload: payload.map { dict in
                dict.mapValues { AnyCodable($0) }
            },
            timestamp: Int(Date().timeIntervalSince1970 * 1000),
            sentBy: "mobile"
        )

        let message = SessionControlMessage(message: controlPayload)
        if let data = try? JSONEncoder().encode(message),
           let json = String(data: data, encoding: .utf8) {
            indexClient.sendRaw(json)
            logger.info("Sent session_control: \(messageType) for session \(sessionId)")
        }
    }

    /// Append a tool result to the session room for transcript storage.
    /// Some interactive responses (AskUserQuestion, ToolPermission) persist the response
    /// as a system message so it appears in the transcript.
    public func appendToolResult(sessionId: String, toolResultId: String, content: String) {
        guard let encryptedContent = try? crypto.encrypt(plaintext: content) else {
            logger.error("Failed to encrypt tool result content")
            return
        }

        let entry = ServerMessageEntry(
            id: toolResultId,
            sequence: 0, // Server assigns the real sequence
            createdAt: Int(Date().timeIntervalSince1970 * 1000),
            source: "system",
            direction: "input",
            encryptedContent: encryptedContent.encrypted,
            iv: encryptedContent.iv,
            metadata: nil
        )

        let request = AppendMessageRequest(message: entry)
        if let data = try? JSONEncoder().encode(request),
           let json = String(data: data, encoding: .utf8) {
            sessionClient.sendRaw(json)
            logger.info("Appended tool result \(toolResultId) to session room")
        }
    }

    enum SyncError: LocalizedError {
        case sessionNotFound
        case encodingFailed
        case webSocketSendFailed(String)

        var errorDescription: String? {
            switch self {
            case .sessionNotFound:
                return "Session not found"
            case .encodingFailed:
                return "Failed to encode message"
            case .webSocketSendFailed(let detail):
                return "Failed to send: \(detail)"
            }
        }
    }

    /// Diagnostic information from a session message sync operation.
    public struct SessionSyncDiagnostic {
        public let totalServerMessages: Int
        public let decryptedCount: Int
        public let storedCount: Int
        public let failedMessageIds: [String]
        public let failedSequences: [Int]
        public let error: String?
    }

    // MARK: - Session Actions

    // MARK: - Push Token Registration

    private func setupPushTokenForwarding() {
        NotificationManager.shared.onTokenReceived = { [weak self] token in
            Task { @MainActor in
                self?.registerPushToken(token)
            }
        }
        NotificationManager.shared.onPushDisabled = { [weak self] in
            Task { @MainActor in
                self?.unregisterPushToken()
            }
        }
        // If a token was already received before SyncManager was created, use it now.
        // This handles the case where NotificationManager.shared was accessed early
        // (e.g., from SettingsView) and got a token before the callback was set.
        if let existingToken = NotificationManager.shared.deviceToken {
            if NotificationManager.shared.shouldRegisterForPush {
                registerPushToken(existingToken)
            } else {
                unregisterPushToken()
            }
        }
    }

    /// Send the APNs push token to the sync server.
    public func registerPushToken(_ token: String) {
        guard NotificationManager.shared.shouldRegisterForPush else {
            logger.info("Skipping push token registration because push notifications are disabled in app or OS")
            return
        }

        let message = NotificationManager.makeRegisterTokenMessage(
            token: token,
            deviceId: WebSocketClient.deviceId
        )
        if let data = try? JSONEncoder().encode(message),
           let json = String(data: data, encoding: .utf8) {
            indexClient.sendRaw(json)
            logger.info("Registered push token with server")
        }
    }

    public func unregisterPushToken() {
        let message = NotificationManager.makeUnregisterTokenMessage(
            deviceId: WebSocketClient.deviceId
        )
        if let data = try? JSONEncoder().encode(message),
           let json = String(data: data, encoding: .utf8) {
            indexClient.sendRaw(json)
            logger.info("Unregistered push token with server")
        }
    }

    /// Mark a session as read locally and push lastReadAt through the sync server.
    public func markSessionRead(sessionId: String) {
        let now = Int(Date().timeIntervalSince1970 * 1000)

        // Update local SQLite
        do {
            try database.markSessionRead(sessionId)
        } catch {
            logger.error("Failed to mark session read locally: \(error.localizedDescription)")
        }

        // Push lastReadAt through index update to server
        guard let session = try? database.session(byId: sessionId) else { return }
        do {
            let encryptedProjectId = try crypto.encryptProjectId(session.projectId)

            // Build a minimal index update with lastReadAt
            var entry: [String: Any] = [
                "sessionId": session.id,
                "encryptedProjectId": encryptedProjectId,
                "projectIdIv": CryptoManager.projectIdIvBase64,
                "provider": session.provider ?? "unknown",
                "messageCount": 0,
                "lastMessageAt": session.lastMessageAt ?? session.updatedAt,
                "createdAt": session.createdAt,
                "updatedAt": session.updatedAt,
                "isExecuting": session.isExecuting,
                "lastReadAt": now,
            ]

            // Encrypt title if available
            if let title = session.titleDecrypted {
                let result = try crypto.encrypt(plaintext: title)
                entry["encryptedTitle"] = result.encrypted
                entry["titleIv"] = result.iv
            }

            let message: [String: Any] = [
                "type": "indexUpdate",
                "session": entry,
            ]

            if let data = try? JSONSerialization.data(withJSONObject: message),
               let json = String(data: data, encoding: .utf8) {
                indexClient.sendRaw(json)
            }
        } catch {
            logger.error("Failed to push lastReadAt to server: \(error.localizedDescription)")
        }
    }

    /// Request the desktop to create a new session in a project.
    public func createSession(
        projectId: String,
        initialPrompt: String? = nil,
        sessionType: String? = nil,
        parentSessionId: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        agentRole: String? = nil
    ) throws {
        let encryptedProjectId = try crypto.encryptProjectId(projectId)

        var encryptedPrompt: String?
        var promptIv: String?
        if let prompt = initialPrompt {
            let result = try crypto.encrypt(plaintext: prompt)
            encryptedPrompt = result.encrypted
            promptIv = result.iv
        }

        let request = CreateSessionRequestMessage(
            request: EncryptedCreateSessionRequest(
                requestId: UUID().uuidString,
                encryptedProjectId: encryptedProjectId,
                projectIdIv: CryptoManager.projectIdIvBase64,
                encryptedInitialPrompt: encryptedPrompt,
                initialPromptIv: promptIv,
                sessionType: sessionType,
                parentSessionId: parentSessionId,
                provider: provider,
                model: model,
                agentRole: agentRole,
                timestamp: Int(Date().timeIntervalSince1970 * 1000)
            )
        )

        if let data = try? JSONEncoder().encode(request),
           let json = String(data: data, encoding: .utf8) {
            indexClient.sendRaw(json)
        }
    }

    /// Request the desktop to create a new git worktree.
    /// The desktop will create the worktree and the result will arrive via index broadcast.
    public func createWorktree(projectId: String) throws {
        let encryptedProjectId = try crypto.encryptProjectId(projectId)

        let request = CreateWorktreeRequestMessage(
            request: CreateWorktreeRequest(
                requestId: UUID().uuidString,
                encryptedProjectId: encryptedProjectId,
                projectIdIv: CryptoManager.projectIdIvBase64,
                timestamp: Int(Date().timeIntervalSince1970 * 1000)
            )
        )

        if let data = try? JSONEncoder().encode(request),
           let json = String(data: data, encoding: .utf8) {
            indexClient.sendRaw(json)
        }
    }

    /// Update a session's parent (for reparenting into a workstream).
    /// Updates the local database immediately for instant UI feedback.
    /// The change will propagate to desktop on the next index sync cycle.
    public func updateSessionParent(sessionId: String, parentSessionId: String) throws {
        try database.writer.write { db in
            try db.execute(
                sql: "UPDATE sessions SET parentSessionId = ? WHERE id = ?",
                arguments: [parentSessionId, sessionId]
            )
        }
    }

    /// Archive or unarchive a session.
    /// Updates the local database and sends a control message so the desktop
    /// can propagate the change to the sync server.
    public func setSessionArchived(sessionId: String, isArchived: Bool) throws {
        try database.writer.write { db in
            try db.execute(
                sql: "UPDATE sessions SET isArchived = ? WHERE id = ?",
                arguments: [isArchived, sessionId]
            )
        }

        sendSessionControlMessage(
            sessionId: sessionId,
            messageType: "archive",
            payload: ["isArchived": isArchived]
        )
    }
}
