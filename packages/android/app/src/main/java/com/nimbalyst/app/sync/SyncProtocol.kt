package com.nimbalyst.app.sync

import com.google.gson.Gson
import com.google.gson.JsonDeserializationContext
import com.google.gson.JsonDeserializer
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParseException
import com.google.gson.annotations.JsonAdapter
import java.lang.reflect.Type

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

data class ContextInfo(
    val tokens: Long,
    val contextWindow: Long,
)

data class ContextMeterIdentityV1(
    val nimbalystSessionId: String,
    val providerId: String,
    val persistedModelId: String,
    val providerModelId: String? = null,
    val catalogEntryId: String? = null,
    val interfaceId: String? = null,
    val upstreamThreadId: String,
    val producerRole: String,
)

data class ContextMeterOrderV1(
    val processInstanceId: String,
    val lifecycleGeneration: Long,
    val sequence: Long,
    val turnId: String? = null,
    val observedAtMs: Long,
)

data class ContextMeterProvenanceV1(
    val identity: ContextMeterIdentityV1,
    val order: ContextMeterOrderV1,
    val adapterId: String,
    val windowPolicy: String,
    val numeratorSource: String,
    val denominatorSource: String,
    val runtimeWindowTokens: Long? = null,
    val contextWindowSeedTokens: Long? = null,
    val acceptedAtMs: Long,
    val lastFreshObservationAtMs: Long? = null,
    val invalidationReason: String? = null,
)

data class ContextMeterStateV1(
    val schemaVersion: Int,
    val confidence: String,
    val fillTokens: Long? = null,
    val effectiveWindowTokens: Long? = null,
    val reason: String? = null,
    val provenance: ContextMeterProvenanceV1? = null,
) {
    fun isValid(): Boolean = runCatching {
        if (schemaVersion != 1 || confidence !in VALID_CONFIDENCE) return@runCatching false
        if (confidence == "unavailable") {
            return@runCatching reason != null && reason in UNAVAILABLE_REASONS &&
                (provenance == null || isValidProvenance(provenance))
        }
        val p = provenance ?: return@runCatching false
        val fill = fillTokens ?: return@runCatching false
        val window = effectiveWindowTokens ?: return@runCatching false
        if (fill !in 0L..MAX_SAFE_INTEGER || window !in 1L..MAX_SAFE_INTEGER || fill > window ||
            !isValidProvenance(p) || p.denominatorSource == "none"
        ) {
            return@runCatching false
        }
        if (confidence == "estimated") {
            return@runCatching p.denominatorSource == "immutable-model-seed" &&
                p.contextWindowSeedTokens == window
        }
        if (p.denominatorSource == "immutable-model-seed") {
            return@runCatching confidence == "stale" && p.contextWindowSeedTokens == window
        }
        p.runtimeWindowTokens == window
    }.getOrDefault(false)

    companion object {
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        private const val MAX_CONTEXT_WINDOW_SEED_TOKENS = 2_000_000L

        private fun String?.isValidOptionalIdentityField(): Boolean =
            this == null || this.isNotBlank()

        private fun isValidProvenance(provenance: ContextMeterProvenanceV1): Boolean =
            provenance.run {
                identity.producerRole == "lead" &&
                    identity.nimbalystSessionId.isNotBlank() &&
                    identity.providerId.isNotBlank() &&
                    identity.persistedModelId.isNotBlank() &&
                    identity.providerModelId.isValidOptionalIdentityField() &&
                    identity.catalogEntryId.isValidOptionalIdentityField() &&
                    identity.interfaceId.isValidOptionalIdentityField() &&
                    identity.upstreamThreadId.isNotBlank() &&
                    order.processInstanceId.isNotBlank() &&
                    order.lifecycleGeneration in 0L..MAX_SAFE_INTEGER &&
                    order.sequence in 1L..MAX_SAFE_INTEGER &&
                    order.turnId.isValidOptionalIdentityField() &&
                    order.observedAtMs in 0L..MAX_SAFE_INTEGER &&
                    adapterId in ADAPTER_IDS &&
                    windowPolicy in WINDOW_POLICIES &&
                    numeratorSource == "runtime-observation" &&
                    denominatorSource in DENOMINATOR_SOURCES &&
                    (runtimeWindowTokens == null ||
                        runtimeWindowTokens in 1L..MAX_SAFE_INTEGER) &&
                    (contextWindowSeedTokens == null ||
                        contextWindowSeedTokens in 1L..MAX_CONTEXT_WINDOW_SEED_TOKENS) &&
                    acceptedAtMs in 0L..MAX_SAFE_INTEGER &&
                    (lastFreshObservationAtMs == null ||
                        lastFreshObservationAtMs in 0L..MAX_SAFE_INTEGER) &&
                    (invalidationReason == null || invalidationReason in INVALIDATION_REASONS)
            }

        private val VALID_CONFIDENCE = setOf("exact", "estimated", "stale", "unavailable")
        private val ADAPTER_IDS = setOf(
            "claude-agent-sdk-parent-v1",
            "codex-sdk-token-count-v1",
            "codex-app-server-thread-usage-v1",
        )
        private val WINDOW_POLICIES = setOf("runtime-required", "runtime-then-model-seed")
        private val DENOMINATOR_SOURCES = setOf(
            "runtime-observation",
            "prior-runtime-observation",
            "immutable-model-seed",
            "none",
        )
        private val INVALIDATION_REASONS = setOf(
            "compacted",
            "thread-reset",
            "model-changed",
            "route-changed",
            "interface-changed",
            "restart-mismatch",
        )
        private val UNAVAILABLE_REASONS = setOf(
            "no-observation",
            "adapter-unavailable",
            "runtime-window-required",
            "seed-conflict",
            "malformed-observation",
            "identity-invalidated",
            "legacy-unverifiable",
            "turn-missing-observation",
            "compacted",
            "thread-reset",
            "model-changed",
            "route-changed",
            "interface-changed",
            "restart-mismatch",
        )
    }
}

data class ClientMetadata(
    val currentContext: ContextInfo? = null,
    @field:JsonAdapter(ContextMeterStateV1Deserializer::class)
    val contextMeterState: ContextMeterStateV1? = null,
    val hasPendingPrompt: Boolean? = null,
    val phase: String? = null,
    val tags: List<String>? = null,
    val draftInput: String? = null,
    val draftUpdatedAt: Long? = null,
)

/**
 * Enforces key-presence semantics at the reflected [ClientMetadata.contextMeterState] field.
 * Bare Gson reaches this adapter while reflecting the nullable Kotlin property, keeping the
 * key-presence check on the same field path used by the production decrypted metadata boundary.
 */
class ContextMeterStateV1Deserializer : JsonDeserializer<ContextMeterStateV1> {
    override fun deserialize(
        json: JsonElement,
        typeOfT: Type,
        context: JsonDeserializationContext,
    ): ContextMeterStateV1 {
        validateContextMeterStateKeyPresence(json)
        return context.deserialize(json, ContextMeterStateV1::class.java)
    }
}

private fun validateContextMeterStateKeyPresence(stateElement: JsonElement) {
    if (stateElement.isJsonNull || !stateElement.isJsonObject) return
    val state = stateElement.asJsonObject
    state.rejectExplicitNull("provenance", "contextMeterState.provenance")
    val provenanceElement = state.get("provenance") ?: return
    if (!provenanceElement.isJsonObject) return
    val provenance = provenanceElement.asJsonObject
    provenance.rejectExplicitNull(
        "runtimeWindowTokens",
        "contextMeterState.provenance.runtimeWindowTokens",
    )
    provenance.rejectExplicitNull(
        "contextWindowSeedTokens",
        "contextMeterState.provenance.contextWindowSeedTokens",
    )
    provenance.rejectExplicitNull(
        "lastFreshObservationAtMs",
        "contextMeterState.provenance.lastFreshObservationAtMs",
    )
    provenance.rejectExplicitNull(
        "invalidationReason",
        "contextMeterState.provenance.invalidationReason",
    )

    val identityElement = provenance.get("identity")
    if (identityElement != null && identityElement.isJsonObject) {
        val identity = identityElement.asJsonObject
        identity.rejectExplicitNull(
            "providerModelId",
            "contextMeterState.provenance.identity.providerModelId",
        )
        identity.rejectExplicitNull(
            "catalogEntryId",
            "contextMeterState.provenance.identity.catalogEntryId",
        )
        identity.rejectExplicitNull(
            "interfaceId",
            "contextMeterState.provenance.identity.interfaceId",
        )
    }

    val orderElement = provenance.get("order")
    if (orderElement != null && orderElement.isJsonObject) {
        orderElement.asJsonObject.rejectExplicitNull(
            "turnId",
            "contextMeterState.provenance.order.turnId",
        )
    }
}

private fun JsonObject.rejectExplicitNull(key: String, path: String) {
    if (has(key) && get(key).isJsonNull) {
        throw JsonParseException("$path must be omitted, not null")
    }
}

data class ResolvedContextMeterMetadata(
    val stateJson: String?,
    val tokens: Long?,
    val window: Long?,
)

fun resolveContextMeterMetadata(
    metadata: ClientMetadata?,
    existingStateJson: String?,
    existingTokens: Long?,
    existingWindow: Long?,
): ResolvedContextMeterMetadata {
    val state = metadata?.contextMeterState
    if (state != null) {
        if (!state.isValid()) {
            return ResolvedContextMeterMetadata(existingStateJson, existingTokens, existingWindow)
        }
        val stateJson = Gson().toJson(state)
        if (state.confidence == "unavailable") {
            return ResolvedContextMeterMetadata(stateJson, null, null)
        }
        return ResolvedContextMeterMetadata(stateJson, state.fillTokens, state.effectiveWindowTokens)
    }
    if (existingStateJson != null) {
        return ResolvedContextMeterMetadata(existingStateJson, existingTokens, existingWindow)
    }
    return ResolvedContextMeterMetadata(
        null,
        metadata?.currentContext?.tokens ?: existingTokens,
        metadata?.currentContext?.contextWindow ?: existingWindow,
    )
}

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
    val version: Int,
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
