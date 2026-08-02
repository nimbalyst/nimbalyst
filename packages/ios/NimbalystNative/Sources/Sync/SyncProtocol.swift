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

enum ContextMeterConfidence: String, Codable {
    case exact, estimated, stale, unavailable
}

private extension KeyedDecodingContainer {
    func decodeOptionalRejectingExplicitNull<T: Decodable>(
        _ type: T.Type,
        forKey key: Key
    ) throws -> T? {
        guard contains(key) else { return nil }
        if try decodeNil(forKey: key) {
            throw DecodingError.valueNotFound(
                type,
                .init(
                    codingPath: codingPath + [key],
                    debugDescription: "Optional context-meter fields must be omitted, not null"
                )
            )
        }
        return try decode(type, forKey: key)
    }
}

struct ContextMeterIdentityV1: Codable, Equatable {
    let nimbalystSessionId: String
    let providerId: String
    let persistedModelId: String
    let providerModelId: String?
    let catalogEntryId: String?
    let interfaceId: String?
    let upstreamThreadId: String
    let producerRole: String

    private enum CodingKeys: String, CodingKey {
        case nimbalystSessionId, providerId, persistedModelId
        case providerModelId, catalogEntryId, interfaceId
        case upstreamThreadId, producerRole
    }

    init(
        nimbalystSessionId: String,
        providerId: String,
        persistedModelId: String,
        providerModelId: String?,
        catalogEntryId: String?,
        interfaceId: String?,
        upstreamThreadId: String,
        producerRole: String
    ) {
        self.nimbalystSessionId = nimbalystSessionId
        self.providerId = providerId
        self.persistedModelId = persistedModelId
        self.providerModelId = providerModelId
        self.catalogEntryId = catalogEntryId
        self.interfaceId = interfaceId
        self.upstreamThreadId = upstreamThreadId
        self.producerRole = producerRole
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        nimbalystSessionId = try values.decode(String.self, forKey: .nimbalystSessionId)
        providerId = try values.decode(String.self, forKey: .providerId)
        persistedModelId = try values.decode(String.self, forKey: .persistedModelId)
        providerModelId = try values.decodeOptionalRejectingExplicitNull(
            String.self,
            forKey: .providerModelId
        )
        catalogEntryId = try values.decodeOptionalRejectingExplicitNull(
            String.self,
            forKey: .catalogEntryId
        )
        interfaceId = try values.decodeOptionalRejectingExplicitNull(
            String.self,
            forKey: .interfaceId
        )
        upstreamThreadId = try values.decode(String.self, forKey: .upstreamThreadId)
        producerRole = try values.decode(String.self, forKey: .producerRole)
    }
}

struct ContextMeterOrderV1: Codable, Equatable {
    let processInstanceId: String
    let lifecycleGeneration: Int
    let sequence: Int
    let turnId: String?
    let observedAtMs: Int

    private enum CodingKeys: String, CodingKey {
        case processInstanceId, lifecycleGeneration, sequence, turnId, observedAtMs
    }

    init(
        processInstanceId: String,
        lifecycleGeneration: Int,
        sequence: Int,
        turnId: String?,
        observedAtMs: Int
    ) {
        self.processInstanceId = processInstanceId
        self.lifecycleGeneration = lifecycleGeneration
        self.sequence = sequence
        self.turnId = turnId
        self.observedAtMs = observedAtMs
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        processInstanceId = try values.decode(String.self, forKey: .processInstanceId)
        lifecycleGeneration = try values.decode(Int.self, forKey: .lifecycleGeneration)
        sequence = try values.decode(Int.self, forKey: .sequence)
        turnId = try values.decodeOptionalRejectingExplicitNull(String.self, forKey: .turnId)
        observedAtMs = try values.decode(Int.self, forKey: .observedAtMs)
    }
}

struct ContextMeterProvenanceV1: Codable, Equatable {
    let identity: ContextMeterIdentityV1
    let order: ContextMeterOrderV1
    let adapterId: String
    let windowPolicy: String
    let numeratorSource: String
    let denominatorSource: String
    let runtimeWindowTokens: Int?
    let contextWindowSeedTokens: Int?
    let acceptedAtMs: Int
    let lastFreshObservationAtMs: Int?
    let invalidationReason: String?

    private enum CodingKeys: String, CodingKey {
        case identity, order, adapterId, windowPolicy, numeratorSource, denominatorSource
        case runtimeWindowTokens, contextWindowSeedTokens, acceptedAtMs
        case lastFreshObservationAtMs, invalidationReason
    }

    init(
        identity: ContextMeterIdentityV1,
        order: ContextMeterOrderV1,
        adapterId: String,
        windowPolicy: String,
        numeratorSource: String,
        denominatorSource: String,
        runtimeWindowTokens: Int?,
        contextWindowSeedTokens: Int?,
        acceptedAtMs: Int,
        lastFreshObservationAtMs: Int?,
        invalidationReason: String?
    ) {
        self.identity = identity
        self.order = order
        self.adapterId = adapterId
        self.windowPolicy = windowPolicy
        self.numeratorSource = numeratorSource
        self.denominatorSource = denominatorSource
        self.runtimeWindowTokens = runtimeWindowTokens
        self.contextWindowSeedTokens = contextWindowSeedTokens
        self.acceptedAtMs = acceptedAtMs
        self.lastFreshObservationAtMs = lastFreshObservationAtMs
        self.invalidationReason = invalidationReason
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        identity = try values.decode(ContextMeterIdentityV1.self, forKey: .identity)
        order = try values.decode(ContextMeterOrderV1.self, forKey: .order)
        adapterId = try values.decode(String.self, forKey: .adapterId)
        windowPolicy = try values.decode(String.self, forKey: .windowPolicy)
        numeratorSource = try values.decode(String.self, forKey: .numeratorSource)
        denominatorSource = try values.decode(String.self, forKey: .denominatorSource)
        runtimeWindowTokens = try values.decodeOptionalRejectingExplicitNull(
            Int.self,
            forKey: .runtimeWindowTokens
        )
        contextWindowSeedTokens = try values.decodeOptionalRejectingExplicitNull(
            Int.self,
            forKey: .contextWindowSeedTokens
        )
        acceptedAtMs = try values.decode(Int.self, forKey: .acceptedAtMs)
        lastFreshObservationAtMs = try values.decodeOptionalRejectingExplicitNull(
            Int.self,
            forKey: .lastFreshObservationAtMs
        )
        invalidationReason = try values.decodeOptionalRejectingExplicitNull(
            String.self,
            forKey: .invalidationReason
        )
    }
}

struct ContextMeterStateV1: Codable, Equatable {
    let schemaVersion: Int
    let confidence: ContextMeterConfidence
    let fillTokens: Int?
    let effectiveWindowTokens: Int?
    let reason: String?
    let provenance: ContextMeterProvenanceV1?

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, confidence, fillTokens, effectiveWindowTokens, reason, provenance
    }

    init(
        schemaVersion: Int,
        confidence: ContextMeterConfidence,
        fillTokens: Int?,
        effectiveWindowTokens: Int?,
        reason: String?,
        provenance: ContextMeterProvenanceV1?
    ) {
        self.schemaVersion = schemaVersion
        self.confidence = confidence
        self.fillTokens = fillTokens
        self.effectiveWindowTokens = effectiveWindowTokens
        self.reason = reason
        self.provenance = provenance
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        confidence = try values.decode(ContextMeterConfidence.self, forKey: .confidence)
        fillTokens = try values.decodeIfPresent(Int.self, forKey: .fillTokens)
        effectiveWindowTokens = try values.decodeIfPresent(Int.self, forKey: .effectiveWindowTokens)
        reason = try values.decodeIfPresent(String.self, forKey: .reason)
        provenance = try values.decodeOptionalRejectingExplicitNull(
            ContextMeterProvenanceV1.self,
            forKey: .provenance
        )
    }

    var isValid: Bool {
        guard schemaVersion == 1 else { return false }
        if confidence == .unavailable {
            guard let reason, Self.unavailableReasons.contains(reason) else { return false }
            guard let provenance else { return true }
            return Self.isValidProvenance(provenance)
        }
        guard let fillTokens, Self.isSafeNonNegativeInteger(fillTokens),
              let effectiveWindowTokens, Self.isSafePositiveInteger(effectiveWindowTokens),
              fillTokens <= effectiveWindowTokens,
              let provenance, Self.isValidProvenance(provenance),
              provenance.denominatorSource != "none" else { return false }
        if confidence == .estimated {
            return provenance.denominatorSource == "immutable-model-seed"
                && provenance.contextWindowSeedTokens == effectiveWindowTokens
        }
        if provenance.denominatorSource == "immutable-model-seed" {
            return confidence == .stale
                && provenance.contextWindowSeedTokens == effectiveWindowTokens
        }
        return provenance.runtimeWindowTokens == effectiveWindowTokens
    }

    private static let maxSafeInteger = 9_007_199_254_740_991
    private static let maxContextWindowSeedTokens = 2_000_000

    private static func isNonEmpty(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func isValidOptionalIdentityField(_ value: String?) -> Bool {
        guard let value else { return true }
        return isNonEmpty(value)
    }

    private static func isSafeNonNegativeInteger(_ value: Int) -> Bool {
        value >= 0 && value <= maxSafeInteger
    }

    private static func isSafePositiveInteger(_ value: Int) -> Bool {
        value > 0 && value <= maxSafeInteger
    }

    private static func isValidOptionalPositiveInteger(_ value: Int?) -> Bool {
        guard let value else { return true }
        return isSafePositiveInteger(value)
    }

    private static func isValidOptionalSeed(_ value: Int?) -> Bool {
        guard let value else { return true }
        return isSafePositiveInteger(value) && value <= maxContextWindowSeedTokens
    }

    private static func isValidOptionalNonNegativeInteger(_ value: Int?) -> Bool {
        guard let value else { return true }
        return isSafeNonNegativeInteger(value)
    }

    private static func isValidOptionalInvalidationReason(_ value: String?) -> Bool {
        guard let value else { return true }
        return invalidationReasons.contains(value)
    }

    private static func isValidProvenance(_ provenance: ContextMeterProvenanceV1) -> Bool {
        let identity = provenance.identity
        let order = provenance.order
        return identity.producerRole == "lead"
            && isNonEmpty(identity.nimbalystSessionId)
            && isNonEmpty(identity.providerId)
            && isNonEmpty(identity.persistedModelId)
            && isValidOptionalIdentityField(identity.providerModelId)
            && isValidOptionalIdentityField(identity.catalogEntryId)
            && isValidOptionalIdentityField(identity.interfaceId)
            && isNonEmpty(identity.upstreamThreadId)
            && isNonEmpty(order.processInstanceId)
            && isSafeNonNegativeInteger(order.lifecycleGeneration)
            && isSafePositiveInteger(order.sequence)
            && isValidOptionalIdentityField(order.turnId)
            && isSafeNonNegativeInteger(order.observedAtMs)
            && adapterIds.contains(provenance.adapterId)
            && windowPolicies.contains(provenance.windowPolicy)
            && provenance.numeratorSource == "runtime-observation"
            && denominatorSources.contains(provenance.denominatorSource)
            && isValidOptionalPositiveInteger(provenance.runtimeWindowTokens)
            && isValidOptionalSeed(provenance.contextWindowSeedTokens)
            && isSafeNonNegativeInteger(provenance.acceptedAtMs)
            && isValidOptionalNonNegativeInteger(provenance.lastFreshObservationAtMs)
            && isValidOptionalInvalidationReason(provenance.invalidationReason)
    }

    private static let adapterIds: Set<String> = [
        "claude-agent-sdk-parent-v1",
        "codex-sdk-token-count-v1",
        "codex-app-server-thread-usage-v1"
    ]
    private static let windowPolicies: Set<String> = [
        "runtime-required", "runtime-then-model-seed"
    ]
    private static let denominatorSources: Set<String> = [
        "runtime-observation", "prior-runtime-observation",
        "immutable-model-seed", "none"
    ]
    private static let invalidationReasons: Set<String> = [
        "compacted", "thread-reset", "model-changed", "route-changed",
        "interface-changed", "restart-mismatch"
    ]
    private static let unavailableReasons: Set<String> = [
        "no-observation", "adapter-unavailable", "runtime-window-required",
        "seed-conflict", "malformed-observation", "identity-invalidated",
        "legacy-unverifiable", "turn-missing-observation", "compacted",
        "thread-reset", "model-changed", "route-changed", "interface-changed",
        "restart-mismatch"
    ]
}

struct ResolvedContextMeterMetadata: Equatable {
    let stateJson: String?
    let tokens: Int?
    let window: Int?
}

func resolveContextMeterMetadata(
    _ metadata: ClientMetadata?,
    existingStateJson: String?,
    existingTokens: Int?,
    existingWindow: Int?
) -> ResolvedContextMeterMetadata {
    if let state = metadata?.contextMeterState {
        guard state.isValid,
              let data = try? JSONEncoder().encode(state),
              let stateJson = String(data: data, encoding: .utf8) else {
            return .init(
                stateJson: existingStateJson,
                tokens: existingTokens,
                window: existingWindow
            )
        }
        if state.confidence == .unavailable {
            return .init(stateJson: stateJson, tokens: nil, window: nil)
        }
        return .init(
            stateJson: stateJson,
            tokens: state.fillTokens,
            window: state.effectiveWindowTokens
        )
    }
    if existingStateJson != nil {
        return .init(
            stateJson: existingStateJson,
            tokens: existingTokens,
            window: existingWindow
        )
    }
    return .init(
        stateJson: nil,
        tokens: metadata?.currentContext?.tokens ?? existingTokens,
        window: metadata?.currentContext?.contextWindow ?? existingWindow
    )
}

/// Decrypted client metadata blob - opaque to server, only clients read it.
/// Add new display-only fields here without touching the server.
struct ClientMetadata: Codable {
    let currentContext: ContextInfo?
    let contextMeterState: ContextMeterStateV1?
    let hasPendingPrompt: Bool?
    /// Kanban phase: backlog, planning, implementing, validating, complete
    let phase: String?
    /// Arbitrary tags for categorization
    let tags: [String]?
    /// Draft input text (unsent message) for cross-device sync
    let draftInput: String?
    /// Epoch ms when draftInput was last updated by the sending device
    let draftUpdatedAt: Int?
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

struct IndexSyncRequest: Encodable {
    let type = "indexSyncRequest"
    let projectId: String?
    /// When set, server returns only entries updated after this timestamp (Unix ms).
    let since: Int?
}

struct DeviceAnnounceMessage: Encodable {
    let type = "deviceAnnounce"
    let device: DeviceInfo
}

public struct RegisterPushTokenMessage: Encodable {
    let type = "registerPushToken"
    public let token: String
    public let platform: String
    public let deviceId: String
    public let environment: String
}

public struct UnregisterPushTokenMessage: Encodable {
    let type = "unregisterPushToken"
    public let deviceId: String
}

struct CreateSessionRequestMessage: Encodable {
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

struct CreateWorktreeRequestMessage: Encodable {
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

struct VoiceToolRequestMessage: Encodable {
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
struct IndexUpdateMessage: Encodable {
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

struct SessionControlMessage: Encodable {
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
struct SessionSyncRequest: Encodable {
    let type = "syncRequest"
    let sinceSeq: Int?
}

/// Append a message to the session.
struct AppendMessageRequest: Encodable {
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
struct ProjectSyncRequestMessage: Encodable {
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
struct FileContentPushMessage: Encodable {
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
struct FileContentBatchPushMessage: Encodable {
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
struct FileDeleteMessage: Encodable {
    let type = "fileDelete"
    let syncId: String
}

/// Yjs update (phase 2 - file being actively edited).
struct FileYjsUpdateMessage: Encodable {
    let type = "fileYjsUpdate"
    let syncId: String
    let encryptedUpdate: String
    let iv: String
}

/// Upgrade file from markdown to Yjs phase.
struct FileYjsInitMessage: Encodable {
    let type = "fileYjsInit"
    let syncId: String
    let encryptedSnapshot: String
    let iv: String
}

/// Yjs snapshot compaction.
struct FileYjsCompactMessage: Encodable {
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
