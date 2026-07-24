package com.nimbalyst.app.attachments

import android.graphics.Bitmap
import java.io.ByteArrayOutputStream
import kotlin.math.roundToInt

object ImageCompressor {
    private const val MAX_DIMENSION = 1024f
    private const val TARGET_QUALITY = 60
    private const val MIN_QUALITY = 10
    private const val MAX_BYTES = 500 * 1024

    data class CompressedImage(
        val data: ByteArray,
        val width: Int,
        val height: Int,
    )

    fun compress(bitmap: Bitmap): CompressedImage? {
        val resized = resizeIfNeeded(bitmap)
        var quality = TARGET_QUALITY
        var bytes = jpegBytes(resized, quality) ?: return null

        while (bytes.size > MAX_BYTES && quality > MIN_QUALITY) {
            quality -= 10
            bytes = jpegBytes(resized, quality) ?: break
        }

        return CompressedImage(
            data = bytes,
            width = resized.width,
            height = resized.height
        )
    }

    private fun resizeIfNeeded(bitmap: Bitmap): Bitmap {
        val width = bitmap.width.toFloat()
        val height = bitmap.height.toFloat()
        if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
            return bitmap
        }

        val scale = if (width > height) {
            MAX_DIMENSION / width
        } else {
            MAX_DIMENSION / height
        }
        val targetWidth = (width * scale).roundToInt()
        val targetHeight = (height * scale).roundToInt()
        return Bitmap.createScaledBitmap(bitmap, targetWidth, targetHeight, true)
    }

    private fun jpegBytes(bitmap: Bitmap, quality: Int): ByteArray? {
        val output = ByteArrayOutputStream()
        return if (bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output)) {
            output.toByteArray()
        } else {
            null
        }
    }
}
