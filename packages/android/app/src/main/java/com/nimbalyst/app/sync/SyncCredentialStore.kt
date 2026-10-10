package com.nimbalyst.app.sync

import com.nimbalyst.app.pairing.PairingCredentials
import com.nimbalyst.app.pairing.PairingStore

/**
 * The credentials [SyncManager] connects with. [PairingStore] is the real
 * source; tests supply their own because [PairingStore] needs the Android
 * KeyStore, which Robolectric does not provide.
 */
interface SyncCredentialStore {
    val credentials: PairingCredentials?
    fun save(credentials: PairingCredentials)
}

internal class PairingStoreCredentials(private val store: PairingStore) : SyncCredentialStore {
    override val credentials: PairingCredentials?
        get() = store.state.value.credentials

    override fun save(credentials: PairingCredentials) = store.savePairing(credentials)
}
