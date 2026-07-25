package com.nimbalyst.app

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.auth.AuthCallbackParseResult
import com.nimbalyst.app.ui.NimbalystAndroidApp
import com.nimbalyst.app.ui.theme.NimbalystAndroidTheme

internal enum class DeepLinkRoute {
    AUTH_CALLBACK,
    SESSION,
    UNSUPPORTED,
}

internal fun routeDeepLink(host: String?, path: String?): DeepLinkRoute = when {
    host == "auth" && path == "/callback" -> DeepLinkRoute.AUTH_CALLBACK
    host == "session" -> DeepLinkRoute.SESSION
    else -> DeepLinkRoute.UNSUPPORTED
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIntent(intent)

        setContent {
            NimbalystAndroidTheme {
                NimbalystAndroidApp()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val deepLink = intent?.data ?: return
        val app = applicationContext as NimbalystApplication
        val message = when (routeDeepLink(deepLink.host, deepLink.path)) {
            DeepLinkRoute.SESSION -> {
                // nimbalyst://session/<sessionId> -- opened from a push notification tap.
                val sessionId = deepLink.pathSegments.firstOrNull()?.takeIf { it.isNotBlank() }
                if (sessionId == null) {
                    "Invalid session link."
                } else {
                    app.requestSessionNavigation(sessionId)
                    null
                }
            }

            DeepLinkRoute.AUTH_CALLBACK -> when (
                val result = com.nimbalyst.app.auth.AuthCallbackParser.parse(
                    deepLink = deepLink.toString(),
                    pairedUserId = app.pairingStore.state.value.credentials?.pairedUserId
                )
            ) {
                is AuthCallbackParseResult.Success -> {
                    app.pairingStore.saveAuthSession(result.data)
                    result.data.email?.let { AnalyticsManager.setEmail(it) }
                    AnalyticsManager.capture("mobile_login_completed")
                    app.syncManager.connectIfConfigured()
                    "Authentication updated for ${result.data.email ?: "paired account"}."
                }

                is AuthCallbackParseResult.Failure -> result.reason
            }

            DeepLinkRoute.UNSUPPORTED -> null
        }

        message?.let {
            Toast.makeText(this, it, Toast.LENGTH_LONG).show()
        }
    }
}
