package com.nimbalyst.app.screenshots

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.documents.DocumentCryptoCache
import com.nimbalyst.app.documents.DocumentSyncManager
import com.nimbalyst.app.documents.Documents
import com.nimbalyst.app.documents.DocumentsDatabase
import com.nimbalyst.app.documents.ExpandedPathsStore
import com.nimbalyst.app.documents.documentSyncAccount
import com.nimbalyst.app.documents.sha256Hex
import com.nimbalyst.app.pairing.PairingCredentials
import com.nimbalyst.app.sync.WebSocketFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * Files for the Files tab and the document editor in screenshot mode. The real
 * [DocumentSyncManager] runs unchanged; only its socket is replaced by an
 * in-process room that answers the sync request with the demo files, encrypted
 * with the demo account's key. Nothing leaves the device.
 */
@OptIn(ExperimentalCoroutinesApi::class)
internal object ScreenshotDocuments {
    private const val TAG = "ScreenshotDocuments"

    fun install(app: NimbalystApplication, credentials: PairingCredentials, now: Long) {
        val room = DemoDocumentRoom(now)
        val manager = DocumentSyncManager(
            scope = app.applicationScope,
            dispatcher = Dispatchers.IO.limitedParallelism(1),
            openDatabase = { DocumentsDatabase.open(app, it) },
            socketFactory = room,
        )
        // Documents owns a lazily created singleton with a real socket; claim the slot
        // before any screen asks for it. Debug-only, so reflection beats a seam in main.
        val replaced = runCatching {
            Documents::class.java.getDeclaredField("instance").apply { isAccessible = true }.set(null, manager)
        }
        if (replaced.isFailure) {
            Log.e(TAG, "Could not install the demo document manager; Files will be empty", replaced.exceptionOrNull())
            return
        }
        ExpandedPathsStore(app, ScreenshotDemoData.SHOWCASE_PROJECT_ID).save(ScreenshotDemoData.EXPANDED_DOCUMENT_DIRS)
        app.applicationScope.launch {
            val account = documentSyncAccount(credentials, DocumentCryptoCache())
            if (account == null) {
                Log.e(TAG, "Demo credentials did not resolve a document account")
                return@launch
            }
            room.crypto = account.crypto
            manager.setAccount(account)
        }
    }

    /** One fake socket per room; it opens at once and answers every sync request. */
    private class DemoDocumentRoom(private val now: Long) : WebSocketFactory {
        @Volatile var crypto: CryptoManager? = null
        private val main = Handler(Looper.getMainLooper())

        override fun open(request: Request, listener: WebSocketListener): WebSocket {
            val socket = object : WebSocket {
                override fun request() = request
                override fun queueSize() = 0L
                override fun send(bytes: ByteString) = false
                override fun close(code: Int, reason: String?) = true
                override fun cancel() = Unit
                override fun send(text: String): Boolean {
                    val type = runCatching { JsonParser.parseString(text).asJsonObject["type"]?.asString }.getOrNull()
                    if (type == "projectSyncRequest") {
                        val response = syncResponse() ?: return false
                        main.post { listener.onMessage(this, response) }
                    }
                    return true
                }
            }
            val opened = Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(101).message("").build()
            main.post { listener.onOpen(socket, opened) }
            return socket
        }

        private fun syncResponse(): String? {
            val crypto = crypto ?: return null
            val files = JsonArray()
            ScreenshotDemoData.documents().forEach { doc ->
                val content = crypto.encrypt(doc.markdown)
                val path = crypto.encrypt(doc.relativePath)
                val title = crypto.encrypt(doc.relativePath.substringAfterLast('/'))
                files.add(JsonObject().apply {
                    addProperty("syncId", doc.syncId)
                    addProperty("encryptedContent", content.encrypted)
                    addProperty("contentIv", content.iv)
                    addProperty("contentHash", sha256Hex(doc.markdown))
                    addProperty("encryptedPath", path.encrypted)
                    addProperty("pathIv", path.iv)
                    addProperty("encryptedTitle", title.encrypted)
                    addProperty("titleIv", title.iv)
                    addProperty("lastModifiedAt", now - doc.modifiedAgo)
                    addProperty("hasYjs", false)
                })
            }
            return JsonObject().apply {
                addProperty("type", "projectSyncResponse")
                add("updatedFiles", JsonArray())
                add("newFiles", files)
                add("yjsUpdates", JsonArray())
                add("needFromClient", JsonArray())
                add("deletedSyncIds", JsonArray())
                addProperty("transferId", "screenshot")
                addProperty("batchIndex", 0)
                addProperty("isLastBatch", true)
            }.toString()
        }
    }
}
