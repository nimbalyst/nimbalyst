package com.nimbalyst.app

import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MainActivityDeepLinkTest {
    @Test
    fun `pairing links are not routed even when explicitly delivered`() {
        assertEquals(
            DeepLinkRoute.UNSUPPORTED,
            routeDeepLink("pair", null)
        )
    }

    @Test
    fun `pairing links are not registered as browsable intents`() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val intent = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("nimbalyst://pair?data=attacker-controlled")
        ).addCategory(Intent.CATEGORY_BROWSABLE)

        val matches = context.packageManager.queryIntentActivities(intent, 0)

        assertTrue(matches.isEmpty())
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
