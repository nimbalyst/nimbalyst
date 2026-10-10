package com.nimbalyst.app.data

import androidx.room.TypeConverter
import com.google.gson.Gson

/**
 * A prompt the desktop has accepted but not started. Mirrors the wire shape
 * (`messageId`, `sentAt`, `sentBy`), and is stored as one JSON column because
 * it is only ever read and replaced whole. The server does not persist it, so
 * it is present only between a broadcast that carries it and the next update
 * for the session.
 */
data class PendingExecution(
    val messageId: String,
    val sentAt: Long,
    val sentBy: String,
)

class PendingExecutionConverter {
    @TypeConverter
    fun fromJson(json: String?): PendingExecution? =
        json?.let { runCatching { gson.fromJson(it, PendingExecution::class.java) }.getOrNull() }

    @TypeConverter
    fun toJson(value: PendingExecution?): String? = value?.let(gson::toJson)

    private companion object {
        val gson = Gson()
    }
}
