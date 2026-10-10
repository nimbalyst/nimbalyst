package com.nimbalyst.app.attachments

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt

/** A pending attachment's on-disk copy, so a draft's images survive process death. */
data class StoredAttachment(
    val id: String,
    val filename: String,
    val path: String,
)

/**
 * Decodes picked, captured, and pasted images, and keeps unsent attachments on
 * disk under `files/compose-attachments/<sessionId>/` until they are sent or
 * removed.
 */
object AttachmentStore {
    /**
     * Decode bound. Above [ImageCompressor]'s 1024px send size, so nothing sent
     * is lost, while a 12MP camera frame does not cost ~48MB of heap per draft
     * attachment.
     */
    private const val DECODE_MAX_DIMENSION = 2048
    private const val STORED_JPEG_QUALITY = 92

    fun decode(context: Context, uri: Uri): Bitmap? =
        decode(ImageDecoder.createSource(context.contentResolver, uri))

    fun decode(file: File): Bitmap? = decode(ImageDecoder.createSource(file))

    private fun decode(source: ImageDecoder.Source): Bitmap? = runCatching {
        ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            // Software so ImageCompressor can scale and re-encode it.
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val longest = max(info.size.width, info.size.height)
            if (longest > DECODE_MAX_DIMENSION) {
                val scale = DECODE_MAX_DIMENSION.toFloat() / longest
                decoder.setTargetSize(
                    (info.size.width * scale).roundToInt().coerceAtLeast(1),
                    (info.size.height * scale).roundToInt().coerceAtLeast(1)
                )
            }
        }
    }.getOrNull()

    fun save(context: Context, sessionId: String, bitmap: Bitmap, filename: String): StoredAttachment? {
        val id = UUID.randomUUID().toString()
        val file = File(sessionDir(context, sessionId), "$id.jpg")
        return runCatching {
            file.parentFile?.mkdirs()
            file.outputStream().use { out ->
                check(bitmap.compress(Bitmap.CompressFormat.JPEG, STORED_JPEG_QUALITY, out))
            }
            StoredAttachment(id = id, filename = filename, path = file.absolutePath)
        }.onFailure { file.delete() }.getOrNull()
    }

    fun load(stored: StoredAttachment): Bitmap? =
        runCatching { BitmapFactory.decodeFile(stored.path) }.getOrNull()

    fun delete(stored: StoredAttachment) {
        File(stored.path).delete()
    }

    /** A fresh full-resolution capture target for `ActivityResultContracts.TakePicture`. */
    fun newCameraFile(context: Context): File =
        File(File(context.cacheDir, "camera").apply { mkdirs() }, "${UUID.randomUUID()}.jpg")

    fun uriForCameraFile(context: Context, file: File): Uri =
        FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)

    private fun sessionDir(context: Context, sessionId: String): File =
        File(File(context.filesDir, "compose-attachments"), sessionId.replace(Regex("[^A-Za-z0-9._-]"), "_"))
}
