import Foundation
import CryptoKit
import os

/// Manages document sync with ProjectSyncRoom Durable Objects.
/// Handles one WebSocket connection per project for syncing .md files.
///
/// Architecture:
///   - Connects to: `org:{orgId}:user:{userId}:project:{projectId}`
///   - Receives encrypted file content from the server
///   - Decrypts using CryptoManager and stores in GRDB via DatabaseManager
///   - DocumentListView observes the database for reactive updates
///   - Queues outgoing messages when offline, replays on reconnect
@MainActor
public final class DocumentSyncManager: ObservableObject {
    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "DocumentSync")

    private let crypto: CryptoManager
    private let database: DatabaseManager
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    /// One WebSocket client per project (keyed by projectId).
    private var projectClients: [String: WebSocketClient] = [:]

    /// Offline message queue per project. Messages are replayed on reconnect.
    private var offlineQueues: [String: [Data]] = [:]

    /// Track which project is currently active (user is viewing its files).
    @Published public var activeProjectId: String?

    /// Whether the active project's WebSocket is connected.
    @Published public var isConnected = false
    @Published public private(set) var loadStates: [String: DocumentSyncState] = [:]
    private var transfers: [String: DocumentSyncTransfer] = [:]
    private var transferTimeouts: [String: Task<Void, Never>] = [:]
    private let transferTimeout: Duration

    public func state(for projectId: String) -> DocumentSyncState {
        loadStates[projectId] ?? .connecting
    }

    func beginTransfer(_ projectId: String) {
        transfers[projectId] = DocumentSyncTransfer()
        loadStates[projectId] = .syncing(received: 0)
        scheduleTransferTimeout(projectId)
    }

    private func scheduleTransferTimeout(_ projectId: String) {
        transferTimeouts.removeValue(forKey: projectId)?.cancel()
        transferTimeouts[projectId] = Task { [weak self] in
            guard let duration = self?.transferTimeout else { return }
            do { try await Task.sleep(for: duration) } catch { return }
            self?.failProject(projectId, message: "File sync timed out before finishing. Please retry.")
        }
    }

    func failProject(_ projectId: String, message: String) {
        transferTimeouts.removeValue(forKey: projectId)?.cancel()
        loadStates[projectId] = .failed(message)
        logger.error("[DocSync] \(message)")
    }

    public func retryProject(_ projectId: String) {
        disconnectProject(projectId)
        connectProject(projectId)
    }

    /// Notifies when a remote file content update arrives for a specific syncId.
    /// DocumentEditorView subscribes to this to refresh its WKWebView content.
    public var onRemoteContentUpdate: ((String, String) -> Void)?  // (syncId, newMarkdown)

    private var serverUrl: String
    private var userId: String
    private var authUserId: String?
    private var authToken: String?
    private var orgId: String?

    /// Track per-project connection state for queueing decisions.
    private var projectConnected: [String: Bool] = [:]

    public init(crypto: CryptoManager, database: DatabaseManager, serverUrl: String, userId: String, transferTimeout: Duration = .seconds(30)) {
        self.crypto = crypto
        self.database = database
        self.serverUrl = serverUrl
        self.userId = userId
        self.transferTimeout = transferTimeout
    }

    /// The user ID to use for room routing. Prefers authUserId (from JWT) over pairing userId.
    private var effectiveUserId: String {
        authUserId ?? userId
    }

    // MARK: - Connection

    /// Store auth credentials for connecting to project rooms.
    public func setAuth(authToken: String, authUserId: String?, orgId: String) {
        let changed = self.authToken != authToken || self.authUserId != authUserId || self.orgId != orgId
        self.authToken = authToken
        self.authUserId = authUserId
        self.orgId = orgId
        if changed {
            let active = activeProjectId
            for projectId in Array(projectClients.keys) { retryProject(projectId) }
            activeProjectId = active
            isConnected = active.flatMap { projectConnected[$0] } ?? false
        }
    }

    /// Hash a project ID (workspace path) to match the desktop's SHA-256 room routing.
    private func hashProjectId(_ projectId: String) -> String {
        let data = Data(projectId.utf8)
        let hash = SHA256.hash(data: data)
        return hash.map { String(format: "%02x", $0) }.joined()
    }

    /// Connect to a project's ProjectSyncRoom for document sync.
    /// The projectId is the workspace path (matching Project.id).
    public func connectProject(_ projectId: String) {
        activeProjectId = projectId
        guard let authToken = authToken, let orgId = orgId else {
            failProject(projectId, message: "File sync is waiting for sign-in. Please retry after connecting.")
            return
        }
        if let existing = projectClients[projectId], existing.isConnected {
            isConnected = projectConnected[projectId] == true
            return
        }
        projectClients.removeValue(forKey: projectId)?.disconnect()
        loadStates[projectId] = .connecting
        isConnected = false
        scheduleTransferTimeout(projectId)
        let client = WebSocketClient()
        projectClients[projectId] = client
        let roomId = "org:\(orgId):user:\(effectiveUserId):project:\(hashProjectId(projectId))"

        client.onConnectedAsync = { [weak self, weak client] in
            guard let self, let client, self.projectClients[projectId] === client else { return }
            self.projectConnected[projectId] = true
            if self.activeProjectId == projectId { self.isConnected = true }
            self.beginTransfer(projectId)
            self.sendSyncRequest(projectId: projectId)
            self.replayOfflineQueue(projectId: projectId)
        }
        client.onConnectionStateChanged = { [weak self, weak client] connected in
            guard !connected else { return }
            Task { @MainActor in
                guard let self, let client, self.projectClients[projectId] === client else { return }
                self.projectConnected[projectId] = false
                if self.activeProjectId == projectId { self.isConnected = false }
            }
        }
        client.onError = { [weak self, weak client] message in
            guard let self, let client, self.projectClients[projectId] === client else { return }
            self.failProject(projectId, message: message)
        }
        client.onMessageAsync = { [weak self, weak client] data in
            guard let self, let client, self.projectClients[projectId] === client else { return }
            self.handleMessage(data, projectId: projectId)
        }

        client.connect(serverUrl: serverUrl, roomId: roomId, authToken: authToken)
    }

    /// Disconnect from a project's sync room.
    public func disconnectProject(_ projectId: String) {
        let client = projectClients.removeValue(forKey: projectId)
        client?.disconnect()
        transferTimeouts.removeValue(forKey: projectId)?.cancel()
        transfers.removeValue(forKey: projectId)
        loadStates.removeValue(forKey: projectId)
        projectConnected.removeValue(forKey: projectId)
        // Keep offline queue -- it will replay if we reconnect later
        if activeProjectId == projectId {
            activeProjectId = nil
            isConnected = false
        }
    }

    /// Disconnect from all project rooms.
    public func disconnectAll() {
        let clients = Array(projectClients.values)
        projectClients.removeAll()
        for client in clients { client.disconnect() }
        for timeout in transferTimeouts.values { timeout.cancel() }
        transferTimeouts.removeAll()
        transfers.removeAll()
        loadStates.removeAll()
        projectConnected.removeAll()
        offlineQueues.removeAll()
        activeProjectId = nil
        isConnected = false
    }

    /// Reconnect active project if WebSocket was dropped (e.g., app returning from background).
    public func reconnectIfNeeded() {
        for (projectId, client) in projectClients {
            if !client.isConnected {
                logger.info("[DocSync] Reconnecting project \(projectId)")
                client.reconnect()
            }
        }
    }

    // MARK: - On-Demand Fetch

    /// Resolve a document by relative path, ensuring it syncs to this device if
    /// it isn't here yet. Used when a user taps a transcript link for a doc the
    /// session just created: viewing a transcript does NOT connect us to that
    /// project's sync room, so the doc may never have arrived. Connecting sends a
    /// sync request that pulls any server docs we're missing; we then poll the
    /// local DB until the doc lands or we time out.
    ///
    /// Returns the document if it resolves within `timeout`, else nil.
    public func awaitDocument(
        projectId: String,
        relativePath: String,
        timeout: TimeInterval = 8.0
    ) async -> SyncedDocument? {
        // Fast path: already synced locally.
        if let doc = try? database.document(forProject: projectId, relativePath: relativePath) {
            return doc
        }

        // Connecting triggers sendSyncRequest -> server returns missing docs as
        // newFiles, which get upserted into the DB. Idempotent if already connected.
        connectProject(projectId)

        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 300_000_000) // 300ms
            if let doc = try? database.document(forProject: projectId, relativePath: relativePath) {
                return doc
            }
        }
        return try? database.document(forProject: projectId, relativePath: relativePath)
    }

    // MARK: - Sync Request

    /// Send initial sync request with manifest of locally cached documents.
    private func sendSyncRequest(projectId: String) {
        guard let client = projectClients[projectId] else { return }

        do {
            let docs = try database.documents(forProject: projectId)
            let manifest = docs.map { doc in
                ProjectSyncManifestEntry(
                    syncId: doc.id,
                    contentHash: doc.contentHash ?? "",
                    lastModifiedAt: doc.lastModifiedAt ?? 0,
                    hasYjs: doc.hasYjs,
                    yjsSeq: doc.yjsSeq
                )
            }

            let request = ProjectSyncRequestMessage(files: manifest)
            let data = try encoder.encode(request)
            guard let json = String(data: data, encoding: .utf8) else { throw CocoaError(.fileReadInapplicableStringEncoding) }
            client.sendRaw(json) { [weak self, weak client] error in
                guard let self, let client, self.projectClients[projectId] === client, let error else { return }
                self.failProject(projectId, message: "Could not request files: \(error.localizedDescription)")
            }
            logger.info("[DocSync] Sent sync request for project \(projectId) with \(manifest.count) files")
        } catch {
            failProject(projectId, message: "Could not request files: \(error.localizedDescription)")
        }
    }

    // MARK: - Message Handling

    func handleMessage(_ data: Data, projectId: String) {
        if case .failed = state(for: projectId) { return }
        guard let envelope = try? decoder.decode(ServerMessage.self, from: data) else {
            failProject(projectId, message: "File sync received an unreadable message. Please retry.")
            return
        }

        switch envelope.type {
        case "projectSyncResponse":
            handleSyncResponse(data, projectId: projectId)
        case "fileContentBroadcast":
            handleFileContentBroadcast(data, projectId: projectId)
        case "fileDeleteBroadcast":
            handleFileDeleteBroadcast(data, projectId: projectId)
        case "fileYjsInitBroadcast":
            handleYjsInitBroadcast(data, projectId: projectId)
        case "fileYjsUpdateBroadcast":
            handleYjsUpdateBroadcast(data, projectId: projectId)
        case "error":
            if let error = try? decoder.decode(ServerError.self, from: data) {
                failProject(projectId, message: error.message)
            }
        default:
            // logger.debug("[DocSync] Ignoring message type: \(envelope.type)")
            break
        }
    }

    // MARK: - Sync Response

    private func handleSyncResponse(_ data: Data, projectId: String) {
        do {
            let response = try decoder.decode(ProjectSyncResponse.self, from: data)
            var transfer = transfers[projectId] ?? DocumentSyncTransfer()
            try transfer.accept(response)
            try applyDocumentSyncBatch(response, projectId: projectId, crypto: crypto, database: database)
            transfers[projectId] = transfer
            loadStates[projectId] = transfer.complete ? .ready : .syncing(received: transfer.received)
            if transfer.complete {
                transferTimeouts.removeValue(forKey: projectId)?.cancel()
            } else {
                scheduleTransferTimeout(projectId)
            }
        } catch {
            logger.error("[DocSync] Batch failed: \(error.localizedDescription)")
            failProject(projectId, message: "Could not read or save downloaded files. Please retry.")
        }
    }

    // MARK: - Broadcast Handlers

    private func handleFileContentBroadcast(_ data: Data, projectId: String) {
        guard let broadcast = try? decoder.decode(FileContentBroadcast.self, from: data) else {
            logger.error("[DocSync] Failed to decode file content broadcast")
            return
        }

        let entry = ProjectSyncFileEntry(
            syncId: broadcast.syncId,
            encryptedContent: broadcast.encryptedContent,
            contentIv: broadcast.contentIv,
            contentHash: broadcast.contentHash,
            encryptedPath: broadcast.encryptedPath,
            pathIv: broadcast.pathIv,
            encryptedTitle: broadcast.encryptedTitle,
            titleIv: broadcast.titleIv,
            lastModifiedAt: broadcast.lastModifiedAt,
            hasYjs: false  // content broadcast = markdown phase
        )
        upsertFileEntry(entry, projectId: projectId)
        logger.info("[DocSync] File content broadcast: \(broadcast.syncId)")

        // Notify open editor if viewing this document
        if let content = crypto.decryptOrNil(encryptedBase64: broadcast.encryptedContent, ivBase64: broadcast.contentIv) {
            onRemoteContentUpdate?(broadcast.syncId, content)
        }
    }

    private func handleFileDeleteBroadcast(_ data: Data, projectId: String) {
        guard let broadcast = try? decoder.decode(FileDeleteBroadcast.self, from: data) else {
            logger.error("[DocSync] Failed to decode file delete broadcast")
            return
        }

        do {
            try database.deleteDocument(broadcast.syncId)
            logger.info("[DocSync] File deleted via broadcast: \(broadcast.syncId)")
        } catch {
            logger.error("[DocSync] Failed to delete file: \(error.localizedDescription)")
        }
    }

    private func handleYjsInitBroadcast(_ data: Data, projectId: String) {
        guard let broadcast = try? decoder.decode(FileYjsInitBroadcast.self, from: data) else {
            logger.error("[DocSync] Failed to decode Yjs init broadcast")
            return
        }

        do {
            if var doc = try database.document(byId: broadcast.syncId) {
                doc.hasYjs = true
                doc.updatedAt = Int(Date().timeIntervalSince1970 * 1000)
                try database.upsertDocument(doc)
                logger.info("[DocSync] File upgraded to Yjs: \(broadcast.syncId)")
            }
        } catch {
            logger.error("[DocSync] Failed to handle Yjs init: \(error.localizedDescription)")
        }
    }

    private func handleYjsUpdateBroadcast(_ data: Data, projectId: String) {
        guard let broadcast = try? decoder.decode(FileYjsUpdateBroadcast.self, from: data) else {
            logger.error("[DocSync] Failed to decode Yjs update broadcast")
            return
        }

        do {
            if var doc = try database.document(byId: broadcast.syncId) {
                if broadcast.sequence > doc.yjsSeq {
                    doc.yjsSeq = broadcast.sequence
                    doc.updatedAt = Int(Date().timeIntervalSince1970 * 1000)
                    try database.upsertDocument(doc)
                }
            }
        } catch {
            logger.error("[DocSync] Failed to handle Yjs update: \(error.localizedDescription)")
        }
    }

    // MARK: - File Upsert Helper

    /// Decrypt and upsert a file entry from the server.
    /// When `skipContent` is true, only metadata (path, title, hash) is stored -- content
    /// is decrypted on demand when the user opens the document. This prevents OOM during bulk sync.
    private func upsertFileEntry(_ entry: ProjectSyncFileEntry, projectId: String, skipContent: Bool = false) {
        let now = Int(Date().timeIntervalSince1970 * 1000)

        // Always decrypt path and title (small strings, needed for file list UI)
        let path = crypto.decryptOrNil(encryptedBase64: entry.encryptedPath, ivBase64: entry.pathIv) ?? "unknown.md"
        let title = crypto.decryptOrNil(encryptedBase64: entry.encryptedTitle, ivBase64: entry.titleIv) ?? (path as NSString).lastPathComponent

        // Only decrypt content for individual updates (broadcasts), not bulk sync
        let content: String? = skipContent ? nil : crypto.decryptOrNil(encryptedBase64: entry.encryptedContent, ivBase64: entry.contentIv)

        let doc = SyncedDocument(
            id: entry.syncId,
            projectId: projectId,
            relativePath: path,
            title: title,
            contentHash: entry.contentHash,
            lastModifiedAt: entry.lastModifiedAt,
            syncedAt: now,
            contentDecrypted: content,
            // Store encrypted content for on-demand decryption when content was skipped
            encryptedContent: skipContent ? entry.encryptedContent : nil,
            contentIv: skipContent ? entry.contentIv : nil,
            hasYjs: entry.hasYjs,
            yjsSeq: 0,
            createdAt: now,
            updatedAt: now
        )

        do {
            try database.upsertDocument(doc)
        } catch {
            logger.error("[DocSync] Failed to upsert document \(entry.syncId): \(error.localizedDescription)")
        }
    }

    // MARK: - On-Demand Content Decryption

    /// Decrypt and cache content for a document that was stored without content during bulk sync.
    /// Returns the decrypted markdown, or nil if decryption fails.
    public func decryptContentOnDemand(_ document: SyncedDocument) -> String? {
        decryptDocumentContent(document, crypto: crypto, database: database)
    }

    // MARK: - Offline Queue

    /// Enqueue a message for a project. Sends immediately if connected, otherwise queues for replay.
    private func sendOrQueue<T: Encodable>(_ message: T, projectId: String) {
        guard let data = try? encoder.encode(message) else {
            logger.error("[DocSync] Failed to encode message for queue")
            return
        }

        if projectConnected[projectId] == true, let client = projectClients[projectId] {
            client.send(message)
        } else {
            offlineQueues[projectId, default: []].append(data)
            logger.info("[DocSync] Queued message for offline project \(projectId) (\(self.offlineQueues[projectId]?.count ?? 0) queued)")
        }
    }

    /// Replay all queued messages for a project after reconnect.
    private func replayOfflineQueue(projectId: String) {
        guard let queue = offlineQueues[projectId], !queue.isEmpty else { return }
        guard let client = projectClients[projectId] else { return }

        logger.info("[DocSync] Replaying \(queue.count) queued messages for project \(projectId)")
        for data in queue {
            if let json = String(data: data, encoding: .utf8) {
                client.sendRaw(json)
            }
        }
        offlineQueues[projectId] = nil
    }

    // MARK: - Content Push (Encrypted)

    /// Push edited markdown content to the server. Encrypts content, path, and title before sending.
    /// Also updates the local GRDB cache. Queues the message if offline.
    public func pushEditedContent(document: SyncedDocument, markdown: String, projectId: String) {
        let now = Int(Date().timeIntervalSince1970 * 1000)

        // Compute content hash (SHA-256 of plaintext)
        let hash = SHA256.hash(data: Data(markdown.utf8))
        let contentHash = hash.map { String(format: "%02x", $0) }.joined()

        do {
            let (encContent, contentIv) = try crypto.encrypt(plaintext: markdown)
            let (encPath, pathIv) = try crypto.encrypt(plaintext: document.relativePath)
            let (encTitle, titleIv) = try crypto.encrypt(plaintext: document.title)

            let message = FileContentPushMessage(
                syncId: document.id,
                encryptedContent: encContent,
                contentIv: contentIv,
                contentHash: contentHash,
                encryptedPath: encPath,
                pathIv: pathIv,
                encryptedTitle: encTitle,
                titleIv: titleIv,
                lastModifiedAt: now
            )
            sendOrQueue(message, projectId: projectId)

            // Update local GRDB cache
            var updated = document
            updated.contentDecrypted = markdown
            updated.contentHash = contentHash
            updated.lastModifiedAt = now
            updated.updatedAt = now
            try database.upsertDocument(updated)
        } catch {
            logger.error("[DocSync] Failed to push edited content for \(document.id): \(error.localizedDescription)")
        }
    }

    /// Number of queued messages for a project (for debugging/UI).
    public func queuedMessageCount(for projectId: String) -> Int {
        offlineQueues[projectId]?.count ?? 0
    }

    // MARK: - Send Messages

    /// Push raw pre-encrypted file content to the server.
    public func pushFileContent(
        syncId: String,
        encryptedContent: String,
        contentIv: String,
        contentHash: String,
        encryptedPath: String,
        pathIv: String,
        encryptedTitle: String,
        titleIv: String,
        lastModifiedAt: Int,
        projectId: String
    ) {
        let message = FileContentPushMessage(
            syncId: syncId,
            encryptedContent: encryptedContent,
            contentIv: contentIv,
            contentHash: contentHash,
            encryptedPath: encryptedPath,
            pathIv: pathIv,
            encryptedTitle: encryptedTitle,
            titleIv: titleIv,
            lastModifiedAt: lastModifiedAt
        )
        sendOrQueue(message, projectId: projectId)
    }

    /// Send a Yjs update for a file being edited.
    public func pushYjsUpdate(syncId: String, encryptedUpdate: String, iv: String, projectId: String) {
        let message = FileYjsUpdateMessage(
            syncId: syncId,
            encryptedUpdate: encryptedUpdate,
            iv: iv
        )
        sendOrQueue(message, projectId: projectId)
    }

    /// Initialize Yjs for a file (upgrade from markdown to CRDT phase).
    public func initYjs(syncId: String, encryptedSnapshot: String, iv: String, projectId: String) {
        let message = FileYjsInitMessage(
            syncId: syncId,
            encryptedSnapshot: encryptedSnapshot,
            iv: iv
        )
        sendOrQueue(message, projectId: projectId)
    }

    /// Delete a file from the sync room.
    public func deleteFile(syncId: String, projectId: String) {
        let message = FileDeleteMessage(syncId: syncId)
        sendOrQueue(message, projectId: projectId)
    }
}
