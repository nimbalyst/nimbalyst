package com.nimbalyst.app.documents

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.gson.Gson
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.pairing.PairingCredentials
import com.nimbalyst.app.sync.extractJwtClaims
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The app's one [DocumentSyncManager], created on first use. It follows the
 * paired account on its own: a JWT refresh, re-pair, or sign-out in
 * `PairingStore` reaches the manager without any other wiring.
 */
object Documents {
    @Volatile
    private var instance: DocumentSyncManager? = null

    fun manager(context: Context): DocumentSyncManager {
        instance?.let { return it }
        return synchronized(this) {
            instance ?: create(context.applicationContext as NimbalystApplication).also { instance = it }
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private fun create(app: NimbalystApplication): DocumentSyncManager {
        val manager = DocumentSyncManager(
            scope = app.applicationScope,
            dispatcher = Dispatchers.IO.limitedParallelism(1),
            openDatabase = { DocumentsDatabase.open(app, it) },
        )
        followAccount(app.applicationScope, app.pairingStore.state.map { it.credentials }, manager)
        // No sockets in the background; the outbox keeps unsent edits for the return.
        Handler(Looper.getMainLooper()).post {
            ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) = manager.resumeConnections()
                override fun onStop(owner: LifecycleOwner) = manager.suspendConnections()
            })
        }
        return manager
    }

    private fun followAccount(
        scope: CoroutineScope,
        credentials: kotlinx.coroutines.flow.Flow<PairingCredentials?>,
        manager: DocumentSyncManager,
    ) {
        val keys = DocumentCryptoCache()
        scope.launch {
            credentials.distinctUntilChanged().collect { current ->
                manager.setAccount(current?.let { documentSyncAccount(it, keys) })
            }
        }
    }
}

/** PBKDF2 is deliberately slow, so a key is derived once per seed and user. */
internal class DocumentCryptoCache {
    private var cached: Pair<String, CryptoManager>? = null

    suspend fun get(seed: String, userId: String): CryptoManager {
        val identity = cryptoIdentity(seed, userId)
        cached?.takeIf { it.first == identity }?.let { return it.second }
        val crypto = withContext(Dispatchers.Default) { CryptoManager.fromSeed(seed, userId) }
        cached = identity to crypto
        return crypto
    }
}

internal fun cryptoIdentity(seed: String, userId: String): String = sha256Hex("$seed\u001f$userId").take(16)

/**
 * The document-room identity for [credentials], resolved exactly as the index
 * room resolves it in `SyncManager.connect`: personal routing ids first, then
 * the JWT's claims; the key comes from the seed and the auth user id. Null
 * until the device is signed in.
 */
internal suspend fun documentSyncAccount(credentials: PairingCredentials, keys: DocumentCryptoCache): DocumentSyncAccount? {
    val token = credentials.authJwt?.takeIf { it.isNotBlank() } ?: return null
    val claims = extractJwtClaims(token, Gson())
    val userId = credentials.routingUserId ?: claims?.sub ?: return null
    val orgId = credentials.routingOrgId ?: claims?.orgId ?: return null
    val cryptoUserId = credentials.cryptoUserId ?: claims?.sub ?: return null
    return DocumentSyncAccount(
        serverUrl = credentials.serverUrl,
        authToken = token,
        orgId = orgId,
        userId = userId,
        crypto = keys.get(credentials.encryptionSeed, cryptoUserId),
        cryptoIdentity = cryptoIdentity(credentials.encryptionSeed, cryptoUserId),
    )
}
