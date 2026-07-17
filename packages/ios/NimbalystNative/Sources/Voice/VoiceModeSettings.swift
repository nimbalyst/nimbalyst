import Foundation

/// Which turn-detection engine drives turn-taking. `semanticVad` has the model
/// judge whether the user is actually trying to speak instead of raw amplitude
/// -- far more robust against residual echo of the agent's own voice (desktop
/// [barge-in] metrics 2026-07-02 showed amplitude server_vad tripping on echo
/// even with AEC routing and the raised 0.85 threshold; mirrors the desktop
/// VadDetectionType in voiceBargeInPolicy.ts). `serverVad` is the amplitude
/// fallback kept for A/B comparison; vadThreshold/silenceDurationMs only apply
/// to it.
public enum VadDetection: String, Codable {
    case semanticVad = "semantic_vad"
    case serverVad = "server_vad"
}

// Defined outside the `#if os(iOS)` voice code (no platform dependencies) so
// the persistence/migration logic is unit-testable on macOS.
public struct VoiceModeSettings: Codable {
    public var voice: String
    public var idleTimeout: TimeInterval
    public var autoAnnounceCompletions: Bool
    public var vadThreshold: Double
    public var silenceDurationMs: Int
    /// Optional so older persisted settings still decode; nil means the
    /// default engine (semantic_vad). Read via `effectiveVadDetection`.
    public var vadDetection: VadDetection?
    public var promptConfirmationDelay: TimeInterval
    /// Preferred spoken language synced from the desktop (BCP-47 or common
    /// language name). The voice agent pins its language to this. Nil/empty
    /// means no preference -> English. Optional so older persisted settings
    /// that lack the field still decode.
    public var language: String?

    /// Old vadThreshold default; persisted values equal to it are migrated to
    /// the new default on load (see `load()`), since 0.5 lets residual echo of
    /// the agent's own speakerphone audio trip server VAD (NIM-1314).
    public static let legacyDefaultVadThreshold = 0.5
    public static let defaultVadThreshold = 0.85

    public init(
        // "alloy" (not "sage"): until 2026-07 the voice setting was ignored and
        // the agent was hardcoded to alloy, so alloy is what existing users
        // hear -- keep fresh installs sounding the same now that the setting
        // is actually applied. It also matches the desktop constructor default.
        voice: String = "alloy",
        idleTimeout: TimeInterval = 30,
        autoAnnounceCompletions: Bool = true,
        vadThreshold: Double = VoiceModeSettings.defaultVadThreshold,
        silenceDurationMs: Int = 500,
        vadDetection: VadDetection? = nil,
        promptConfirmationDelay: TimeInterval = 5,
        language: String? = nil
    ) {
        self.voice = voice
        self.idleTimeout = idleTimeout
        self.autoAnnounceCompletions = autoAnnounceCompletions
        self.vadThreshold = vadThreshold
        self.silenceDurationMs = silenceDurationMs
        self.vadDetection = vadDetection
        self.promptConfirmationDelay = promptConfirmationDelay
        self.language = language
    }

    /// The turn-detection engine to use; nil (older persisted settings or the
    /// fresh default) resolves to semantic_vad.
    public var effectiveVadDetection: VadDetection { vadDetection ?? .semanticVad }

    private static let userDefaultsKey = "voiceModeSettings"

    public static func load(from defaults: UserDefaults = .standard) -> VoiceModeSettings {
        guard let data = defaults.data(forKey: userDefaultsKey),
              var settings = try? JSONDecoder().decode(VoiceModeSettings.self, from: data) else {
            return VoiceModeSettings()
        }
        // A persisted 0.5 is indistinguishable from the old default, and 0.5
        // reintroduces echo self-interruption (NIM-1314) -- migrate it up.
        if settings.vadThreshold == Self.legacyDefaultVadThreshold {
            settings.vadThreshold = Self.defaultVadThreshold
        }
        return settings
    }

    public func save(to defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(self) {
            defaults.set(data, forKey: VoiceModeSettings.userDefaultsKey)
        }
    }
}
