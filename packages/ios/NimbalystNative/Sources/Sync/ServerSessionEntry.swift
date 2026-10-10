import Foundation

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
    /// Manager session ID; independent of hierarchy across container boundaries.
    let createdBySessionId: String?
    /// Worktree ID for git worktree association
    let worktreeId: String?
    /// Stable ID of the desktop or headless host that owns execution
    let hostDeviceId: String?
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
    // Decode-only presence distinguishes an omitted legacy patch from a canonical
    // desktop null that detaches a row or rejects an optimistic phone move.
    var parentSessionIdPresent = false
    var createdBySessionIdPresent = false

    enum CodingKeys: String, CodingKey {
        case sessionId
        case encryptedProjectId
        case projectIdIv
        case encryptedTitle
        case titleIv
        case provider
        case model
        case mode
        case sessionType
        case parentSessionId
        case agentRole
        case createdBySessionId
        case worktreeId
        case hostDeviceId
        case isArchived
        case isPinned
        case branchedFromSessionId
        case branchPointMessageId
        case branchedAt
        case messageCount
        case lastMessageAt
        case createdAt
        case updatedAt
        case pendingExecution
        case isExecuting
        case queuedPromptCount
        case encryptedQueuedPrompts
        case hasPendingPrompt
        case encryptedClientMetadata
        case clientMetadataIv
        case lastReadAt
    }
}

extension ServerSessionEntry {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try values.decode(String.self, forKey: .sessionId)
        encryptedProjectId = try values.decode(String.self, forKey: .encryptedProjectId)
        projectIdIv = try values.decode(String.self, forKey: .projectIdIv)
        encryptedTitle = try values.decodeIfPresent(String.self, forKey: .encryptedTitle)
        titleIv = try values.decodeIfPresent(String.self, forKey: .titleIv)
        provider = try values.decodeIfPresent(String.self, forKey: .provider)
        model = try values.decodeIfPresent(String.self, forKey: .model)
        mode = try values.decodeIfPresent(String.self, forKey: .mode)
        sessionType = try values.decodeIfPresent(String.self, forKey: .sessionType)
        parentSessionId = try values.decodeIfPresent(String.self, forKey: .parentSessionId)
        agentRole = try values.decodeIfPresent(String.self, forKey: .agentRole)
        createdBySessionId = try values.decodeIfPresent(String.self, forKey: .createdBySessionId)
        worktreeId = try values.decodeIfPresent(String.self, forKey: .worktreeId)
        hostDeviceId = try values.decodeIfPresent(String.self, forKey: .hostDeviceId)
        isArchived = try values.decodeIfPresent(Bool.self, forKey: .isArchived)
        isPinned = try values.decodeIfPresent(Bool.self, forKey: .isPinned)
        branchedFromSessionId = try values.decodeIfPresent(String.self, forKey: .branchedFromSessionId)
        branchPointMessageId = try values.decodeIfPresent(Int.self, forKey: .branchPointMessageId)
        branchedAt = try values.decodeIfPresent(Int.self, forKey: .branchedAt)
        messageCount = try values.decodeIfPresent(Int.self, forKey: .messageCount)
        lastMessageAt = try values.decodeIfPresent(Int.self, forKey: .lastMessageAt)
        createdAt = try values.decode(Int.self, forKey: .createdAt)
        updatedAt = try values.decode(Int.self, forKey: .updatedAt)
        pendingExecution = try values.decodeIfPresent(PendingExecution.self, forKey: .pendingExecution)
        isExecuting = try values.decodeIfPresent(Bool.self, forKey: .isExecuting)
        queuedPromptCount = try values.decodeIfPresent(Int.self, forKey: .queuedPromptCount)
        encryptedQueuedPrompts = try values.decodeIfPresent([EncryptedQueuedPrompt].self, forKey: .encryptedQueuedPrompts)
        hasPendingPrompt = try values.decodeIfPresent(Bool.self, forKey: .hasPendingPrompt)
        encryptedClientMetadata = try values.decodeIfPresent(String.self, forKey: .encryptedClientMetadata)
        clientMetadataIv = try values.decodeIfPresent(String.self, forKey: .clientMetadataIv)
        lastReadAt = try values.decodeIfPresent(Int.self, forKey: .lastReadAt)
        parentSessionIdPresent = values.contains(.parentSessionId)
        createdBySessionIdPresent = values.contains(.createdBySessionId)
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(sessionId, forKey: .sessionId)
        try values.encode(encryptedProjectId, forKey: .encryptedProjectId)
        try values.encode(projectIdIv, forKey: .projectIdIv)
        try values.encodeIfPresent(encryptedTitle, forKey: .encryptedTitle)
        try values.encodeIfPresent(titleIv, forKey: .titleIv)
        try values.encodeIfPresent(provider, forKey: .provider)
        try values.encodeIfPresent(model, forKey: .model)
        try values.encodeIfPresent(mode, forKey: .mode)
        try values.encodeIfPresent(sessionType, forKey: .sessionType)
        try values.encodeIfPresent(parentSessionId, forKey: .parentSessionId)
        try values.encodeIfPresent(agentRole, forKey: .agentRole)
        try values.encodeIfPresent(createdBySessionId, forKey: .createdBySessionId)
        try values.encodeIfPresent(worktreeId, forKey: .worktreeId)
        try values.encodeIfPresent(hostDeviceId, forKey: .hostDeviceId)
        try values.encodeIfPresent(isArchived, forKey: .isArchived)
        try values.encodeIfPresent(isPinned, forKey: .isPinned)
        try values.encodeIfPresent(branchedFromSessionId, forKey: .branchedFromSessionId)
        try values.encodeIfPresent(branchPointMessageId, forKey: .branchPointMessageId)
        try values.encodeIfPresent(branchedAt, forKey: .branchedAt)
        try values.encodeIfPresent(messageCount, forKey: .messageCount)
        try values.encodeIfPresent(lastMessageAt, forKey: .lastMessageAt)
        try values.encode(createdAt, forKey: .createdAt)
        try values.encode(updatedAt, forKey: .updatedAt)
        try values.encodeIfPresent(pendingExecution, forKey: .pendingExecution)
        try values.encodeIfPresent(isExecuting, forKey: .isExecuting)
        try values.encodeIfPresent(queuedPromptCount, forKey: .queuedPromptCount)
        try values.encodeIfPresent(encryptedQueuedPrompts, forKey: .encryptedQueuedPrompts)
        try values.encodeIfPresent(hasPendingPrompt, forKey: .hasPendingPrompt)
        try values.encodeIfPresent(encryptedClientMetadata, forKey: .encryptedClientMetadata)
        try values.encodeIfPresent(clientMetadataIv, forKey: .clientMetadataIv)
        try values.encodeIfPresent(lastReadAt, forKey: .lastReadAt)
        if parentSessionIdPresent && parentSessionId == nil { try values.encodeNil(forKey: .parentSessionId) }
        if createdBySessionIdPresent && createdBySessionId == nil { try values.encodeNil(forKey: .createdBySessionId) }
    }
}
