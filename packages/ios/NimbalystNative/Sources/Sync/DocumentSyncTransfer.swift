import Foundation
import GRDB
import os

extension ProjectSyncResponse {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        type = try values.decode(String.self, forKey: .type)
        updatedFiles = try values.decode([ProjectSyncFileEntry].self, forKey: .updatedFiles)
        newFiles = try values.decode([ProjectSyncFileEntry].self, forKey: .newFiles)
        yjsUpdates = try values.decode([ProjectSyncYjsUpdate].self, forKey: .yjsUpdates)
        needFromClient = try values.decode([String].self, forKey: .needFromClient)
        deletedSyncIds = try values.decode([String].self, forKey: .deletedSyncIds)
        // Only absent metadata denotes a legacy response; explicit null is malformed.
        if values.contains(.transferId) || values.contains(.batchIndex) || values.contains(.isLastBatch) {
            transferId = try values.decode(String.self, forKey: .transferId)
            batchIndex = try values.decode(Int.self, forKey: .batchIndex)
            isLastBatch = try values.decode(Bool.self, forKey: .isLastBatch)
        }
    }
}

public enum DocumentSyncState: Equatable, Sendable {
    case connecting
    case syncing(received: Int)
    case ready
    case failed(String)
}

/// One connection's initial download. Commit this value only after its DB transaction succeeds.
struct DocumentSyncTransfer {
    private var transferId: String?
    private var nextBatch = 0
    private(set) var received = 0
    private(set) var complete = false

    mutating func accept(_ response: ProjectSyncResponse) throws {
        guard !complete else { throw TransferError.invalidSequence }
        switch (response.transferId, response.batchIndex, response.isLastBatch) {
        case (nil, nil, nil):
            guard nextBatch == 0 else { throw TransferError.invalidSequence }
            complete = true
        case let (.some(id), .some(index), .some(last)):
            guard !id.isEmpty, index == nextBatch,
                  transferId == nil || transferId == id else { throw TransferError.invalidSequence }
            transferId = id
            nextBatch += 1
            complete = last
        default:
            throw TransferError.invalidSequence
        }
        received += response.updatedFiles.count + response.newFiles.count
    }

    enum TransferError: LocalizedError {
        case invalidSequence
        var errorDescription: String? { "File sync received an invalid or out-of-order batch. Please retry." }
    }
}

/// A batch is atomic, including deletions and Yjs sequence bookkeeping.
/// Initial sync keeps content encrypted even when a small transport batch has fewer than 50 files.
@MainActor
func applyDocumentSyncBatch(_ response: ProjectSyncResponse, projectId: String, crypto: CryptoManager, database: DatabaseManager) throws {
    let now = Int(Date().timeIntervalSince1970 * 1000)
    let documents = try (response.updatedFiles + response.newFiles).map { entry in
        let path = try crypto.decrypt(encryptedBase64: entry.encryptedPath, ivBase64: entry.pathIv)
        let title = try crypto.decrypt(encryptedBase64: entry.encryptedTitle, ivBase64: entry.titleIv)
        return SyncedDocument(id: entry.syncId, projectId: projectId, relativePath: path, title: title,
                              contentHash: entry.contentHash, lastModifiedAt: entry.lastModifiedAt, syncedAt: now,
                              contentDecrypted: nil, encryptedContent: entry.encryptedContent, contentIv: entry.contentIv,
                              hasYjs: entry.hasYjs, yjsSeq: 0, createdAt: now, updatedAt: now)
    }
    try database.writer.write { db in
        for document in documents { try document.save(db) }
        if !response.deletedSyncIds.isEmpty {
            try SyncedDocument
                .filter(SyncedDocument.Columns.projectId == projectId)
                .filter(response.deletedSyncIds.contains(SyncedDocument.Columns.id))
                .deleteAll(db)
        }
        for update in response.yjsUpdates {
            if var document = try SyncedDocument.fetchOne(db, key: update.syncId),
               document.projectId == projectId, update.sequence > document.yjsSeq {
                document.yjsSeq = update.sequence
                document.updatedAt = now
                try document.save(db)
            }
        }
    }
}

@MainActor
func decryptDocumentContent(_ document: SyncedDocument, crypto: CryptoManager, database: DatabaseManager) -> String? {
    let logger = Logger(subsystem: "com.nimbalyst.app", category: "DocumentSync")
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
