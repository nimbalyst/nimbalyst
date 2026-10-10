package com.nimbalyst.app.pages

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The one channel every inbound console link takes to the Pages screen: App
 * Links, `nimbalyst://console/...`, Team tab rows, and (later) a push's
 * `consolePath`.
 *
 * [route] is the page the Pages screen shows, or null when it is closed. The
 * screen is a full-screen destination above the app shell, so a link that
 * arrives before any project is open still has somewhere to land.
 */
class ConsoleLinkInbox(private val environment: ConsoleEnvironment = ConsoleEnvironment.production) {
    private val _route = MutableStateFlow<ConsoleRoute?>(null)
    val route: StateFlow<ConsoleRoute?> = _route.asStateFlow()

    private val _personalPageRequested = MutableStateFlow(false)
    /** Set when a link named a Personal page, which only the desktop holds. */
    val personalPageRequested: StateFlow<Boolean> = _personalPageRequested.asStateFlow()

    /** The team route an https console URL or `nimbalyst://console/...` link names, if any. */
    fun teamRoute(url: String): ConsoleRoute? {
        if (environment.isConsoleOrigin(url)) {
            return ConsoleRoute.fromUrl(url, environment)?.takeIf { it.isTeamProjectPath }
        }
        return (NimbalystAppLink.parse(url) as? NimbalystAppLink.Console)?.route
    }

    /** True for a console link that names a Personal page (`/app/...`). */
    fun isPersonalPage(url: String): Boolean {
        if (environment.isConsoleOrigin(url)) {
            val raw = runCatching { java.net.URI(url).rawPath }.getOrNull().orEmpty()
            val path = ConsoleRoute.canonicalPath(raw)
            return path == "/app" || path.startsWith("/app/")
        }
        return NimbalystAppLink.parse(url) == NimbalystAppLink.ConsolePersonal
    }

    /**
     * Route a link to Pages when it is a console team page. Returns false for
     * anything else, so the caller falls back to its existing handling.
     */
    fun open(url: String): Boolean {
        val route = teamRoute(url)
        if (route == null) {
            if (isPersonalPage(url)) _personalPageRequested.value = true
            return false
        }
        open(route)
        return true
    }

    fun open(route: ConsoleRoute) {
        _route.value = route
    }

    /**
     * A push's reserved `consolePath` key. Nothing sends it yet; when the server
     * does, it lands here and nowhere else.
     */
    fun openPath(path: String): Boolean {
        val route = ConsoleRoute.parse(path)?.takeIf { it.isTeamProjectPath } ?: return false
        open(route)
        return true
    }

    /**
     * An App Link or `nimbalyst://console/...` delivered to the app. A team page
     * opens in Pages when an account is signed in; otherwise an https link goes
     * back to the browser, so a console link never dead-ends in the app.
     */
    fun handleInbound(url: String, signedIn: Boolean): InboundConsoleLink {
        val isHttps = environment.isConsoleOrigin(url)
        return when {
            teamRoute(url) != null -> when {
                signedIn -> { open(url); InboundConsoleLink.OPENED }
                isHttps -> InboundConsoleLink.OPEN_IN_BROWSER
                else -> InboundConsoleLink.SIGN_IN_REQUIRED
            }
            isPersonalPage(url) -> { _personalPageRequested.value = true; InboundConsoleLink.PERSONAL }
            isHttps -> InboundConsoleLink.OPEN_IN_BROWSER
            else -> InboundConsoleLink.UNSUPPORTED
        }
    }

    /** The reader left the Pages screen. */
    fun close() {
        _route.value = null
    }

    fun personalPageNoticeShown() {
        _personalPageRequested.value = false
    }

    companion object {
        val shared = ConsoleLinkInbox()
    }
}

enum class InboundConsoleLink { OPENED, PERSONAL, OPEN_IN_BROWSER, SIGN_IN_REQUIRED, UNSUPPORTED }
