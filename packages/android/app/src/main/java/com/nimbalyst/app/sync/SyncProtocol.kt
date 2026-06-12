package com.nimbalyst.app.sync

import com.google.gson.JsonObject

data class ServerMessageEnvelope(
    val type: String
)

data class IndexSyncRequest(
    val type: String = "indexSyncRequest",
    val projectId: String? = null,
)

data class CreateSessionRequestMessage(
    val type: String = "createSessionRequest",
    val request: EncryptedCreateSessionRequest,
)

data class IndexUpdateMessage(
    val type: String = "indexUpdate",
    val session: IndexUpdateEntry,
)

data class IndexUpdateEntry(
    val sessionId: String,
    val encryptedProjectId: String,
    val projectIdIv: String,
    val encryptedTitle: String? = null,
    val titleIv: String? = null,
    val provider: String? = null,
    val model: String? = null,
    val mode: String? = null,
    val messageCount: Int,
    val lastMessageAt: Long,
    val createdAt: Long,
    val updatedAt: Long,
    val isExecuting: Boolean? = null,
    val queuedPromptCount: Int? = null,
    val encryptedQueuedPrompts: List<EncryptedQueuedPrompt>? = null,
    val encryptedClientMetadata: String? = null,
    val clientMetadataIv: String? = null,
)

data class EncryptedQueuedPrompt(
    val id: String,
    val encryptedPrompt: String,
    val iv: String,
    val timestamp: Long,
    val source: String? = null,
    var encryptedAttachments: List<WireEncryptedAttachment>? = null,
)

data class WireEncryptedAttachment(
    val id: String,
    val filename: String,
    val mimeType: String,
    val encryptedData: String,
    val iv: String,
    val size: Int,
    val width: Int? = null,
    val height: Int? = null,
)

data class EncryptedCreateSessionRequest(
    val requestId: String,
    val encryptedProjectId: String,
    val projectIdIv: String,
    val encryptedInitialPrompt: String? = null,
    val initialPromptIv: String? = null,
    val sessionType: String? = null,
    val parentSessionId: String? = null,
    val provider: String? = null,
    val model: String? = null,
    val timestamp: Long,
)

data class SessionSyncRequest(
    val type: String = "syncRequest",
    val sinceSeq: Int? = null,
)

data class RegisterPushTokenMessage(
    val type: String = "registerPushToken",
    val token: String,
    val platform: String,
    val deviceId: String,
)

data class SessionControlMessage(
    val type: String = "sessionControl",
    val message: SessionControlPayload,
)

data class SessionControlPayload(
    val sessionId: String,
    val messageType: String,
    val payload: JsonObject? = null,
    val timestamp: Long,
    val sentBy: String = "mobile",
)

data class IndexSyncResponse(
    val type: String,
    val sessions: List<ServerSessionEntry> = emptyList(),
    val projects: List<ServerProjectEntry> = emptyList(),
    val totalSessionCount: Int? = null,
)

data class ServerProjectEntry(
    val encryptedProjectId: String,
    val projectIdIv: String,
    val sessionCount: Int? = null,
    val lastActivityAt: Long? = null,
    val encryptedConfig: String? = null,
    val configIv: String? = null,
)

data class ServerSessionEntry(
    val sessionId: String,
    val encryptedProjectId: String,
    val projectIdIv: String,
    val encryptedTitle: String? = null,
    val titleIv: String? = null,
    val provider: String? = null,
    val model: String? = null,
    val mode: String? = null,
    val sessionType: String? = null,
    val parentSessionId: String? = null,
    val worktreeId: String? = null,
    val isArchived: Boolean? = null,
    val isPinned: Boolean? = null,
    val branchedFromSessionId: String? = null,
    val branchPointMessageId: Int? = null,
    val branchedAt: Long? = null,
    val messageCount: Int? = null,
    val lastMessageAt: Long? = null,
    val createdAt: Long,
    val updatedAt: Long,
    val isExecuting: Boolean? = null,
    val queuedPromptCount: Int? = null,
    val encryptedQueuedPrompts: List<EncryptedQueuedPrompt>? = null,
    val hasPendingPrompt: Boolean? = null,
    val encryptedClientMetadata: String? = null,
    val clientMetadataIv: String? = null,
    val lastReadAt: Long? = null,
)

data class ClientMetadata(
    val currentContext: ContextInfo? = null,
    val hasPendingPrompt: Boolean? = null,
    val agentStatus: AgentStatus? = null,
    val phase: String? = null,
    val tags: List<String>? = null,
    val draftInput: String? = null,
    val draftUpdatedAt: Long? = null,
    // Compact pre-projected transcript tail the desktop publishes for oversized
    // sessions whose per-message sync was disabled (message_limit_exceeded).
    val mobileTranscriptTailJson: String? = null,
    val mobileTranscriptTailUpdatedAt: Long? = null,
    // Latest cursor-based history page requested by this mobile client.
    val mobileTranscriptHistoryPageJson: String? = null,
    val mobileTranscriptHistoryPageUpdatedAt: Long? = null,
)

data class ContextInfo(
    val tokens: Int,
    val contextWindow: Int,
)

data class AgentStatus(
    val kind: String? = null,
    val label: String? = null,
    val detail: String? = null,
    val toolName: String? = null,
    val updatedAt: Long? = null,
)

data class IndexBroadcast(
    val type: String,
    val session: ServerSessionEntry,
    val fromConnectionId: String? = null,
)

data class IndexDeleteBroadcast(
    val type: String,
    val sessionId: String,
    val fromConnectionId: String? = null,
)

data class ProjectBroadcast(
    val type: String,
    val project: ServerProjectEntry,
    val fromConnectionId: String? = null,
)

data class CreateSessionResponseBroadcast(
    val type: String,
    val response: CreateSessionResponse,
    val fromConnectionId: String? = null,
)

data class CreateSessionResponse(
    val requestId: String,
    val success: Boolean,
    val sessionId: String? = null,
    val error: String? = null,
)

data class EncryptedSettingsPayload(
    val encryptedSettings: String,
    val settingsIv: String,
    val deviceId: String,
    val timestamp: Long,
    val version: Int,
)

data class SettingsSyncBroadcast(
    val type: String,
    val settings: EncryptedSettingsPayload,
    val fromConnectionId: String? = null,
)

data class SyncedSettings(
    val openaiApiKey: String? = null,
    val availableModels: List<SyncedAvailableModel>? = null,
    val defaultModel: String? = null,
    val usage: SyncedUsageSnapshot? = null,
    val version: Int,
)

data class SyncedAvailableModel(
    val id: String,
    val name: String,
    val provider: String,
)

/** One rate-limit window of a provider plan (utilization is 0-100). */
data class SyncedUsageWindow(
    val utilization: Double = 0.0,
    val resetsAt: String? = null,
)

data class SyncedUsageCredits(
    val hasCredits: Boolean = false,
    val unlimited: Boolean = false,
    val balance: Double? = null,
)

data class SyncedProviderUsage(
    val fiveHour: SyncedUsageWindow? = null,
    val sevenDay: SyncedUsageWindow? = null,
    val sevenDayOpus: SyncedUsageWindow? = null,
    val credits: SyncedUsageCredits? = null,
    val lastUpdated: Long? = null,
)

data class SyncedUsageSnapshot(
    val claude: SyncedProviderUsage? = null,
    val codex: SyncedProviderUsage? = null,
)

data class DevicesListMessage(
    val devices: List<DeviceInfo> = emptyList()
)

data class DeviceJoinedMessage(
    val device: DeviceInfo
)

data class DeviceLeftMessage(
    val deviceId: String
)

data class DeviceInfo(
    val deviceId: String,
    val name: String,
    val type: String,
    val platform: String,
    val appVersion: String? = null,
    val connectedAt: Long,
    val lastActiveAt: Long,
    val isFocused: Boolean? = null,
    val status: String? = null,
)

data class ServerErrorMessage(
    val type: String,
    val code: String,
    val message: String
)

data class SessionSyncResponse(
    val type: String,
    val messages: List<ServerMessageEntry> = emptyList(),
    val metadata: SessionRoomMetadata? = null,
    val hasMore: Boolean = false,
    val cursor: String? = null,
)

data class ServerMessageEntry(
    val id: String,
    val sequence: Int,
    val createdAt: Long,
    val source: String,
    val direction: String,
    val encryptedContent: String,
    val iv: String,
    val metadata: JsonObject? = null,
)

data class AppendMessageRequest(
    val type: String = "appendMessage",
    val message: ServerMessageEntry,
)

data class MessageBroadcast(
    val type: String,
    val message: ServerMessageEntry,
    val fromConnectionId: String? = null,
)

data class MetadataBroadcast(
    val type: String,
    val metadata: SessionRoomMetadata,
    val fromConnectionId: String? = null,
)

data class SessionRoomMetadata(
    val title: String? = null,
    val provider: String? = null,
    val model: String? = null,
    val mode: String? = null,
    val isExecuting: Boolean? = null,
    val createdAt: Long? = null,
    val updatedAt: Long? = null,
    val encryptedProjectId: String? = null,
    val projectIdIv: String? = null,
    val encryptedClientMetadata: String? = null,
    val clientMetadataIv: String? = null,
)
