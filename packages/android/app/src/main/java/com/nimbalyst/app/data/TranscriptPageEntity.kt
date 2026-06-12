package com.nimbalyst.app.data

import androidx.room.Entity

/**
 * Cached desktop-projected transcript history page.
 *
 * Pages for a concrete cursor are immutable (raw rows below a fixed raw id
 * never change), so once fetched they can be served locally forever. The
 * cursorKey is the `beforeRawMessageId` the page was requested with; the
 * tail-overlapping "latest" page (null cursor) is never cached because it
 * changes as the session grows.
 */
@Entity(
    tableName = "transcript_pages",
    primaryKeys = ["sessionId", "cursorKey"]
)
data class TranscriptPageEntity(
    val sessionId: String,
    /** beforeRawMessageId used to request this page. */
    val cursorKey: Long,
    val rawStartId: Long?,
    val rawEndId: Long?,
    val hasMoreBefore: Boolean,
    /** Full serialized MobileTranscriptHistoryPage JSON, as published by desktop. */
    val pageJson: String,
    val updatedAt: Long
)
