package com.nimbalyst.app.sync

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android side of the golden wire fixtures in
 * `packages/collab-protocol/fixtures`. Every fixture the manifest routes to or
 * from a mobile client must either decode into the Kotlin type Android uses
 * for it, or be listed in [NOT_ON_ANDROID] with the reason. Decoding is
 * checked by round trip: a fixture field that does not survive decode and
 * re-encode is a field Android does not model, and it fails here until the
 * type gains it or [IGNORED_PATHS] says why Android ignores it. So a field
 * added to a TypeScript type plus its fixture fails this test until Android
 * lands its half.
 */
class WireFixtureTest {
    private val gson = Gson()
    // Gradle runs unit tests from the module directory (packages/android/app).
    private val fixtures = File("../../collab-protocol/fixtures")

    private val kotlinTypes: Map<String, Class<*>> = mapOf(
        "indexUpdate.json" to IndexUpdateMessage::class.java,
        "indexClientMetadataPatch.desktop.json" to IndexClientMetadataPatchMessage::class.java,
        "clientMetadata.desktop.json" to ClientMetadata::class.java,
        "settingsPayload.desktop.json" to SyncedSettings::class.java,
        "projectConfig.desktop.json" to ProjectConfig::class.java,
        "settingsSyncBroadcast.desktop.json" to SettingsSyncBroadcast::class.java,
        "metadataBroadcast.server.json" to MetadataBroadcast::class.java,
        "createSessionRequest.json" to CreateSessionRequestMessage::class.java,
        "createSessionResponseBroadcast.json" to CreateSessionResponseBroadcast::class.java,
        "createWorktreeRequest.json" to CreateWorktreeRequestMessage::class.java,
        "createWorktreeResponseBroadcast.json" to CreateWorktreeResponseBroadcast::class.java,
        "sessionControl.mobile.json" to SessionControlMessage::class.java,
        "indexBroadcast.server.json" to IndexBroadcast::class.java,
        "indexPageRequest.json" to IndexPageRequest::class.java,
        "indexPageResponse.runtime.json" to IndexPageResponse::class.java,
        "indexPageResponse.protocol.json" to IndexPageResponse::class.java,
        "indexChange.runtime.session.json" to IndexChange::class.java,
        "indexChange.runtime.project.json" to IndexChange::class.java,
        "indexChange.runtime.file.json" to IndexChange::class.java,
        "indexChange.runtime.deleted.json" to IndexChange::class.java,
        "indexChange.protocol.session.json" to IndexChange::class.java,
        "indexChange.protocol.project.json" to IndexChange::class.java,
        "indexChange.protocol.file.json" to IndexChange::class.java,
        "indexChange.protocol.deleted.json" to IndexChange::class.java,
        "indexChangesAvailable.json" to IndexChangesAvailable::class.java,
        "projectBroadcast.json" to ProjectBroadcast::class.java,
        "indexSyncRequest.json" to IndexSyncRequest::class.java,
        "indexSyncResponse.json" to IndexSyncResponse::class.java,
        "indexDeleteBroadcast.json" to IndexDeleteBroadcast::class.java,
        "appendMessage.json" to AppendMessageRequest::class.java,
        "messageBroadcast.json" to MessageBroadcast::class.java,
        "syncRequest.json" to SessionSyncRequest::class.java,
        "syncResponse.json" to SessionSyncResponse::class.java,
        "deviceAnnounce.json" to DeviceAnnounceMessage::class.java,
        "devicesList.json" to DevicesListMessage::class.java,
        "deviceJoined.json" to DeviceJoinedMessage::class.java,
        "deviceLeft.json" to DeviceLeftMessage::class.java,
        "error.json" to ServerErrorMessage::class.java,
    )

    @Test
    fun `every mobile fixture decodes into its Android type without dropping fields`() {
        val manifest = JsonParser.parseString(File(fixtures, "index.json").readText()).asJsonObject
        val mobile = manifest.getAsJsonArray("fixtures").map { it.asJsonObject }
            .filter { it.get("direction").asString in MOBILE_DIRECTIONS }
            .map { it.get("file").asString }
            .toSortedSet()
        val failures = mutableListOf<String>()

        for (file in mobile) {
            if (file in NOT_ON_ANDROID) continue
            val type = kotlinTypes[file]
            if (type == null) {
                failures += "$file: no Android type and no NOT_ON_ANDROID reason"
                continue
            }
            val text = File(fixtures, file).readText()
            val fixture = JsonParser.parseString(text)
            // Decode the raw text, as the app does: the JsonElement path silently
            // truncates an out-of-range Int where the string path throws.
            val decoded = runCatching { gson.fromJson(text, type) }
            if (decoded.isFailure) {
                failures += "$file: does not decode as ${type.simpleName}: ${decoded.exceptionOrNull()?.message}"
                continue
            }
            val kept = paths(gson.toJsonTree(decoded.getOrThrow()))
            val dropped = paths(fixture) - kept - IGNORED_PATHS.getOrDefault(file, emptySet()) - GLOBALLY_IGNORED
            if (dropped.isNotEmpty()) failures += "$file: ${type.simpleName} drops $dropped"
        }
        (NOT_ON_ANDROID.keys + kotlinTypes.keys - mobile).forEach { failures += "$it: listed here but not a mobile fixture" }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun `the project config fixture carries the Local wiki folder onto the project row`() {
        val text = File(fixtures, "projectConfig.desktop.json").readText()
        val config = gson.fromJson(text, ProjectConfig::class.java)
        assertEquals("nimbalyst-local/wiki", normalizeLocalWikiFolder(config.localWiki?.folder))
        val types = gson.fromJson(rawLocalWikiTypes(text), Array<SyncedWikiType>::class.java).toList()
        assertEquals(listOf("competitor", "partner"), types.map { it.typeId })
        assertEquals("table", types.last().storage)
        assertEquals(true, types.first().fields.single().multiValue)
        assertNull(rawLocalWikiTypes("""{"commands":[]}"""))
        assertEquals("docs/wiki", normalizeLocalWikiFolder("docs/wiki/"))
        for (unsafe in listOf("", "/abs/wiki", "../wiki", "docs/../../x", "docs//wiki")) {
            assertNull(unsafe, normalizeLocalWikiFolder(unsafe))
        }
    }

    /** Every leaf path, with array indices collapsed to `[]`. */
    private fun paths(element: JsonElement, prefix: String = ""): Set<String> = when {
        element.isJsonObject -> element.asJsonObject.entrySet()
            .flatMap { (key, value) -> paths(value, if (prefix.isEmpty()) key else "$prefix.$key") }
            .toSet()
            .ifEmpty { setOf(prefix) }
        element.isJsonArray -> element.asJsonArray.flatMap { paths(it, "$prefix[]") }.toSet().ifEmpty { setOf(prefix) }
        element.isJsonNull -> emptySet()
        else -> setOf(prefix)
    }

    private companion object {
        val MOBILE_DIRECTIONS = setOf("serverToIos", "iosToServer", "desktopToIos", "desktopToServer")

        /** Android dispatches on the envelope's `type` before decoding, so a type need not carry it. */
        val GLOBALLY_IGNORED = setOf("type")

        /** Mobile fixtures Android does not consume, and why. */
        val NOT_ON_ANDROID = mapOf(
            "voiceToolRequest.json" to "voice is out of scope on Android",
            "voiceToolResponseBroadcast.json" to "voice is out of scope on Android",
            "readReceiptBroadcast.json" to "personal-state lanes are not ported; unread state rides on index lastReadAt",
            "trackerPersonalStateBroadcast.json" to "trackers are not on Android",
            "personalStatePageResponse.json" to "personal-state lanes are not ported",
            "fileIndexBroadcast.json" to "file metadata syncs through the documents lane",
            "fileIndexDeleteBroadcast.json" to "file metadata syncs through the documents lane",
            "sessionControlBroadcast.desktop.json" to "Android does not act on desktop session controls",
            // Desktop-only legs of messages Android does use.
            "settingsSync.desktop.json" to "desktop publishes settings; Android consumes the broadcast",
            "createSessionResponse.json" to "desktop's leg; Android consumes the broadcast",
            "createWorktreeResponse.json" to "desktop's leg; Android consumes the broadcast",
            "sessionControl.desktop.json" to "desktop's leg",
            "readReceipt.json" to "personal-state lanes are not ported",
            "trackerPersonalState.json" to "trackers are not on Android",
            "personalStatePageRequest.json" to "personal-state lanes are not ported",
            "fileIndexUpdate.json" to "desktop publishes file metadata",
            "fileIndexDelete.json" to "desktop publishes file metadata",
            "voiceToolResponse.json" to "voice is out of scope on Android",
        )

        /** Fields Android deliberately does not model, per fixture. */
        val IGNORED_PATHS: Map<String, Set<String>> = mapOf(
            "settingsPayload.desktop.json" to setOf(
                // Voice is out of scope on Android.
                "voiceMode.voice", "voiceMode.submitDelayMs", "voiceMode.engine", "voiceMode.liveVoice",
                "voiceMode.liveControllerModel", "preferredAgentLanguage",
            ),
        )
    }
}
