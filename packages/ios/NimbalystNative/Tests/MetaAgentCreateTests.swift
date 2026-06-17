import XCTest
@testable import NimbalystNative

/// Tests for Meta Agent creation from mobile (Phase 1):
/// - the create-session wire request carries `agentRole`
/// - the synced settings carry the `metaAgentEnabled` alpha gate
/// - FeaturePreferences persists the gate
final class MetaAgentCreateTests: XCTestCase {

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
