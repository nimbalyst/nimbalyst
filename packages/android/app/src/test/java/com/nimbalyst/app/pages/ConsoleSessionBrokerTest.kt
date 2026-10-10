package com.nimbalyst.app.pages

import com.google.gson.JsonParser
import com.nimbalyst.app.pairing.PairingCredentials
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** In-memory [ConsoleKeyValueStore]: what survives a "relaunch" is whatever is in [values]. */
internal class MemoryConsoleStore(val values: MutableMap<String, String> = mutableMapOf()) : ConsoleKeyValueStore {
    override fun getString(key: String): String? = values[key]
    override fun putString(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }
    override fun keys(): Set<String> = values.keys.toSet()
}

/**
 * The broker's state machine with a fake HTTP client: what the personal JWT may
 * reach, one mint per request, account-generation fencing, and the store-removal
 * journal. Mirrors iOS `PagesBrokerTests`.
 */
class ConsoleSessionBrokerTest {
    private val personalJwt = "personal.jwt"
    private val accountSessionToken = "account-session-token"
    private var account: ConsoleAccountContext? = ConsoleAccountContext("acct-1", "https://sync.example", 0)
    private var duringJwtRead: (() -> Unit)? = null
    private val requests = mutableListOf<ConsoleHttpRequest>()
    private val responses = mutableMapOf<String, ConsoleHttpResponse>()
    private var gate: CompletableDeferred<Unit>? = null
    private val stores = FakeStores()

    private val credentials = object : ConsoleCredentials {
        override fun account(): ConsoleAccountContext? = account
        override suspend fun personalJwt(context: ConsoleAccountContext): String? {
            duringJwtRead?.invoke()
            if (account != context) return null
            return if (context.accountId == "acct-1") personalJwt else "${context.accountId}.jwt"
        }
    }

    private val http = ConsoleHttp { request ->
        requests += request
        gate?.await()
        val path = java.net.URI(request.url).path
        responses[path] ?: throw IOException("no stub for $path")
    }

    private class FakeStores : ConsoleWebDataStores {
        val cleared = mutableListOf<String>()
        val deleted = mutableListOf<String>()
        var deleteFailuresRemaining = 0
        override suspend fun clear(profileName: String) {
            cleared += profileName
        }
        override suspend fun delete(profileName: String) {
            if (deleteFailuresRemaining > 0) {
                deleteFailuresRemaining -= 1
                throw IllegalStateException("profile loaded in this process")
            }
            deleted += profileName
        }
    }

    private fun broker(store: MemoryConsoleStore = MemoryConsoleStore()) = ConsoleSessionBroker(
        credentials = credentials,
        dataStores = stores,
        http = http,
        orgChoices = ConsoleOrgChoiceStore(store),
        profiles = ConsoleProfileLedger(store),
    )

    private fun stub(path: String, status: Int, body: String) {
        responses[path] = ConsoleHttpResponse(status, body)
    }

    private val minted = """{"sessionToken":"minted-token","sessionJwt":"minted.jwt","orgId":"organization-team","memberId":"member-1","expiresAt":"2026-10-16T00:00:00Z"}"""

    @Test
    fun `mint sends only the org id and keeps every token out of URLs`() = runTest {
        stub(ConsoleSessionBroker.MINT_PATH, 200, minted)
        val delivery = broker().answer("r1", "organization-team", null, account!!)

        assertEquals(
            mapOf("requestId" to "r1", "orgId" to "organization-team", "sessionToken" to "minted-token", "sessionJwt" to "minted.jwt"),
            delivery?.payload,
        )
        val mint = requests.single()
        assertEquals("POST", mint.method)
        assertEquals("https://sync.example/auth/console-session", mint.url)
        assertEquals("Bearer $personalJwt", mint.headers["Authorization"])
        assertEquals(mapOf("orgId" to "organization-team"), JsonParser.parseString(mint.body).asJsonObject.entrySet().associate { it.key to it.value.asString })
        for (secret in listOf("minted-token", "minted.jwt", personalJwt, accountSessionToken)) {
            assertFalse("no credential in a URL", requests.any { it.url.contains(secret) })
        }
        // The broker has no way to write the account; a mint leaves it as it was.
        assertEquals(ConsoleAccountContext("acct-1", "https://sync.example", 0), account)
    }

    @Test
    fun `one mint per request id and one per expiry`() = runTest {
        stub(ConsoleSessionBroker.MINT_PATH, 200, minted)
        val broker = broker()
        broker.answer("r1", null, "organization-team", account!!)
        assertNull("a repeated post of one request never mints twice", broker.answer("r1", null, "organization-team", account!!))
        assertEquals(1, requests.size)
        broker.answer("r2", "organization-team", null, account!!)
        assertEquals("a new sessionExpired re-mints exactly once", 2, requests.size)
        // No org at all: refused without a request.
        val unknown = broker.answer("r3", null, null, account!!)
        assertEquals(ConsoleMintOutcome.Refused(ConsoleSessionDeliveryError.FAILED, null, "unknown_org"), unknown?.outcome)
        assertEquals(2, requests.size)
    }

    @Test
    fun `refusals map to delivery errors`() {
        fun outcome(status: Int, body: String) = ConsoleSessionBroker.mintOutcome(status, body, "organization-team")
        fun refused(code: ConsoleSessionDeliveryError, reason: String?) = ConsoleMintOutcome.Refused(code, "organization-team", reason)

        assertEquals(refused(ConsoleSessionDeliveryError.ORG_AUTH_REQUIRED, "mfa_required"), outcome(403, """{"error":"org_auth_required","reason":"mfa_required"}"""))
        assertEquals(refused(ConsoleSessionDeliveryError.ORG_AUTH_REQUIRED, "primary_auth_required"), outcome(403, """{"error":"org_auth_required","reason":"primary_auth_required"}"""))
        assertEquals(refused(ConsoleSessionDeliveryError.NOT_A_MEMBER, null), outcome(403, """{"error":"not_a_member"}"""))
        assertEquals(refused(ConsoleSessionDeliveryError.FAILED, "not_a_team_org"), outcome(403, """{"error":"not_a_team_org"}"""))
        assertEquals(refused(ConsoleSessionDeliveryError.FAILED, "personal_scope_required"), outcome(403, """{"error":"personal_scope_required"}"""))
        assertEquals(refused(ConsoleSessionDeliveryError.UNAVAILABLE, "console_session_unavailable"), outcome(503, """{"error":"console_session_unavailable"}"""))
        assertEquals(refused(ConsoleSessionDeliveryError.FAILED, "console_session_failed"), outcome(502, """{"error":"console_session_failed"}"""))
        assertEquals(refused(ConsoleSessionDeliveryError.FAILED, "unauthorized"), outcome(401, """{"error":"unauthorized"}"""))
        assertEquals(refused(ConsoleSessionDeliveryError.FAILED, "http_500"), outcome(500, "<html>"))
        // A session for a different org than requested is never delivered.
        assertEquals(refused(ConsoleSessionDeliveryError.FAILED, "malformed_response"), outcome(200, """{"sessionToken":"t","sessionJwt":"j","orgId":"organization-other"}"""))
        val delivery = ConsoleSessionDelivery("r", ConsoleMintOutcome.Refused(ConsoleSessionDeliveryError.ORG_AUTH_REQUIRED, "o", "mfa_required"))
        assertEquals(mapOf("requestId" to "r", "error" to "org_auth_required", "orgId" to "o", "reason" to "mfa_required"), delivery.payload)
        assertEquals(PagesSessionFailure.NETWORK, PagesWebController.sessionFailure(ConsoleSessionDeliveryError.FAILED, "timeout"))
        assertEquals(PagesSessionFailure.SIGN_IN_REFRESH, PagesWebController.sessionFailure(ConsoleSessionDeliveryError.FAILED, "personal_session_unavailable"))
    }

    @Test
    fun `personal JWT only goes to the mint route and the team directory`() = runTest {
        stub(ConsoleSessionBroker.MINT_PATH, 403, """{"error":"not_a_member"}""")
        stub(ConsoleSessionBroker.TEAMS_PATH, 200, """{"teams":[]}""")
        val broker = broker()
        broker.mint("organization-team")
        broker.teams()
        assertEquals(setOf("/auth/console-session", "/api/teams"), requests.map { java.net.URI(it.url).path }.toSet())
        assertTrue(requests.all { it.headers["Authorization"] == "Bearer $personalJwt" })
        // Transport failures are an outcome, never a throw.
        responses.clear()
        assertEquals(ConsoleMintOutcome.Refused(ConsoleSessionDeliveryError.FAILED, "organization-team", "network"), broker.mint("organization-team"))
    }

    @Test
    fun `signed out mints nothing`() = runTest {
        account = null
        assertEquals(ConsoleMintOutcome.Refused(ConsoleSessionDeliveryError.FAILED, "organization-team", "signed_out"), broker().mint("organization-team"))
        assertTrue(requests.isEmpty())
    }

    @Test
    fun `sign out journals the profile at once, and signing in again gets a fresh profile`() = runTest {
        val disk = MemoryConsoleStore()
        val broker = broker(disk)
        broker.rememberOrgChoice("organization-team", "/p")
        val first = broker.profileFor("acct-1")
        assertEquals("stable until sign-out", first, broker.profileFor("acct-1"))
        assertTrue(first.startsWith(ConsoleSessionBroker.profileName("acct-1") + "-"))

        val journaled = broker.accountSignedOut("acct-1")
        // Nothing has suspended: this is what a process death right now leaves behind.
        assertEquals(listOf(first), journaled)
        assertEquals(listOf(first), ConsoleProfileLedger(disk).pendingDeletions)
        assertNull(broker.rememberedOrgId("/p"))

        // In-process the loaded profile can only be cleared, never deleted.
        broker.clearProfiles(journaled)
        assertEquals(listOf(first), stores.cleared)
        assertTrue(stores.deleted.isEmpty())
        assertEquals("a cleared profile is still journaled", listOf(first), ConsoleProfileLedger(disk).pendingDeletions)

        val second = broker.profileFor("acct-1")
        assertNotEquals("a re-sign-in never reuses the signed-out profile", first, second)
        assertEquals("an account that never opened Pages journals nothing", emptyList<String>(), broker.accountSignedOut("never-opened"))
    }

    @Test
    fun `cold start deletes journaled and orphaned profiles and keeps the signed-in one`() = runTest {
        val disk = MemoryConsoleStore()
        val before = broker(disk)
        val signedOut = before.profileFor("a")
        before.accountSignedOut("a")
        // The process died after B's profile was created but before B's sign-out was seen.
        val orphan = before.profileFor("b")
        val current = before.profileFor("acct-1")

        val relaunched = broker(disk)
        relaunched.deletePendingAtColdStart(currentAccountId = "acct-1")
        assertEquals(setOf(signedOut, orphan), stores.deleted.toSet())
        assertTrue(ConsoleProfileLedger(disk).pendingDeletions.isEmpty())
        assertEquals("the signed-in account keeps its profile", current, relaunched.profileFor("acct-1"))
    }

    @Test
    fun `a profile that cannot be deleted stays journaled for the next start`() = runTest {
        val disk = MemoryConsoleStore()
        val broker = broker(disk)
        val name = broker.profileFor("acct-1")
        broker.accountSignedOut("acct-1")
        stores.deleteFailuresRemaining = 1
        broker(disk).deletePendingAtColdStart(currentAccountId = null)
        assertEquals(listOf(name), ConsoleProfileLedger(disk).pendingDeletions)
        broker(disk).deletePendingAtColdStart(currentAccountId = null)
        assertEquals(listOf(name), stores.deleted)
        assertTrue(ConsoleProfileLedger(disk).pendingDeletions.isEmpty())
        assertFalse("no shared-profile path", PagesWebSupport(bridge = true, multiProfile = false).supported)
    }

    @Test
    fun `a stale selection gets no session`() = runTest {
        stub(ConsoleSessionBroker.MINT_PATH, 200, minted)
        val broker = broker()
        val old = account!!
        account = ConsoleAccountContext("acct-1", "https://sync.example", 7)
        assertNull(broker.answer("r1", "organization-team", null, old))
        assertTrue(requests.isEmpty())
    }

    @Test
    fun `a switch during the mint drops the answer`() = runTest {
        stub(ConsoleSessionBroker.MINT_PATH, 200, minted)
        gate = CompletableDeferred()
        val broker = broker()
        val original = account!!
        val delivery = async { broker.answer("r1", "organization-team", null, original) }
        runCurrent()
        assertEquals(1, requests.size)
        account = ConsoleAccountContext("acct-2", "https://acct-2.example", 1)
        gate!!.complete(Unit)
        assertNull("minted for A, never handed to B's selection", delivery.await())
    }

    @Test
    fun `a switch during the directory JWT read sends nothing`() = runTest {
        stub(ConsoleSessionBroker.TEAMS_PATH, 200, """{"teams":[]}""")
        duringJwtRead = { account = ConsoleAccountContext("acct-2", "https://acct-2.example", 1) }
        assertEquals(ConsoleTeamsOutcome.Failed("account_changed"), broker().teams())
        assertTrue("B's JWT never goes to A's API base", requests.isEmpty())
    }

    @Test
    fun `a switch during the directory request discards the result`() = runTest {
        stub(ConsoleSessionBroker.TEAMS_PATH, 200, """{"teams":[{"orgId":"organization-team","name":"Team","projects":[]}]}""")
        gate = CompletableDeferred()
        val broker = broker()
        val first = async { broker.teams() }
        runCurrent()
        account = ConsoleAccountContext("acct-2", "https://acct-2.example", 1)
        broker.selectionChanged()
        gate!!.complete(Unit)
        assertEquals(ConsoleTeamsOutcome.Failed("account_changed"), first.await())

        gate = null
        val fresh = broker.teams()
        assertTrue("B reads its own directory: $fresh", fresh is ConsoleTeamsOutcome.Loaded)
        assertEquals("acct-2.example", java.net.URI(requests.last().url).host)
        assertEquals("Bearer acct-2.jwt", requests.last().headers["Authorization"])
        assertEquals("Bearer $personalJwt", requests.first().headers["Authorization"])
    }

    @Test
    fun `teams are cached per account`() = runTest {
        stub(ConsoleSessionBroker.TEAMS_PATH, 200, """{"teams":[{"orgId":"organization-team","name":"Team","projects":[]}]}""")
        val broker = broker()
        broker.teams()
        broker.teams()
        assertEquals(1, requests.size)
        account = ConsoleAccountContext("acct-2", "https://sync.example")
        broker.teams()
        assertEquals("another account never reads the first account's cache", 2, requests.size)
    }

    @Test
    fun `resolver matches the remote hash in active orgs`() {
        val teams = listOf(
            ConsoleTeamSummary("organization-a", "A", projects = listOf(ConsoleTeamSummary.TeamProject("x", "tp-a", "hash1"))),
            ConsoleTeamSummary("organization-b", "B", gitRemoteHash = "hash1", teamProjectId = "tp-b"),
            ConsoleTeamSummary("organization-c", "C", membershipType = "pending_member", projects = listOf(ConsoleTeamSummary.TeamProject("y", "tp-c", "hash1"))),
            ConsoleTeamSummary("organization-d", "D", projects = listOf(ConsoleTeamSummary.TeamProject("z", "tp-d", "other"))),
        )
        val matches = ConsoleTeamResolver.matches("hash1", teams)
        assertEquals(listOf("organization-a/tp-a", "organization-b/tp-b"), matches.map { it.id })
        assertEquals(ConsoleProjectMapping.NeedsChoice(matches), ConsoleTeamResolver.mapping("hash1", teams, null))
        assertEquals(ConsoleProjectMapping.Mapped(matches[1]), ConsoleTeamResolver.mapping("hash1", teams, "organization-b"))
        assertEquals(ConsoleProjectMapping.Mapped(ConsoleTeamProjectMatch("organization-d", "D", "tp-d")), ConsoleTeamResolver.mapping("other", teams, null))
        assertEquals(ConsoleProjectMapping.Unmapped, ConsoleTeamResolver.mapping(null, teams, null))
        assertEquals("/org/organization-a/project/tp-a/wiki", matches[0].wikiRoute?.path)

        val parsed = ConsoleTeamSummary.parseResponse(
            """{"teams":[{"orgId":"organization-a","name":"A","membershipType":"active_member","projects":[{"projectId":"x","teamProjectId":"tp-a","gitRemoteHash":"hash1","name":"Repo"},{"projectId":"bad"}]},{"name":"no org"}]}"""
        )
        assertEquals(listOf(ConsoleTeamSummary("organization-a", "A", "active_member", projects = listOf(ConsoleTeamSummary.TeamProject("x", "tp-a", "hash1", "Repo")))), parsed)
        assertNull(ConsoleTeamSummary.parseResponse("""{"nope":[]}"""))
    }

    @Test
    fun `account tracker bumps the generation and reports the previous account synchronously`() {
        val signedIn = PairingCredentials(serverUrl = "wss://sync.example", encryptionSeed = "seed", authJwt = "jwt", authUserId = "member-1", sessionToken = accountSessionToken)
        var credentials: PairingCredentials? = signedIn
        val changes = mutableListOf<String?>()
        val tracker = ConsoleAccountTracker(read = { credentials }, onChange = { changes += it })

        val first = tracker.current()!!
        assertEquals("https://sync.example", first.apiBase)
        assertFalse("the account id never carries the member id in the clear", first.accountId.contains("member-1"))
        // A JWT refresh is the same selection.
        credentials = signedIn.copy(authJwt = "jwt-2", sessionToken = "rotated")
        assertEquals(first, tracker.current())

        credentials = signedIn.copy(authJwt = null, authUserId = null, sessionToken = null)
        assertNull(tracker.current())
        assertEquals(listOf(first.accountId), changes)

        credentials = signedIn
        val again = tracker.current()!!
        assertEquals(first.accountId, again.accountId)
        assertNotEquals("signing in again is a new selection", first, again)
        assertEquals(listOf(first.accountId, null), changes)

        assertEquals("about to expire", null, ConsoleJwt.fresh(jwtExpiringAt(30), nowMs = 0))
        assertEquals(jwtExpiringAt(3_600), ConsoleJwt.fresh(jwtExpiringAt(3_600), nowMs = 0))
    }

    private fun jwtExpiringAt(seconds: Long): String {
        val payload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("""{"exp":$seconds}""".toByteArray())
        return "h.$payload.s"
    }
}
