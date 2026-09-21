import Foundation
import os

/// Decrypts a desktop settings broadcast and applies the parts that live
/// outside `SyncManager`'s published state: the Keychain credential, voice mode,
/// the model picker's cache, and the meta-agent gate.
///
/// Split out of `SyncManager` so the ordering decision is a pure function with
/// a test, rather than a log line in the middle of six side effects.
enum SettingsSyncApplier {
    enum Failure: Error, Equatable {
        case undecodable
        case undecryptable
        case unparsable
        /// The payload describes state we have already moved past.
        case stale
    }

    struct Accepted {
        let payload: EncryptedSettingsPayload
        let settings: SyncedSettings
    }

    private static let logger = Logger(subsystem: "com.nimbalyst.app", category: "SettingsSync")

    static func decode(_ data: Data, crypto: CryptoManager) -> Result<Accepted, Failure> {
        guard let broadcast = try? JSONDecoder().decode(SettingsSyncBroadcast.self, from: data) else {
            return .failure(.undecodable)
        }
        let payload = broadcast.settings
        guard let settingsJson = crypto.decryptOrNil(
            encryptedBase64: payload.encryptedSettings,
            ivBase64: payload.settingsIv
        ) else {
            return .failure(.undecryptable)
        }
        guard let settings = try? JSONDecoder().decode(SyncedSettings.self, from: Data(settingsJson.utf8)) else {
            return .failure(.unparsable)
        }
        return .success(Accepted(payload: payload, settings: settings))
    }

    /// Whether a broadcast describes newer state than what we last applied.
    ///
    /// Older desktops reset `version` on launch. Order by timestamp first so
    /// their new launch is accepted but a higher counter replayed from the old
    /// launch cannot rewind settings. The counter breaks same-millisecond ties.
    /// This also accepts the persisted counters used by newer desktops without
    /// changing the wire contract. A backward desktop clock waits until its
    /// timestamp catches up; a higher counter alone cannot prove freshness.
    static func isFresh(version: Int, timestamp: Int, lastApplied: AppliedSettingsVersion?) -> Bool {
        guard let lastApplied else { return true }
        if timestamp != lastApplied.timestamp { return timestamp > lastApplied.timestamp }
        return version > lastApplied.version
    }

    /// Applies everything that is not `SyncManager` published state.
    static func apply(_ settings: SyncedSettings) {
        do {
            if try applySyncedOpenAIKey(
                settings.openaiApiKey,
                store: KeychainManager.storeOpenAIApiKey,
                delete: KeychainManager.deleteOpenAIApiKey
            ) {
                NotificationCenter.default.post(name: .init("OpenAIApiKeySynced"), object: nil)
            }
        } catch {
            logger.error("Could not apply synced OpenAI credential to Keychain")
        }

        #if os(iOS)
        // preferredAgentLanguage is a top-level field, so persist it even when
        // voiceMode itself is absent -- it pins the voice agent's spoken
        // language to the desktop default.
        if settings.voiceMode != nil || settings.preferredAgentLanguage != nil {
            var currentSettings = VoiceModeSettings.load()
            if let voiceMode = settings.voiceMode {
                if let engine = voiceMode.engine { currentSettings.engine = engine }
                if let voice = voiceMode.liveVoice { currentSettings.liveVoice = voice }
                if let model = voiceMode.liveControllerModel { currentSettings.liveControllerModel = model }
                if let voice = voiceMode.voice {
                    currentSettings.voice = voice
                }
                if let delay = voiceMode.submitDelayMs {
                    currentSettings.promptConfirmationDelay = TimeInterval(delay) / 1000.0
                }
            }
            currentSettings.language = settings.preferredAgentLanguage
            currentSettings.save()
        }
        #endif

        if let models = settings.availableModels {
            ModelPreferences.saveAvailableModels(models, defaultModel: settings.defaultModel)
        }

        let metaAgentEnabled = settings.metaAgentEnabled ?? false
        FeaturePreferences.setMetaAgentEnabled(metaAgentEnabled)
        NotificationCenter.default.post(name: .init("MetaAgentEnabledSynced"), object: nil)
    }
}

/// The last settings broadcast this device accepted from one desktop.
struct AppliedSettingsVersion: Equatable {
    let version: Int
    let timestamp: Int
}

/// Persists the watermark per desktop, across app launches. A watermark that
/// only lived in memory would let the first broadcast after every cold start
/// overwrite whatever the user changed on the phone in between.
struct AppliedSettingsVersionStore {
    private let defaults: UserDefaults
    private static let key = "nimbalyst_applied_settings_versions"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func lastApplied(deviceId: String) -> AppliedSettingsVersion? {
        guard let raw = defaults.dictionary(forKey: Self.key)?[deviceId] as? [String: Int],
              let version = raw["version"], let timestamp = raw["timestamp"] else { return nil }
        return AppliedSettingsVersion(version: version, timestamp: timestamp)
    }

    func record(deviceId: String, version: Int, timestamp: Int) {
        var all = defaults.dictionary(forKey: Self.key) ?? [:]
        all[deviceId] = ["version": version, "timestamp": timestamp]
        defaults.set(all, forKey: Self.key)
    }

    func reset() {
        defaults.removeObject(forKey: Self.key)
    }
}

extension SettingsSyncApplier.Failure {
    var label: String {
        switch self {
        case .undecodable: return "could not decode the broadcast"
        case .undecryptable: return "could not decrypt with this device's key"
        case .unparsable: return "decrypted payload was not settings JSON"
        case .stale: return "older than the settings already applied"
        }
    }
}
