import XCTest
@testable import NimbalystNative

/// Tests for Meta Agent creation from mobile (Phase 1):
/// - the create-session wire request carries `agentRole`
/// - the synced settings carry the `metaAgentEnabled` alpha gate
/// - FeaturePreferences persists the gate
final class MetaAgentCreateTests: XCTestCase {

    @MainActor
    func testErrorDismissalDefersPublishingAndPreservesNewErrors() async {
        let requests = SessionCreationRequests()
        requests.errorMessage = "Creation failed"
        requests.dismissError()
        requests.dismissError() // Both the alert binding and button may dismiss.
        XCTAssertEqual(requests.errorMessage, "Creation failed", "Do not publish inside SwiftUI's view update")
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        XCTAssertNil(requests.errorMessage)

        for nextError in ["A newer failure", "Creation failed"] {
            requests.errorMessage = "Creation failed"
            requests.dismissError()
            requests.errorMessage = nextError
            await withCheckedContinuation { continuation in
                DispatchQueue.main.async { continuation.resume() }
            }
            XCTAssertEqual(requests.errorMessage, nextError, "A newer failure must survive, even with identical text")
        }
    }

    @MainActor
    func testDesktopTargetAndRequestOutcomes() throws {
        let requests = SessionCreationRequests()
        let crypto = CryptoManager(seed: SyncIntegrationTests.passphrase, userId: SyncIntegrationTests.userId)
        let desktop = creationDevice("mac", type: "desktop", status: "away", lastActive: 1)
        let sandbox = creationDevice("sandbox", type: "headless", status: "active", lastActive: 999)
        var wire: [String: Any] = [:]
        var options = SessionCreationOptions(projectId: "/mac/project", initialPrompt: "hello", provider: "openai-codex")
        let requestId = try requests.create(options, crypto: crypto, devices: [sandbox, desktop], isConnected: true) { json, completion in
            wire = try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
            completion(nil)
        }
        // The server reads the envelope field, not request.targetDeviceId.
        XCTAssertEqual(wire["targetDeviceId"] as? String, "mac")
        let payload = try XCTUnwrap(wire["request"] as? [String: Any])
        XCTAssertNil(payload["targetDeviceId"])
        XCTAssertEqual(payload["provider"] as? String, "openai-codex")
        XCTAssertEqual(requests.pendingCount, 1, "Socket send success is not session creation success")
        XCTAssertFalse(requests.receive(CreateSessionResponse(requestId: "another-phone", success: true, sessionId: "other", error: nil)))
        XCTAssertEqual(requests.pendingCount, 1)
        XCTAssertTrue(requests.receive(CreateSessionResponse(requestId: requestId, success: true, sessionId: "created", error: nil)))
        XCTAssertEqual(requests.pendingCount, 0)
        XCTAssertFalse(requests.receive(CreateSessionResponse(requestId: requestId, success: true, sessionId: "created", error: nil)))

        // Explicit machine choice still works; only the default is desktop-only.
        options.targetDeviceId = "sandbox"
        let rejectedId = try requests.create(options, crypto: crypto, devices: [sandbox, desktop], isConnected: true) { json, _ in
            let envelope = try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
            XCTAssertEqual(envelope["targetDeviceId"] as? String, "sandbox")
        }
        XCTAssertFalse(requests.receive(CreateSessionResponse(requestId: rejectedId, success: false, sessionId: nil, error: "Workspace is unavailable")))
        XCTAssertEqual(requests.errorMessage, "Workspace is unavailable")
        XCTAssertEqual(requests.pendingCount, 0)
    }

    @MainActor
    func testMissingDesktopSendFailureDisconnectAndTimeoutAreVisible() async throws {
        let requests = SessionCreationRequests(timeoutNanoseconds: 10_000_000)
        let crypto = CryptoManager(seed: SyncIntegrationTests.passphrase, userId: SyncIntegrationTests.userId)
        let options = SessionCreationOptions(projectId: "/mac/project")
        let desktop = creationDevice("mac", type: "desktop", status: "away", lastActive: 1)
        let sandbox = creationDevice("sandbox", type: "headless", status: "active", lastActive: 999)
        XCTAssertThrowsError(try requests.create(options, crypto: crypto, devices: [sandbox], isConnected: true) { _, _ in
            XCTFail("A sandbox must never be an implicit fallback")
        })
        XCTAssertTrue(requests.errorMessage?.contains("No desktop") == true)
        _ = try requests.create(options, crypto: crypto, devices: [desktop], isConnected: true) { _, completion in
            completion(NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "Send failed"]))
        }
        XCTAssertEqual(requests.errorMessage, "Send failed")
        XCTAssertEqual(requests.pendingCount, 0)
        let disconnectedId = try requests.create(options, crypto: crypto, devices: [desktop], isConnected: true) { _, _ in }
        XCTAssertNil(requests.errorMessage)
        requests.disconnect()
        XCTAssertEqual(requests.pendingCount, 0)
        XCTAssertNotNil(requests.errorMessage)
        XCTAssertFalse(requests.receive(CreateSessionResponse(requestId: disconnectedId, success: true, sessionId: "late", error: nil)))
        var sends = 0
        _ = try requests.create(options, crypto: crypto, devices: [desktop], isConnected: true) { _, _ in sends += 1 }
        for _ in 0..<100 where requests.pendingCount != 0 {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(requests.pendingCount, 0)
        XCTAssertTrue(requests.errorMessage?.contains("may still appear") == true)
        XCTAssertEqual(sends, 1, "An ambiguous timeout must not create a duplicate session")
    }

    private func creationDevice(_ id: String, type: String, status: String, lastActive: Int) -> DeviceInfo {
        DeviceInfo(deviceId: id, name: id, type: type, platform: "test", appVersion: nil,
            connectedAt: 1, lastActiveAt: lastActive, isFocused: false, status: status)
    }

    // MARK: - Create request encodes agentRole (camelCase wire format)

    func testCreateSessionRequestEncodesAgentRole() throws {
        let message = CreateSessionRequestMessage(
            request: EncryptedCreateSessionRequest(
                requestId: "req-1",
                encryptedProjectId: "enc-project",
                projectIdIv: CryptoManager.projectIdIvBase64,
                encryptedInitialPrompt: nil,
                initialPromptIv: nil,
                sessionType: nil,
                parentSessionId: nil,
                provider: "claude-code",
                model: "claude-code:opus",
                agentRole: "meta-agent",
                timestamp: 1707820800000
            )
        )

        let data = try JSONEncoder().encode(message)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "createSessionRequest")
        let request = json["request"] as! [String: Any]
        XCTAssertEqual(request["agentRole"] as? String, "meta-agent")
        XCTAssertEqual(request["provider"] as? String, "claude-code")
    }

    func testCreateSessionRequestOmitsAgentRoleWhenNil() throws {
        let message = CreateSessionRequestMessage(
            request: EncryptedCreateSessionRequest(
                requestId: "req-2",
                encryptedProjectId: "enc-project",
                projectIdIv: CryptoManager.projectIdIvBase64,
                encryptedInitialPrompt: nil,
                initialPromptIv: nil,
                sessionType: nil,
                parentSessionId: nil,
                provider: nil,
                model: nil,
                agentRole: nil,
                timestamp: 1707820800000
            )
        )

        let data = try JSONEncoder().encode(message)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let request = json["request"] as! [String: Any]
        // Optional nil fields are omitted by the default Codable encoder.
        XCTAssertNil(request["agentRole"])
    }

    // MARK: - SyncedSettings carries the metaAgentEnabled gate

    func testSyncedSettingsDecodesMetaAgentEnabled() throws {
        let jsonOn = #"{"metaAgentEnabled": true, "version": 3}"#.data(using: .utf8)!
        let on = try JSONDecoder().decode(SyncedSettings.self, from: jsonOn)
        XCTAssertEqual(on.metaAgentEnabled, true)

        // Absent flag decodes to nil (back-compat with older desktops).
        let jsonAbsent = #"{"version": 3}"#.data(using: .utf8)!
        let absent = try JSONDecoder().decode(SyncedSettings.self, from: jsonAbsent)
        XCTAssertNil(absent.metaAgentEnabled)
    }

    // MARK: - FeaturePreferences round-trip

    func testFeaturePreferencesMetaAgentRoundTrip() {
        FeaturePreferences.setMetaAgentEnabled(true)
        XCTAssertTrue(FeaturePreferences.metaAgentEnabled)
        FeaturePreferences.setMetaAgentEnabled(false)
        XCTAssertFalse(FeaturePreferences.metaAgentEnabled)
    }
}
