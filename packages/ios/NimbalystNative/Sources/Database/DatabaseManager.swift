import Foundation
import GRDB

/// Manages the local SQLite database using GRDB.
/// Provides database access, migrations, and observation for reactive UI updates.
public final class DatabaseManager: @unchecked Sendable {
    /// The underlying database writer (DatabasePool for file, DatabaseQueue for in-memory).
    public let writer: any DatabaseWriter

    /// Initialize with a database at the given file path.
    public init(path: String) throws {
        writer = try DatabasePool(path: path)
        try migrate()
    }

    /// Initialize with an in-memory database (for testing).
    public init() throws {
        writer = try DatabaseQueue()
        try migrate()
    }

    /// Default database path in the app's Application Support directory.
    /// The directory is protected with `NSFileProtectionComplete` so the database
    /// (which caches decrypted content) is encrypted at rest when the device is locked.
    public static var defaultPath: String {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
        let dbDir = appSupport.appendingPathComponent("NimbalystNative", isDirectory: true)
        try? FileManager.default.createDirectory(at: dbDir, withIntermediateDirectories: true)
        // Protect the database directory so all files within it (including WAL and SHM)
        // are encrypted at rest when the device is locked.
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: dbDir.path
        )
        return dbDir.appendingPathComponent("nimbalyst.sqlite").path
    }

    /// Erase all data from every table. Safe to call while the database is still
    /// open -- this avoids the ARC-timing issues of deleting the file on disk
    /// while references may still hold the database pool open.
    public func eraseAllData() throws {
        try writer.write { db in
            // Order matters: children before parents due to foreign key constraints
            try db.execute(sql: "DELETE FROM queuedPrompts")
            try db.execute(sql: "DELETE FROM messages")
            try db.execute(sql: "DELETE FROM syncedDocuments")
            try db.execute(sql: "DELETE FROM syncState")
            try db.execute(sql: "DELETE FROM sessions")
            try db.execute(sql: "DELETE FROM projects")
        }
    }

    /// Delete the entire database directory from disk.
    /// Removes the directory containing the sqlite file, WAL, and SHM in one operation.
    /// The directory is recreated on the next `defaultPath` access.
    public static func deleteDatabase() {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
        let dbDir = appSupport.appendingPathComponent("NimbalystNative", isDirectory: true)
        try? FileManager.default.removeItem(at: dbDir)
    }

    // MARK: - Migrations

    private func migrate() throws {
        var migrator = DatabaseMigrator()

        #if DEBUG
        migrator.eraseDatabaseOnSchemaChange = true
        #endif

        migrator.registerMigration("v1_initial") { db in
            // Projects
            try db.create(table: "projects") { t in
                t.primaryKey("id", .text)
                t.column("name", .text).notNull()
                t.column("sessionCount", .integer).defaults(to: 0)
                t.column("lastUpdatedAt", .integer)
                t.column("sortOrder", .integer).defaults(to: 0)
            }

            // Sessions
            try db.create(table: "sessions") { t in
                t.primaryKey("id", .text)
                t.column("projectId", .text)
                    .notNull()
                    .references("projects", onDelete: .cascade)
                t.column("titleEncrypted", .text)
                t.column("titleIv", .text)
                t.column("titleDecrypted", .text)
                t.column("provider", .text)
                t.column("model", .text)
                t.column("mode", .text)
                t.column("isExecuting", .boolean).defaults(to: false)
                t.column("hasQueuedPrompts", .boolean).defaults(to: false)
                t.column("createdAt", .integer).notNull()
                t.column("updatedAt", .integer).notNull()
                t.column("lastSyncedSeq", .integer).defaults(to: 0)
            }

            // Messages
            try db.create(table: "messages") { t in
                t.primaryKey("id", .text)
                t.column("sessionId", .text)
                    .notNull()
                    .references("sessions", onDelete: .cascade)
                t.column("sequence", .integer).notNull()
                t.column("source", .text).notNull()
                t.column("direction", .text).notNull()
                t.column("encryptedContent", .text).notNull()
                t.column("iv", .text).notNull()
                t.column("contentDecrypted", .text)
                t.column("metadataJson", .text)
                t.column("createdAt", .integer).notNull()
                t.uniqueKey(["sessionId", "sequence"])
            }

            // Sync state watermarks
            try db.create(table: "syncState") { t in
                t.primaryKey("roomId", .text)
                t.column("lastCursor", .text)
                t.column("lastSequence", .integer).defaults(to: 0)
                t.column("lastSyncedAt", .integer)
            }

            // Queued prompts
            try db.create(table: "queuedPrompts") { t in
                t.primaryKey("id", .text)
                t.column("sessionId", .text)
                    .notNull()
                    .references("sessions", onDelete: .cascade)
                t.column("promptTextEncrypted", .text).notNull()
                t.column("iv", .text).notNull()
                t.column("createdAt", .integer).notNull()
                t.column("sentAt", .integer)
            }

            // Indices
            try db.create(
                index: "idx_messages_session_seq",
                on: "messages",
                columns: ["sessionId", "sequence"]
            )
            try db.create(
                index: "idx_sessions_project",
                on: "sessions",
                columns: ["projectId"]
            )
            try db.create(
                index: "idx_sessions_updated",
                on: "sessions",
                columns: ["updatedAt"]
            )
        }

        migrator.registerMigration("v2_context_usage") { db in
            try db.alter(table: "sessions") { t in
                t.add(column: "contextTokens", .integer)
                t.add(column: "contextWindow", .integer)
            }
        }

        migrator.registerMigration("v3_read_state") { db in
            try db.alter(table: "sessions") { t in
                t.add(column: "lastReadAt", .integer)
                t.add(column: "lastMessageAt", .integer)
            }
        }

        migrator.registerMigration("v4_session_type") { db in
            try db.alter(table: "sessions") { t in
                t.add(column: "sessionType", .text)
            }
        }

        migrator.registerMigration("v5_project_commands") { db in
            try db.alter(table: "projects") { t in
                t.add(column: "commandsJson", .text)
            }
        }

        migrator.registerMigration("v6_session_hierarchy") { db in
            try db.alter(table: "sessions") { t in
                t.add(column: "parentSessionId", .text)
                t.add(column: "phase", .text)
                t.add(column: "tagsJson", .text)
            }
            // Index for efficient child lookups
            try db.create(index: "idx_sessions_parent", on: "sessions", columns: ["parentSessionId"])
        }

        migrator.registerMigration("v7_worktree_and_branch") { db in
            try db.alter(table: "sessions") { t in
                t.add(column: "worktreeId", .text)
                t.add(column: "isArchived", .boolean).defaults(to: false)
                t.add(column: "isPinned", .boolean).defaults(to: false)
                t.add(column: "branchedFromSessionId", .text)
                t.add(column: "branchPointMessageId", .integer)
                t.add(column: "branchedAt", .integer)
            }
        }

        migrator.registerMigration("v8_draft_and_queue_display") { db in
            try db.alter(table: "sessions") { t in
                t.add(column: "draftInput", .text)
            }
            try db.alter(table: "queuedPrompts") { t in
                t.add(column: "promptTextDecrypted", .text)
                t.add(column: "source", .text)
            }
        }

        migrator.registerMigration("v9_draft_updated_at") { db in
            try db.alter(table: "sessions") { t in
                t.add(column: "draftUpdatedAt", .integer)
            }
        }

        migrator.registerMigration("v10_synced_documents") { db in
            try db.create(table: "syncedDocuments") { t in
                t.primaryKey("id", .text)              // syncId UUID
                t.column("projectId", .text)
                    .notNull()
                    .references("projects", onDelete: .cascade)
                t.column("relativePath", .text).notNull()
                t.column("title", .text).notNull()
                t.column("contentHash", .text)
                t.column("lastModifiedAt", .integer)
                t.column("syncedAt", .integer)
                t.column("contentDecrypted", .text)
                t.column("hasYjs", .boolean).defaults(to: false)
                t.column("yjsSeq", .integer).defaults(to: 0)
                t.column("yjsStateEncrypted", .text)
                t.column("yjsStateIv", .text)
                t.column("createdAt", .integer).notNull()
                t.column("updatedAt", .integer).notNull()
            }
            try db.create(
                index: "idx_synced_documents_project",
                on: "syncedDocuments",
                columns: ["projectId"]
            )
            try db.create(
                index: "idx_synced_documents_path",
                on: "syncedDocuments",
                columns: ["projectId", "relativePath"],
                unique: true
            )
        }

        migrator.registerMigration("v11_project_git_remote_hash") { db in
            try db.alter(table: "projects") { t in
                t.add(column: "gitRemoteHash", .text)
            }
        }

        migrator.registerMigration("v12_document_encrypted_content") { db in
            try db.alter(table: "syncedDocuments") { t in
                t.add(column: "encryptedContent", .text)
                t.add(column: "contentIv", .text)
            }
        }

        migrator.registerMigration("v13_meta_agent") { db in
            try db.alter(table: "sessions") { t in
                t.add(column: "agentRole", .text)
                t.add(column: "createdBySessionId", .text)
            }
            // Index for efficient sub-agent (child) lookups by meta-agent session
            try db.create(index: "idx_sessions_created_by", on: "sessions", columns: ["createdBySessionId"])
        }

        try migrator.migrate(writer)
    }

    // MARK: - Project Queries

    public func allProjects() throws -> [Project] {
        try writer.read { db in
            try Project.order(Project.Columns.sortOrder, Project.Columns.name).fetchAll(db)
        }
    }

    public func upsertProject(_ project: Project) throws {
        try writer.write { db in
            try project.save(db)
        }
    }

    /// Update a project's lastUpdatedAt only if the new value is more recent.
    public func updateProjectLastActivity(projectId: String, activityAt: Int) throws {
        try writer.write { db in
            try db.execute(
                sql: "UPDATE projects SET lastUpdatedAt = MAX(COALESCE(lastUpdatedAt, 0), ?) WHERE id = ?",
                arguments: [activityAt, projectId]
            )
        }
    }

    /// Recalculate lastUpdatedAt and sessionCount for all projects from their sessions.
    /// This ensures project ordering is correct even if server-side stats are stale.
    /// sessionCount reflects what the user sees in SessionListView -- archived and
    /// workstream/blitz containers are excluded.
    public func refreshAllProjectStats() throws {
        try writer.write { db in
            try db.execute(sql: """
                UPDATE projects SET
                    lastUpdatedAt = (
                        SELECT MAX(updatedAt) FROM sessions WHERE sessions.projectId = projects.id
                    ),
                    sessionCount = (
                        SELECT COUNT(*) FROM sessions
                        WHERE sessions.projectId = projects.id
                          AND COALESCE(sessions.sessionType, 'session') NOT IN ('workstream', 'blitz')
                          AND sessions.isArchived = 0
                    )
            """)
        }
    }

    // MARK: - Session Queries

    public func sessions(forProject projectId: String) throws -> [Session] {
        try writer.read { db in
            try Session
                .filter(Session.Columns.projectId == projectId)
                // Hide workstream/blitz parent sessions - structural containers on desktop.
                // NULL = legacy session before type field existed, treat as normal.
                .filter(Session.Columns.sessionType == nil || (Session.Columns.sessionType != "workstream" && Session.Columns.sessionType != "blitz"))
                .order(Session.Columns.updatedAt.desc)
                .fetchAll(db)
        }
    }

    public func upsertSession(_ session: Session) throws {
        try writer.write { db in
            try session.save(db)
        }
    }

    public func session(byId sessionId: String) throws -> Session? {
        try writer.read { db in
            try Session.fetchOne(db, id: sessionId)
        }
    }

    public func deleteSession(_ sessionId: String) throws {
        try writer.write { db in
            _ = try Session.deleteOne(db, id: sessionId)
        }
    }

    /// Recount sessions for a project and update the stored count.
    /// Matches the filter applied in SessionListView (and refreshAllProjectStats):
    /// archived sessions and workstream/blitz container types are excluded so the
    /// displayed count matches what the user actually sees.
    public func refreshSessionCount(forProject projectId: String) throws {
        try writer.write { db in
            let count = try Session
                .filter(Session.Columns.projectId == projectId)
                .filter(Session.Columns.isArchived == false)
                .filter(Session.Columns.sessionType == nil || (Session.Columns.sessionType != "workstream" && Session.Columns.sessionType != "blitz"))
                .fetchCount(db)
            try db.execute(
                sql: "UPDATE projects SET sessionCount = ? WHERE id = ?",
                arguments: [count, projectId]
            )
        }
    }

    public func updateSessionTitle(_ sessionId: String, decrypted: String) throws {
        try writer.write { db in
            try db.execute(
                sql: "UPDATE sessions SET titleDecrypted = ? WHERE id = ?",
                arguments: [decrypted, sessionId]
            )
        }
    }

    /// Mark a session as read by updating lastReadAt to the current time.
    public func markSessionRead(_ sessionId: String) throws {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        try writer.write { db in
            try db.execute(
                sql: "UPDATE sessions SET lastReadAt = ? WHERE id = ?",
                arguments: [now, sessionId]
            )
        }
    }

    // MARK: - Message Queries

    public func messages(forSession sessionId: String) throws -> [Message] {
        try writer.read { db in
            try Message
                .filter(Message.Columns.sessionId == sessionId)
                .order(Message.Columns.sequence)
                .fetchAll(db)
        }
    }

    public func nextSequence(forSession sessionId: String) throws -> Int {
        try writer.read { db in
            let maxSeq = try Int.fetchOne(
                db,
                sql: "SELECT MAX(sequence) FROM messages WHERE sessionId = ?",
                arguments: [sessionId]
            )
            return (maxSeq ?? 0) + 1
        }
    }

    public func appendMessage(_ message: Message) throws {
        try writer.write { db in
            // Use INSERT OR IGNORE to skip duplicates (same sessionId + sequence).
            // This handles the case where we store a message locally (e.g. a sent prompt)
            // and then receive the same message back via a session room broadcast.
            try message.insert(db, onConflict: .ignore)
        }
    }

    public func appendMessages(_ messages: [Message]) throws {
        try writer.write { db in
            for message in messages {
                try message.insert(db, onConflict: .ignore)
            }
        }
    }

    // MARK: - Sync State Queries

    public func syncState(forRoom roomId: String) throws -> SyncState? {
        try writer.read { db in
            try SyncState.filter(Column("roomId") == roomId).fetchOne(db)
        }
    }

    public func updateSyncState(_ state: SyncState) throws {
        try writer.write { db in
            try state.save(db)
        }
    }

    // MARK: - Queued Prompts

    public func pendingPrompts(forSession sessionId: String) throws -> [QueuedPrompt] {
        try writer.read { db in
            try QueuedPrompt
                .filter(QueuedPrompt.Columns.sessionId == sessionId)
                .filter(QueuedPrompt.Columns.sentAt == nil)
                .order(QueuedPrompt.Columns.createdAt)
                .fetchAll(db)
        }
    }

    public func markPromptSent(_ promptId: String) throws {
        try writer.write { db in
            let now = Int(Date().timeIntervalSince1970 * 1000)
            try db.execute(
                sql: "UPDATE queuedPrompts SET sentAt = ? WHERE id = ?",
                arguments: [now, promptId]
            )
        }
    }

    /// All queued prompts for a session (including synced from desktop), ordered by creation time.
    public func queuedPrompts(forSession sessionId: String) throws -> [QueuedPrompt] {
        try writer.read { db in
            try QueuedPrompt
                .filter(QueuedPrompt.Columns.sessionId == sessionId)
                .order(QueuedPrompt.Columns.createdAt)
                .fetchAll(db)
        }
    }

    /// Replace all queued prompts for a session with the given list (used for sync updates).
    public func replaceQueuedPrompts(forSession sessionId: String, with prompts: [QueuedPrompt]) throws {
        try writer.write { db in
            // Delete existing prompts for this session that were synced from remote
            // (keep locally-created ones that haven't been sent yet)
            try QueuedPrompt
                .filter(QueuedPrompt.Columns.sessionId == sessionId)
                .filter(QueuedPrompt.Columns.source != nil)
                .deleteAll(db)
            // Insert the new synced prompts
            for prompt in prompts {
                try prompt.save(db)
            }
        }
    }

    /// Delete all synced queued prompts for a session (queue was cleared).
    public func deleteRemoteQueuedPrompts(forSession sessionId: String) throws {
        try writer.write { db in
            try QueuedPrompt
                .filter(QueuedPrompt.Columns.sessionId == sessionId)
                .filter(QueuedPrompt.Columns.source != nil)
                .deleteAll(db)
        }
    }

    /// Update draft input for a session.
    public func updateSessionDraftInput(sessionId: String, draftInput: String?, draftUpdatedAt: Int? = nil) throws {
        try writer.write { db in
            try db.execute(
                sql: "UPDATE sessions SET draftInput = ?, draftUpdatedAt = ? WHERE id = ?",
                arguments: [draftInput, draftUpdatedAt, sessionId]
            )
        }
    }

    // MARK: - Synced Document Queries

    public func documents(forProject projectId: String) throws -> [SyncedDocument] {
        try writer.read { db in
            try SyncedDocument
                .filter(SyncedDocument.Columns.projectId == projectId)
                .order(SyncedDocument.Columns.relativePath)
                .fetchAll(db)
        }
    }

    public func document(byId syncId: String) throws -> SyncedDocument? {
        try writer.read { db in
            try SyncedDocument.fetchOne(db, id: syncId)
        }
    }

    public func document(forProject projectId: String, relativePath: String) throws -> SyncedDocument? {
        try writer.read { db in
            try SyncedDocument
                .filter(SyncedDocument.Columns.projectId == projectId)
                .filter(SyncedDocument.Columns.relativePath == relativePath)
                .fetchOne(db)
        }
    }

    public func upsertDocument(_ document: SyncedDocument) throws {
        try writer.write { db in
            try document.save(db)
        }
    }

    public func upsertDocuments(_ documents: [SyncedDocument]) throws {
        try writer.write { db in
            for document in documents {
                try document.save(db)
            }
        }
    }

    public func deleteDocument(_ syncId: String) throws {
        try writer.write { db in
            _ = try SyncedDocument.deleteOne(db, id: syncId)
        }
    }

    public func deleteDocuments(syncIds: [String]) throws {
        try writer.write { db in
            try SyncedDocument
                .filter(syncIds.contains(SyncedDocument.Columns.id))
                .deleteAll(db)
        }
    }

    /// Count of synced documents for a project.
    public func documentCount(forProject projectId: String) throws -> Int {
        try writer.read { db in
            try SyncedDocument
                .filter(SyncedDocument.Columns.projectId == projectId)
                .fetchCount(db)
        }
    }
}
