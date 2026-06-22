import Foundation

/// Persists feature-gate flags synced from the desktop (UserDefaults-backed).
/// Mirrors `ModelPreferences` -- these are desktop-controlled flags the mobile
/// app reads to gate alpha UI, kept in sync via the `SyncedSettings` channel.
public enum FeaturePreferences {
    private static let metaAgentEnabledKey = "metaAgentEnabled"

    /// Persist whether the desktop "meta-agent" alpha feature is enabled.
    public static func setMetaAgentEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: metaAgentEnabledKey)
    }

    /// Whether the desktop "meta-agent" alpha feature is enabled.
    /// Defaults to `false` until the desktop syncs its setting.
    public static var metaAgentEnabled: Bool {
        UserDefaults.standard.bool(forKey: metaAgentEnabledKey)
    }
}
