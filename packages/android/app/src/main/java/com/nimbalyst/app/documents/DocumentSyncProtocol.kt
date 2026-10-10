package com.nimbalyst.app.documents

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Wire types for a project's document room (`ProjectSyncRoom` in collabv3).
 * Mirrors the ProjectSync section of iOS `SyncProtocol.swift`; field names are
 * the wire names.
 */

/** Any malformed message or invalid transfer step. The message is user-facing. */
class DocumentSyncException(message: String, cause: Throwable? = null) : Exception(message, cause)

internal data class ProjectSyncManifestEntry(
    val syncId: String,
    val contentHash: String,
    val lastModifiedAt: Long,
    val hasYjs: Boolean,
    val yjsSeq: Long,
)

internal data class ProjectSyncRequestMessage(
    val files: List<ProjectSyncManifestEntry>,
    val type: String = "projectSyncRequest",
)

internal data class FileContentPushMessage(
    val syncId: String,
    val encryptedContent: String,
    val contentIv: String,
    val contentHash: String,
    val encryptedPath: String,
    val pathIv: String,
    val encryptedTitle: String,
    val titleIv: String,
    val lastModifiedAt: Long,
    val type: String = "fileContentPush",
)

internal data class FileDeleteMessage(val syncId: String, val type: String = "fileDelete")

internal data class FileYjsUpdateMessage(
    val syncId: String,
    val encryptedUpdate: String,
    val iv: String,
    val type: String = "fileYjsUpdate",
)

internal data class FileYjsInitMessage(
    val syncId: String,
    val encryptedSnapshot: String,
    val iv: String,
    val type: String = "fileYjsInit",
)

/** A file in a sync response or a `fileContentBroadcast`. */
internal data class ProjectSyncFileEntry(
    val syncId: String,
    val encryptedContent: String,
    val contentIv: String,
    val contentHash: String,
    val encryptedPath: String,
    val pathIv: String,
    val encryptedTitle: String,
    val titleIv: String,
    val lastModifiedAt: Long,
    val hasYjs: Boolean,
) {
    companion object {
        fun from(json: JsonObject, hasYjsDefault: Boolean? = null) = ProjectSyncFileEntry(
            syncId = json.requireString("syncId"),
            encryptedContent = json.requireString("encryptedContent"),
            contentIv = json.requireString("contentIv"),
            contentHash = json.requireString("contentHash"),
            encryptedPath = json.requireString("encryptedPath"),
            pathIv = json.requireString("pathIv"),
            encryptedTitle = json.requireString("encryptedTitle"),
            titleIv = json.requireString("titleIv"),
            lastModifiedAt = json.requireLong("lastModifiedAt"),
            hasYjs = hasYjsDefault ?: json.requireBoolean("hasYjs"),
        )
    }
}

internal data class ProjectSyncYjsUpdate(val syncId: String, val sequence: Long)

internal data class TransferMetadata(val transferId: String, val batchIndex: Int, val isLastBatch: Boolean)

/** One `projectSyncResponse` message, which may be one batch of a larger transfer. */
internal data class ProjectSyncResponse(
    val updatedFiles: List<ProjectSyncFileEntry>,
    val newFiles: List<ProjectSyncFileEntry>,
    val yjsUpdates: List<ProjectSyncYjsUpdate>,
    val needFromClient: List<String>,
    val deletedSyncIds: List<String>,
    /** Null only when all three batch fields are absent (a pre-batching server). */
    val metadata: TransferMetadata?,
) {
    val files: List<ProjectSyncFileEntry> get() = updatedFiles + newFiles

    companion object {
        fun parse(text: String): ProjectSyncResponse = parse(parseObject(text))

        fun parse(json: JsonObject): ProjectSyncResponse = wrapMalformed {
            // Only absent metadata denotes a legacy response; explicit null is malformed.
            val hasMetadata = listOf("transferId", "batchIndex", "isLastBatch").any(json::has)
            ProjectSyncResponse(
                updatedFiles = json.requireArray("updatedFiles").map { ProjectSyncFileEntry.from(it.asObjectOrThrow()) },
                newFiles = json.requireArray("newFiles").map { ProjectSyncFileEntry.from(it.asObjectOrThrow()) },
                yjsUpdates = json.requireArray("yjsUpdates").map {
                    val update = it.asObjectOrThrow()
                    ProjectSyncYjsUpdate(update.requireString("syncId"), update.requireLong("sequence"))
                },
                needFromClient = json.requireArray("needFromClient").map { it.asStringOrThrow() },
                deletedSyncIds = json.requireArray("deletedSyncIds").map { it.asStringOrThrow() },
                metadata = if (hasMetadata) {
                    TransferMetadata(
                        transferId = json.requireString("transferId"),
                        batchIndex = json.requireLong("batchIndex").toInt(),
                        isLastBatch = json.requireBoolean("isLastBatch"),
                    )
                } else {
                    null
                },
            )
        }
    }
}

internal object DocumentSyncWire {
    private val gson = Gson()

    fun encode(message: Any): String = gson.toJson(message)
}

internal fun parseObject(text: String): JsonObject = wrapMalformed {
    JsonParser.parseString(text).asObjectOrThrow()
}

internal fun JsonObject.optString(name: String): String? =
    get(name)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString

internal fun JsonObject.requireString(name: String): String =
    optString(name) ?: throw DocumentSyncException("Missing $name")

internal fun JsonObject.requireLong(name: String): Long {
    val value = get(name)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }
        ?: throw DocumentSyncException("Missing $name")
    return value.asLong
}

internal fun JsonObject.requireBoolean(name: String): Boolean {
    val value = get(name)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }
        ?: throw DocumentSyncException("Missing $name")
    return value.asBoolean
}

private fun JsonObject.requireArray(name: String): JsonArray =
    get(name)?.takeIf { it.isJsonArray }?.asJsonArray ?: throw DocumentSyncException("Missing $name")

private fun JsonElement.asObjectOrThrow(): JsonObject =
    takeIf { it.isJsonObject }?.asJsonObject ?: throw DocumentSyncException("Expected an object")

private fun JsonElement.asStringOrThrow(): String =
    takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
        ?: throw DocumentSyncException("Expected a string")

private inline fun <T> wrapMalformed(block: () -> T): T = try {
    block()
} catch (error: DocumentSyncException) {
    throw error
} catch (error: RuntimeException) {
    throw DocumentSyncException("Unreadable message", error)
}
