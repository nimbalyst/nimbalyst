package com.nimbalyst.app.sync

import com.google.gson.JsonObject
import com.nimbalyst.app.data.PendingExecution

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
    /** Routes the request to one host. Absent means broadcast to every desktop. */
    val targetDeviceId: String? = null,
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
    // Null means "unchanged": the server keeps its own count (COALESCE). A
    // phone that has not synced a session's transcript must not send its
    // local count of zero.
    val messageCount: Int? = null,
    val lastMessageAt: Long,
    val createdAt: Long,
    val updatedAt: Long,
    // Execution state belongs to the desktop. Null (omitted) leaves it alone.
    val isExecuting: Boolean? = null,
    val queuedPromptCount: Int? = null,
    val encryptedQueuedPrompts: List<EncryptedQueuedPrompt>? = null,
    val encryptedClientMetadata: String? = null,
    val clientMetadataIv: String? = null,
    // The server only ever advances this (max), so a stale value is harmless.
    val lastReadAt: Long? = null,
    val sessionType: String? = null,
    val parentSessionId: String? = null,
    val worktreeId: String? = null,
    val hostDeviceId: String? = null,
    val agentRole: String? = null,
    val createdBySessionId: String? = null,
    val isArchived: Boolean? = null,
    val isPinned: Boolean? = null,
    val branchedFromSessionId: String? = null,
    val branchPointMessageId: Int? = null,
    val branchedAt: Long? = null,
    val pendingExecution: PendingExecution? = null,
    val hasPendingPrompt: Boolean? = null,
)

/**
 * Patches only a row's client-metadata blob, read marker or execution flag.
 * Unlike [IndexUpdateMessage], the server never touches title, model, mode or
 * timestamps for it, so a stale local row cannot overwrite a newer one.
 */
data class IndexClientMetadataPatchMessage(
    val type: String = "indexClientMetadataPatch",
    val patch: IndexClientMetadataPatch,
)

data class IndexClientMetadataPatch(
    val sessionId: String,
    val encryptedClientMetadata: String? = null,
    val clientMetadataIv: String? = null,
    val isExecuting: Boolean? = null,
    /** The server only ever advances this (max). */
    val lastReadAt: Long? = null,
)

data class DeviceAnnounceMessage(
    val type: String = "deviceAnnounce",
    val device: DeviceInfo,
)

data class EncryptedQueuedPrompt(
    val id: String,
    val encryptedPrompt: String,
    val iv: String,
    val timestamp: Long,
    val source: String? = null,
    var encryptedAttachments: List<WireEncryptedAttachment>? = null,
    /** Turn options the sender pinned for this prompt. */
    val options: RemoteTurnOptions? = null,
)

/** Per-turn options carried with a queued prompt. Every field is optional on the wire. */
data class RemoteTurnOptions(
    /** "agent" or "planning". */
    val mode: String? = null,
    val model: String? = null,
    /** Free-form, so a new level from a newer desktop still decodes. */
    val effortLevel: String? = null,
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
    val agentRole: String? = null,
    val timestamp: Long,
)

data class CreateWorktreeRequestMessage(
    val type: String = "createWorktreeRequest",
    val request: CreateWorktreeRequest,
    /** Routes the request to the project's host. Absent means broadcast. */
    val targetDeviceId: String? = null,
)

data class CreateWorktreeRequest(
    val requestId: String,
    val encryptedProjectId: String,
    val projectIdIv: String,
    val timestamp: Long,
)

data class CreateWorktreeResponseBroadcast(
    val type: String,
    val response: CreateWorktreeResponse,
    val fromConnectionId: String? = null,
)

data class CreateWorktreeResponse(
    val requestId: String,
    val success: Boolean,
    val error: String? = null,
)

data class SessionSyncRequest(
    val type: String = "syncRequest",
    val sinceSeq: Int? = null,
    /** Message id cursor; the server accepts either this or [sinceSeq]. */
    val sinceId: String? = null,
)

data class RegisterPushTokenMessage(
    val type: String = "registerPushToken",
    val token: String,
    val platform: String,
    val deviceId: String,
    // Matches the iOS wire contract (RegisterPushTokenMessage.environment); the
    // collab server routes push delivery by environment.
    val environment: String = "production",
)

data class UnregisterPushTokenMessage(
    val type: String = "unregisterPushToken",
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
    /** Stable id of this device, so the receiving host can filter its own echoes. */
    val sentByDeviceId: String? = null,
    /** The host that owns the session. Absent means broadcast to every desktop. */
    val targetDeviceId: String? = null,
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
    val encryptedName: String? = null,
    val nameIv: String? = null,
    val encryptedPath: String? = null,
    val pathIv: String? = null,
    val syncEnabled: Boolean? = null,
    val sessionCount: Int? = null,
    val lastActivityAt: Long? = null,
    val encryptedConfig: String? = null,
    val configIv: String? = null,
    /** SHA-256 of the git remote URL, used for project document sync routing. */
    val gitRemoteHash: String? = null,
)

/** Decrypted `encryptedConfig` of a project entry. */
data class ProjectConfig(
    val commands: List<SyncedSlashCommand>? = null,
    val lastCommandsUpdate: Long? = null,
    /** Absent on desktops that predate action sync. */
    val actions: List<SyncedActionPrompt>? = null,
    val lastActionsUpdate: Long? = null,
    /** Carried in the blob by the desktop; the entry's plaintext field is the one read. */
    val gitRemoteHash: String? = null,
    /** Absent when the project has no Local wiki or the desktop predates wiki sync. */
    val localWiki: LocalWikiConfig? = null,
)

/**
 * Where the project's Local wiki lives, relative to the project root, and the
 * wiki's type definitions (their YAML does not sync as files).
 */
data class LocalWikiConfig(
    val folder: String? = null,
    val types: List<SyncedWikiType>? = null,
)

/** A wiki type definition (`.nimbalyst/trackers/<type>.yaml` with `storage:`), as `loadTypeDefs` reads it. */
data class SyncedWikiType(
    val typeId: String,
    val displayName: String,
    val displayNamePlural: String,
    /** "pages" or "table". */
    val storage: String,
    /** Field holding the item title. */
    val titleField: String,
    val fields: List<SyncedWikiField> = emptyList(),
)

data class SyncedWikiField(
    val name: String,
    val type: String,
    val itemType: String? = null,
    val multiValue: Boolean? = null,
)

/**
 * `localWiki.types` re-serialized from the raw blob rather than from
 * [SyncedWikiType], so a field a newer desktop adds survives to the reader.
 */
fun rawLocalWikiTypes(configJson: String): String? = runCatching {
    com.google.gson.JsonParser.parseString(configJson).asJsonObject
        .getAsJsonObject("localWiki")?.get("types")
        ?.takeIf { it.isJsonArray }?.toString()
}.getOrNull()

/**
 * The wiki folder if it is a relative path inside the project: `/`-separated,
 * no trailing slash. Absolute paths and `..` segments are dropped rather than
 * trusted, since readers join the folder onto synced document paths.
 */
fun normalizeLocalWikiFolder(raw: String?): String? {
    val folder = raw?.trim()?.trimEnd('/') ?: return null
    if (folder.isEmpty() || folder.startsWith("/")) return null
    val segments = folder.split("/")
    if (segments.any { it.isEmpty() || it == "." || it == ".." }) return null
    return folder
}

data class SyncedSlashCommand(
    val name: String,
    val description: String? = null,
    /** "builtin" | "project" | "user" | "plugin" */
    val source: String? = null,
)

/**
 * An action prompt from the desktop workspace's ai-actions.md. Everything past
 * [body] is optional: same-session actions send none of it.
 */
data class SyncedActionPrompt(
    val id: String,
    val label: String,
    val body: String,
    val truncated: Boolean? = null,
    /** "new-session" for launcher actions. */
    val launch: String? = null,
    val model: String? = null,
    val autoSubmit: Boolean? = null,
    val worktree: Boolean? = null,
) {
    val launchesNewSession: Boolean get() = launch == "new-session"

    /** Worktree launches need a worktree first; shown but not offered as launchers. */
    val isSupportedOnMobile: Boolean get() = worktree != true
}

@com.google.gson.annotations.JsonAdapter(SessionHierarchyAdapter::class)
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
    /** Agent role marker, e.g. "meta-agent". */
    val agentRole: String? = null,
    /** The meta-agent session that spawned this one. */
    val createdBySessionId: String? = null,
    val worktreeId: String? = null,
    /** Stable id of the desktop or headless host that runs this session. */
    val hostDeviceId: String? = null,
    val isArchived: Boolean? = null,
    val isPinned: Boolean? = null,
    val branchedFromSessionId: String? = null,
    val branchPointMessageId: Int? = null,
    val branchedAt: Long? = null,
    val messageCount: Int? = null,
    val lastMessageAt: Long? = null,
    val createdAt: Long,
    val updatedAt: Long,
    /** A prompt accepted but not started. Transient: the server does not store it. */
    val pendingExecution: PendingExecution? = null,
    val isExecuting: Boolean? = null,
    val queuedPromptCount: Int? = null,
    val encryptedQueuedPrompts: List<EncryptedQueuedPrompt>? = null,
    val hasPendingPrompt: Boolean? = null,
    val encryptedClientMetadata: String? = null,
    val clientMetadataIv: String? = null,
    val lastReadAt: Long? = null,
) {
    // Local decode metadata, never serialized as wire fields. Declared in the
    // body so it stays out of equals/hashCode/copy.
    @Transient var parentSessionIdPresent: Boolean = false
    @Transient var createdBySessionIdPresent: Boolean = false
}

data class ClientMetadata(
    val currentContext: ContextInfo? = null,
    val hasPendingPrompt: Boolean? = null,
    val phase: String? = null,
    val tags: List<String>? = null,
    val draftInput: String? = null,
    val draftUpdatedAt: Long? = null,
    val hasBeenNamed: Boolean? = null,
)

data class ContextInfo(
    val tokens: Int,
    val contextWindow: Int,
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
    /** Desktop seeds this from Date.now(), so it exceeds Int range. */
    val version: Long,
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
    /** Whether the desktop meta-agent feature is on; gates the mobile Meta Agent UI. */
    val metaAgentEnabled: Boolean? = null,
    val version: Long,
)

data class SyncedAvailableModel(
    val id: String,
    val name: String,
    val provider: String,
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
    /** Server-set: false for a known installation that is not connected now. */
    val isOnline: Boolean? = null,
    /** Server-set: epoch ms the server last saw this device. */
    val lastSeenAt: Long? = null,
    /** Server-set: the user hid this installation from their device list. */
    val inventoryHidden: Boolean? = null,
)

data class ServerErrorMessage(
    val type: String,
    val code: String,
    val message: String,
    /** Echoed when the failure answers a specific request. */
    val requestId: String? = null,
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
    /** Legacy plaintext title; current servers send only [encryptedTitle]. */
    val title: String? = null,
    val encryptedTitle: String? = null,
    val titleIv: String? = null,
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
    /** The in-flight turn, when the room has one. Absent means unchanged. */
    val pendingExecution: PendingExecution? = null,
    /** Rides on metadata so a phone only in the session room still sees the queue change. */
    val encryptedQueuedPrompts: List<EncryptedQueuedPrompt>? = null,
)
