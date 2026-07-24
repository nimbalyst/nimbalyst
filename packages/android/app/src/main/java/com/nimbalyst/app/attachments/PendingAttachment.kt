package com.nimbalyst.app.attachments

import android.graphics.Bitmap
import java.util.UUID

data class PendingAttachment(
    val bitmap: Bitmap,
    val filename: String = "photo.jpg",
    val id: String = UUID.randomUUID().toString(),
)
