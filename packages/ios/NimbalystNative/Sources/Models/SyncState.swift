import Foundation
import GRDB

/// Tracks sync watermarks for incremental sync per room.
public struct SyncState: Codable, Identifiable, Hashable {
    /// Room ID: "index" or a session ID.
    public var id: String { roomId }
    public var roomId: String
    public var lastCursor: String?
    public var lastSequence: Int
    public var lastSyncedAt: Int?
}

// MARK: - GRDB Conformance

extension SyncState: FetchableRecord, PersistableRecord {
    public static let databaseTableName = "syncState"

    public enum Columns: String, ColumnExpression {
        case roomId, lastCursor, lastSequence, lastSyncedAt
    }
}
