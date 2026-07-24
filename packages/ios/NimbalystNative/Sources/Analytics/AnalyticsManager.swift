import Foundation
import PostHog

/// Mobile analytics service using PostHog, matching the Capacitor AnalyticsService.ts implementation.
///
/// Privacy approach:
/// - Anonymous distinctId (or shared with desktop via QR pairing)
/// - Minimal event data (no session content, project names, or file paths)
/// - Opt-out support
/// - Email only set if user authenticates via Stytch
@MainActor
public final class AnalyticsManager: Sendable {
    public static let shared = AnalyticsManager()

    private static let posthogKey = "phc_s3lQIILexwlGHvxrMBqti355xUgkRocjMXW4LjV0ATw"
    private static let posthogHost = "https://us.i.posthog.com"
    private static let analyticsEnabledKey = "analytics_enabled"

    private var initialized = false

    /// Whether analytics is currently enabled.
    public private(set) var isEnabled: Bool = true

    private init() {}

    /// Initialize PostHog with privacy settings.
    /// Called from AppState.init() on app launch.
    public func initialize() {
        guard !initialized else { return }

        // Load or generate distinct ID
        var distinctId = KeychainManager.getAnalyticsId()
        if distinctId == nil {
            let newId = "nimbalyst_mobile_\(UUID().uuidString.lowercased())"
            try? KeychainManager.storeAnalyticsId(newId)
            distinctId = newId
        }

        // Load opt-out preference
        isEnabled = UserDefaults.standard.object(forKey: Self.analyticsEnabledKey) as? Bool ?? true

        // Configure PostHog with privacy settings
        // sessionReplay defaults to false and is iOS-only, so no need to set it
        let config = PostHogConfig(apiKey: Self.posthogKey, host: Self.posthogHost)
        config.captureScreenViews = false
        config.captureApplicationLifecycleEvents = false

        PostHogSDK.shared.setup(config)

        // Set the distinct ID
        if let id = distinctId {
            PostHogSDK.shared.identify(id)
        }

        // Mark dev users
        #if DEBUG
        PostHogSDK.shared.capture("$set", properties: ["$set_once": ["is_dev_user": true]])
        #endif

        if !isEnabled {
            PostHogSDK.shared.optOut()
        }

        initialized = true
    }

    /// Called after QR pairing to adopt desktop's analytics ID.
    /// This links mobile and desktop events to the same user in PostHog.
    ///
    /// Uses alias() to merge the mobile person with the desktop person,
    /// then identify() to switch future events to the desktop's distinct_id.
    /// Without alias(), PostHog won't merge two already-identified users.
    public func setDistinctIdFromPairing(_ analyticsId: String?) {
        guard let analyticsId, !analyticsId.isEmpty else { return }

        if initialized {
            // Alias merges the current mobile identity with the desktop identity
            PostHogSDK.shared.alias(analyticsId)
        }

        try? KeychainManager.storeAnalyticsId(analyticsId)
        if initialized {
            PostHogSDK.shared.identify(analyticsId)
        }
    }

    /// Called after Stytch login to set email on PostHog profile.
    /// This provides secondary correlation between devices.
    public func setEmail(_ email: String) {
        guard !email.isEmpty, initialized else { return }
        PostHogSDK.shared.capture("$set", properties: ["$set": ["email": email]])
    }

    /// Capture an analytics event.
    public func capture(_ event: String, properties: [String: Any]? = nil) {
        guard initialized, isEnabled else { return }
        PostHogSDK.shared.capture(event, properties: properties)
    }

    /// Opt out of analytics tracking.
    public func optOut() {
        // Send opt-out event before disabling
        capture("mobile_analytics_opt_out")
        PostHogSDK.shared.optOut()
        isEnabled = false
        UserDefaults.standard.set(false, forKey: Self.analyticsEnabledKey)
    }

    /// Opt back in to analytics tracking.
    public func optIn() {
        PostHogSDK.shared.optIn()
        isEnabled = true
        UserDefaults.standard.set(true, forKey: Self.analyticsEnabledKey)
    }

    /// Reset analytics state (called on unpair).
    public func reset() {
        PostHogSDK.shared.reset()
        KeychainManager.deleteAnalyticsId()
        initialized = false
    }
}
