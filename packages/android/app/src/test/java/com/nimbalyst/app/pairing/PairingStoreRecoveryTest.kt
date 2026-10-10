package com.nimbalyst.app.pairing

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.test.core.app.ApplicationProvider
import javax.crypto.AEADBadTagException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Robolectric has no AndroidKeyStore, so the tests inject a prefs opener that
// fails like EncryptedSharedPreferences does and otherwise returns plain prefs.
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class PairingStoreRecoveryTest {
    private lateinit var context: Context
    private val credentials = PairingCredentials(
        serverUrl = "https://sync.nimbalyst.com",
        encryptionSeed = "seed",
        pairedUserId = "user",
    )

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        prefs(PairingStore.PREFS_NAME).edit { putString("server_url", "https://old"); putString("encryption_seed", "old") }
        prefs("unrelated").edit { putString("keep", "me") }
    }

    private fun prefs(name: String): SharedPreferences = context.getSharedPreferences(name, Context.MODE_PRIVATE)

    private fun openerFailing(times: Int, error: () -> Throwable = { AEADBadTagException("bad tag") }): (Context) -> SharedPreferences {
        var failures = 0
        return { ctx ->
            if (failures++ < times) throw error()
            ctx.getSharedPreferences(PairingStore.PREFS_NAME, Context.MODE_PRIVATE)
        }
    }

    @Test
    fun `a single transient failure is retried without deleting pairing`() {
        val store = PairingStore(context, openerFailing(1))

        assertEquals("https://old", store.state.value.credentials?.serverUrl)
    }

    @Test
    fun `undecryptable prefs reset to unpaired and delete only the pairing file`() {
        val store = PairingStore(context, openerFailing(2))

        assertNull(store.state.value.credentials)
        assertFalse(prefs(PairingStore.PREFS_NAME).contains("server_url"))
        assertEquals("me", prefs("unrelated").getString("keep", null))

        store.savePairing(credentials)
        assertEquals("seed", PairingStore(context, openerFailing(0)).state.value.credentials?.encryptionSeed)
    }

    @Test
    fun `a value that fails to decrypt on read resets to unpaired`() {
        val store = PairingStore(context) { ctx ->
            val real = ctx.getSharedPreferences(PairingStore.PREFS_NAME, Context.MODE_PRIVATE)
            if (real.contains("server_url")) {
                object : SharedPreferences by real {
                    override fun getString(key: String?, defValue: String?): String? =
                        throw SecurityException("Could not decrypt value")
                }
            } else {
                real
            }
        }

        assertNull(store.state.value.credentials)
        assertTrue(prefs(PairingStore.PREFS_NAME).all.isEmpty())
    }

    @Test
    fun `a Keystore that never opens keeps pairing in memory instead of crashing`() {
        val store = PairingStore(context, openerFailing(Int.MAX_VALUE))

        store.savePairing(credentials)

        assertEquals("seed", store.state.value.credentials?.encryptionSeed)
    }

    @Test(expected = IllegalStateException::class)
    fun `unrelated errors are not treated as corruption`() {
        PairingStore(context, openerFailing(1) { IllegalStateException("bug") })
    }
}
