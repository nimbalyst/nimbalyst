package com.nimbalyst.app

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Looper
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.auth.AuthCallbackParseResult
import com.nimbalyst.app.auth.AuthCallbackParser
import com.nimbalyst.app.notifications.VisibleSession
import com.nimbalyst.app.pages.ConsoleEnvironment
import com.nimbalyst.app.pages.ConsoleLinkInbox
import com.nimbalyst.app.pages.InboundConsoleLink
import com.nimbalyst.app.pages.NimbalystAppLink
import com.nimbalyst.app.pages.PagesHost
import com.nimbalyst.app.screenshots.ScreenshotHost
import com.nimbalyst.app.screenshots.ScreenshotMode
import com.nimbalyst.app.transcript.TranscriptExternalLinks
import com.nimbalyst.app.transcript.TranscriptWebViewPool
import com.nimbalyst.app.ui.NimbalystAndroidApp
import com.nimbalyst.app.ui.navigation.WorkspaceNavigation
import com.nimbalyst.app.ui.theme.NimbalystAndroidTheme

internal enum class DeepLinkRoute {
    AUTH_CALLBACK,
    SESSION,
    /** Open the in-app scanner. The link's own payload is never read. */
    PAIR,
    /** `nimbalyst://console/<team path>` or an https console App Link: open it in Pages. */
    CONSOLE,
    UNSUPPORTED,
}

internal fun routeDeepLink(host: String?, path: String?, scheme: String? = "nimbalyst"): DeepLinkRoute = when {
    scheme.equals("https", ignoreCase = true) ->
        if (host.equals(ConsoleEnvironment.production.host, ignoreCase = true)) DeepLinkRoute.CONSOLE else DeepLinkRoute.UNSUPPORTED
    host == "auth" && path == "/callback" -> DeepLinkRoute.AUTH_CALLBACK
    host == "session" -> DeepLinkRoute.SESSION
    host == "pair" -> DeepLinkRoute.PAIR
    host == "console" -> DeepLinkRoute.CONSOLE
    else -> DeepLinkRoute.UNSUPPORTED
}

class MainActivity : ComponentActivity() {
    private val navigation: WorkspaceNavigation by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        // The app is dark only; the automatic style would pick dark icons on a phone in
        // light mode and hide them against our background.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        // A recreated activity (rotation, process restore) would replay the launch link.
        if (savedInstanceState == null) handleIntent(intent)

        // Marketing capture path: debug builds only, opt-in per launch intent.
        val screenshotScreen = if (ScreenshotMode.isEnabled(intent)) {
            ScreenshotMode.screen(intent).also {
                ScreenshotMode.apply(
                    app = applicationContext as NimbalystApplication,
                    screen = it,
                    now = System.currentTimeMillis()
                )
            }
        } else {
            null
        }

        setContent {
            NimbalystAndroidTheme {
                if (screenshotScreen != null) {
                    ScreenshotHost(screenshotScreen)
                } else {
                    PagesHost(onAppLink = ::openAppLink) {
                        NimbalystAndroidApp(navigation)
                    }
                }
            }
        }

        // Pre-warm transcript WebViews once the main thread is idle, so the
        // first session opens instantly without delaying the first frame.
        // warmup never throws; a missing WebView provider surfaces as an
        // error card when a transcript is opened.
        Looper.myQueue().addIdleHandler {
            TranscriptWebViewPool.warmup(applicationContext)
            false
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        VisibleSession.setActivityResumed(true)
    }

    override fun onPause() {
        VisibleSession.setActivityResumed(false)
        super.onPause()
    }

    /** Any touch or key press counts as presence; the sync layer throttles to once a second. */
    override fun onUserInteraction() {
        super.onUserInteraction()
        (applicationContext as NimbalystApplication).syncManager.reportUserActivity()
    }

    /** An app route a team console page linked to. */
    private fun openAppLink(link: NimbalystAppLink) {
        when (link) {
            is NimbalystAppLink.Session -> navigation.openSession(link.id)
            NimbalystAppLink.PairScanner -> navigation.requestScanner()
            else -> Unit
        }
    }

    private fun handleIntent(intent: Intent?) {
        val deepLink = intent?.data ?: return
        // Resolved only by the branches that need it: a pairing link reaches no app service.
        val app by lazy { applicationContext as NimbalystApplication }
        val message = when (routeDeepLink(deepLink.host, deepLink.path, deepLink.scheme)) {
            DeepLinkRoute.SESSION -> {
                // nimbalyst://session/<sessionId> -- opened from a push notification tap.
                val sessionId = deepLink.pathSegments.firstOrNull()?.takeIf { it.isNotBlank() }
                if (sessionId == null) {
                    getString(R.string.deep_link_invalid_session)
                } else {
                    navigation.openSession(sessionId)
                    null
                }
            }

            DeepLinkRoute.PAIR -> {
                navigation.requestScanner()
                null
            }

            DeepLinkRoute.AUTH_CALLBACK -> when (
                val result = AuthCallbackParser.parse(
                    deepLink = deepLink.toString(),
                    pairedUserId = app.pairingStore.state.value.credentials?.pairedUserId
                )
            ) {
                is AuthCallbackParseResult.Success -> {
                    navigation.reportAuthCallbackFailure(null)
                    app.pairingStore.saveAuthSession(result.data)
                    result.data.email?.let { AnalyticsManager.setEmail(it) }
                    AnalyticsManager.capture("mobile_login_completed")
                    app.syncManager.connectIfConfigured()
                    getString(R.string.deep_link_auth_updated, result.data.email ?: getString(R.string.deep_link_paired_account))
                }

                is AuthCallbackParseResult.Failure -> {
                    // The sign-in screen shows it; a signed-in user only sees the toast.
                    navigation.reportAuthCallbackFailure(result.reason)
                    result.reason.takeIf { app.pairingStore.state.value.isAuthenticated }
                }
            }

            DeepLinkRoute.CONSOLE -> {
                val url = deepLink.toString()
                when (ConsoleLinkInbox.shared.handleInbound(url, app.pairingStore.state.value.isAuthenticated)) {
                    InboundConsoleLink.OPENED, InboundConsoleLink.PERSONAL -> null
                    InboundConsoleLink.OPEN_IN_BROWSER -> {
                        TranscriptExternalLinks.open(this, url)
                        null
                    }
                    InboundConsoleLink.SIGN_IN_REQUIRED -> getString(R.string.pages_sign_in_title)
                    InboundConsoleLink.UNSUPPORTED -> getString(R.string.pages_link_unsupported)
                }
            }

            DeepLinkRoute.UNSUPPORTED -> null
        }

        message?.let {
            Toast.makeText(this, it, Toast.LENGTH_LONG).show()
        }
    }
}
