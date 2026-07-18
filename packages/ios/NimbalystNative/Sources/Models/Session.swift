import Foundation
import GRDB

/// A session represents an AI conversation within a project.
public struct Session: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var projectId: String
    public var titleEncrypted: String?
    public var titleIv: String?
    public var titleDecrypted: String?
    public var provider: String?
    public var model: String?
    public var mode: String?          // "agent" | "planning"
    /// Structural type: "session" (normal), "workstream" (parent container), "blitz" (quick task)
    public var sessionType: String?
    /// Parent session ID for workstream/worktree hierarchy
    public var parentSessionId: String?
    /// Agent role marker (e.g. "meta-agent"); nil for standard sessions
    public var agentRole: String?
    /// Session ID of the meta-agent that spawned this session (sub-agent link)
    public var createdBySessionId: String?
    /// Kanban phase: backlog, planning, implementing, validating, complete
    public var phase: String?
    /// Arbitrary tags for categorization (stored as JSON array string in DB)
    public var tagsJson: String?
    /// Worktree ID for git worktree association
    public var worktreeId: String?
    /// Whether the session is archived
    public var isArchived: Bool
    /// Whether the session is pinned
    public var isPinned: Bool
    /// Session ID this was branched/forked from
    public var branchedFromSessionId: String?
    /// Message ID at the branch point
    public var branchPointMessageId: Int?
    /// When this session was branched (unix ms)
    public var branchedAt: Int?
    public var isExecuting: Bool
    /// Authoritative interactive prompt state (questions, permission, plans, commits).
    public var hasPendingPrompt: Bool
    public var hasQueuedPrompts: Bool
    /// Generic attention is intentionally separate from interactive prompt state.
    public var attentionPending: Bool
    public var attentionSeverity: String?
    public var attentionEventId: String?
    public var attentionEffectiveDeadline: String?
    public var contextTokens: Int?
    public var contextWindow: Int?
    public var createdAt: Int
    public var updatedAt: Int
    public var lastSyncedSeq: Int
    public var lastReadAt: Int?
    public var lastMessageAt: Int?
    /// Draft input text (unsent message) synced across devices
    public var draftInput: String?
    /// Epoch ms when draftInput was last updated by the sending device
    public var draftUpdatedAt: Int?
    /// Whether the session title was AI-chosen. Nil means an older peer has not supplied the marker.
    public var hasBeenNamed: Bool?

    /// Context usage as a percentage (0-100), or nil if no context info available.
    public var contextUsagePercent: Int? {
        guard let tokens = contextTokens, let window = contextWindow, window > 0 else {
            return nil
        }
        return min(100, Int(Double(tokens) / Double(window) * 100))
    }

    /// Decoded tags array from JSON string
    public var tags: [String] {
        guard let json = tagsJson, let data = json.data(using: .utf8),
              let arr = try? JSONDecoder().decode([String].self, from: data) else {
            return []
        }
        return arr
    }

    /// Whether this session has unread messages (a message arrived after the last read).
    public var hasUnread: Bool {
        guard let messageAt = lastMessageAt, messageAt > 0 else { return false }
        guard let readAt = lastReadAt else { return true }
        return messageAt > readAt
    }

    var attentionState: SessionAttentionState {
        SessionAttentionState(
            pending: attentionPending,
            severity: attentionSeverity,
            eventId: attentionEventId,
            effectiveDeadline: attentionEffectiveDeadline
        )
    }

    var attentionPresentation: SessionAttentionPresentation? {
        SessionAttentionPresentation.make(from: attentionState)
    }

    public init(
        id: String,
        projectId: String,
        titleEncrypted: String? = nil,
        titleIv: String? = nil,
        titleDecrypted: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        mode: String? = nil,
        sessionType: String? = nil,
        parentSessionId: String? = nil,
        agentRole: String? = nil,
        createdBySessionId: String? = nil,
        phase: String? = nil,
        tagsJson: String? = nil,
        worktreeId: String? = nil,
        isArchived: Bool = false,
        isPinned: Bool = false,
        branchedFromSessionId: String? = nil,
        branchPointMessageId: Int? = nil,
        branchedAt: Int? = nil,
        isExecuting: Bool = false,
        hasPendingPrompt: Bool = false,
        hasQueuedPrompts: Bool = false,
        attentionPending: Bool = false,
        attentionSeverity: String? = nil,
        attentionEventId: String? = nil,
        attentionEffectiveDeadline: String? = nil,
        contextTokens: Int? = nil,
        contextWindow: Int? = nil,
        createdAt: Int = Int(Date().timeIntervalSince1970 * 1000),
        updatedAt: Int = Int(Date().timeIntervalSince1970 * 1000),
        lastSyncedSeq: Int = 0,
        lastReadAt: Int? = nil,
        lastMessageAt: Int? = nil,
        draftInput: String? = nil,
        draftUpdatedAt: Int? = nil,
        hasBeenNamed: Bool? = nil
    ) {
        self.id = id
        self.projectId = projectId
        self.titleEncrypted = titleEncrypted
        self.titleIv = titleIv
        self.titleDecrypted = titleDecrypted
        self.provider = provider
        self.model = model
        self.mode = mode
        self.sessionType = sessionType
        self.parentSessionId = parentSessionId
        self.agentRole = agentRole
        self.createdBySessionId = createdBySessionId
        self.phase = phase
        self.tagsJson = tagsJson
        self.worktreeId = worktreeId
        self.isArchived = isArchived
        self.isPinned = isPinned
        self.branchedFromSessionId = branchedFromSessionId
        self.branchPointMessageId = branchPointMessageId
        self.branchedAt = branchedAt
        self.isExecuting = isExecuting
        self.hasPendingPrompt = hasPendingPrompt
        self.hasQueuedPrompts = hasQueuedPrompts
        self.attentionPending = attentionPending
        self.attentionSeverity = attentionSeverity
        self.attentionEventId = attentionEventId
        self.attentionEffectiveDeadline = attentionEffectiveDeadline
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastSyncedSeq = lastSyncedSeq
        self.lastReadAt = lastReadAt
        self.lastMessageAt = lastMessageAt
        self.draftInput = draftInput
        self.draftUpdatedAt = draftUpdatedAt
        self.hasBeenNamed = hasBeenNamed
    }
}

// MARK: - GRDB Conformance

extension Session: FetchableRecord, PersistableRecord {
    public static let databaseTableName = "sessions"

    public enum Columns: String, ColumnExpression {
        case id, projectId, titleEncrypted, titleIv, titleDecrypted
        case provider, model, mode, sessionType, parentSessionId, agentRole, createdBySessionId, phase, tagsJson, worktreeId
        case isArchived, isPinned, branchedFromSessionId, branchPointMessageId, branchedAt
        case isExecuting, hasPendingPrompt, hasQueuedPrompts
        case attentionPending, attentionSeverity, attentionEventId, attentionEffectiveDeadline
        case contextTokens, contextWindow
        case createdAt, updatedAt, lastSyncedSeq
        case lastReadAt, lastMessageAt, draftInput, draftUpdatedAt, hasBeenNamed
    }

    /// Association to parent project.
    static let project = belongsTo(Project.self)

    /// Association to child messages.
    static let messages = hasMany(Message.self)
}
