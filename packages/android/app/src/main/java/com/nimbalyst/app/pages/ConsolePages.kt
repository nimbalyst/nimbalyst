package com.nimbalyst.app.pages

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.gson.JsonParser
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.pairing.PairingCredentials
import com.nimbalyst.app.transcript.TranscriptExternalLinks
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TAG = "ConsolePages"

/**
 * The account selection Pages runs under, read straight from the pairing state.
 *
 * Android holds one account at a time. Its id is derived from the sync server
 * and the personal member id, so it names a store without exposing either.
 * Every change of id (sign-in, sign-out, re-pair to another account) bumps the
 * generation and reports the previous id synchronously, before any caller sees
 * the new selection.
 */
internal class ConsoleAccountTracker(
    private val read: () -> PairingCredentials?,
    private val onChange: (previousAccountId: String?) -> Unit,
) {
    private var initialized = false
    private var lastAccountId: String? = null
    private var generation = 0L

    fun current(): ConsoleAccountContext? {
        val credentials = read()
        val accountId = credentials?.let(::accountId)
        if (!initialized) {
            initialized = true
            lastAccountId = accountId
        } else if (accountId != lastAccountId) {
            val previous = lastAccountId
            lastAccountId = accountId
            generation += 1
            onChange(previous)
        }
        val apiBase = credentials?.serverUrl?.let(ConsoleAccountContext::apiBase) ?: return null
        return accountId?.let { ConsoleAccountContext(it, apiBase, generation) }
    }

    companion object {
        /** Null unless the account is signed in (a personal JWT and member id are present). */
        fun accountId(credentials: PairingCredentials): String? {
            val memberId = credentials.authUserId
            if (!credentials.hasAuthToken || memberId.isNullOrBlank()) return null
            val digest = MessageDigest.getInstance("SHA-256").digest("${credentials.serverUrl}|$memberId".toByteArray())
            return digest.take(16).joinToString("") { "%02x".format(it) }
        }
    }
}

/** Expiry of a Stytch JWT, from its unverified `exp` claim. Null when it cannot be read. */
internal object ConsoleJwt {
    fun expiresAtMs(jwt: String): Long? {
        val payload = jwt.split('.').takeIf { it.size == 3 }?.get(1) ?: return null
        val json = runCatching { String(Base64.getUrlDecoder().decode(payload.trimEnd('='))) }.getOrNull() ?: return null
        val exp = runCatching { JsonParser.parseString(json).asJsonObject.get("exp")?.asLong }.getOrNull() ?: return null
        return exp * 1000
    }

    /** [jwt] unless it expires within [marginMs]. A JWT without a readable expiry is left to the server. */
    fun fresh(jwt: String?, nowMs: Long, marginMs: Long = 60_000): String? {
        if (jwt.isNullOrBlank()) return null
        val expiresAt = expiresAtMs(jwt) ?: return jwt
        return jwt.takeIf { expiresAt - nowMs > marginMs }
    }
}

/** The app's one Pages runtime, created on first use and kept for the process. */
object ConsolePages {
    @Volatile
    private var instance: ConsolePagesRuntime? = null

    /** Main thread. */
    fun runtime(context: Context): ConsolePagesRuntime {
        instance?.let { return it }
        return synchronized(this) {
            instance ?: ConsolePagesRuntime(context.applicationContext as NimbalystApplication).also { instance = it }
        }
    }
}

/**
 * Owns the session broker, the per-account WebView controller, and the
 * lifecycle hooks Pages needs. Main thread only. Mirrors iOS `AppState+Pages`.
 */
class ConsolePagesRuntime internal constructor(private val app: NimbalystApplication) {
    val environment: ConsoleEnvironment = ConsoleEnvironment.production
    val inbox: ConsoleLinkInbox = ConsoleLinkInbox.shared
    val support: PagesWebSupport = PagesWebSupport.detect()
    val reachability = ConsoleReachability(app)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val store = SharedPreferencesConsoleStore(app.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))
    // Touched only when the WebView supports profiles; there is no shared-profile fallback.
    private val profiles = ProfileConsoleDataStores()
    private val tracker = ConsoleAccountTracker(read = { app.pairingStore.state.value.credentials }, onChange = ::accountChanged)

    val broker = ConsoleSessionBroker(
        credentials = object : ConsoleCredentials {
            override fun account(): ConsoleAccountContext? = tracker.current()
            override suspend fun personalJwt(context: ConsoleAccountContext): String? = readPersonalJwt(context)
        },
        dataStores = profiles,
        http = OkHttpConsoleHttp(),
        orgChoices = ConsoleOrgChoiceStore(store),
        profiles = ConsoleProfileLedger(store),
    )

    private val _controller = MutableStateFlow<PagesWebController?>(null)
    val controller: StateFlow<PagesWebController?> = _controller.asStateFlow()

    /** Signed-out profiles are deleted at cold start, before any profile is loaded. */
    private val coldStart = CompletableDeferred<Unit>()

    private val _appLinks = MutableSharedFlow<NimbalystAppLink>(extraBufferCapacity = 4)
    /** Known app routes the console linked to (a session, the pairing scanner). */
    val appLinks: SharedFlow<NimbalystAppLink> = _appLinks.asSharedFlow()

    init {
        val launchAccount = tracker.current()
        scope.launch {
            try {
                if (support.supported) broker.deletePendingAtColdStart(launchAccount?.accountId)
            } finally {
                coldStart.complete(Unit)
            }
        }
        // Sign-in, sign-out and re-pair reach Pages without any other wiring.
        scope.launch { app.pairingStore.state.collect { tracker.current() } }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStop(owner: LifecycleOwner) {
                val controller = _controller.value ?: return
                scope.launch { controller.appDidStop() }
            }
        })
    }

    fun account(): ConsoleAccountContext? = tracker.current()

    /** The controller, only if it belongs to the current selection. Never creates one. */
    fun currentController(): PagesWebController? {
        val account = account() ?: return null
        return _controller.value?.takeIf { it.account == account && !it.isTornDown }
    }

    /**
     * Create the controller for the current selection, in the account's own profile.
     * Waits for the cold-start deletions, which must run before any profile loads.
     */
    suspend fun prepareController() {
        if (!support.supported || currentController() != null) return
        coldStart.await()
        val account = account() ?: return
        if (currentController() != null) return
        _controller.value?.tearDown()
        val profileName = broker.profileFor(account.accountId)
        profiles.prepare(profileName)
        _controller.value = PagesWebController(
            context = app,
            environment = environment,
            account = account,
            broker = broker,
            profileName = profileName,
            appVersion = runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "0",
            flush = PagesFlushCoordinator(store),
            isOnline = { reachability.isOnline.value },
            hooks = PagesWebController.Hooks(
                openExternally = { url -> TranscriptExternalLinks.open(app, url) },
                appRoute = { link -> _appLinks.tryEmit(link) },
            ),
        )
    }

    /**
     * Called synchronously by the tracker the moment it sees a different account.
     * The previous account's profile is journaled for deletion before anything can
     * suspend; the WebView is torn down and the profile cleared after the current
     * call returns. The deletion itself happens at the next cold start.
     */
    private fun accountChanged(previousAccountId: String?) {
        val journaled = previousAccountId?.let(broker::accountSignedOut).orEmpty()
        broker.selectionChanged()
        val old = _controller.value
        _controller.value = null
        mainHandler.post {
            old?.tearDown()
            if (journaled.isNotEmpty()) scope.launch { broker.clearProfiles(journaled) }
        }
    }

    private suspend fun readPersonalJwt(context: ConsoleAccountContext): String? {
        if (tracker.current() != context) return null
        ConsoleJwt.fresh(app.pairingStore.state.value.credentials?.authJwt, System.currentTimeMillis())?.let { return it }
        // About to expire: the account's own refresh, the same one sync runs every four minutes.
        Log.i(TAG, "Refreshing the personal JWT before a console request")
        withContext(Dispatchers.IO) { app.syncManager.refreshJwt() }
        if (tracker.current() != context) return null
        return ConsoleJwt.fresh(app.pairingStore.state.value.credentials?.authJwt, System.currentTimeMillis())
    }

    private companion object {
        const val PREFS_NAME = "console_pages"
    }
}
