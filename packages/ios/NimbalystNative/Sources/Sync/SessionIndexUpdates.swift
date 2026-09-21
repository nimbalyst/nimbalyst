import Foundation

/// Builds the `indexUpdate` messages the phone sends for its own local edits.
///
/// These all publish an optimistic local write: the row is already committed in
/// GRDB and the send is how the desktop finds out. They are built here, from a
/// `Session` read at send time, so `SyncRequestRegistry` can call the same
/// builder again after a reconnect and publish what the row says *now* rather
/// than replaying bytes the user has since edited.
enum SessionIndexUpdates {
    static func prompt(session: Session, prompt: EncryptedQueuedPrompt, messageCount: Int, crypto: CryptoManager) throws -> String {
        try encode(IndexUpdateEntry(
            sessionId: session.id,
            encryptedProjectId: crypto.encryptProjectId(session.projectId),
            projectIdIv: CryptoManager.projectIdIvBase64,
            encryptedTitle: session.titleEncrypted,
            titleIv: session.titleIv,
            provider: session.provider ?? "claude-code",
            model: session.model,
            mode: session.mode,
            messageCount: messageCount,
            lastMessageAt: prompt.timestamp,
            createdAt: session.createdAt,
            updatedAt: prompt.timestamp,
            isExecuting: nil,
            queuedPromptCount: 1,
            encryptedQueuedPrompts: [prompt]
        ))
    }

    /// Publishes the draft the composer holds. An empty `draft` is sent
    /// explicitly rather than omitted, because omitting it means "unchanged"
    /// and the remote cache would keep showing the cleared text.
    static func draft(
        session: Session,
        draft: String,
        draftUpdatedAt: Int,
        messageCount: Int?,
        crypto: CryptoManager
    ) throws -> String {
        var entry = try base(session: session, messageCount: messageCount, crypto: crypto,
                             updatedAt: Int(Date().timeIntervalSince1970 * 1000))
        let clientMeta = ClientMetadata(
            currentContext: nil,
            hasPendingPrompt: nil,
            phase: session.phase,
            tags: session.tags.isEmpty ? nil : session.tags,
            draftInput: draft,
            draftUpdatedAt: draftUpdatedAt
        )
        let metaJson = try JSONEncoder().encode(clientMeta)
        guard let metaString = String(data: metaJson, encoding: .utf8) else {
            throw SessionIndexUpdateError.encodingFailed
        }
        let encrypted = try crypto.encrypt(plaintext: metaString)
        entry.encryptedClientMetadata = encrypted.encrypted
        entry.clientMetadataIv = encrypted.iv
        return try encode(entry)
    }

    /// Publishes the read marker. `messageCount` is deliberately absent: this
    /// message knows nothing about the transcript length, and a synthetic zero
    /// would overwrite the count the server already has.
    static func readReceipt(session: Session, lastReadAt: Int, crypto: CryptoManager) throws -> String {
        var entry = try base(session: session, messageCount: nil, crypto: crypto)
        entry.lastReadAt = lastReadAt
        return try encode(entry)
    }

    /// Publishes a reparent. Without this the phone's move is local-only and
    /// the desktop reasserts the old parent on the next index page.
    static func parent(session: Session, parentSessionId: String, crypto: CryptoManager) throws -> String {
        var entry = try base(session: session, messageCount: nil, crypto: crypto,
                             updatedAt: Int(Date().timeIntervalSince1970 * 1000))
        entry.parentSessionId = parentSessionId
        return try encode(entry)
    }

    /// The fields every one of these messages carries. Title is re-encrypted
    /// from plaintext when we have it, and passed through otherwise, so a row
    /// whose title we could not decrypt is not blanked by a draft push.
    private static func base(
        session: Session,
        messageCount: Int?,
        crypto: CryptoManager,
        updatedAt: Int? = nil
    ) throws -> IndexUpdateEntry {
        var encryptedTitle = session.titleEncrypted
        var titleIv = session.titleIv
        if let title = session.titleDecrypted {
            let result = try crypto.encrypt(plaintext: title)
            encryptedTitle = result.encrypted
            titleIv = result.iv
        }

        var entry = IndexUpdateEntry(
            sessionId: session.id,
            encryptedProjectId: try crypto.encryptProjectId(session.projectId),
            projectIdIv: CryptoManager.projectIdIvBase64,
            encryptedTitle: encryptedTitle,
            titleIv: titleIv,
            provider: session.provider ?? "claude-code",
            model: session.model,
            mode: session.mode,
            messageCount: messageCount,
            lastMessageAt: session.lastMessageAt ?? session.updatedAt,
            createdAt: session.createdAt,
            updatedAt: updatedAt ?? session.updatedAt,
            // Execution belongs to the desktop; the phone's cached value may
            // predate the turn that just started while this edit was sending.
            isExecuting: nil,
            queuedPromptCount: nil,
            encryptedQueuedPrompts: nil
        )
        entry.sessionType = session.sessionType
        return entry
    }

    static func encode(_ entry: IndexUpdateEntry) throws -> String {
        let data = try JSONEncoder().encode(IndexUpdateMessage(session: entry))
        guard let json = String(data: data, encoding: .utf8) else {
            throw SessionIndexUpdateError.encodingFailed
        }
        return json
    }
}

enum SessionIndexUpdateError: Error {
    case encodingFailed
}
