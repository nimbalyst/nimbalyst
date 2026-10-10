package com.nimbalyst.app.pages

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.CookieJar
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Which WebView capabilities the Pages shell can rely on. */
data class PagesWebSupport(
    /** Document-start scripts and origin-scoped message listeners: required for the bridge. */
    val bridge: Boolean,
    /** Per-account profiles. Without them Pages does not load: there is no shared-profile path. */
    val multiProfile: Boolean,
) {
    val supported: Boolean get() = bridge && multiProfile

    companion object {
        fun detect(): PagesWebSupport = runCatching {
            PagesWebSupport(
                bridge = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) &&
                    WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER),
                multiProfile = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE),
            )
        }.getOrElse {
            // A missing or updating WebView provider.
            Log.w("ConsolePages", "WebView features unavailable: ${it.message}")
            PagesWebSupport(bridge = false, multiProfile = false)
        }
    }
}

/** One androidx.webkit profile per account sign-in: cookies, storage and cache never cross accounts. */
@SuppressLint("RequiresFeature")
class ProfileConsoleDataStores : ConsoleWebDataStores {
    /** Main thread. Loads the profile into this process, after which it cannot be deleted until the next. */
    fun prepare(profileName: String) {
        ProfileStore.getInstance().getOrCreateProfile(profileName)
    }

    override suspend fun clear(profileName: String) = withContext(Dispatchers.Main.immediate) {
        val profile = ProfileStore.getInstance().getProfile(profileName) ?: return@withContext
        suspendCancellableCoroutine { continuation -> profile.cookieManager.removeAllCookies { continuation.resume(Unit) } }
        profile.cookieManager.flush()
        profile.webStorage.deleteAllData()
    }

    override suspend fun delete(profileName: String) = withContext(Dispatchers.Main.immediate) {
        // False means it never existed. Throws IllegalStateException when it is loaded in this process.
        ProfileStore.getInstance().deleteProfile(profileName)
        Unit
    }
}

/**
 * Network reachability for Pages and the Team tab. Pages are online-only, so an
 * offline open shows a native empty state instead of a WebView error page.
 */
class ConsoleReachability(context: Context) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val _isOnline = MutableStateFlow(currentlyOnline())
    val isOnline: StateFlow<Boolean> = _isOnline.asStateFlow()

    init {
        runCatching {
            connectivity?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { _isOnline.value = true }
                override fun onLost(network: Network) { _isOnline.value = currentlyOnline() }
                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    _isOnline.value = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                }
            })
        }.onFailure { Log.w("ConsolePages", "Network callback unavailable: ${it.message}") }
    }

    private fun currentlyOnline(): Boolean {
        val manager = connectivity ?: return true
        val capabilities = runCatching { manager.getNetworkCapabilities(manager.activeNetwork) }.getOrNull() ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}

/**
 * No cookies, no cache, no redirects: a bearer JWT goes only to the URL it was
 * addressed to, and neither it nor a minted token is persisted by the client.
 */
class OkHttpConsoleHttp : ConsoleHttp {
    private val client = OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES)
        .cache(null)
        .followRedirects(false)
        .followSslRedirects(false)
        .callTimeout(15, TimeUnit.SECONDS)
        .build()

    override suspend fun execute(request: ConsoleHttpRequest): ConsoleHttpResponse = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(request.url).header("Cache-Control", "no-store")
        request.headers.forEach { (name, value) -> builder.header(name, value) }
        val body = request.body?.toRequestBody("application/json".toMediaType())
        builder.method(request.method, body)
        client.newCall(builder.build()).execute().use { response ->
            ConsoleHttpResponse(response.code, response.body?.string().orEmpty())
        }
    }
}
