package com.nimbalyst.app.pages

import com.nimbalyst.app.DeepLinkRoute
import com.nimbalyst.app.routeDeepLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every row of the Pages navigation table (plan section 5), the inbound link
 * parsers that feed it, the bridge gate, and the scripts native runs in the page.
 */
class ConsoleNavigationPolicyTest {
    private val team = "https://console.nimbalyst.com/org/organization-abc/project/p1"

    private fun decide(raw: String, main: Boolean = true, newWindow: Boolean = false) =
        ConsoleNavigationPolicy.decide(raw, isMainFrame = main, opensNewWindow = newWindow)

    @Test
    fun `policy table`() {
        val cases: List<Triple<String, Pair<Boolean, Boolean>, ConsoleNavigationAction>> = listOf(
            // Team paths stay in the WebView.
            Triple("$team/wiki", true to false, ConsoleNavigationAction.Allow),
            Triple("$team/pages", true to false, ConsoleNavigationAction.Allow),
            Triple("$team/document/d1", true to false, ConsoleNavigationAction.Allow),
            Triple("$team/page/item/NIM-1", true to false, ConsoleNavigationAction.Allow),
            Triple("$team/page/type/t1", true to false, ConsoleNavigationAction.Allow),
            Triple("$team/view/v1", true to false, ConsoleNavigationAction.Allow),
            Triple("$team/marks", true to false, ConsoleNavigationAction.Allow),
            Triple("$team/trackers/item/i1?tab=body#top", true to false, ConsoleNavigationAction.Allow),
            Triple("https://console.nimbalyst.com/", true to false, ConsoleNavigationAction.Allow),
            Triple("https://console.nimbalyst.com/authenticate/native?orgId=organization-abc", true to false, ConsoleNavigationAction.Allow),
            // A `_blank` team link loads in the same WebView, through the leave guard.
            Triple("$team/wiki", true to true, ConsoleNavigationAction.Load("$team/wiki")),
            // Personal pages are desktop-only.
            Triple("https://console.nimbalyst.com/app/doc/1", true to false, ConsoleNavigationAction.PersonalPages),
            Triple("nimbalyst://console/app/doc/1", true to false, ConsoleNavigationAction.PersonalPages),
            // Console login never renders in the embed.
            Triple("https://console.nimbalyst.com/login", true to false, ConsoleNavigationAction.Reauthenticate),
            Triple("https://console.nimbalyst.com/authenticate?token=x", true to false, ConsoleNavigationAction.Reauthenticate),
            Triple("https://console.nimbalyst.com/authenticate/other", true to false, ConsoleNavigationAction.Reauthenticate),
            // nimbalyst://console rewrites to the https console path.
            Triple("nimbalyst://console/org/organization-abc/project/p1/wiki", true to false, ConsoleNavigationAction.Load("$team/wiki")),
            Triple("nimbalyst://console/org/../etc", true to false, ConsoleNavigationAction.Cancel),
            // Known app routes go to the app router; auth callbacks never do.
            Triple("nimbalyst://session/s1", true to false, ConsoleNavigationAction.AppRoute(NimbalystAppLink.Session("s1"))),
            Triple("nimbalyst://pair?data=x", true to false, ConsoleNavigationAction.AppRoute(NimbalystAppLink.PairScanner)),
            Triple("nimbalyst://auth/callback?token=x", true to false, ConsoleNavigationAction.Cancel),
            // Other app links are desktop-only in v1.
            Triple("nimbalyst://tracker/NIM-1", true to false, ConsoleNavigationAction.DesktopOnly),
            Triple("nimbalyst://invite/abc", true to false, ConsoleNavigationAction.DesktopOnly),
            // Other http(s), and console paths the embed does not host, open in the browser.
            Triple("https://example.com/a", true to false, ConsoleNavigationAction.OpenExternally("https://example.com/a")),
            Triple("https://example.com/a", true to true, ConsoleNavigationAction.OpenExternally("https://example.com/a")),
            Triple(
                "http://console.nimbalyst.com/org/organization-abc", true to false,
                ConsoleNavigationAction.OpenExternally("http://console.nimbalyst.com/org/organization-abc"),
            ),
            Triple(
                "https://console.nimbalyst.com:8443/org/organization-abc/project/p1/wiki", true to false,
                ConsoleNavigationAction.OpenExternally("https://console.nimbalyst.com:8443/org/organization-abc/project/p1/wiki"),
            ),
            Triple(
                "https://console.nimbalyst.com/public/wiki/x", true to false,
                ConsoleNavigationAction.OpenExternally("https://console.nimbalyst.com/public/wiki/x"),
            ),
            Triple("https://console.nimbalyst.com/connect", true to false, ConsoleNavigationAction.OpenExternally("https://console.nimbalyst.com/connect")),
            Triple("mailto:a@b.c", true to false, ConsoleNavigationAction.OpenExternally("mailto:a@b.c")),
            // Anything else is cancelled.
            Triple("about:blank", true to false, ConsoleNavigationAction.Allow),
            Triple("about:srcdoc", true to false, ConsoleNavigationAction.Cancel),
            Triple("javascript:alert(1)", true to false, ConsoleNavigationAction.Cancel),
            Triple("file:///etc/passwd", true to false, ConsoleNavigationAction.Cancel),
            Triple("data:text/html,hi", true to false, ConsoleNavigationAction.Cancel),
            Triple("intent://x#Intent;scheme=nimbalyst;end", true to false, ConsoleNavigationAction.Cancel),
            // Subframes load what the CSP allows and never leave the app.
            Triple("https://js.stytch.com/frame", false to false, ConsoleNavigationAction.Allow),
            Triple("about:srcdoc", false to false, ConsoleNavigationAction.Allow),
            Triple("nimbalyst://session/s1", false to false, ConsoleNavigationAction.Cancel),
            Triple("javascript:alert(1)", false to false, ConsoleNavigationAction.Cancel),
        )
        for ((raw, frame, expected) in cases) {
            assertEquals(raw, expected, decide(raw, main = frame.first, newWindow = frame.second))
        }
    }

    @Test
    fun `app link router has a console case`() {
        assertEquals(
            NimbalystAppLink.Console(ConsoleRoute.parse("/org/organization-abc/project/p1/page/item/NIM-1?x=1")!!),
            NimbalystAppLink.parse("nimbalyst://console/org/organization-abc/project/p1/page/item/NIM-1?x=1"),
        )
        assertEquals(NimbalystAppLink.ConsolePersonal, NimbalystAppLink.parse("nimbalyst://console/app/x"))
        // Org-level pages and malformed paths are not Pages destinations.
        assertEquals(NimbalystAppLink.Unsupported, NimbalystAppLink.parse("nimbalyst://console/org/organization-abc/admin"))
        assertEquals(NimbalystAppLink.Unsupported, NimbalystAppLink.parse("nimbalyst://console/org/organization-abc/project/%2e%2e/x"))
        assertEquals(NimbalystAppLink.Session("s1"), NimbalystAppLink.parse("nimbalyst://session/s1"))

        // MainActivity's deep-link router sends both forms to Pages, and nothing else.
        assertEquals(DeepLinkRoute.CONSOLE, routeDeepLink("console", "/org/organization-abc/project/p1/wiki"))
        assertEquals(DeepLinkRoute.CONSOLE, routeDeepLink("console.nimbalyst.com", "/org/o/project/p/wiki", "https"))
        assertEquals(DeepLinkRoute.UNSUPPORTED, routeDeepLink("example.com", "/org/o/project/p/wiki", "https"))
        assertEquals(DeepLinkRoute.SESSION, routeDeepLink("session", "/s1"))
    }

    @Test
    fun `route parsing rejects traversal and keeps the team project`() {
        val route = ConsoleRoute.parse("/org/organization-abc/project/team%20one/wiki?x=1#y")!!
        assertEquals("organization-abc", route.orgId)
        assertEquals("team one", route.teamProjectId)
        assertNull(ConsoleRoute.parse("/org/organization-abc/project/p1/../../app"))
        assertNull(ConsoleRoute.parse("/org/organization-abc/project/p1/a%2Fb"))
        assertNull(ConsoleRoute.parse("/org//project/p1"))
        assertNull(ConsoleRoute.parse("/org/organization-abc/project/p 1"))
        assertNull(ConsoleRoute.parse("/app/x"))
        assertNull(ConsoleRoute.fromUrl("https://evil.example/org/organization-abc/project/p1/wiki"))
        assertEquals(null, ConsoleRoute.parse("/org/acme")?.orgId)
        assertEquals("/org/organization-a/project/p%201/wiki", ConsoleRoute.wiki("organization-a", "p 1")?.path)
        assertEquals("/org/organization-a/project/p1/trackers", ConsoleRoute.trackers("organization-a", "p1")?.path)
    }

    @Test
    fun `encoded dot segments are judged by the path the server will see`() {
        val escape = ".%2e/.%2e/.%2e/.%2e"
        // `nimbalyst://console/org/o/project/p/.%2e/.%2e/.%2e/.%2e/app/private` normalizes to /app/private.
        assertEquals(ConsoleNavigationAction.PersonalPages, decide("nimbalyst://console/org/organization-abc/project/p1/$escape/app/private"))
        assertEquals(ConsoleNavigationAction.PersonalPages, decide("$team/$escape/app/private"))
        assertEquals(ConsoleNavigationAction.Reauthenticate, decide("$team/%2e./%2E%2E/%2e%2e/%2e./login"))
        assertEquals(NimbalystAppLink.ConsolePersonal, NimbalystAppLink.parse("nimbalyst://console/org/organization-abc/project/p1/$escape/app/x"))
        assertEquals("/app/private", ConsoleRoute.canonicalPath("/org/o/project/p/$escape/app/private"))

        for (segment in listOf(".%2e", "%2e.", "%2E%2E", "%2e", "a%2fb", "a%2Fb", "a%5cb", "%zz", "%c3%28", "%00")) {
            assertNull(segment, ConsoleRoute.parse("/org/organization-abc/project/p1/$segment/wiki"))
        }
        assertNull(ConsoleRoute.parse("/org/organization-abc/project/%2e%2e/wiki"))
        assertEquals("caf\u00e9", ConsoleRoute.parse("/org/organization-abc/project/caf%C3%A9/wiki")?.teamProjectId)

        // Native loads pass the same policy, on the canonical path.
        assertFalse(ConsoleNavigationPolicy.allowsNativeLoad("$team/$escape/app/private"))
        assertFalse(ConsoleNavigationPolicy.allowsNativeLoad("https://example.com/org/organization-abc/project/p1/wiki"))
        assertTrue(ConsoleNavigationPolicy.allowsNativeLoad("$team/wiki"))
        assertTrue(ConsoleNavigationPolicy.allowsNativeLoad("https://console.nimbalyst.com/authenticate/native?orgId=organization-abc&returnTo=%2Forg"))
    }

    @Test
    fun `inbox takes only team pages, and only when signed in`() {
        val inbox = ConsoleLinkInbox()
        assertEquals(InboundConsoleLink.OPENED, inbox.handleInbound("$team/wiki", signedIn = true))
        assertEquals("/org/organization-abc/project/p1/wiki", inbox.route.value?.path)

        val signedOut = ConsoleLinkInbox()
        // An App Link goes back to the browser rather than dead-ending in a signed-out app.
        assertEquals(InboundConsoleLink.OPEN_IN_BROWSER, signedOut.handleInbound("$team/wiki", signedIn = false))
        assertEquals(InboundConsoleLink.SIGN_IN_REQUIRED, signedOut.handleInbound("nimbalyst://console/org/organization-abc/project/p1/wiki", signedIn = false))
        assertNull(signedOut.route.value)

        assertEquals(InboundConsoleLink.PERSONAL, signedOut.handleInbound("nimbalyst://console/app/doc", signedIn = true))
        assertTrue(signedOut.personalPageRequested.value)
        assertEquals(InboundConsoleLink.OPEN_IN_BROWSER, signedOut.handleInbound("https://console.nimbalyst.com/org/organization-abc/settings", signedIn = true))
        assertEquals(InboundConsoleLink.UNSUPPORTED, signedOut.handleInbound("nimbalyst://console/org/organization-abc/admin", signedIn = true))
        assertFalse(signedOut.openPath("/org/organization-abc/settings"))
        assertTrue(signedOut.openPath("/org/organization-abc/project/p1/trackers"))
    }

    @Test
    fun `bridge accepts only well-formed main-frame console-origin messages`() {
        val env = ConsoleEnvironment.production
        val origin = "https://console.nimbalyst.com"
        fun accept(body: String, from: String = origin, main: Boolean = true) = ConsoleBridgeMessage.accept(body, from, main, env)

        assertEquals(ConsoleBridgeMessage.Ready(1), accept("""{"type":"ready","protocol":1}"""))
        assertEquals(ConsoleBridgeMessage.RequestSession("r1", "organization-a"), accept("""{"type":"requestSession","requestId":"r1","orgId":"organization-a"}"""))
        assertEquals(ConsoleBridgeMessage.SessionExpired("r2", null), accept("""{"type":"sessionExpired","requestId":"r2","orgId":null}"""))
        assertEquals(ConsoleBridgeMessage.EditState(editing = true, unsynced = true), accept("""{"type":"editState","editing":true,"unsynced":true}"""))
        assertEquals(
            ConsoleBridgeMessage.FlushResult("f1", ConsoleFlushResult(ConsoleFlushResult.Status.TIMED_OUT, null)),
            accept("""{"type":"flushResult","requestId":"f1","status":"timed-out","detail":null}"""),
        )
        assertEquals(
            ConsoleBridgeMessage.FlushResult("f2", ConsoleFlushResult(ConsoleFlushResult.Status.FAILED, "malformed-flush-result")),
            accept("""{"type":"flushResult","requestId":"f2","status":"done"}"""),
        )
        assertEquals(ConsoleBridgeMessage.DocumentStart("0123456789abcdef0123456789abcdef"), accept("""{"type":"documentStart","nonce":"0123456789abcdef0123456789abcdef"}"""))

        // Subframes, other origins, and malformed bodies are dropped.
        val ready = """{"type":"ready","protocol":1}"""
        assertNull(accept(ready, main = false))
        assertNull(accept(ready, from = "https://evil.example"))
        assertNull(accept(ready, from = "http://console.nimbalyst.com"))
        assertNull(accept(ready, from = "null"))
        assertNull(accept("""{"type":"documentStart","nonce":"ABCDEF"}"""))
        assertNull(accept("""{"type":"requestSession","requestId":"r1"}"""))
        assertNull(accept("""{"type":"unknown"}"""))
        assertNull(accept("not json"))
        assertNull(accept("""["ready"]"""))
    }

    @Test
    fun `delivery script refuses a different origin or document, and never splices raw values`() {
        val env = ConsoleEnvironment.production
        val payload = mapOf("requestId" to "r1", "orgId" to "organization-a", "sessionToken" to "tok\"en</script> ", "sessionJwt" to "a.b.c")
        val script = ConsoleScripts.deliverSession(payload, env, "0123456789abcdef0123456789abcdef")

        // The origin and nonce checks come before the bridge is touched.
        val guard = script.indexOf("window.location.origin !== \"https://console.nimbalyst.com\"")
        val nonce = script.indexOf("window.__nimbalystDocumentNonce !== \"0123456789abcdef0123456789abcdef\"")
        val deliver = script.indexOf("deliverSession(")
        assertTrue(guard in 0 until deliver)
        assertTrue(nonce in 0 until deliver)
        assertTrue(script.contains("return 'wrong-document'"))
        // Every value is a JSON literal: no raw quote, tag or line separator reaches the source.
        assertTrue(script.contains("\"sessionToken\":\"tok\\\"en\\u003c/script\\u003e\\u2028\""))
        assertFalse(script.contains("</script>"))
        assertFalse(script.contains(" "))

        val marker = ConsoleScripts.embedMarker(env, "1.2.3")
        assertTrue(marker.contains("if (window.top !== window) return;"))
        assertTrue(marker.indexOf("window.location.origin !== \"https://console.nimbalyst.com\"") < marker.indexOf("__NIMBALYST_EMBED__"))
        assertTrue(marker.contains("platform: 'android'"))
        assertTrue(marker.contains("bridge: \"nimbalystConsole\""))

        val flush = ConsoleScripts.flushPending(5000, "f\"1", env)
        assertTrue(flush.indexOf("window.location.origin !==") < flush.indexOf("flushPending("))
        assertTrue(flush.contains("b.flushPending(5000, \"f\\\"1\")"))

        assertEquals("wrong-document", ConsoleScripts.decodeResult("\"wrong-document\""))
        assertEquals(true, ConsoleScripts.decodeResult("true"))
        assertEquals(3.0, ConsoleScripts.decodeResult("3"))
        assertNull(ConsoleScripts.decodeResult("null"))
        assertNull(ConsoleScripts.decodeResult("{}"))
    }
}
