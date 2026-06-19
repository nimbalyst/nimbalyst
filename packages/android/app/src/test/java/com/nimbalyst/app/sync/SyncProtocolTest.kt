package com.nimbalyst.app.sync

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Gson round-trip tests for every wire message/data type in [SyncProtocol].
 *
 * These types are serialized/deserialized with Gson reflection. Release-mode
 * minification keep-rules protect the field names from being renamed; these
 * tests guard the actual wire contract: every Kotlin field maps to a
 * camelCase JSON key, the values survive a serialize -> deserialize round
 * trip, and the tagged-union `type` discriminators carry their expected
 * literal values.
 *
 * The app uses a bare `Gson()` (see SyncManager.kt: `private val gson = Gson()`),
 * with no custom GsonBuilder, no FieldNamingPolicy, and no @SerializedName
 * annotations anywhere in SyncProtocol.kt. We therefore use the same bare
 * `Gson()` here so the test exercises the exact configuration the app ships.
 */
class SyncProtocolTest {

    private val gson = Gson()

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private fun serializedKeys(any: Any): Set<String> {
        val json = JsonParser.parseString(gson.toJson(any)).asJsonObject
        return json.keySet()
    }

    /** Asserts that serializing [any] produces exactly [expectedKeys] (camelCase wire keys). */
    private fun assertKeys(any: Any, vararg expectedKeys: String) {
        val actual = serializedKeys(any)
        assertEquals(
            "Serialized JSON keys for ${any::class.simpleName}",
            expectedKeys.toSortedSet(),
            actual.toSortedSet()
        )
    }

    /** Round-trips [original] through Gson and asserts deep equality. */
    private inline fun <reified T : Any> assertRoundTrip(original: T): T {
        val json = gson.toJson(original)
        val restored = gson.fromJson(json, T::class.java)
        assertEquals(original, restored)
        return restored
    }

    private fun sampleJsonObject(): JsonObject = JsonObject().apply {
        addProperty("k", "v")
        addProperty("n", 42)
        addProperty("b", true)
    }

    // ---------------------------------------------------------------------
    // ServerMessageEnvelope (the discriminator-only peek type)
    // ---------------------------------------------------------------------

    @Test
    fun `ServerMessageEnvelope round-trip and keys`() {
        val msg = ServerMessageEnvelope(type = "indexUpdate")
        assertRoundTrip(msg)
        assertKeys(msg, "type")
        assertEquals(
            "indexUpdate",
            JsonParser.parseString(gson.toJson(msg)).asJsonObject.get("type").asString
        )
    }

    // ---------------------------------------------------------------------
    // Outbound requests with tagged-union `type` discriminators
    // ---------------------------------------------------------------------

    @Test
    fun `IndexSyncRequest carries default type discriminator and round-trips`() {
        val msg = IndexSyncRequest(projectId = "proj-1")
        val restored = assertRoundTrip(msg)
        assertEquals("indexSyncRequest", restored.type)
        assertKeys(msg, "type", "projectId")
        assertEquals(
            "indexSyncRequest",
            JsonParser.parseString(gson.toJson(msg)).asJsonObject.get("type").asString
        )
    }

    @Test
    fun `IndexSyncRequest with null projectId omits the key`() {
        val msg = IndexSyncRequest()
        assertRoundTrip(msg)
        // null projectId is omitted by default Gson
        assertKeys(msg, "type")
    }

    @Test
    fun `SessionSyncRequest carries default type discriminator and round-trips`() {
        val msg = SessionSyncRequest(sinceSeq = 7)
        val restored = assertRoundTrip(msg)
        assertEquals("syncRequest", restored.type)
        assertKeys(msg, "type", "sinceSeq")
    }

    @Test
    fun `RegisterPushTokenMessage round-trip and keys`() {
        val msg = RegisterPushTokenMessage(
            token = "fcm-token",
            platform = "android",
            deviceId = "device-1"
        )
        val restored = assertRoundTrip(msg)
        assertEquals("registerPushToken", restored.type)
        assertEquals("production", restored.environment)
        assertKeys(msg, "type", "token", "platform", "deviceId", "environment")
    }

    @Test
    fun `AppendMessageRequest round-trip and keys`() {
        val msg = AppendMessageRequest(message = sampleServerMessageEntry())
        val restored = assertRoundTrip(msg)
        assertEquals("appendMessage", restored.type)
        assertKeys(msg, "type", "message")
    }

    @Test
    fun `CreateSessionRequestMessage round-trip and keys`() {
        val msg = CreateSessionRequestMessage(request = sampleEncryptedCreateSessionRequest())
        val restored = assertRoundTrip(msg)
        assertEquals("createSessionRequest", restored.type)
        assertKeys(msg, "type", "request")
    }

    @Test
    fun `IndexUpdateMessage round-trip and keys`() {
        val msg = IndexUpdateMessage(session = sampleIndexUpdateEntry())
        val restored = assertRoundTrip(msg)
        assertEquals("indexUpdate", restored.type)
        assertKeys(msg, "type", "session")
    }

    @Test
    fun `SessionControlMessage round-trip and keys`() {
        val msg = SessionControlMessage(message = sampleSessionControlPayload())
        val restored = assertRoundTrip(msg)
        assertEquals("sessionControl", restored.type)
        assertKeys(msg, "type", "message")
    }

    // ---------------------------------------------------------------------
    // Nested payload / entry data classes
    // ---------------------------------------------------------------------

    @Test
    fun `EncryptedCreateSessionRequest round-trip with all fields populated`() {
        val msg = sampleEncryptedCreateSessionRequest()
        assertRoundTrip(msg)
        assertKeys(
            msg,
            "requestId", "encryptedProjectId", "projectIdIv", "encryptedInitialPrompt",
            "initialPromptIv", "sessionType", "parentSessionId", "provider", "model",
            "timestamp"
        )
    }

    @Test
    fun `IndexUpdateEntry round-trip with all fields populated`() {
        val msg = sampleIndexUpdateEntry()
        assertRoundTrip(msg)
        assertKeys(
            msg,
            "sessionId", "encryptedProjectId", "projectIdIv", "encryptedTitle", "titleIv",
            "provider", "model", "mode", "messageCount", "lastMessageAt", "createdAt",
            "updatedAt", "isExecuting", "queuedPromptCount", "encryptedQueuedPrompts",
            "encryptedClientMetadata", "clientMetadataIv"
        )
    }

    @Test
    fun `EncryptedQueuedPrompt round-trip with all fields populated`() {
        val msg = sampleEncryptedQueuedPrompt()
        assertRoundTrip(msg)
        assertKeys(
            msg,
            "id", "encryptedPrompt", "iv", "timestamp", "source", "encryptedAttachments"
        )
    }

    @Test
    fun `WireEncryptedAttachment round-trip with all fields populated`() {
        val msg = sampleWireEncryptedAttachment()
        assertRoundTrip(msg)
        assertKeys(
            msg,
            "id", "filename", "mimeType", "encryptedData", "iv", "size", "width", "height"
        )
    }

    @Test
    fun `SessionControlPayload round-trip with JsonObject payload`() {
        val msg = sampleSessionControlPayload()
        val restored = assertRoundTrip(msg)
        assertEquals(sampleJsonObject(), restored.payload)
        assertEquals("mobile", restored.sentBy)
        assertKeys(msg, "sessionId", "messageType", "payload", "timestamp", "sentBy")
    }

    // ---------------------------------------------------------------------
    // Index sync responses / broadcasts
    // ---------------------------------------------------------------------

    @Test
    fun `IndexSyncResponse round-trip with all fields populated`() {
        val msg = IndexSyncResponse(
            type = "indexSyncResponse",
            sessions = listOf(sampleServerSessionEntry()),
            projects = listOf(sampleServerProjectEntry()),
            totalSessionCount = 5
        )
        assertRoundTrip(msg)
        assertKeys(msg, "type", "sessions", "projects", "totalSessionCount")
    }

    @Test
    fun `ServerProjectEntry round-trip with all fields populated`() {
        val msg = sampleServerProjectEntry()
        assertRoundTrip(msg)
        assertKeys(
            msg,
            "encryptedProjectId", "projectIdIv", "sessionCount", "lastActivityAt",
            "encryptedConfig", "configIv"
        )
    }

    @Test
    fun `ServerSessionEntry round-trip with all fields populated`() {
        val msg = sampleServerSessionEntry()
        assertRoundTrip(msg)
        assertKeys(
            msg,
            "sessionId", "encryptedProjectId", "projectIdIv", "encryptedTitle", "titleIv",
            "provider", "model", "mode", "sessionType", "parentSessionId", "worktreeId",
            "isArchived", "isPinned", "branchedFromSessionId", "branchPointMessageId",
            "branchedAt", "messageCount", "lastMessageAt", "createdAt", "updatedAt",
            "isExecuting", "queuedPromptCount", "encryptedQueuedPrompts", "hasPendingPrompt",
            "encryptedClientMetadata", "clientMetadataIv", "lastReadAt"
        )
    }

    @Test
    fun `ClientMetadata round-trip with all fields populated`() {
        val msg = ClientMetadata(
            currentContext = ContextInfo(tokens = 100, contextWindow = 200000),
            hasPendingPrompt = true,
            phase = "implementing",
            tags = listOf("android", "sync"),
            draftInput = "draft text",
            draftUpdatedAt = 1_700_000_000_000L
        )
        val restored = assertRoundTrip(msg)
        assertEquals(100, restored.currentContext?.tokens)
        assertKeys(
            msg,
            "currentContext", "hasPendingPrompt", "phase", "tags", "draftInput",
            "draftUpdatedAt"
        )
    }

    @Test
    fun `ContextInfo round-trip and keys`() {
        val msg = ContextInfo(tokens = 1234, contextWindow = 200000)
        assertRoundTrip(msg)
        assertKeys(msg, "tokens", "contextWindow")
    }

    @Test
    fun `IndexBroadcast round-trip with all fields populated`() {
        val msg = IndexBroadcast(
            type = "indexBroadcast",
            session = sampleServerSessionEntry(),
            fromConnectionId = "conn-1"
        )
        assertRoundTrip(msg)
        assertKeys(msg, "type", "session", "fromConnectionId")
    }

    @Test
    fun `IndexDeleteBroadcast round-trip with all fields populated`() {
        val msg = IndexDeleteBroadcast(
            type = "indexDeleteBroadcast",
            sessionId = "session-1",
            fromConnectionId = "conn-1"
        )
        assertRoundTrip(msg)
        assertKeys(msg, "type", "sessionId", "fromConnectionId")
    }

    @Test
    fun `ProjectBroadcast round-trip with all fields populated`() {
        val msg = ProjectBroadcast(
            type = "projectBroadcast",
            project = sampleServerProjectEntry(),
            fromConnectionId = "conn-1"
        )
        assertRoundTrip(msg)
        assertKeys(msg, "type", "project", "fromConnectionId")
    }

    @Test
    fun `CreateSessionResponseBroadcast round-trip with all fields populated`() {
        val msg = CreateSessionResponseBroadcast(
            type = "createSessionResponse",
            response = CreateSessionResponse(
                requestId = "req-1",
                success = true,
                sessionId = "session-1",
                error = null
            ),
            fromConnectionId = "conn-1"
        )
        assertRoundTrip(msg)
        assertKeys(msg, "type", "response", "fromConnectionId")
    }

    @Test
    fun `CreateSessionResponse round-trip with all fields populated`() {
        val msg = CreateSessionResponse(
            requestId = "req-1",
            success = false,
            sessionId = "session-1",
            error = "boom"
        )
        assertRoundTrip(msg)
        assertKeys(msg, "requestId", "success", "sessionId", "error")
    }

    // ---------------------------------------------------------------------
    // Settings sync
    // ---------------------------------------------------------------------

    @Test
    fun `EncryptedSettingsPayload round-trip and keys`() {
        val msg = sampleEncryptedSettingsPayload()
        assertRoundTrip(msg)
        assertKeys(msg, "encryptedSettings", "settingsIv", "deviceId", "timestamp", "version")
    }

    @Test
    fun `SettingsSyncBroadcast round-trip with all fields populated`() {
        val msg = SettingsSyncBroadcast(
            type = "settingsSync",
            settings = sampleEncryptedSettingsPayload(),
            fromConnectionId = "conn-1"
        )
        assertRoundTrip(msg)
        assertKeys(msg, "type", "settings", "fromConnectionId")
    }

    @Test
    fun `SyncedSettings round-trip with all fields populated`() {
        val msg = SyncedSettings(
            openaiApiKey = "sk-xxx",
            availableModels = listOf(
                SyncedAvailableModel(id = "gpt-4", name = "GPT-4", provider = "openai")
            ),
            defaultModel = "gpt-4",
            version = 3
        )
        assertRoundTrip(msg)
        assertKeys(msg, "openaiApiKey", "availableModels", "defaultModel", "version")
    }

    @Test
    fun `SyncedAvailableModel round-trip and keys`() {
        val msg = SyncedAvailableModel(id = "claude-sonnet-4", name = "Sonnet", provider = "anthropic")
        assertRoundTrip(msg)
        assertKeys(msg, "id", "name", "provider")
    }

    // ---------------------------------------------------------------------
    // Device presence
    // ---------------------------------------------------------------------

    @Test
    fun `DevicesListMessage round-trip and keys`() {
        val msg = DevicesListMessage(devices = listOf(sampleDeviceInfo()))
        assertRoundTrip(msg)
        assertKeys(msg, "devices")
    }

    @Test
    fun `DeviceJoinedMessage round-trip and keys`() {
        val msg = DeviceJoinedMessage(device = sampleDeviceInfo())
        assertRoundTrip(msg)
        assertKeys(msg, "device")
    }

    @Test
    fun `DeviceLeftMessage round-trip and keys`() {
        val msg = DeviceLeftMessage(deviceId = "device-1")
        assertRoundTrip(msg)
        assertKeys(msg, "deviceId")
    }

    @Test
    fun `DeviceInfo round-trip with all fields populated`() {
        val msg = sampleDeviceInfo()
        assertRoundTrip(msg)
        assertKeys(
            msg,
            "deviceId", "name", "type", "platform", "appVersion", "connectedAt",
            "lastActiveAt", "isFocused", "status"
        )
    }

    // ---------------------------------------------------------------------
    // Server errors
    // ---------------------------------------------------------------------

    @Test
    fun `ServerErrorMessage round-trip and keys`() {
        val msg = ServerErrorMessage(type = "error", code = "UNAUTHORIZED", message = "nope")
        assertRoundTrip(msg)
        assertKeys(msg, "type", "code", "message")
    }

    // ---------------------------------------------------------------------
    // Session message sync responses / broadcasts
    // ---------------------------------------------------------------------

    @Test
    fun `SessionSyncResponse round-trip with all fields populated`() {
        val msg = SessionSyncResponse(
            type = "syncResponse",
            messages = listOf(sampleServerMessageEntry()),
            metadata = sampleSessionRoomMetadata(),
            hasMore = true,
            cursor = "cursor-1"
        )
        assertRoundTrip(msg)
        assertKeys(msg, "type", "messages", "metadata", "hasMore", "cursor")
    }

    @Test
    fun `ServerMessageEntry round-trip with JsonObject metadata`() {
        val msg = sampleServerMessageEntry()
        val restored = assertRoundTrip(msg)
        assertEquals(sampleJsonObject(), restored.metadata)
        assertKeys(
            msg,
            "id", "sequence", "createdAt", "source", "direction", "encryptedContent",
            "iv", "metadata"
        )
    }

    @Test
    fun `MessageBroadcast round-trip with all fields populated`() {
        val msg = MessageBroadcast(
            type = "messageBroadcast",
            message = sampleServerMessageEntry(),
            fromConnectionId = "conn-1"
        )
        assertRoundTrip(msg)
        assertKeys(msg, "type", "message", "fromConnectionId")
    }

    @Test
    fun `MetadataBroadcast round-trip with all fields populated`() {
        val msg = MetadataBroadcast(
            type = "metadataBroadcast",
            metadata = sampleSessionRoomMetadata(),
            fromConnectionId = "conn-1"
        )
        assertRoundTrip(msg)
        assertKeys(msg, "type", "metadata", "fromConnectionId")
    }

    @Test
    fun `SessionRoomMetadata round-trip with all fields populated`() {
        val msg = sampleSessionRoomMetadata()
        assertRoundTrip(msg)
        assertKeys(
            msg,
            "title", "provider", "model", "mode", "isExecuting", "createdAt", "updatedAt",
            "encryptedProjectId", "projectIdIv", "encryptedClientMetadata", "clientMetadataIv"
        )
    }

    // ---------------------------------------------------------------------
    // Nested-collection survival: queued prompts + attachments through a
    // full IndexUpdateEntry round-trip.
    // ---------------------------------------------------------------------

    @Test
    fun `nested encrypted queued prompts and attachments survive round-trip`() {
        val entry = sampleIndexUpdateEntry()
        val restored = assertRoundTrip(entry)
        val prompt = restored.encryptedQueuedPrompts!!.single()
        assertEquals("queued-1", prompt.id)
        val attachment = prompt.encryptedAttachments!!.single()
        assertEquals("attach-1", attachment.id)
        assertEquals(2048, attachment.size)
        assertTrue(attachment.width == 800 && attachment.height == 600)
    }

    // ---------------------------------------------------------------------
    // Sample factories (all fields populated so camelCase-key assertions
    // observe every wire key — default Gson omits null fields).
    // ---------------------------------------------------------------------

    private fun sampleWireEncryptedAttachment() = WireEncryptedAttachment(
        id = "attach-1",
        filename = "image.png",
        mimeType = "image/png",
        encryptedData = "ZW5jcnlwdGVk",
        iv = "aXY=",
        size = 2048,
        width = 800,
        height = 600
    )

    private fun sampleEncryptedQueuedPrompt() = EncryptedQueuedPrompt(
        id = "queued-1",
        encryptedPrompt = "ZW5jcnlwdGVkUHJvbXB0",
        iv = "aXY=",
        timestamp = 1_700_000_000_000L,
        source = "mobile",
        encryptedAttachments = listOf(sampleWireEncryptedAttachment())
    )

    private fun sampleEncryptedCreateSessionRequest() = EncryptedCreateSessionRequest(
        requestId = "req-1",
        encryptedProjectId = "ZW5jUHJvag==",
        projectIdIv = "aXY=",
        encryptedInitialPrompt = "ZW5jUHJvbXB0",
        initialPromptIv = "aXYy",
        sessionType = "worktree",
        parentSessionId = "parent-1",
        provider = "claude-code",
        model = "claude-sonnet-4",
        timestamp = 1_700_000_000_000L
    )

    private fun sampleIndexUpdateEntry() = IndexUpdateEntry(
        sessionId = "session-1",
        encryptedProjectId = "ZW5jUHJvag==",
        projectIdIv = "aXY=",
        encryptedTitle = "ZW5jVGl0bGU=",
        titleIv = "aXYy",
        provider = "claude-code",
        model = "claude-sonnet-4",
        mode = "agent",
        messageCount = 12,
        lastMessageAt = 1_700_000_000_000L,
        createdAt = 1_699_000_000_000L,
        updatedAt = 1_700_000_500_000L,
        isExecuting = true,
        queuedPromptCount = 1,
        encryptedQueuedPrompts = listOf(sampleEncryptedQueuedPrompt()),
        encryptedClientMetadata = "ZW5jTWV0YQ==",
        clientMetadataIv = "aXYz"
    )

    private fun sampleSessionControlPayload() = SessionControlPayload(
        sessionId = "session-1",
        messageType = "interrupt",
        payload = sampleJsonObject(),
        timestamp = 1_700_000_000_000L,
        sentBy = "mobile"
    )

    private fun sampleServerProjectEntry() = ServerProjectEntry(
        encryptedProjectId = "ZW5jUHJvag==",
        projectIdIv = "aXY=",
        sessionCount = 4,
        lastActivityAt = 1_700_000_000_000L,
        encryptedConfig = "ZW5jQ29uZmln",
        configIv = "aXYy"
    )

    private fun sampleServerSessionEntry() = ServerSessionEntry(
        sessionId = "session-1",
        encryptedProjectId = "ZW5jUHJvag==",
        projectIdIv = "aXY=",
        encryptedTitle = "ZW5jVGl0bGU=",
        titleIv = "aXYy",
        provider = "claude-code",
        model = "claude-sonnet-4",
        mode = "agent",
        sessionType = "worktree",
        parentSessionId = "parent-1",
        worktreeId = "wt-1",
        isArchived = false,
        isPinned = true,
        branchedFromSessionId = "branch-src-1",
        branchPointMessageId = 5,
        branchedAt = 1_699_500_000_000L,
        messageCount = 12,
        lastMessageAt = 1_700_000_000_000L,
        createdAt = 1_699_000_000_000L,
        updatedAt = 1_700_000_500_000L,
        isExecuting = true,
        queuedPromptCount = 1,
        encryptedQueuedPrompts = listOf(sampleEncryptedQueuedPrompt()),
        hasPendingPrompt = true,
        encryptedClientMetadata = "ZW5jTWV0YQ==",
        clientMetadataIv = "aXYz",
        lastReadAt = 1_700_000_400_000L
    )

    private fun sampleEncryptedSettingsPayload() = EncryptedSettingsPayload(
        encryptedSettings = "ZW5jU2V0dGluZ3M=",
        settingsIv = "aXY=",
        deviceId = "device-1",
        timestamp = 1_700_000_000_000L,
        version = 2
    )

    private fun sampleDeviceInfo() = DeviceInfo(
        deviceId = "device-1",
        name = "Pixel 9",
        type = "mobile",
        platform = "android",
        appVersion = "1.2.3",
        connectedAt = 1_700_000_000_000L,
        lastActiveAt = 1_700_000_500_000L,
        isFocused = true,
        status = "active"
    )

    private fun sampleServerMessageEntry() = ServerMessageEntry(
        id = "msg-1",
        sequence = 7,
        createdAt = 1_700_000_000_000L,
        source = "claude-code",
        direction = "output",
        encryptedContent = "ZW5jQ29udGVudA==",
        iv = "aXY=",
        metadata = sampleJsonObject()
    )

    private fun sampleSessionRoomMetadata() = SessionRoomMetadata(
        title = "Sync roadmap",
        provider = "claude-code",
        model = "claude-sonnet-4",
        mode = "planning",
        isExecuting = false,
        createdAt = 1_699_000_000_000L,
        updatedAt = 1_700_000_500_000L,
        encryptedProjectId = "ZW5jUHJvag==",
        projectIdIv = "aXY=",
        encryptedClientMetadata = "ZW5jTWV0YQ==",
        clientMetadataIv = "aXYy"
    )
}
