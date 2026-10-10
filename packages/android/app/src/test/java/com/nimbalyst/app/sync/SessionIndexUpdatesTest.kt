package com.nimbalyst.app.sync

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.SessionEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Outbound index updates, and the inbound merge they must round-trip through. */
class SessionIndexUpdatesTest {
    private val gson = Gson()
    private val crypto = CryptoManager.fromSeed("test-seed", "user-1")
    private val updates = SessionIndexUpdates(gson)
    private val session = SessionEntity(
        id = "s1",
        projectId = "/work/app",
        titleEncrypted = "enc-title",
        titleIv = "title-iv",
        phase = "implementing",
        tagsJson = """["android"]""",
        isExecuting = false,
        createdAt = 1L,
        updatedAt = 2L,
        lastReadAt = 900L
    )

    private fun entryOf(json: String): JsonObject = JsonParser.parseString(json).asJsonObject.getAsJsonObject("session")

    @Test
    fun `canonical null hierarchy clears cached edges while omitted patches preserve them`() {
        val cached = session.copy(parentSessionId = "optimistic-parent", createdBySessionId = "old-manager")
        val payload = gson.toJsonTree(ServerSessionEntry(sessionId = session.id,
            encryptedProjectId = crypto.encryptProjectId(session.projectId),
            projectIdIv = CryptoManager.projectIdIvBase64, createdAt = 1, updatedAt = 3)).asJsonObject
        val decoder = SessionEntryDecoder(gson)
        val omitted = decoder.decodeSession(gson.fromJson(payload, ServerSessionEntry::class.java), crypto, existing = cached)!!.session
        assertEquals("optimistic-parent", omitted.parentSessionId)
        assertEquals("old-manager", omitted.createdBySessionId)
        payload.add("parentSessionId", com.google.gson.JsonNull.INSTANCE)
        payload.add("createdBySessionId", com.google.gson.JsonNull.INSTANCE)
        val decoded = gson.fromJson(payload, ServerSessionEntry::class.java)
        val detached = decoder.decodeSession(decoded, crypto, existing = cached)!!.session
        assertNull(detached.parentSessionId)
        assertNull(detached.createdBySessionId)
        val encoded = gson.toJsonTree(decoded).asJsonObject
        assertTrue(encoded.get("parentSessionId")?.isJsonNull == true)
        assertTrue(encoded.get("createdBySessionId")?.isJsonNull == true)
        assertFalse(encoded.has("parentSessionIdPresent"))
        assertFalse(encoded.has("createdBySessionIdPresent"))
    }

    @Test
    fun `parent moves include explicit null for clears but never assign a manager`() {
        val cached = session.copy(parentSessionId = "old-parent", createdBySessionId = "desktop-manager")
        val moved = entryOf(updates.parent(cached, "new-parent", crypto))
        assertEquals("new-parent", moved.get("parentSessionId").asString)
        assertFalse(moved.has("createdBySessionId"))
        val cleared = entryOf(updates.parent(cached, null, crypto))
        assertTrue(cleared.has("parentSessionId"))
        assertTrue(cleared.get("parentSessionId")?.isJsonNull == true)
        assertFalse(cleared.has("createdBySessionId"))
    }

    @Test
    fun `a prompt never sends the phone's cached execution state`() {
        val prompt = EncryptedQueuedPrompt(id = "p1", encryptedPrompt = "e", iv = "i", timestamp = 10L, source = "keyboard")

        val entry = entryOf(updates.prompt(session, prompt, crypto = crypto))

        // A stale false here stops the spinner on every other device mid-turn.
        assertFalse(entry.has("isExecuting"))
        assertEquals(1, entry.get("queuedPromptCount").asInt)
    }

    @Test
    fun `a draft push keeps the desktop's client metadata fields`() {
        val desktopBlob = JsonObject().apply {
            add("currentContext", JsonObject().apply {
                addProperty("tokens", 1200)
                addProperty("contextWindow", 200000)
            })
            addProperty("hasPendingPrompt", true)
            addProperty("hasBeenNamed", true)
            addProperty("phase", "planning")
            addProperty("draftInput", "old draft")
            addProperty("draftUpdatedAt", 5L)
        }

        val update = updates.draft(
            session = session,
            draft = "new draft",
            draftUpdatedAt = 20L,
            remoteClientMetadata = desktopBlob,
            crypto = crypto
        )
        val entry = JsonParser.parseString(update.json).asJsonObject.getAsJsonObject("patch")
        val sent = JsonParser.parseString(
            crypto.decrypt(entry.get("encryptedClientMetadata").asString, entry.get("clientMetadataIv").asString)
        ).asJsonObject

        assertEquals(1200, sent.getAsJsonObject("currentContext").get("tokens").asInt)
        assertTrue(sent.get("hasPendingPrompt").asBoolean)
        assertTrue(sent.get("hasBeenNamed").asBoolean)
        assertEquals("planning", sent.get("phase").asString)
        assertEquals("new draft", sent.get("draftInput").asString)
        assertEquals(20L, sent.get("draftUpdatedAt").asLong)
        assertFalse(entry.has("isExecuting"))
    }

    @Test
    fun `an index entry with an older read marker does not bring the unread dot back`() {
        val decoder = SessionEntryDecoder(gson)
        val entry = ServerSessionEntry(
            sessionId = "s1",
            encryptedProjectId = crypto.encryptProjectId("/work/app"),
            projectIdIv = CryptoManager.projectIdIvBase64,
            createdAt = 1L,
            updatedAt = 3L,
            lastReadAt = 100L
        )

        val merged = decoder.decodeSession(entry, crypto, existing = session)!!.session

        assertEquals(900L, merged.lastReadAt)
        assertNull(decoder.decodeSession(entry.copy(lastReadAt = null), crypto, existing = null)!!.session.lastReadAt)
    }

    /**
     * The server's indexUpdate overwrites title, provider, model, mode and
     * timestamps unconditionally (collabv3 IndexRoom.handleIndexUpdate), so a
     * read marker or draft sent that way puts the phone's stale copy back over
     * a newer server row. indexClientMetadataPatch touches only last_read_at
     * (max) and the metadata blob.
     */
    @Test
    fun `read receipts and drafts are metadata patches that cannot overwrite a newer server row`() {
        fun patchOf(json: String): JsonObject {
            val message = JsonParser.parseString(json).asJsonObject
            assertEquals("indexClientMetadataPatch", message.get("type").asString)
            return message.getAsJsonObject("patch")
        }

        val receipt = patchOf(updates.readReceipt(session, lastReadAt = 1_000L))
        assertEquals(setOf("sessionId", "lastReadAt"), receipt.keySet())
        assertEquals(1_000L, receipt.get("lastReadAt").asLong)

        val draft = patchOf(
            updates.draft(
                session = session,
                draft = "text",
                draftUpdatedAt = 20L,
                remoteClientMetadata = JsonObject(),
                crypto = crypto
            ).json
        )
        assertEquals(setOf("sessionId", "encryptedClientMetadata", "clientMetadataIv"), draft.keySet())
    }

    @Test
    fun `a prompt leaves the server's message count alone`() {
        val prompt = EncryptedQueuedPrompt(id = "p1", encryptedPrompt = "e", iv = "i", timestamp = 10L)
        // The phone may not have synced the transcript; its count would lower the server's.
        assertFalse(entryOf(updates.prompt(session, prompt, crypto = crypto)).has("messageCount"))
    }
}
