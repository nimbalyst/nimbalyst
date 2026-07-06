import XCTest
@testable import NimbalystNative

/// Tests for the NIM-1314 Phase 1 server-side levers: far-field noise
/// reduction, raised VAD threshold default, turn-detection response gating
/// while the agent speaks, and truncate-on-barge-in item tracking.
final class RealtimeSessionConfigTests: XCTestCase {
    @MainActor
    private func makeClient() -> RealtimeClient {
        RealtimeClient(apiKey: "test-key")
    }

    // MARK: - gpt-realtime-2 unification (desktop RealtimeAPIClient parity)

    @MainActor
    func testSessionConfigUsesStreamingRealtimeWhisperTranscription() throws {
        let client = makeClient()
        let config = client.buildSessionConfig(instructions: "hi")

        let audio = try XCTUnwrap(config["audio"] as? [String: Any])
        let input = try XCTUnwrap(audio["input"] as? [String: Any])
        let transcription = try XCTUnwrap(input["transcription"] as? [String: Any])
        XCTAssertEqual(transcription["model"] as? String, "gpt-realtime-whisper")
    }

    @MainActor
    func testConnectionURLTargetsGptRealtime2() throws {
        let client = makeClient()
        XCTAssertEqual(client.model, "gpt-realtime-2")
        let url = try XCTUnwrap(client.connectionURL)
        XCTAssertEqual(url.absoluteString, "wss://api.openai.com/v1/realtime?model=gpt-realtime-2")
    }

    @MainActor
    func testSessionConfigIncludesLowReasoningEffortByDefault() throws {
        let client = makeClient()
        let config = client.buildSessionConfig(instructions: "hi")

        let reasoning = try XCTUnwrap(config["reasoning"] as? [String: Any])
        XCTAssertEqual(reasoning["effort"] as? String, "low")
    }

    @MainActor
    func testModelFallbackIsOneShotAndUpdatesConnectionURL() throws {
        let client = makeClient()

        XCTAssertTrue(client.attemptModelFallback())
        XCTAssertEqual(client.model, "gpt-realtime")
        XCTAssertEqual(
            client.connectionURL?.absoluteString,
            "wss://api.openai.com/v1/realtime?model=gpt-realtime"
        )
        // One-shot: never falls back again (no loop), even from the fallback model.
        XCTAssertFalse(client.attemptModelFallback())
        XCTAssertEqual(client.model, "gpt-realtime")
    }

    @MainActor
    func testSessionCreatedMarksSessionEstablished() throws {
        let client = makeClient()
        XCTAssertFalse(client.hasEstablishedSession)

        let created: [String: Any] = ["type": "session.created"]
        client.handleMessage(try JSONSerialization.data(withJSONObject: created))
        XCTAssertTrue(client.hasEstablishedSession)
    }

    @MainActor
    func testInstructionsCapIsModelAware() throws {
        let client = makeClient()
        // gpt-realtime-2 handles long instructions (desktop ships ~5k chars live).
        XCTAssertEqual(client.maxInstructionsLength, 8000)
        // The gpt-realtime fallback keeps the proven 2000-char crash guard.
        XCTAssertTrue(client.attemptModelFallback())
        XCTAssertEqual(client.maxInstructionsLength, 2000)
    }

    @MainActor
    func testSessionReadyFiresOncePerConnectionDespiteGatingUpdates() throws {
        let client = makeClient()
        var readyCount = 0
        client.onSessionReady = { readyCount += 1 }

        let created = try JSONSerialization.data(withJSONObject: ["type": "session.created"])
        let updated = try JSONSerialization.data(withJSONObject: ["type": "session.updated"])

        client.handleMessage(created)
        client.handleMessage(updated)
        XCTAssertEqual(readyCount, 1)

        // Response-gating flips (setServerResponsesGated) send partial
        // session.updates; the server echoes session.updated for each. Those
        // must NOT re-run the connection-ready ritual (chime, capture restart,
        // forced .listening) mid-conversation (NIM-1471).
        client.handleMessage(updated)
        client.handleMessage(updated)
        XCTAssertEqual(readyCount, 1)

        // A fresh connection (session.created) re-arms it.
        client.handleMessage(created)
        client.handleMessage(updated)
        XCTAssertEqual(readyCount, 2)
    }

    @MainActor
    func testSessionConfigIncludesFarFieldNoiseReductionByDefault() throws {
        let client = makeClient()
        let config = client.buildSessionConfig(instructions: "hi")

        let audio = try XCTUnwrap(config["audio"] as? [String: Any])
        let input = try XCTUnwrap(audio["input"] as? [String: Any])
        let noiseReduction = try XCTUnwrap(input["noise_reduction"] as? [String: Any])
        XCTAssertEqual(noiseReduction["type"] as? String, "far_field")
    }

    @MainActor
    func testSessionConfigOmitsNoiseReductionWhenNil() throws {
        let client = makeClient()
        client.noiseReductionType = nil
        let config = client.buildSessionConfig(instructions: "hi")

        let audio = try XCTUnwrap(config["audio"] as? [String: Any])
        let input = try XCTUnwrap(audio["input"] as? [String: Any])
        XCTAssertNil(input["noise_reduction"])
    }

    @MainActor
    func testTurnDetectionDefaultsToSemanticVad() throws {
        let client = makeClient()
        let td = client.buildTurnDetection(allowServerResponses: true)

        XCTAssertEqual(td["type"] as? String, "semantic_vad")
        XCTAssertEqual(td["eagerness"] as? String, "auto")
        XCTAssertEqual(td["create_response"] as? Bool, true)
        XCTAssertEqual(td["interrupt_response"] as? Bool, true)
        // Amplitude knobs must not leak into the semantic config.
        XCTAssertNil(td["threshold"])
        XCTAssertNil(td["silence_duration_ms"])
    }

    @MainActor
    func testServerVadFallbackKeepsRaisedThresholdAndAmplitudeKnobs() throws {
        let client = makeClient()
        client.vadDetection = .serverVad
        let td = client.buildTurnDetection(allowServerResponses: true)

        XCTAssertEqual(td["type"] as? String, "server_vad")
        XCTAssertEqual(td["threshold"] as? Double, 0.85)
        XCTAssertEqual(td["silence_duration_ms"] as? Int, 500)
        XCTAssertEqual(td["create_response"] as? Bool, true)
        XCTAssertEqual(td["interrupt_response"] as? Bool, true)
    }

    @MainActor
    func testGatedTurnDetectionDisablesServerResponses() throws {
        let client = makeClient()
        for detection in [VadDetection.semanticVad, .serverVad] {
            client.vadDetection = detection
            let td = client.buildTurnDetection(allowServerResponses: false)

            XCTAssertEqual(td["create_response"] as? Bool, false)
            XCTAssertEqual(td["interrupt_response"] as? Bool, false)
        }
    }

    @MainActor
    func testSetServerResponsesGatedFlipsStateAndAffectsSessionConfig() throws {
        let client = makeClient()
        XCTAssertFalse(client.serverResponsesGated)

        client.setServerResponsesGated(true)
        XCTAssertTrue(client.serverResponsesGated)

        let config = client.buildSessionConfig(instructions: "hi")
        let audio = try XCTUnwrap(config["audio"] as? [String: Any])
        let input = try XCTUnwrap(audio["input"] as? [String: Any])
        let td = try XCTUnwrap(input["turn_detection"] as? [String: Any])
        XCTAssertEqual(td["create_response"] as? Bool, false)

        client.setServerResponsesGated(false)
        XCTAssertFalse(client.serverResponsesGated)
    }

    @MainActor
    func testAudioDeltaTracksAssistantItemIdAndTruncateClearsIt() throws {
        let client = makeClient()
        XCTAssertNil(client.currentAssistantItemId)

        let delta: [String: Any] = [
            "type": "response.output_audio.delta",
            "item_id": "item_abc",
            "delta": Data([0, 0]).base64EncodedString(),
        ]
        client.handleMessage(try JSONSerialization.data(withJSONObject: delta))
        XCTAssertEqual(client.currentAssistantItemId, "item_abc")

        // The item id survives response.done: playback outlives the response
        // and a tail barge-in must still be able to truncate this item.
        let done: [String: Any] = ["type": "response.done"]
        client.handleMessage(try JSONSerialization.data(withJSONObject: done))
        XCTAssertEqual(client.currentAssistantItemId, "item_abc")

        client.truncatePlayedAudio(audioEndMs: 1200)
        XCTAssertNil(client.currentAssistantItemId)
        // A second truncate with no streamed item is a no-op (no double truncate).
        client.truncatePlayedAudio(audioEndMs: 1300)
        XCTAssertNil(client.currentAssistantItemId)
    }
}

/// Tests for the persisted-settings threshold migration (NIM-1314).
final class VoiceModeSettingsMigrationTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suiteName = "VoiceModeSettingsMigrationTests"

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    func testLegacyDefaultThresholdIsMigratedUpOnLoad() {
        var legacy = VoiceModeSettings()
        legacy.vadThreshold = VoiceModeSettings.legacyDefaultVadThreshold
        legacy.save(to: defaults)

        let loaded = VoiceModeSettings.load(from: defaults)
        XCTAssertEqual(loaded.vadThreshold, VoiceModeSettings.defaultVadThreshold)
    }

    func testExplicitNonDefaultThresholdIsPreserved() {
        var custom = VoiceModeSettings()
        custom.vadThreshold = 0.7
        custom.save(to: defaults)

        let loaded = VoiceModeSettings.load(from: defaults)
        XCTAssertEqual(loaded.vadThreshold, 0.7)
    }

    func testFreshSettingsUseRaisedDefault() {
        let fresh = VoiceModeSettings.load(from: defaults)
        XCTAssertEqual(fresh.vadThreshold, 0.85)
    }

    func testFreshSettingsDefaultToSemanticVad() {
        let fresh = VoiceModeSettings.load(from: defaults)
        XCTAssertNil(fresh.vadDetection)
        XCTAssertEqual(fresh.effectiveVadDetection, .semanticVad)
    }

    func testOlderPersistedSettingsWithoutDetectionFieldDecodeToSemanticVad() {
        // Settings persisted before vadDetection existed have no such key.
        let old = VoiceModeSettings()
        old.save(to: defaults)

        let loaded = VoiceModeSettings.load(from: defaults)
        XCTAssertEqual(loaded.effectiveVadDetection, .semanticVad)
    }

    func testExplicitServerVadChoiceSurvivesRoundTrip() {
        var custom = VoiceModeSettings()
        custom.vadDetection = .serverVad
        custom.save(to: defaults)

        let loaded = VoiceModeSettings.load(from: defaults)
        XCTAssertEqual(loaded.effectiveVadDetection, .serverVad)
    }
}
