import Foundation

/// Request modes for versioned index replication.
///
/// Only `bootstrap` and `delta` establish coverage. `recent` and `lookup` serve
/// the screen -- a recent page is a feed, and a lookup answers "fetch exactly
/// this session and its ancestors" -- so neither may advance the account cursor
/// or claim history is complete.
enum IndexReplicationMode: String, Sendable, CaseIterable {
    case bootstrap
    case delta
    case recent
    case lookup

    var advancesCursor: Bool {
        switch self {
        case .bootstrap, .delta: return true
        case .recent, .lookup: return false
        }
    }
}

/// Why a page was refused. Every case leaves the cursor where it was: an
/// unparseable or self-inconsistent page is not evidence of anything, least of
/// all of deletion.
enum IndexReplicationPageError: Error, Equatable, Sendable {
    case unsupportedProtocolVersion(Int)
    case requestMismatch(expected: String, received: String)
    case modeMismatch(expected: String, received: String)
    /// `complete: false` with no token cannot be resumed; a token on a terminal
    /// page contradicts it.
    case pageTokenInconsistent(complete: Bool, hasToken: Bool)
    case unknownEntity(String)
    case invalidRemovalReason(String)
    case unknownMode(String)
    /// Rows migrated from a pre-v2 server carry baseline revision 0, which is
    /// valid. Only a negative revision is nonsense.
    case invalidRevision(id: String, revision: Int)
    /// A terminal page that advances the cursor must say what that cursor is.
    /// Inferring it from the highest entry revision is wrong: a bootstrap page
    /// can carry a row newer than the range the terminal actually proves.
    case missingTerminalCursor
    case invalidCursor(Int)
    case missingPayload(entity: String, id: String)
    case unexpectedPayload(entity: String, id: String)
    case decryptionFailed(entity: String, id: String)
}

/// A page that passed validation and decryption, ready to apply.
struct ValidatedIndexPage: @unchecked Sendable {
    let mode: IndexReplicationMode
    let operations: [IndexWriteOperation]
    /// Identity of every entry on the page, recorded during a bootstrap so
    /// enumeration coverage is provable from SQLite rather than from memory.
    let seen: [IndexReplicationSeenKey]
    let highestRevision: Int?
    let nextPageToken: String?
    let cursor: Int?
    let complete: Bool
    let resetRequired: Bool

    /// The revision this page proves, and only ever the one the server stated.
    ///
    /// The highest revision on the page is not a substitute: a bootstrap page
    /// can contain a row newer than the range its terminal actually proves, and
    /// committing that would skip everything in between. A partial DELTA page
    /// may commit a supplied cursor -- the server only sends one for a
    /// contiguous prefix -- while a partial bootstrap page proves nothing.
    var committableCursor: Int? {
        guard mode.advancesCursor else { return nil }
        if complete { return cursor }
        return mode == .delta ? cursor : nil
    }
}

struct IndexReplicationSeenKey: Equatable, Sendable {
    let entity: IndexReplicationEntity
    let id: String
}

/// Validates and decrypts versioned index pages. Pure: no database, no state.
enum IndexReplicationPageValidator {
    static let supportedProtocolVersion = 2

    /// - Parameters:
    ///   - expectedRequestId: the in-flight request this response must answer.
    ///     A response for any other request is discarded, which is what keeps a
    ///     page from a retired generation out of the cursor.
    static func validate(
        _ response: IndexPageResponse,
        expectedRequestId: String,
        expectedMode: IndexReplicationMode,
        crypto: CryptoManager
    ) -> Result<ValidatedIndexPage, IndexReplicationPageError> {
        guard response.protocolVersion == supportedProtocolVersion else {
            return .failure(.unsupportedProtocolVersion(response.protocolVersion))
        }
        guard response.requestId == expectedRequestId else {
            return .failure(.requestMismatch(expected: expectedRequestId, received: response.requestId))
        }
        guard let mode = IndexReplicationMode(rawValue: response.mode) else {
            return .failure(.unknownMode(response.mode))
        }
        guard mode == expectedMode else {
            return .failure(.modeMismatch(expected: expectedMode.rawValue, received: response.mode))
        }

        // A reset is shaped unlike any other page -- complete:false, no entries,
        // no token -- and must be recognised before the page-token consistency
        // rule, which it deliberately violates. The caller resets the cursor and
        // starts a fresh bootstrap; cached rows stay exactly where they are.
        if response.resetRequired == true {
            return .success(ValidatedIndexPage(
                mode: mode, operations: [], seen: [], highestRevision: nil,
                nextPageToken: nil, cursor: nil, complete: false, resetRequired: true
            ))
        }

        let hasToken = response.nextPageToken != nil
        guard response.complete != hasToken else {
            return .failure(.pageTokenInconsistent(complete: response.complete, hasToken: hasToken))
        }
        var operations: [IndexWriteOperation] = []
        var seen: [IndexReplicationSeenKey] = []
        var highestRevision: Int?

        for change in response.entries {
            if let reason = change.removalReason, (!change.deleted || change.entity != "session" || !["expired", "deleted"].contains(reason)) {
                return .failure(.invalidRemovalReason(reason))
            }
            guard let entity = IndexReplicationEntity(rawValue: change.entity) else {
                return .failure(.unknownEntity(change.entity))
            }
            guard change.revision >= 0 else {
                return .failure(.invalidRevision(id: change.id, revision: change.revision))
            }
            let payloadCount = [change.session != nil, change.project != nil, change.file != nil]
                .filter { $0 }.count

            if change.deleted {
                guard payloadCount == 0 else {
                    return .failure(.unexpectedPayload(entity: change.entity, id: change.id))
                }
                // A project tombstone carries only the encrypted id, so the local
                // row it refers to has to be recovered by decrypting it with the
                // fixed project IV. Revisions stay keyed by the wire id.
                var localId = change.id
                if entity == .project {
                    guard let decrypted = crypto.decryptOrNil(
                        encryptedBase64: change.id,
                        ivBase64: CryptoManager.projectIdIvBase64
                    ) else {
                        return .failure(.decryptionFailed(entity: change.entity, id: change.id))
                    }
                    localId = decrypted
                }
                operations.append(.delete(
                    key: IndexEntityKey(entity: entity, wireId: change.id, localId: localId),
                    revision: change.revision
                ))
            } else {
                guard payloadCount == 1 else {
                    return .failure(payloadCount == 0
                        ? .missingPayload(entity: change.entity, id: change.id)
                        : .unexpectedPayload(entity: change.entity, id: change.id))
                }
                switch entity {
                case .session:
                    guard let entry = change.session, entry.sessionId == change.id else {
                        return .failure(.missingPayload(entity: change.entity, id: change.id))
                    }
                    guard let decrypted = IndexEntryDecryptor.decrypt(session: entry, crypto: crypto, policy: .strict) else {
                        return .failure(.decryptionFailed(entity: change.entity, id: change.id))
                    }
                    operations.append(.session(decrypted, revision: change.revision))
                case .project:
                    // The server keys projects by their ENCRYPTED id, so that is
                    // what the entry id must match. Comparing against the
                    // decrypted path would reject every real project page.
                    guard let entry = change.project, entry.encryptedProjectId == change.id else {
                        return .failure(.missingPayload(entity: change.entity, id: change.id))
                    }
                    guard let decrypted = IndexEntryDecryptor.decrypt(project: entry, crypto: crypto, policy: .strict) else {
                        return .failure(.decryptionFailed(entity: change.entity, id: change.id))
                    }
                    operations.append(.project(decrypted, revision: change.revision))
                case .file:
                    guard let entry = change.file, entry.docId == change.id else {
                        return .failure(.missingPayload(entity: change.entity, id: change.id))
                    }
                    guard let decrypted = decryptFile(entry, crypto: crypto) else {
                        return .failure(.decryptionFailed(entity: change.entity, id: change.id))
                    }
                    operations.append(.file(decrypted, revision: change.revision))
                }
            }
            // Coverage is keyed the way the server keys it.
            seen.append(IndexReplicationSeenKey(entity: entity, id: change.id))
            highestRevision = max(highestRevision ?? 0, change.revision)
        }

        // Checked after the entries so a page with a bad entry reports the
        // specific entry problem rather than the envelope one.
        if let cursor = response.cursor, cursor < 0 {
            return .failure(.invalidCursor(cursor))
        }
        if mode.advancesCursor, response.complete, response.cursor == nil {
            return .failure(.missingTerminalCursor)
        }

        return .success(ValidatedIndexPage(
            mode: mode,
            operations: operations,
            seen: seen,
            highestRevision: highestRevision,
            nextPageToken: response.nextPageToken,
            cursor: response.cursor,
            complete: response.complete,
            resetRequired: response.resetRequired ?? false
        ))
    }

    /// Every field of a file entry is required, and all three are non-optional on
    /// the wire. A row we could only half-read must not advance a revision past
    /// the part we failed to read.
    static func decryptFile(_ entry: ServerIndexFileEntry, crypto: CryptoManager) -> IndexReplicationStore.IndexFileMetadata? {
        guard let projectId = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedProjectId,
            ivBase64: entry.projectIdIv
        ),
        let relativePath = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedRelativePath,
            ivBase64: entry.relativePathIv
        ),
        let title = crypto.decryptOrNil(encryptedBase64: entry.encryptedTitle, ivBase64: entry.titleIv) else {
            return nil
        }
        return IndexReplicationStore.IndexFileMetadata(
            docId: entry.docId,
            projectId: projectId,
            relativePath: relativePath,
            title: title,
            lastModifiedAt: entry.lastModifiedAt,
            syncedAt: entry.syncedAt
        )
    }
}
