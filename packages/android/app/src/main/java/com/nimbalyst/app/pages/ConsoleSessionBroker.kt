package com.nimbalyst.app.pages

import android.util.Log
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.IOException
import java.io.InterruptedIOException
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred

private const val TAG = "ConsolePages"

/**
 * The account a console session is minted for, and where its API lives.
 *
 * [generation] changes on every pairing, sign-in, sign-out and account change.
 * Two contexts are equal only if they belong to the same selection, so work
 * captured under one selection can never act under the next.
 */
data class ConsoleAccountContext(
    val accountId: String,
    /** `https://<sync host>`: the account's server URL with ws(s) mapped to http(s). */
    val apiBase: String,
    val generation: Long = 0,
) {
    companion object {
        /** Map a stored `wss://...` server URL to its HTTP base. */
        fun apiBase(fromServerUrl: String): String? {
            val base = fromServerUrl.replace("wss://", "https://").replace("ws://", "http://").trimEnd('/')
            val uri = runCatching { java.net.URI(base) }.getOrNull() ?: return null
            if ((uri.scheme != "https" && uri.scheme != "http") || uri.host.isNullOrEmpty()) return null
            return base
        }
    }
}

/**
 * How the broker reads the selected account. It has no way to write one: a
 * mint must never store into, or rotate, the account's own session.
 */
interface ConsoleCredentials {
    fun account(): ConsoleAccountContext?

    /**
     * The personal JWT for exactly [context], not about to expire, or null when
     * [context] is no longer the current selection (before or after a refresh).
     */
    suspend fun personalJwt(context: ConsoleAccountContext): String?
}

data class ConsoleHttpRequest(val method: String, val url: String, val headers: Map<String, String>, val body: String?)
data class ConsoleHttpResponse(val status: Int, val body: String)

/** One HTTP exchange. Throws [IOException] (an [InterruptedIOException] for a timeout) on transport failure. */
fun interface ConsoleHttp {
    suspend fun execute(request: ConsoleHttpRequest): ConsoleHttpResponse
}

/**
 * The androidx.webkit profiles that hold console data, one per account sign-in.
 * A profile loaded in this process cannot be deleted until the next process, so
 * removal is two steps: [clear] what can be cleared now, [delete] at the next
 * cold start before any profile is loaded.
 */
interface ConsoleWebDataStores {
    /** Best effort, in this process: drop the profile's cookies and storage. Not a removal. */
    suspend fun clear(profileName: String)
    /** Delete a profile not loaded in this process. Throws when it is still there. */
    suspend fun delete(profileName: String)
}

/**
 * Which profile each account uses, and which profiles must be deleted.
 *
 * A name is assigned (and persisted) before its profile is first created, with a
 * random suffix, so signing in again gets a fresh profile at once instead of
 * waiting on one this process cannot delete. Journaling moves a name to the
 * deletion list in one synchronous write, before the mapping is dropped, so a
 * process death at any point leaves the profile recorded.
 */
class ConsoleProfileLedger(
    private val store: ConsoleKeyValueStore,
    private val newSuffix: () -> String = { java.util.UUID.randomUUID().toString().replace("-", "").take(16) },
) {
    val pendingDeletions: List<String> get() = store.getStringList(PENDING_KEY)

    fun profileName(accountId: String): String? = store.getString(ASSIGNED_PREFIX + accountId)

    /** The account's profile name, assigning a new one when it has none. */
    fun assign(accountId: String): String =
        profileName(accountId) ?: (ConsoleSessionBroker.profileName(accountId) + "-" + newSuffix()).also {
            store.putString(ASSIGNED_PREFIX + accountId, it)
        }

    /** Journal the profiles of [accountIds] for deletion and forget them. Returns the names journaled. */
    fun journal(accountIds: List<String>): List<String> {
        val assigned = accountIds.distinct().mapNotNull { id -> profileName(id)?.let { id to it } }
        if (assigned.isEmpty()) return emptyList()
        val pending = pendingDeletions
        store.putStringList(PENDING_KEY, pending + assigned.map { it.second }.filter { it !in pending })
        assigned.forEach { (id, _) -> store.putString(ASSIGNED_PREFIX + id, null) }
        return assigned.map { it.second }
    }

    /** Every account with a profile other than [accountId]. */
    fun accountsOtherThan(accountId: String?): List<String> =
        store.keys().filter { it.startsWith(ASSIGNED_PREFIX) }.map { it.removePrefix(ASSIGNED_PREFIX) }.filter { it != accountId }

    fun deleted(profileName: String) = store.putStringList(PENDING_KEY, pendingDeletions - profileName)

    companion object {
        const val PENDING_KEY = "consolePages.pendingProfileDeletions"
        const val ASSIGNED_PREFIX = "consolePages.profile."
    }
}

data class ConsoleSessionTokens(val orgId: String, val sessionToken: String, val sessionJwt: String) {
    override fun toString(): String = "ConsoleSessionTokens(orgId=$orgId, <redacted>)"
}

/** The error codes `deliverSession` accepts (`nativeSession.ts`). */
enum class ConsoleSessionDeliveryError(val raw: String) {
    ORG_AUTH_REQUIRED("org_auth_required"),
    NOT_A_MEMBER("not_a_member"),
    UNAVAILABLE("unavailable"),
    FAILED("failed"),
}

sealed interface ConsoleMintOutcome {
    data class Minted(val tokens: ConsoleSessionTokens) : ConsoleMintOutcome
    data class Refused(val error: ConsoleSessionDeliveryError, val orgId: String?, val reason: String?) : ConsoleMintOutcome
}

/** One answer to a console `requestSession` / `sessionExpired`. */
data class ConsoleSessionDelivery(
    val requestId: String,
    val outcome: ConsoleMintOutcome,
    /** The selection this answer was minted under. Delivered only while it is current. */
    val account: ConsoleAccountContext? = null,
) {
    /** The argument to `window.__nimbalystConsoleBridge.deliverSession`. Never part of a URL. */
    val payload: Map<String, String>
        get() = when (outcome) {
            is ConsoleMintOutcome.Minted -> linkedMapOf(
                "requestId" to requestId,
                "orgId" to outcome.tokens.orgId,
                "sessionToken" to outcome.tokens.sessionToken,
                "sessionJwt" to outcome.tokens.sessionJwt,
            )
            is ConsoleMintOutcome.Refused -> linkedMapOf("requestId" to requestId, "error" to outcome.error.raw).apply {
                outcome.orgId?.let { put("orgId", it) }
                outcome.reason?.let { put("reason", it) }
            }
        }
}

sealed interface ConsoleTeamsOutcome {
    data class Loaded(val teams: List<ConsoleTeamSummary>) : ConsoleTeamsOutcome
    data class Failed(val reason: String) : ConsoleTeamsOutcome
}

/**
 * Mints console sessions for the Pages WebView and owns its per-account web data
 * store. Owned by the app-level [ConsolePages] runtime, never by a screen.
 * Confined to the main thread, like the WebView it serves.
 *
 * The personal JWT goes to exactly two places: the mint route and
 * `GET /api/teams`. Minted tokens go to exactly one: the console's
 * `deliverSession`, in the WebView of the selection they were minted for.
 * Nothing here caches a minted token; every console request is one mint.
 */
class ConsoleSessionBroker(
    private val credentials: ConsoleCredentials,
    private val dataStores: ConsoleWebDataStores,
    private val http: ConsoleHttp,
    val orgChoices: ConsoleOrgChoiceStore,
    val profiles: ConsoleProfileLedger,
    private val teamsTtlMs: Long = 120_000,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private data class TeamsCache(val account: ConsoleAccountContext, val fetchedAt: Long, val teams: List<ConsoleTeamSummary>)

    private var teamsCache: TeamsCache? = null
    private var teamsInFlight: Pair<ConsoleAccountContext, CompletableDeferred<ConsoleTeamsOutcome>>? = null
    /** Request ids already answered. A console request is one mint, never two. */
    private val answeredRequestIds = ArrayDeque<String>()

    /** True while [context] is still the selected account and generation. */
    fun isCurrent(context: ConsoleAccountContext): Boolean = credentials.account() == context

    /** Every pairing, sign-in, sign-out or account change: nothing captured before it may complete after it. */
    fun selectionChanged() {
        teamsInFlight?.second?.complete(ConsoleTeamsOutcome.Failed("account_changed"))
        teamsInFlight = null
        teamsCache = null
        answeredRequestIds.clear()
    }

    // region Web data store

    /** The profile [accountId]'s WebView uses; assigned and persisted before the profile is created. */
    fun profileFor(accountId: String): String = profiles.assign(accountId)

    /**
     * Sign-out or account change. Synchronous, so the previous account's profile
     * is journaled before anything can suspend. Returns the profiles to [clearProfiles]
     * once the WebView using them is destroyed.
     */
    fun accountSignedOut(accountId: String): List<String> {
        selectionChanged()
        orgChoices.forgetAccount(accountId)
        return profiles.journal(listOf(accountId))
    }

    /** Best effort in this process; the journaled deletion at next cold start is the removal. */
    suspend fun clearProfiles(names: List<String>) {
        for (name in names) {
            try {
                dataStores.clear(name)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.w(TAG, "Could not clear a signed-out console profile in-process: ${error.message}")
            }
        }
    }

    /**
     * Cold start, before any profile is loaded: journal profiles left by accounts
     * that are no longer signed in, then delete every journaled profile. A profile
     * that still cannot be deleted stays journaled for the next start.
     */
    suspend fun deletePendingAtColdStart(currentAccountId: String?) {
        profiles.journal(profiles.accountsOtherThan(currentAccountId))
        for (name in profiles.pendingDeletions) {
            try {
                dataStores.delete(name)
                profiles.deleted(name)
                Log.i(TAG, "Deleted a signed-out console profile")
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.e(TAG, "Console profile deletion failed; retrying next start: ${error.message}")
            }
        }
    }

    // endregion

    // region Sessions

    /**
     * Answer one console session request from the WebView bound to [account].
     * Returns null for a duplicate request id (it never mints twice) and for a
     * WebView whose selection is no longer current (its request is dropped).
     * [orgId] null means "the session expired and the page does not know its
     * org"; [fallbackOrgId] is the org of the page native opened.
     */
    suspend fun answer(requestId: String, orgId: String?, fallbackOrgId: String?, account: ConsoleAccountContext): ConsoleSessionDelivery? {
        if (!isCurrent(account)) {
            Log.w(TAG, "Dropping a console session request from a stale account selection")
            return null
        }
        if (requestId in answeredRequestIds) {
            Log.i(TAG, "Ignoring duplicate console session request")
            return null
        }
        answeredRequestIds.addLast(requestId)
        while (answeredRequestIds.size > 64) answeredRequestIds.removeFirst()
        val target = orgId ?: fallbackOrgId
            ?: return ConsoleSessionDelivery(requestId, ConsoleMintOutcome.Refused(ConsoleSessionDeliveryError.FAILED, null, "unknown_org"), account)
        val outcome = mint(target, account)
        if (!isCurrent(account)) return null
        return ConsoleSessionDelivery(requestId, outcome, account)
    }

    /** `POST /auth/console-session {orgId}` with [account]'s personal JWT. One call, one outcome. */
    suspend fun mint(orgId: String, account: ConsoleAccountContext): ConsoleMintOutcome {
        fun refused(reason: String) = ConsoleMintOutcome.Refused(ConsoleSessionDeliveryError.FAILED, orgId, reason)
        if (!isCurrent(account)) return refused(if (credentials.account() == null) "signed_out" else "account_changed")
        val jwt = credentials.personalJwt(account)
            ?: return refused(if (isCurrent(account)) "personal_session_unavailable" else "account_changed")
        if (!isCurrent(account)) return refused("account_changed")

        val request = ConsoleHttpRequest(
            method = "POST",
            url = account.apiBase.trimEnd('/') + MINT_PATH,
            headers = mapOf("Content-Type" to "application/json", "Authorization" to "Bearer $jwt"),
            body = JsonObject().apply { addProperty("orgId", orgId) }.toString(),
        )
        val outcome = try {
            val response = http.execute(request)
            mintOutcome(response.status, response.body, orgId)
        } catch (error: CancellationException) {
            throw error
        } catch (error: InterruptedIOException) {
            Log.w(TAG, "Console session mint timed out")
            refused("timeout")
        } catch (error: Exception) {
            Log.w(TAG, "Console session mint transport failed: ${error.message}")
            refused("network")
        }
        // A switch while the request was in flight: the answer belongs to the old selection.
        if (!isCurrent(account)) return refused("account_changed")
        if (outcome is ConsoleMintOutcome.Refused) Log.w(TAG, "Console session mint refused: ${outcome.error.raw} ${outcome.reason.orEmpty()}")
        return outcome
    }

    /** Mint for whichever account is selected now (tests and diagnostics). */
    suspend fun mint(orgId: String): ConsoleMintOutcome {
        val account = credentials.account()
            ?: return ConsoleMintOutcome.Refused(ConsoleSessionDeliveryError.FAILED, orgId, "signed_out")
        return mint(orgId, account)
    }

    // endregion

    // region Teams

    /**
     * `GET /api/teams`, cached per selection for a short TTL. Failures are not
     * cached. A result that arrives after a selection change is discarded.
     */
    suspend fun teams(forceRefresh: Boolean = false): ConsoleTeamsOutcome {
        val account = credentials.account() ?: return ConsoleTeamsOutcome.Failed("signed_out")
        val cache = teamsCache
        if (!forceRefresh && cache != null && cache.account == account && now() - cache.fetchedAt < teamsTtlMs) {
            return ConsoleTeamsOutcome.Loaded(cache.teams)
        }
        teamsInFlight?.takeIf { it.first == account }?.let { (_, waiting) ->
            val outcome = waiting.await()
            return if (isCurrent(account)) outcome else ConsoleTeamsOutcome.Failed("account_changed")
        }
        val deferred = CompletableDeferred<ConsoleTeamsOutcome>()
        teamsInFlight = account to deferred
        val outcome = try {
            fetchTeams(account)
        } catch (error: CancellationException) {
            deferred.complete(ConsoleTeamsOutcome.Failed("cancelled"))
            throw error
        } finally {
            if (teamsInFlight?.second === deferred) teamsInFlight = null
        }
        // A selection change already completed this with account_changed; that wins.
        val ownAnswer = deferred.complete(outcome)
        if (!ownAnswer || !isCurrent(account)) return ConsoleTeamsOutcome.Failed("account_changed")
        if (outcome is ConsoleTeamsOutcome.Loaded) teamsCache = TeamsCache(account, now(), outcome.teams)
        return outcome
    }

    /** The org the user picked for a project shared in several orgs. */
    fun rememberedOrgId(projectId: String): String? =
        credentials.account()?.let { orgChoices.orgId(it.accountId, projectId) }

    fun rememberOrgChoice(orgId: String, projectId: String) {
        val account = credentials.account() ?: return
        orgChoices.remember(orgId, account.accountId, projectId)
    }

    private suspend fun fetchTeams(account: ConsoleAccountContext): ConsoleTeamsOutcome {
        val jwt = credentials.personalJwt(account)
        if (jwt == null || !isCurrent(account)) {
            return ConsoleTeamsOutcome.Failed(if (isCurrent(account)) "personal_session_unavailable" else "account_changed")
        }
        val request = ConsoleHttpRequest(
            method = "GET",
            url = account.apiBase.trimEnd('/') + TEAMS_PATH,
            headers = mapOf("Authorization" to "Bearer $jwt"),
            body = null,
        )
        return try {
            val response = http.execute(request)
            if (!isCurrent(account)) return ConsoleTeamsOutcome.Failed("account_changed")
            if (response.status != 200) {
                Log.w(TAG, "Team directory request failed: HTTP ${response.status}")
                return ConsoleTeamsOutcome.Failed("http_${response.status}")
            }
            ConsoleTeamSummary.parseResponse(response.body)?.let { ConsoleTeamsOutcome.Loaded(it) }
                ?: ConsoleTeamsOutcome.Failed("malformed_response")
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            Log.w(TAG, "Team directory request failed: ${error.message}")
            ConsoleTeamsOutcome.Failed(if (isCurrent(account)) "network" else "account_changed")
        }
    }

    // endregion

    companion object {
        const val MINT_PATH = "/auth/console-session"
        const val TEAMS_PATH = "/api/teams"

        /** A stable per-account profile name. Derived, so it survives relaunch without being stored. */
        fun profileName(accountId: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest("nimbalyst-console-store:$accountId".toByteArray())
            return "nimbalyst-console-" + digest.take(16).joinToString("") { "%02x".format(it) }
        }

        /** The route's responses (`collabv3/src/consoleSession.ts`) mapped to the codes `deliverSession` accepts. Pure. */
        fun mintOutcome(status: Int, body: String, requestedOrgId: String): ConsoleMintOutcome {
            val json = runCatching { JsonParser.parseString(body) }.getOrNull()?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()
            val error = json.stringOrNull("error")
            fun refused(code: ConsoleSessionDeliveryError, reason: String?) = ConsoleMintOutcome.Refused(code, requestedOrgId, reason)
            return when (status) {
                200 -> {
                    val token = json.stringOrNull("sessionToken")?.takeIf { it.isNotEmpty() }
                    val sessionJwt = json.stringOrNull("sessionJwt")?.takeIf { it.isNotEmpty() }
                    val orgId = json.stringOrNull("orgId")
                    if (token == null || sessionJwt == null || orgId != requestedOrgId) {
                        refused(ConsoleSessionDeliveryError.FAILED, "malformed_response")
                    } else {
                        ConsoleMintOutcome.Minted(ConsoleSessionTokens(orgId, token, sessionJwt))
                    }
                }
                403 -> when (error) {
                    // Every reason (mfa_required, primary_auth_required, member_mfa_enrolled,
                    // auth_method_not_allowed, org_policy_unknown) is the same answer to the reader.
                    "org_auth_required" -> refused(ConsoleSessionDeliveryError.ORG_AUTH_REQUIRED, json.stringOrNull("reason"))
                    "not_a_member" -> refused(ConsoleSessionDeliveryError.NOT_A_MEMBER, null)
                    // personal_scope_required, not_a_team_org, or an unknown refusal.
                    else -> refused(ConsoleSessionDeliveryError.FAILED, error ?: "forbidden")
                }
                503 -> refused(ConsoleSessionDeliveryError.UNAVAILABLE, error)
                401 -> refused(ConsoleSessionDeliveryError.FAILED, "unauthorized")
                else -> refused(ConsoleSessionDeliveryError.FAILED, error ?: "http_$status")
            }
        }
    }
}
