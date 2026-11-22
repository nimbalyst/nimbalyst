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
    /// False when the entry carried no config blob or one this device could not
    /// read. Such an entry (a stats-only broadcast, an older server row) says
    /// nothing about the config, so the stored config fields stand.
    var hasReadableConfig: Bool = false
}

/// How to treat a field we cannot read.
enum IndexDecryptionPolicy: Sendable {
    /// Legacy responses and broadcasts: an unreadable optional field degrades to
    /// nil, because the alternative is dropping a row the user can otherwise see.
    case lenient
    /// Versioned pages: any unreadable field skips the entry's payload. Its
    /// identity and revision still establish coverage without changing the cache.
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
            if strict { IndexRowDiagnostics.skipped(field: "projectId") }
            return nil
        }

        let titleDecrypted = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedTitle,
            ivBase64: entry.titleIv
        )
        if strict, entry.encryptedTitle != nil, entry.titleIv != nil, titleDecrypted == nil {
            IndexRowDiagnostics.skipped(field: "title")
            return nil
        }

        var clientMeta: ClientMetadata?
        if let encryptedMeta = entry.encryptedClientMetadata,
           let metaIv = entry.clientMetadataIv {
            let metaData = crypto.decryptOrNil(encryptedBase64: encryptedMeta, ivBase64: metaIv)?.data(using: .utf8)
            let decoded = metaData.flatMap { try? ClientMetadataDecoding.decode($0) }
            if let decoded {
                if strict, let field = decoded.unreadableFields.first(where: ClientMetadataDecoding.fieldsThatMustBeRead.contains) {
                    IndexRowDiagnostics.skipped(field: "clientMetadata.\(field)")
                    return nil
                }
                decoded.unreadableFields.forEach { IndexRowDiagnostics.degraded(field: $0) }
                clientMeta = decoded.metadata
            } else if strict {
                // An undecryptable blob, or one that is not an object, says
                // nothing reliable about the entry: skip the row.
                IndexRowDiagnostics.skipped(field: metaData == nil ? "clientMetadata.decrypt" : "clientMetadata.shape")
                return nil
            }
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
            if strict, decryptedPrompts.count != encryptedPrompts.count {
                IndexRowDiagnostics.skipped(field: "queuedPrompts")
                return nil
            }
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
        var hasReadableConfig = false
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
            if let configJson,
               let data = configJson.data(using: .utf8),
               (try? JSONDecoder().decode(ProjectConfig.self, from: data)) != nil {
                decodedConfig = decodeProjectConfig(fromJson: configJson)
                hasReadableConfig = true
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
                gitRemoteHash: entry.gitRemoteHash,
                localWikiFolder: decodedConfig.localWikiFolder,
                localWikiTypesJSON: decodedConfig.localWikiTypesJSON
            ),
            hasReadableConfig: hasReadableConfig
        )
    }

    /// The row to store for a project entry. A readable config is the
    /// desktop's whole config, so it replaces the config fields, clearing a
    /// wiki it no longer names. Without one, the stored config fields stand.
    static func merge(_ decrypted: DecryptedProjectEntry, existing: Project?) -> Project {
        var project = decrypted.project
        guard !decrypted.hasReadableConfig, let existing else { return project }
        project.commandsJson = existing.commandsJson
        project.actionsJson = existing.actionsJson
        project.localWikiFolder = existing.localWikiFolder
        project.localWikiTypesJSON = existing.localWikiTypesJSON
        return project
    }

    /// Merge a decrypted entry onto the row currently in the database.
    ///
    /// Hierarchy fields preserve explicit nulls from the authoritative desktop.
    /// Other optional fields fall back to the existing value rather than
    /// overwriting with nil: older server rows omit columns, and overwriting
    /// wipes the session's identity (a missing `model` would blank the badge in
    /// the session list). `updatedAt` is taken from the entry -- it is the sort
    /// timestamp, not a revision, and equal timestamps do not imply equal
    /// content, so the caller must not skip an entry on timestamp equality.
    static func merge(_ decrypted: DecryptedSessionEntry, existing: Session?) -> Session {
        let entry = decrypted.entry
        let clientMeta = decrypted.clientMeta
        let draft = mergeDraft(incoming: clientMeta, existing: existing)
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
            parentSessionId: entry.parentSessionIdPresent ? entry.parentSessionId : (entry.parentSessionId ?? existing?.parentSessionId),
            agentRole: entry.agentRole ?? existing?.agentRole,
            createdBySessionId: entry.createdBySessionIdPresent ? entry.createdBySessionId : (entry.createdBySessionId ?? existing?.createdBySessionId),
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
            draftInput: draft.input,
            draftUpdatedAt: draft.updatedAt,
            transcriptSyncDisabled: transcriptSyncDisabled(incoming: clientMeta, existing: existing)
        )
    }

    /// A readable blob is the publisher's whole client metadata, so a blob that
    /// omits the flag clears it. No blob says nothing, and the row stands.
    static func transcriptSyncDisabled(incoming: ClientMetadata?, existing: Session?) -> Bool {
        guard let incoming else { return existing?.transcriptSyncDisabled ?? false }
        return incoming.transcriptSyncDisabled ?? false
    }

    /// Apply a live metadata broadcast's client blob to the cached row. Fields
    /// the blob omits keep their cached value, except `transcriptSyncDisabled`,
    /// whose absence means false.
    static func apply(_ clientMeta: ClientMetadata, to session: inout Session) {
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
        session.transcriptSyncDisabled = transcriptSyncDisabled(incoming: clientMeta, existing: session)
    }

    /// Decide which side's draft wins.
    ///
    /// `draftUpdatedAt` exists to order drafts and was never compared, so an
    /// index page built before the user's last keystroke -- a reconnect replay,
    /// or a page that was already in flight -- overwrote what the composer
    /// holds. The local row wins whenever the incoming stamp is not newer.
    ///
    /// "" from remote still means "cleared" rather than "not sent", but only
    /// when the clear is the newer of the two.
    static func mergeDraft(
        incoming: ClientMetadata?,
        existing: Session?
    ) -> (input: String?, updatedAt: Int?) {
        guard let incomingDraft = incoming?.draftInput else {
            // The entry says nothing about the draft: local-first, untouched.
            return (existing?.draftInput, existing?.draftUpdatedAt)
        }
        let incomingAt = incoming?.draftUpdatedAt
        if let existingAt = existing?.draftUpdatedAt {
            // An unstamped remote draft cannot prove it is newer than a stamped
            // local one, so the local edit stands.
            guard let incomingAt, incomingAt > existingAt else {
                return (existing?.draftInput, existingAt)
            }
        }
        return (incomingDraft.isEmpty ? nil : incomingDraft, incomingAt ?? existing?.draftUpdatedAt)
    }
}
