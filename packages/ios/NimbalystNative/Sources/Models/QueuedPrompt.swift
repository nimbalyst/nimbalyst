import Foundation
import GRDB

/// A prompt queued by the user (on mobile or desktop), waiting to be processed.
public struct QueuedPrompt: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var sessionId: String
    public var promptTextEncrypted: String
    public var iv: String
    public var createdAt: Int
    public var sentAt: Int?  // nil until acknowledged by desktop
    /// Decrypted prompt text for display (nil for locally-encrypted outgoing prompts)
    public var promptTextDecrypted: String?
    /// Source device/input: "desktop", "keyboard", "voice"
    public var source: String?
}

// MARK: - GRDB Conformance

extension QueuedPrompt: FetchableRecord, PersistableRecord {
    public static let databaseTableName = "queuedPrompts"

    public enum Columns: String, ColumnExpression {
        case id, sessionId, promptTextEncrypted, iv, createdAt, sentAt, promptTextDecrypted, source
    }

    /// Association to parent session.
    static let session = belongsTo(Session.self)
}
