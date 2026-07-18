import Foundation

// MARK: - Server -> Client Messages

/// Top-level server message envelope.
struct ServerMessage: Codable {
    let type: String
}

/// Full index sync response from the server.
struct IndexSyncResponse: Codable, @unchecked Sendable {
    let type: String
    let sessions: [ServerSessionEntry]
    let projects: [ServerProjectEntry]
    /// Total session count from server COUNT(*) - used to detect truncation
    let totalSessionCount: Int?
    /// Echo of the `since` value from the request. Present only for incremental responses.
    let since: Int?
}

/// A session entry as received from the server (encrypted fields).
struct ServerSessionEntry: Codable {
    let sessionId: String
    let encryptedProjectId: String
    let projectIdIv: String
    let encryptedTitle: String?
    let titleIv: String?
    let provider: String?
    let model: String?
    let mode: String?
    /// Structural type: "session", "workstream", or "blitz"
    let sessionType: String?
    /// Parent session ID for workstream/worktree hierarchy
    let parentSessionId: String?
    /// Agent role marker (e.g. "meta-agent"); gates meta-agent powers on desktop
    let agentRole: String?
    /// Session ID of the meta-agent that spawned this sub-agent (child link)
    let createdBySessionId: String?
    /// Worktree ID for git worktree association
    let worktreeId: String?
    /// Whether this session is archived
    let isArchived: Bool?
    /// Whether this session is pinned
    let isPinned: Bool?
    /// Session ID this was branched/forked from
    let branchedFromSessionId: String?
    /// Message sequence number where the branch occurred
    let branchPointMessageId: Int?
    /// Timestamp when the branch was created
    let branchedAt: Int?
    let messageCount: Int?
    let lastMessageAt: Int?
    let createdAt: Int
    let updatedAt: Int
    let pendingExecution: PendingExecution?
    let isExecuting: Bool?
    let queuedPromptCount: Int?
    let encryptedQueuedPrompts: [EncryptedQueuedPrompt]?
    let hasPendingPrompt: Bool?
    let encryptedClientMetadata: String?
    let clientMetadataIv: String?
    let lastReadAt: Int?
}

struct PendingExecution: Codable {
    let messageId: String
    let sentAt: Int
    let sentBy: String
}

struct EncryptedQueuedPrompt: Codable {
    let id: String
    let encryptedPrompt: String
    let iv: String
    let timestamp: Int
    let source: String?
    /// Encrypted image attachments (each independently encrypted).
    var encryptedAttachments: [WireEncryptedAttachment]?
}

/// An encrypted image attachment on the wire. Desktop decrypts and writes to temp file.
public struct WireEncryptedAttachment: Codable {
    public let id: String
    public let filename: String
    public let mimeType: String
    /// Base64 AES-GCM ciphertext of the compressed image data.
    public let encryptedData: String
    /// Base64 IV for decryption.
    public let iv: String
    /// Original size in bytes (before encryption).
    public let size: Int
    public let width: Int?
    public let height: Int?
}

struct ContextInfo: Codable {
    let tokens: Int
    let contextWindow: Int
}

/// Decrypted client metadata blob - opaque to server, only clients read it.
/// Add new display-only fields here without touching the server.
struct ClientMetadata: Codable {
    let currentContext: ContextInfo?
    let hasPendingPrompt: Bool?
    let attentionSummary: AttentionSummary?
    /// Kanban phase: backlog, planning, implementing, validating, complete
    let phase: String?
    /// Arbitrary tags for categorization
    let tags: [String]?
    /// Draft input text (unsent message) for cross-device sync
    let draftInput: String?
    /// Epoch ms when draftInput was last updated by the sending device
    let draftUpdatedAt: Int?
    /// Marker that the title was AI-chosen; prevents repeated rename attempts.
    let hasBeenNamed: Bool?
}

extension ClientMetadata {
    /// A draft edit replaces the complete encrypted client-metadata blob on the
    /// index. The server cannot merge this opaque value, so every draft write
    /// must carry forward the session's canonical prompt/attention state (and
    /// the other client-only fields already available locally).
    static func preservingOpaqueState(
        from session: Session,
        draftInput: String,
        draftUpdatedAt: Int
    ) -> ClientMetadata {
        let currentContext: ContextInfo?
        if let tokens = session.contextTokens,
           let contextWindow = session.contextWindow,
           contextWindow > 0 {
            currentContext = ContextInfo(tokens: tokens, contextWindow: contextWindow)
        } else {
            currentContext = nil
        }

        return ClientMetadata(
            currentContext: currentContext,
            hasPendingPrompt: session.hasPendingPrompt,
            attentionSummary: AttentionSummary(
                pending: session.attentionPending,
                severity: session.attentionSeverity,
                eventId: session.attentionEventId,
                effectiveDeadline: session.attentionEffectiveDeadline
            ),
            phase: session.phase,
            tags: session.tags.isEmpty ? nil : session.tags,
            draftInput: draftInput,
            draftUpdatedAt: draftUpdatedAt,
            hasBeenNamed: session.hasBeenNamed
        )
    }
}

enum SessionOpaqueMetadataReconciler {
    /// Omission means an older peer did not know the field, so retain local
    /// knowledge. Explicit false and true are both authoritative values.
    static func namingMarker(existing: Bool?, incoming: Bool?) -> Bool? {
        incoming ?? existing
    }
}

/// Bounded generic attention state from the encrypted client metadata blob.
/// It deliberately contains no prompt body, question, or raw error text.
struct AttentionSummary: Codable, Equatable, Sendable {
    let pending: Bool
    let severity: String?
    let eventId: String?
    let effectiveDeadline: String?
}

/// A project entry as received from the server (encrypted fields).
struct ServerProjectEntry: Codable {
    let encryptedProjectId: String
    let projectIdIv: String
    let encryptedName: String?
    let nameIv: String?
    let encryptedPath: String?
    let pathIv: String?
    let sessionCount: Int?
    let lastActivityAt: Int?
    let syncEnabled: Bool?
    /// Encrypted project config blob (commands, settings, etc.)
    let encryptedConfig: String?
    /// IV for config decryption
    let configIv: String?
    /// SHA-256 hash of the git remote URL, used for ProjectSyncRoom routing
    let gitRemoteHash: String?
}

/// Decrypted project config containing commands and future project-level settings.
struct ProjectConfig: Codable {
    let commands: [SyncedSlashCommand]
    let lastCommandsUpdate: Int
}

/// Lightweight slash command manifest synced from desktop.
public struct SyncedSlashCommand: Codable, Identifiable {
    public let name: String
    public let description: String?
    public let source: String  // "builtin" | "project" | "user" | "plugin"
    public var id: String { name }
}

/// Session broadcast from index room.
struct IndexBroadcast: Codable {
    let type: String
    let session: ServerSessionEntry
    let fromConnectionId: String?
}

/// Session deletion broadcast.
struct IndexDeleteBroadcast: Codable {
    let type: String
    let sessionId: String
    let fromConnectionId: String?
}

/// New project broadcast.
struct ProjectBroadcast: Codable {
    let type: String
    let project: ServerProjectEntry
    let fromConnectionId: String?
}

/// Device info for presence.
public struct DeviceInfo: Codable {
    public let deviceId: String
    public let name: String
    public let type: String       // "desktop" | "mobile" | "tablet" | "unknown"
    public let platform: String
    public let appVersion: String?
    public let connectedAt: Int
    public let lastActiveAt: Int
    public let isFocused: Bool?
    public let status: String?    // "active" | "idle" | "away"
}

/// Create session response.
struct CreateSessionResponseBroadcast: Codable {
    let type: String
    let response: CreateSessionResponse
    let fromConnectionId: String?
}

struct CreateSessionResponse: Codable {
    let requestId: String
    let success: Bool
    let sessionId: String?
    let error: String?
}

/// Server error message.
struct ServerError: Codable {
    let type: String
    let code: String
    let message: String
}

/// Voice-tool response broadcast (desktop -> mobile) for a proxied voice tool.
struct VoiceToolResponseBroadcast: Codable {
    let type: String
    let response: EncryptedVoiceToolResponse
    let fromConnectionId: String?
}

/// Encrypted voice-tool response payload (result/error carry project knowledge).
struct EncryptedVoiceToolResponse: Codable {
    let requestId: String
    let success: Bool
    let encryptedResult: String?
    let resultIv: String?
    let encryptedError: String?
    let errorIv: String?
}

/// Encrypted settings payload from desktop (e.g., API keys, voice mode config).
struct EncryptedSettingsPayload: Codable {
    let encryptedSettings: String
    let settingsIv: String
    let deviceId: String
    let timestamp: Int
    let version: Int
}

/// Settings sync broadcast from server (desktop -> mobile).
struct SettingsSyncBroadcast: Codable {
    let type: String
    let settings: EncryptedSettingsPayload
    let fromConnectionId: String?
}

/// Decrypted settings received from desktop.
public struct SyncedSettings: Codable {
    public let openaiApiKey: String?
    public let voiceMode: SyncedVoiceModeSettings?
    public let availableModels: [SyncedAvailableModel]?
    public let defaultModel: String?
    /// Whether the desktop "meta-agent" alpha feature is enabled (gates the mobile Meta Agent UI).
    public let metaAgentEnabled: Bool?
    /// Desktop's preferred agent language. The voice agent pins its spoken
    /// language to this so it never starts up in a different language than the
    /// desktop is configured for. Nil/empty means no preference -> English.
    public let preferredAgentLanguage: String?
    public let version: Int
}

/// Voice mode settings synced from desktop.
public struct SyncedVoiceModeSettings: Codable {
    public let voice: String?
    public let submitDelayMs: Int?
}

/// An AI model available on the desktop, synced to mobile for the model picker.
public struct SyncedAvailableModel: Codable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let provider: String
}

// MARK: - Client -> Server Messages

struct IndexSyncRequest: Codable {
    let type = "indexSyncRequest"
    let projectId: String?
    /// When set, server returns only entries updated after this timestamp (Unix ms).
    let since: Int?
}

struct DeviceAnnounceMessage: Codable {
    let type = "deviceAnnounce"
    let device: DeviceInfo
}

public struct RegisterPushTokenMessage: Codable {
    let type = "registerPushToken"
    public let token: String
    public let platform: String
    public let deviceId: String
    public let environment: String
}

public struct UnregisterPushTokenMessage: Codable {
    let type = "unregisterPushToken"
    public let deviceId: String
}

struct CreateSessionRequestMessage: Codable {
    let type = "createSessionRequest"
    let request: EncryptedCreateSessionRequest
}

struct EncryptedCreateSessionRequest: Codable {
    let requestId: String
    let encryptedProjectId: String
    let projectIdIv: String
    let encryptedInitialPrompt: String?
    let initialPromptIv: String?
    let sessionType: String?
    let parentSessionId: String?
    let provider: String?
    let model: String?
    let agentRole: String?
    let timestamp: Int
}

// MARK: - Worktree Creation Request

struct CreateWorktreeRequestMessage: Codable {
    let type = "createWorktreeRequest"
    let request: CreateWorktreeRequest
}

struct CreateWorktreeRequest: Codable {
    let requestId: String
    let encryptedProjectId: String
    let projectIdIv: String
    let timestamp: Int
}

// MARK: - Voice Tool Request (mobile -> desktop)

struct VoiceToolRequestMessage: Codable {
    let type = "voiceToolRequest"
    let request: EncryptedVoiceToolRequest
}

/// Encrypted voice-tool request payload (toolName/args carry project knowledge).
struct EncryptedVoiceToolRequest: Codable {
    let requestId: String
    let encryptedProjectId: String
    let projectIdIv: String
    let encryptedToolName: String
    let toolNameIv: String
    let encryptedArgs: String
    let argsIv: String
    let timestamp: Int
}

/// Send an indexUpdate to notify desktop of queued prompts or metadata changes.
struct IndexUpdateMessage: Codable {
    let type = "indexUpdate"
    let session: IndexUpdateEntry
}

/// Session entry for indexUpdate messages (client -> server).
/// Extra fields like encryptedQueuedPrompts pass through the server broadcast
/// even though the server doesn't persist them.
struct IndexUpdateEntry: Codable {
    let sessionId: String
    let encryptedProjectId: String
    let projectIdIv: String
    let encryptedTitle: String?
    let titleIv: String?
    let provider: String?
    let model: String?
    let mode: String?
    let messageCount: Int
    let lastMessageAt: Int
    let createdAt: Int
    let updatedAt: Int
    let isExecuting: Bool?
    let queuedPromptCount: Int?
    let encryptedQueuedPrompts: [EncryptedQueuedPrompt]?
    /// Encrypted client metadata blob (context, draft, phase, tags, etc.)
    var encryptedClientMetadata: String?
    var clientMetadataIv: String?
}

struct SessionControlMessage: Codable {
    let type = "sessionControl"
    let message: SessionControlPayload
}

struct SessionControlPayload: Codable {
    let sessionId: String
    let messageType: String
    let payload: [String: AnyCodable]?
    let timestamp: Int
    let sentBy: String
}

// MARK: - Session Room Messages (Client -> Server)

/// Request messages for a session room.
struct SessionSyncRequest: Codable {
    let type = "syncRequest"
    let sinceSeq: Int?
}

/// Append a message to the session.
struct AppendMessageRequest: Codable {
    let type = "appendMessage"
    let message: ServerMessageEntry
}

// MARK: - Session Room Messages (Server -> Client)

/// Sync response with paginated messages.
struct SessionSyncResponse: Codable {
    let type: String
    let messages: [ServerMessageEntry]
    let metadata: SessionRoomMetadata?
    let hasMore: Bool
    let cursor: String?
}

/// A message entry from the session room.
struct ServerMessageEntry: Codable {
    let id: String
    let sequence: Int
    let createdAt: Int
    let source: String
    let direction: String
    let encryptedContent: String
    let iv: String
    let metadata: [String: AnyCodable]?
}

/// Session metadata returned with syncResponse.
///
/// Titles are E2E encrypted: the server only ever returns ciphertext under
/// `encryptedTitle` / `titleIv`. The session list pulls decrypted titles
/// from the IndexRoom path; this struct does not currently surface a title
/// to the UI, but the fields are declared so future consumers can decrypt
/// without re-introducing a plaintext server-side field.
struct SessionRoomMetadata: Codable {
    let encryptedTitle: String?
    let titleIv: String?
    let provider: String?
    let model: String?
    let mode: String?
    let isExecuting: Bool?
    let createdAt: Int?
    let updatedAt: Int?
    let encryptedProjectId: String?
    let projectIdIv: String?
    let encryptedClientMetadata: String?
    let clientMetadataIv: String?
}

/// Real-time message broadcast in a session room.
struct MessageBroadcast: Codable {
    let type: String
    let message: ServerMessageEntry
    let fromConnectionId: String?
}

/// Session metadata broadcast in a session room.
struct MetadataBroadcast: Codable {
    let type: String
    let metadata: SessionRoomMetadata
    let fromConnectionId: String?
}

// MARK: - ProjectSync Room Messages (Client -> Server)

/// Initial sync: client sends manifest of what it has.
struct ProjectSyncRequestMessage: Codable {
    let type = "projectSyncRequest"
    let files: [ProjectSyncManifestEntry]
}

/// A file entry in the client's sync manifest.
struct ProjectSyncManifestEntry: Codable {
    let syncId: String
    let contentHash: String
    let lastModifiedAt: Int
    let hasYjs: Bool
    let yjsSeq: Int
}

/// Push file content (markdown phase).
struct FileContentPushMessage: Codable {
    let type = "fileContentPush"
    let syncId: String
    let encryptedContent: String
    let contentIv: String
    let contentHash: String
    let encryptedPath: String
    let pathIv: String
    let encryptedTitle: String
    let titleIv: String
    let lastModifiedAt: Int
}

/// Batch push for startup sync sweep.
struct FileContentBatchPushMessage: Codable {
    let type = "fileContentBatchPush"
    let files: [FileContentPushEntry]
}

/// Individual file entry in a batch push (same shape as FileContentPushMessage minus type).
struct FileContentPushEntry: Codable {
    let syncId: String
    let encryptedContent: String
    let contentIv: String
    let contentHash: String
    let encryptedPath: String
    let pathIv: String
    let encryptedTitle: String
    let titleIv: String
    let lastModifiedAt: Int
}

/// Delete a file.
struct FileDeleteMessage: Codable {
    let type = "fileDelete"
    let syncId: String
}

/// Yjs update (phase 2 - file being actively edited).
struct FileYjsUpdateMessage: Codable {
    let type = "fileYjsUpdate"
    let syncId: String
    let encryptedUpdate: String
    let iv: String
}

/// Upgrade file from markdown to Yjs phase.
struct FileYjsInitMessage: Codable {
    let type = "fileYjsInit"
    let syncId: String
    let encryptedSnapshot: String
    let iv: String
}

/// Yjs snapshot compaction.
struct FileYjsCompactMessage: Codable {
    let type = "fileYjsCompact"
    let syncId: String
    let encryptedSnapshot: String
    let iv: String
    let replacesUpTo: Int
}

// MARK: - ProjectSync Room Messages (Server -> Client)

/// Response to projectSyncRequest.
struct ProjectSyncResponse: Codable {
    let type: String
    /// Files the client is missing or has stale content for.
    let updatedFiles: [ProjectSyncFileEntry]
    /// Yjs updates the client hasn't seen.
    let yjsUpdates: [ProjectSyncYjsUpdate]
    /// Files on server that client doesn't have.
    let newFiles: [ProjectSyncFileEntry]
    /// syncIds of files client has that server needs.
    let needFromClient: [String]
    /// syncIds of files deleted on another device.
    let deletedSyncIds: [String]
}

/// A file entry in the sync response.
struct ProjectSyncFileEntry: Codable {
    let syncId: String
    let encryptedContent: String
    let contentIv: String
    let contentHash: String
    let encryptedPath: String
    let pathIv: String
    let encryptedTitle: String
    let titleIv: String
    let lastModifiedAt: Int
    let hasYjs: Bool
}

/// A Yjs update in the sync response.
struct ProjectSyncYjsUpdate: Codable {
    let syncId: String
    let encryptedUpdate: String
    let iv: String
    let sequence: Int
}

/// Broadcast when another device pushes content.
struct FileContentBroadcast: Codable {
    let type: String
    let syncId: String
    let encryptedContent: String
    let contentIv: String
    let contentHash: String
    let encryptedPath: String
    let pathIv: String
    let encryptedTitle: String
    let titleIv: String
    let lastModifiedAt: Int
    let fromConnectionId: String
}

/// Broadcast Yjs update from another device.
struct FileYjsUpdateBroadcast: Codable {
    let type: String
    let syncId: String
    let encryptedUpdate: String
    let iv: String
    let sequence: Int
    let fromConnectionId: String
}

/// Broadcast file deletion.
struct FileDeleteBroadcast: Codable {
    let type: String
    let syncId: String
    let fromConnectionId: String
}

/// Broadcast Yjs init (file upgraded to Yjs phase).
struct FileYjsInitBroadcast: Codable {
    let type: String
    let syncId: String
    let fromConnectionId: String
}

// MARK: - Utility Types

/// Type-erased Codable wrapper for arbitrary JSON values.
struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            value = NSNull()
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encodeNil()
        }
    }
}
