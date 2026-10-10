package com.nimbalyst.app

import android.content.Intent
import android.net.Uri
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ApplicationProvider
import com.nimbalyst.app.ui.navigation.WorkspaceNavigation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MainActivityDeepLinkTest {
    @Test
    fun `pairing links only open the scanner, whatever payload they carry`() {
        // The route carries no data: MainActivity never reads the link's query.
        assertEquals(DeepLinkRoute.PAIR, routeDeepLink("pair", null))
        assertEquals(DeepLinkRoute.PAIR, routeDeepLink("pair", "/anything"))
    }

    @Test
    fun `external pairing links resolve to the app so the scanner can open`() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val intent = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("nimbalyst://pair?data=attacker-controlled")
        ).addCategory(Intent.CATEGORY_BROWSABLE)

        val matches = context.packageManager.queryIntentActivities(intent, 0)

        assertEquals(listOf(MainActivity::class.java.name), matches.map { it.activityInfo.name })
    }

    @Test
    fun `handling a pairing link opens the scanner without touching stored credentials`() {
        val payload = Uri.encode("""{"serverUrl":"wss://attacker.example","encryptionSeed":"x"}""")
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nimbalyst://pair?data=$payload"))

        val activity = Robolectric.buildActivity(MainActivity::class.java, intent).create().get()

        assertTrue(ViewModelProvider(activity)[WorkspaceNavigation::class.java].state.value.scannerRequested)
        // Robolectric runs a plain Application here (robolectric.properties), so reaching
        // NimbalystApplication's pairing store at all would have thrown during create():
        // the link cannot read or change stored credentials.
        assertFalse(activity.application is NimbalystApplication)
    }

    @Test
    fun `session links are not browsable`() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nimbalyst://session/abc"))
            .addCategory(Intent.CATEGORY_BROWSABLE)

        assertTrue(context.packageManager.queryIntentActivities(intent, 0).isEmpty())
    }

    @Test
    fun `auth callback remains routed only at callback path`() {
        assertEquals(
            DeepLinkRoute.AUTH_CALLBACK,
            routeDeepLink("auth", "/callback")
        )
        assertEquals(
            DeepLinkRoute.UNSUPPORTED,
            routeDeepLink("auth", "/unexpected")
        )
    }

    @Test
    fun `session notification links remain routed`() {
        assertEquals(
            DeepLinkRoute.SESSION,
            routeDeepLink("session", "/session-id")
        )
    }
}
