package com.nimbalyst.app.pages

import java.net.URI

/**
 * A `nimbalyst://` link, as the Pages screen and the deep-link router see it.
 * Mirrors iOS `NimbalystExternalURLRoute`.
 */
sealed interface NimbalystAppLink {
    /** `nimbalyst://console/<team path>`: a team console page, opened in Pages. */
    data class Console(val route: ConsoleRoute) : NimbalystAppLink
    /** `nimbalyst://console/app/...`: a personal page, which only the desktop holds. */
    data object ConsolePersonal : NimbalystAppLink
    data class Session(val id: String) : NimbalystAppLink
    /** Opens the in-app scanner; the link's payload is never read. */
    data object PairScanner : NimbalystAppLink
    data object AuthCallback : NimbalystAppLink
    data object Unsupported : NimbalystAppLink

    companion object {
        fun parse(url: String): NimbalystAppLink {
            val uri = runCatching { URI(url) }.getOrNull() ?: return Unsupported
            if (uri.scheme?.lowercase() != "nimbalyst") return Unsupported
            val host = uri.host?.lowercase()
            val path = uri.path.orEmpty()
            return when {
                host == "auth" && path == "/callback" -> AuthCallback
                host == "pair" -> PairScanner
                host == "session" -> path.trim('/').takeIf { it.isNotEmpty() }?.let(::Session) ?: Unsupported
                host == "console" -> {
                    val canonical = ConsoleRoute.canonicalPath(uri.rawPath.orEmpty())
                    if (canonical == "/app" || canonical.startsWith("/app/")) return ConsolePersonal
                    val route = ConsoleRoute.fullPath(uri)?.let(ConsoleRoute::parse)
                    if (route != null && route.isTeamProjectPath) Console(route) else Unsupported
                }
                else -> Unsupported
            }
        }
    }
}

/** What the Pages WebView does with a navigation it is asked to make. */
sealed interface ConsoleNavigationAction {
    /** Let the WebView perform the navigation. */
    data object Allow : ConsoleNavigationAction
    /** Cancel it and load this console URL through the leave guard instead. */
    data class Load(val url: String) : ConsoleNavigationAction
    /** A Personal page (`/app/...`): only the author's desktop has it. */
    data object PersonalPages : ConsoleNavigationAction
    /** The console wants to sign in. The embedded console never does that itself. */
    data object Reauthenticate : ConsoleNavigationAction
    /** A known app route such as `nimbalyst://session/<id>`. */
    data class AppRoute(val link: NimbalystAppLink) : ConsoleNavigationAction
    /** Another `nimbalyst://` link (tracker, invite, feedback request): desktop only in v1. */
    data object DesktopOnly : ConsoleNavigationAction
    /** Open outside the app (Custom Tab or the mail app), as the transcript does. */
    data class OpenExternally(val url: String) : ConsoleNavigationAction
    data object Cancel : ConsoleNavigationAction
}

/** The Pages screen's navigation table. Pure, so every row is unit tested. */
object ConsoleNavigationPolicy {
    /**
     * @param isMainFrame the navigation targets the top-level document.
     * @param opensNewWindow `target="_blank"` or `window.open`.
     */
    fun decide(
        url: String,
        isMainFrame: Boolean,
        opensNewWindow: Boolean = false,
        environment: ConsoleEnvironment = ConsoleEnvironment.production,
    ): ConsoleNavigationAction {
        val uri = runCatching { URI(url) }.getOrNull()
        val scheme = (uri?.scheme ?: url.substringBefore(':', missingDelimiterValue = "")).lowercase()

        // A subframe never changes what the reader is looking at and never
        // leaves the app. The console's CSP decides which frames may load.
        if (!isMainFrame && !opensNewWindow) {
            return if (scheme in setOf("https", "about", "blob", "data")) ConsoleNavigationAction.Allow else ConsoleNavigationAction.Cancel
        }

        return when (scheme) {
            "about" -> if (url == "about:blank" && !opensNewWindow) ConsoleNavigationAction.Allow else ConsoleNavigationAction.Cancel
            "https", "http" -> when {
                uri == null -> ConsoleNavigationAction.Cancel
                !environment.isConsoleOrigin(uri) -> ConsoleNavigationAction.OpenExternally(url)
                else -> decideConsole(url, uri, opensNewWindow, environment)
            }
            "mailto" -> ConsoleNavigationAction.OpenExternally(url)
            "nimbalyst" -> when (val link = NimbalystAppLink.parse(url)) {
                is NimbalystAppLink.Console ->
                    environment.url(link.route.path)?.let { ConsoleNavigationAction.Load(it) } ?: ConsoleNavigationAction.Cancel
                NimbalystAppLink.ConsolePersonal -> ConsoleNavigationAction.PersonalPages
                is NimbalystAppLink.Session, NimbalystAppLink.PairScanner -> ConsoleNavigationAction.AppRoute(link)
                // Web content must never complete the app's own sign-in.
                NimbalystAppLink.AuthCallback -> ConsoleNavigationAction.Cancel
                NimbalystAppLink.Unsupported ->
                    if (uri?.host?.lowercase() == "console") ConsoleNavigationAction.Cancel else ConsoleNavigationAction.DesktopOnly
            }
            else -> ConsoleNavigationAction.Cancel
        }
    }

    /** Whether native may load [url] itself (a route, a rewrite, re-auth, Retry). */
    fun allowsNativeLoad(url: String, environment: ConsoleEnvironment = ConsoleEnvironment.production): Boolean =
        decide(url, isMainFrame = true, environment = environment) == ConsoleNavigationAction.Allow

    private fun decideConsole(url: String, uri: URI, opensNewWindow: Boolean, environment: ConsoleEnvironment): ConsoleNavigationAction {
        // Classified by the path the server will see, after decoding and dot segments.
        val path = ConsoleRoute.canonicalPath(uri.rawPath.orEmpty())
        val inPlace = if (opensNewWindow) ConsoleNavigationAction.Load(url) else ConsoleNavigationAction.Allow
        return when {
            path == "/app" || path.startsWith("/app/") -> ConsoleNavigationAction.PersonalPages
            path == "/authenticate/native" -> inPlace
            path == "/login" || path.startsWith("/login/") || path == "/authenticate" || path.startsWith("/authenticate/") ->
                ConsoleNavigationAction.Reauthenticate
            path == "/" || ConsoleRoute.fromUrl(url, environment) != null -> inPlace
            // Public wiki pages, `/connect`, and anything else the embed does not
            // host open in the browser (the manifest's App Links filter leaves them there too).
            else -> ConsoleNavigationAction.OpenExternally(url)
        }
    }
}
