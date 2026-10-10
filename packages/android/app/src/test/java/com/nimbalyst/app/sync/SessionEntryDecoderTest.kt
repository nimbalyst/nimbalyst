package com.nimbalyst.app.sync

import com.google.gson.Gson
import com.google.gson.JsonParser
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.PendingExecution
import com.nimbalyst.app.data.SessionEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Field semantics for decoding inbound index entries, room metadata, and project config. */
class SessionEntryDecoderTest {
    private val gson = Gson()
    private val crypto = CryptoManager.fromSeed("seed", "user-1")
    private val decoder = SessionEntryDecoder(gson)

    private fun entryJson(extra: String = "") = """
        {"sessionId":"s1","encryptedProjectId":"${crypto.encryptProjectId("/p")}",
         "projectIdIv":"${CryptoManager.projectIdIvBase64}","createdAt":1,"updatedAt":2$extra}
    """.trimIndent()

    private fun decode(json: String, existing: SessionEntity? = null) =
        decoder.decodeSession(gson.fromJson(json, ServerSessionEntry::class.java), crypto, existing)!!.session

    @Test
    fun `hierarchy and host fields decode and survive an entry that omits them`() {
        val first = decode(
            entryJson(
                ""","agentRole":"meta-agent","createdBySessionId":"meta-1","hostDeviceId":"desk-1",
                   "pendingExecution":{"messageId":"m1","sentAt":5,"sentBy":"mobile"}"""
            )
        )
        assertEquals("meta-agent", first.agentRole)
        assertEquals("meta-1", first.createdBySessionId)
        assertEquals("desk-1", first.hostDeviceId)
        assertEquals(PendingExecution("m1", 5, "mobile"), first.pendingExecution)

        val second = decode(entryJson(), existing = first)
        assertEquals("meta-agent", second.agentRole)
        assertEquals("meta-1", second.createdBySessionId)
        assertEquals("desk-1", second.hostDeviceId)
        // The server never stores pendingExecution: an entry without it means none.
        assertNull(second.pendingExecution)
    }

    @Test
    fun `room metadata decrypts the encrypted title and keeps pending execution until the turn starts`() {
        val title = crypto.encrypt("Real title")
        val existing = decode(entryJson()).copy(pendingExecution = PendingExecution("m1", 5, "mobile"))

        fun metadata(json: String) = gson.fromJson(json, SessionRoomMetadata::class.java)

        val titled = decoder.mergeRoomMetadata(
            existing,
            metadata("""{"encryptedTitle":"${title.encrypted}","titleIv":"${title.iv}"}"""),
            crypto
        )
        assertEquals("Real title", titled.titleDecrypted)
        assertEquals(existing.pendingExecution, titled.pendingExecution)

        val started = decoder.mergeRoomMetadata(titled, metadata("""{"isExecuting":true}"""), crypto)
        assertNull(started.pendingExecution)
    }

    @Test
    fun `project config decodes commands and actions, and a project without config keeps neither`() {
        val config = crypto.encrypt(
            """{"commands":[{"name":"review","description":"Review","source":"project"}],"lastCommandsUpdate":1,
               "actions":[{"id":"ship","label":"Ship","body":"Ship it","launch":"new-session"}],"lastActionsUpdate":2}"""
        )
        val entry = """
            {"encryptedProjectId":"${crypto.encryptProjectId("/work/app")}","projectIdIv":"${CryptoManager.projectIdIvBase64}",
             "encryptedConfig":"${config.encrypted}","configIv":"${config.iv}","gitRemoteHash":"abc"}
        """.trimIndent()
        val project = decoder.decodeProject(gson.fromJson(entry, ServerProjectEntry::class.java), crypto)!!

        assertEquals("app", project.name)
        assertEquals("abc", project.gitRemoteHash)
        val commands = JsonParser.parseString(project.commandsJson).asJsonArray
        assertEquals("review", commands[0].asJsonObject["name"].asString)
        val actions = JsonParser.parseString(project.actionsJson).asJsonArray
        assertEquals("Ship it", actions[0].asJsonObject["body"].asString)

        val bare = decoder.decodeProject(
            gson.fromJson(
                """{"encryptedProjectId":"${crypto.encryptProjectId("/work/app")}","projectIdIv":"${CryptoManager.projectIdIvBase64}"}""",
                ServerProjectEntry::class.java
            ),
            crypto
        )!!
        // Null means "the entry said nothing": the repository keeps the stored config.
        assertNull(bare.commandsJson)
        assertNull(bare.actionsJson)
    }

    @Test
    fun `a draft echo is judged against the stored draft time, even after the decoder was reset`() {
        val blob = { draft: String, at: Long ->
            crypto.encrypt("""{"draftInput":"$draft","draftUpdatedAt":$at}""").let {
                ",\"encryptedClientMetadata\":\"${it.encrypted}\",\"clientMetadataIv\":\"${it.iv}\""
            }
        }
        // A fresh decoder: nothing in memory about this device's pushes.
        val existing = decode(entryJson()).copy(draftInput = "typing", draftUpdatedAt = 20)
        assertEquals("typing", decode(entryJson(blob("old", 20)), existing).draftInput)
        assertEquals("typing", decode(entryJson(blob("older", 10)), existing).draftInput)
        assertEquals("desktop", decode(entryJson(blob("desktop", 30)), existing).draftInput)
    }
}
