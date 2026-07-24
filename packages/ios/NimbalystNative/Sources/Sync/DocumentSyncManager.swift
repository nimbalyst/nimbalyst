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

    public init(crypto: CryptoManager, database: DatabaseManager, serverUrl: String, userId: String) {
        self.crypto = crypto
        self.database = database
        self.serverUrl = serverUrl
        self.userId = userId
    }

    /// The user ID to use for room routing. Prefers authUserId (from JWT) over pairing userId.
    private var effectiveUserId: String {
        authUserId ?? userId
    }

    // MARK: - Connection

    /// Store auth credentials for connecting to project rooms.
    public func setAuth(authToken: String, authUserId: String?, orgId: String) {
        self.authToken = authToken
        self.authUserId = authUserId
        self.orgId = orgId
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
        guard let authToken = authToken, let orgId = orgId else {
            return
        }

        let hashedId = hashProjectId(projectId)

        // Already connected to this project
        if let existing = projectClients[projectId], existing.isConnected {
            activeProjectId = projectId
            isConnected = true
            return
        }

        activeProjectId = projectId

        let client = WebSocketClient()
        projectClients[projectId] = client

        let roomId = "org:\(orgId):user:\(effectiveUserId):project:\(hashedId)"
        logger.info("[DocSync] Connecting to project room: \(roomId)")

        client.onConnectionStateChanged = { [weak self] connected in
            Task { @MainActor in
                guard let self = self else { return }
                self.projectConnected[projectId] = connected
                if self.activeProjectId == projectId {
                    self.isConnected = connected
                }
                if connected {
                    self.sendSyncRequest(projectId: projectId)
                    self.replayOfflineQueue(projectId: projectId)
                }
            }
        }

        client.onMessage = { [weak self] data in
            Task { @MainActor in
                self?.handleMessage(data, projectId: projectId)
            }
        }

        client.connect(serverUrl: serverUrl, roomId: roomId, authToken: authToken)
    }

    /// Disconnect from a project's sync room.
    public func disconnectProject(_ projectId: String) {
        projectClients[projectId]?.disconnect()
        projectClients.removeValue(forKey: projectId)
        projectConnected.removeValue(forKey: projectId)
        // Keep offline queue -- it will replay if we reconnect later
        if activeProjectId == projectId {
            activeProjectId = nil
            isConnected = false
        }
    }

    /// Disconnect from all project rooms.
    public func disconnectAll() {
        for (_, client) in projectClients {
            client.disconnect()
        }
        projectClients.removeAll()
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
            client.send(request)
            logger.info("[DocSync] Sent sync request for project \(projectId) with \(manifest.count) files")
        } catch {
            logger.error("[DocSync] Failed to build sync request: \(error.localizedDescription)")
        }
    }

    // MARK: - Message Handling

    private func handleMessage(_ data: Data, projectId: String) {
        guard let envelope = try? decoder.decode(ServerMessage.self, from: data) else {
            logger.error("[DocSync] Failed to decode message envelope")
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
                logger.error("[DocSync] Server error: \(error.message)")
            }
        default:
            // logger.debug("[DocSync] Ignoring message type: \(envelope.type)")
            break
        }
    }

    // MARK: - Sync Response

    private func handleSyncResponse(_ data: Data, projectId: String) {
        guard let response = try? decoder.decode(ProjectSyncResponse.self, from: data) else {
            logger.error("[DocSync] Failed to decode sync response")
            return
        }

        logger.info("[DocSync] Sync response: \(response.updatedFiles.count) updated, \(response.newFiles.count) new, \(response.needFromClient.count) needed, \(response.deletedSyncIds.count) deleted, \(response.yjsUpdates.count) yjs updates")

        // For bulk syncs (>50 files), skip content decryption to avoid OOM.
        // Content is decrypted on demand when the user opens a document.
        // Individual file broadcasts always include content (they're single files).
        let totalFiles = response.updatedFiles.count + response.newFiles.count
        let isBulkSync = totalFiles > 50

        for file in response.updatedFiles {
            upsertFileEntry(file, projectId: projectId, skipContent: isBulkSync)
        }

        for file in response.newFiles {
            upsertFileEntry(file, projectId: projectId, skipContent: isBulkSync)
        }

        if isBulkSync {
            logger.info("[DocSync] Bulk sync: stored \(totalFiles) file metadata (content loaded on demand)")
        }

        // Process deletions
        if !response.deletedSyncIds.isEmpty {
            do {
                try database.deleteDocuments(syncIds: response.deletedSyncIds)
                logger.info("[DocSync] Deleted \(response.deletedSyncIds.count) files")
            } catch {
                logger.error("[DocSync] Failed to delete files: \(error.localizedDescription)")
            }
        }

        // Process Yjs updates (store latest sequence for each file)
        for update in response.yjsUpdates {
            do {
                if var doc = try database.document(byId: update.syncId) {
                    if update.sequence > doc.yjsSeq {
                        doc.yjsSeq = update.sequence
                        doc.updatedAt = Int(Date().timeIntervalSince1970 * 1000)
                        try database.upsertDocument(doc)
                    }
                }
            } catch {
                logger.error("[DocSync] Failed to update Yjs seq for \(update.syncId): \(error.localizedDescription)")
            }
        }

        // needFromClient: mobile doesn't originate files, so we ignore this for now.
        // Desktop is the source of truth for file content.
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
        guard document.contentDecrypted == nil,
              let encrypted = document.encryptedContent,
              let iv = document.contentIv else {
            return document.contentDecrypted
        }

        guard let content = crypto.decryptOrNil(encryptedBase64: encrypted, ivBase64: iv) else {
            logger.error("[DocSync] Failed to decrypt content on demand for \(document.id)")
            return nil
        }

        // Cache the decrypted content and clear the encrypted blob
        var updated = document
        updated.contentDecrypted = content
        updated.encryptedContent = nil
        updated.contentIv = nil
        do {
            try database.upsertDocument(updated)
        } catch {
            logger.error("[DocSync] Failed to cache decrypted content for \(document.id): \(error.localizedDescription)")
        }

        return content
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
