import Foundation
import GRDB

/// A synced markdown document cached locally for offline viewing and editing.
/// Populated by DocumentSyncManager from ProjectSyncRoom responses.
public struct SyncedDocument: Codable, Identifiable, Hashable, Sendable {
    /// Deterministic syncId: SHA-256(relativePath) -- matches server-side files.sync_id
    public var id: String
    /// Project workspace path (foreign key to projects.id)
    public var projectId: String
    /// Relative path within the project (e.g., "docs/README.md")
    public var relativePath: String
    /// Decrypted document title (derived from filename or frontmatter)
    public var title: String
    /// SHA-256 hash of plaintext markdown content (for diff detection)
    public var contentHash: String?
    /// Desktop mtime (epoch ms) for last-writer-wins ordering
    public var lastModifiedAt: Int?
    /// When this document was last synced (epoch ms)
    public var syncedAt: Int?
    /// Decrypted markdown content (cached for offline reading).
    /// May be nil during bulk sync -- use `encryptedContent`/`contentIv` to decrypt on demand.
    public var contentDecrypted: String?
    /// Encrypted content blob (stored during bulk sync for on-demand decryption)
    public var encryptedContent: String?
    /// IV for content decryption
    public var contentIv: String?
    /// Whether this file has been upgraded to Yjs CRDT phase
    public var hasYjs: Bool
    /// Last Yjs sequence number seen (for incremental sync)
    public var yjsSeq: Int
    /// Encrypted Yjs state blob (for offline Yjs editing)
    public var yjsStateEncrypted: String?
    public var yjsStateIv: String?

    public var createdAt: Int
    public var updatedAt: Int

    /// Display name derived from relativePath filename
    public var displayName: String {
        (relativePath as NSString).lastPathComponent
    }

    /// Parent directory path (empty string for root files)
    public var directory: String {
        let dir = (relativePath as NSString).deletingLastPathComponent
        return dir == "." ? "" : dir
    }

    public init(
        id: String,
        projectId: String,
        relativePath: String,
        title: String,
        contentHash: String? = nil,
        lastModifiedAt: Int? = nil,
        syncedAt: Int? = nil,
        contentDecrypted: String? = nil,
        encryptedContent: String? = nil,
        contentIv: String? = nil,
        hasYjs: Bool = false,
        yjsSeq: Int = 0,
        yjsStateEncrypted: String? = nil,
        yjsStateIv: String? = nil,
        createdAt: Int = Int(Date().timeIntervalSince1970 * 1000),
        updatedAt: Int = Int(Date().timeIntervalSince1970 * 1000)
    ) {
        self.id = id
        self.projectId = projectId
        self.relativePath = relativePath
        self.title = title
        self.contentHash = contentHash
        self.lastModifiedAt = lastModifiedAt
        self.syncedAt = syncedAt
        self.contentDecrypted = contentDecrypted
        self.encryptedContent = encryptedContent
        self.contentIv = contentIv
        self.hasYjs = hasYjs
        self.yjsSeq = yjsSeq
        self.yjsStateEncrypted = yjsStateEncrypted
        self.yjsStateIv = yjsStateIv
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

// MARK: - GRDB Conformance

extension SyncedDocument: FetchableRecord, PersistableRecord {
    public static let databaseTableName = "syncedDocuments"

    public enum Columns: String, ColumnExpression {
        case id, projectId, relativePath, title, contentHash
        case lastModifiedAt, syncedAt, contentDecrypted, encryptedContent, contentIv
        case hasYjs, yjsSeq, yjsStateEncrypted, yjsStateIv
        case createdAt, updatedAt
    }

    /// Association to parent project.
    static let project = belongsTo(Project.self)
}
