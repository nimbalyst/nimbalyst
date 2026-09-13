import Foundation

/// A server index entry after decryption, before it is merged with local state.
///
/// Decryption is the expensive half and touches no database, so it runs outside
/// the write transaction. The merge then runs inside the transaction against
/// rows read there, which is what keeps a draft or read marker written while we
/// were decrypting from being overwritten by the pre-decryption snapshot.
/// `@unchecked` for the same reason as `IndexIngestionWork`: the wire entry it
/// wraps is an immutable Codable struct without concurrency annotations.
struct DecryptedSessionEntry: @unchecked Sendable {
    let entry: ServerSessionEntry
    let projectId: String
    let titleDecrypted: String?
    let clientMeta: ClientMetadata?
    let tagsJson: String?
    /// Prompts the remote says are queued. Empty means the queue was cleared.
    /// `nil` means the entry said nothing about the queue.
    let remoteQueuedPrompts: [QueuedPrompt]?

    var sessionId: String { entry.sessionId }
}

struct DecryptedProjectEntry: Sendable {
    /// The id the local `projects` row uses: the decrypted workspace path.
    let projectId: String
    /// The id the SERVER uses for this project, which is the encrypted project
    /// id, not the path. Revisions and tombstones are keyed by this; a project
    /// tombstone carries nothing else.
    let wireId: String
    let project: Project
}

/// How to treat a field we cannot read.
enum IndexDecryptionPolicy: Sendable {
    /// Legacy responses and broadcasts: an unreadable optional field degrades to
    /// nil, because the alternative is dropping a row the user can otherwise see.
    case lenient
    /// Versioned pages: any unreadable field fails the whole entry. Applying it
    /// would commit a revision covering data we never actually read, and the
    /// cursor would then skip the only chance to fetch it again.
    case strict
}

/// Decrypts index entries. Shared by bulk responses and live broadcasts so the
/// two paths cannot drift into different field semantics.
enum IndexEntryDecryptor {
    static func decrypt(
        session entry: ServerSessionEntry,
        crypto: CryptoManager,
        policy: IndexDecryptionPolicy = .lenient
    ) -> DecryptedSessionEntry? {
        let strict = policy == .strict
        guard let projectId = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedProjectId,
            ivBase64: entry.projectIdIv
        ) else {
            return nil
        }

        let titleDecrypted = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedTitle,
            ivBase64: entry.titleIv
        )
        if strict, entry.encryptedTitle != nil, entry.titleIv != nil, titleDecrypted == nil {
            return nil
        }

        var clientMeta: ClientMetadata?
        if let encryptedMeta = entry.encryptedClientMetadata,
           let metaIv = entry.clientMetadataIv {
            let metaJson = crypto.decryptOrNil(encryptedBase64: encryptedMeta, ivBase64: metaIv)
            let metaData = metaJson?.data(using: .utf8)
            clientMeta = metaData.flatMap { try? JSONDecoder().decode(ClientMetadata.self, from: $0) }
            // Covers both an unreadable blob and one that does not parse: under
            // strict both mean this entry's phase, draft and context are unknown.
            if strict, clientMeta == nil { return nil }
        }

        var tagsJson: String?
        if let tags = clientMeta?.tags, !tags.isEmpty,
           let data = try? JSONEncoder().encode(tags) {
            tagsJson = String(data: data, encoding: .utf8)
        }

        var remoteQueuedPrompts: [QueuedPrompt]?
        if let encryptedPrompts = entry.encryptedQueuedPrompts, !encryptedPrompts.isEmpty {
            let decryptedPrompts = encryptedPrompts.compactMap { ep -> QueuedPrompt? in
                guard let plaintext = crypto.decryptOrNil(encryptedBase64: ep.encryptedPrompt, ivBase64: ep.iv) else {
                    return nil
                }
                return QueuedPrompt(
                    id: ep.id,
                    sessionId: entry.sessionId,
                    promptTextEncrypted: ep.encryptedPrompt,
                    iv: ep.iv,
                    createdAt: ep.timestamp,
                    sentAt: nil,
                    promptTextDecrypted: plaintext,
                    source: ep.source ?? "desktop"
                )
            }
            // A dropped prompt would silently shrink the queue the user sees.
            if strict, decryptedPrompts.count != encryptedPrompts.count { return nil }
            remoteQueuedPrompts = decryptedPrompts
        } else if entry.queuedPromptCount == 0 || entry.encryptedQueuedPrompts?.isEmpty == true {
            // An explicit clear, distinct from an entry that omitted the queue.
            remoteQueuedPrompts = []
        }

        return DecryptedSessionEntry(
            entry: entry,
            projectId: projectId,
            titleDecrypted: titleDecrypted,
            clientMeta: clientMeta,
            tagsJson: tagsJson,
            remoteQueuedPrompts: remoteQueuedPrompts
        )
    }

    static func decrypt(
        project entry: ServerProjectEntry,
        crypto: CryptoManager,
        policy: IndexDecryptionPolicy = .lenient
    ) -> DecryptedProjectEntry? {
        let strict = policy == .strict
        guard let projectId = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedProjectId,
            ivBase64: entry.projectIdIv
        ) else {
            return nil
        }

        var decodedConfig = DecodedProjectConfig.empty
        if let encryptedConfig = entry.encryptedConfig, let configIv = entry.configIv {
            let configJson = crypto.decryptOrNil(encryptedBase64: encryptedConfig, ivBase64: configIv)
            // decodeProjectConfig returns .empty for unparseable JSON, which is
            // indistinguishable from a project with no commands -- so under
            // strict, check the parse itself rather than trusting the result.
            if strict {
                guard let configJson,
                      let data = configJson.data(using: .utf8),
                      (try? JSONDecoder().decode(ProjectConfig.self, from: data)) != nil else {
                    return nil
                }
            }
            if let configJson {
                decodedConfig = decodeProjectConfig(fromJson: configJson)
            }
        }

        // Always use the last path component as the project name: the server
        // stores the encrypted project id as the name placeholder, so decrypting
        // it yields the workspace path rather than a human-friendly name.
        return DecryptedProjectEntry(
            projectId: projectId,
            wireId: entry.encryptedProjectId,
            project: Project(
                id: projectId,
                name: (projectId as NSString).lastPathComponent,
                sessionCount: entry.sessionCount ?? 0,
                lastUpdatedAt: entry.lastActivityAt,
                commandsJson: decodedConfig.commandsJson,
                actionsJson: decodedConfig.actionsJson,
                gitRemoteHash: entry.gitRemoteHash
            )
        )
    }

    /// Merge a decrypted entry onto the row currently in the database.
    ///
    /// Every optional field falls back to the existing value rather than
    /// overwriting with nil: older server rows omit columns, and overwriting
    /// wipes the session's identity (a missing `model` would blank the badge in
    /// the session list). `updatedAt` is taken from the entry -- it is the sort
    /// timestamp, not a revision, and equal timestamps do not imply equal
    /// content, so the caller must not skip an entry on timestamp equality.
    static func merge(_ decrypted: DecryptedSessionEntry, existing: Session?) -> Session {
        let entry = decrypted.entry
        let clientMeta = decrypted.clientMeta
        return Session(
            id: entry.sessionId,
            projectId: decrypted.projectId,
            titleEncrypted: entry.encryptedTitle ?? existing?.titleEncrypted,
            titleIv: entry.titleIv ?? existing?.titleIv,
            titleDecrypted: decrypted.titleDecrypted ?? existing?.titleDecrypted,
            provider: entry.provider ?? existing?.provider,
            model: entry.model ?? existing?.model,
            mode: entry.mode ?? existing?.mode,
            sessionType: entry.sessionType ?? existing?.sessionType,
            parentSessionId: entry.parentSessionId ?? existing?.parentSessionId,
            agentRole: entry.agentRole ?? existing?.agentRole,
            createdBySessionId: entry.createdBySessionId ?? existing?.createdBySessionId,
            phase: clientMeta?.phase ?? existing?.phase,
            tagsJson: decrypted.tagsJson ?? existing?.tagsJson,
            worktreeId: entry.worktreeId ?? existing?.worktreeId,
            hostDeviceId: entry.hostDeviceId ?? existing?.hostDeviceId,
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
    }
}
