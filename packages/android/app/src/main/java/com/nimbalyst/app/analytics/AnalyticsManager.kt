package com.nimbalyst.app.analytics

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.posthog.PostHog
import com.posthog.android.PostHogAndroidConfig
import com.posthog.android.PostHogAndroid
import java.util.UUID

/**
 * Mobile analytics service using PostHog, matching the iOS AnalyticsManager.swift implementation.
 *
 * Privacy approach:
 * - Anonymous distinctId (or shared with desktop via QR pairing)
 * - Minimal event data (no session content, project names, or file paths)
 * - Opt-out support
 * - Email only set if user authenticates via Stytch
 */
object AnalyticsManager {
    private const val POSTHOG_KEY = "phc_s3lQIILexwlGHvxrMBqti355xUgkRocjMXW4LjV0ATw"
    private const val POSTHOG_HOST = "https://us.i.posthog.com"
    private const val PREFS_NAME = "nimbalyst_analytics"
    private const val KEY_ANALYTICS_ID = "analytics_id"
    private const val KEY_ANALYTICS_ENABLED = "analytics_enabled"

    private var initialized = false
    private lateinit var preferences: SharedPreferences

    var isEnabled: Boolean = true
        private set

    /**
     * Initialize PostHog with privacy settings.
     * Called from NimbalystApplication.onCreate().
     */
    fun initialize(context: Context) {
        if (initialized) return

        val appContext = context.applicationContext

        // Use EncryptedSharedPreferences for analytics ID (matches iOS Keychain)
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        preferences = EncryptedSharedPreferences.create(
            appContext,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )

        // Load or generate distinct ID
        var distinctId = preferences.getString(KEY_ANALYTICS_ID, null)
        if (distinctId.isNullOrBlank()) {
            distinctId = "nimbalyst_mobile_${UUID.randomUUID().toString().lowercase()}"
            preferences.edit().putString(KEY_ANALYTICS_ID, distinctId).apply()
        }

        // Load opt-out preference
        isEnabled = preferences.getBoolean(KEY_ANALYTICS_ENABLED, true)

        // Configure PostHog
        val config = PostHogAndroidConfig(apiKey = POSTHOG_KEY, host = POSTHOG_HOST).apply {
            captureScreenViews = false
            captureApplicationLifecycleEvents = false
        }
        PostHogAndroid.setup(appContext, config)

        // Set the distinct ID
        PostHog.identify(distinctId)

        // Mark dev users in debug builds
        if (isDebugBuild()) {
            PostHog.capture(
                "\$set",
                properties = mapOf("\$set_once" to mapOf("is_dev_user" to true))
            )
        }

        if (!isEnabled) {
            PostHog.optOut()
        }

        initialized = true
    }

    /**
     * Called after QR pairing to adopt desktop's analytics ID.
     * Uses alias() to merge mobile identity with desktop identity,
     * then identify() to switch future events to the desktop's distinct_id.
     */
    fun setDistinctIdFromPairing(analyticsId: String?) {
        if (analyticsId.isNullOrBlank()) return

        if (initialized) {
            PostHog.alias(analyticsId)
        }

        preferences.edit().putString(KEY_ANALYTICS_ID, analyticsId).apply()

        if (initialized) {
            PostHog.identify(analyticsId)
        }
    }

    /**
     * Called after Stytch login to set email on PostHog profile.
     */
    fun setEmail(email: String) {
        if (email.isBlank() || !initialized) return
        PostHog.capture(
            "\$set",
            properties = mapOf("\$set" to mapOf("email" to email))
        )
    }

    /**
     * Capture an analytics event.
     */
    fun capture(event: String, properties: Map<String, Any>? = null) {
        if (!initialized || !isEnabled) return
        PostHog.capture(event, properties = properties)
    }

    /**
     * Opt out of analytics tracking.
     */
    fun optOut() {
        capture("mobile_analytics_opt_out")
        PostHog.optOut()
        isEnabled = false
        if (::preferences.isInitialized) {
            preferences.edit().putBoolean(KEY_ANALYTICS_ENABLED, false).apply()
        }
    }

    /**
     * Opt back in to analytics tracking.
     */
    fun optIn() {
        PostHog.optIn()
        isEnabled = true
        if (::preferences.isInitialized) {
            preferences.edit().putBoolean(KEY_ANALYTICS_ENABLED, true).apply()
        }
    }

    /**
     * Reset analytics state (called on unpair).
     */
    fun reset() {
        PostHog.reset()
        if (::preferences.isInitialized) {
            preferences.edit().remove(KEY_ANALYTICS_ID).apply()
        }
        initialized = false
    }

    private fun isDebugBuild(): Boolean {
        return try {
            val buildConfig = Class.forName("com.nimbalyst.app.BuildConfig")
            buildConfig.getField("DEBUG").getBoolean(null)
        } catch (_: Exception) {
            false
        }
    }
}
