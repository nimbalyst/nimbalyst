import XCTest
@testable import NimbalystNative

/// Tests for Phase 4: Settings, QR pairing, and push notifications.
/// Covers QR data parsing, push token message encoding, and settings state.
final class Phase4Tests: XCTestCase {

    // MARK: - QR Pairing Data Parsing (v4 desktop format)

    func testParseV4DesktopPayload() {
        let futureMs = Int(Date().timeIntervalSince1970 * 1000) + 900_000 // 15 min from now
        let json = """
        {"version":4,"serverUrl":"wss://sync.nimbalyst.com","encryptionKeySeed":"abc123base64==","expiresAt":\(futureMs),"analyticsId":"posthog-id","syncEmail":"user@example.com"}
        """
        let result = QRPairingData.parse(json)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.seed, "abc123base64==")
        XCTAssertEqual(result?.serverUrl, "wss://sync.nimbalyst.com")
        XCTAssertEqual(result?.userId, "user@example.com")
        XCTAssertEqual(result?.analyticsId, "posthog-id")
    }

    func testParseV4WithoutSyncEmail() {
        // When syncEmail is absent, analyticsId is used as userId
        let futureMs = Int(Date().timeIntervalSince1970 * 1000) + 900_000
        let json = """
        {"version":4,"serverUrl":"wss://sync.nimbalyst.com","encryptionKeySeed":"key123","expiresAt":\(futureMs),"analyticsId":"analytics-id-456"}
        """
        let result = QRPairingData.parse(json)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.userId, "analytics-id-456")
        XCTAssertEqual(result?.analyticsId, "analytics-id-456")
    }

    func testParseExpiredQRCode() {
        let pastMs = Int(Date().timeIntervalSince1970 * 1000) - 60_000 // 1 min ago
        let json = """
        {"version":4,"serverUrl":"wss://sync.nimbalyst.com","encryptionKeySeed":"key","expiresAt":\(pastMs),"analyticsId":"id","syncEmail":"a@b.com"}
        """
        XCTAssertNil(QRPairingData.parse(json))
    }

    func testParseLegacyPayload() {
        let json = """
        {"seed":"abc123","serverUrl":"https://sync.nimbalyst.com","userId":"user-456"}
        """
        let result = QRPairingData.parse(json)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.seed, "abc123")
        XCTAssertEqual(result?.serverUrl, "https://sync.nimbalyst.com")
        XCTAssertEqual(result?.userId, "user-456")
    }

    func testParseQRDataWithExtraFields() {
        let json = """
        {"seed":"key","serverUrl":"https://example.com","userId":"u1","extra":"ignored"}
        """
        let result = QRPairingData.parse(json)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.seed, "key")
    }

    func testParseQRDataMissingSeedAndEncryptionKey() {
        let json = """
        {"serverUrl":"https://example.com","userId":"u1"}
        """
        XCTAssertNil(QRPairingData.parse(json))
    }

    func testParseQRDataMissingServerUrl() {
        let json = """
        {"seed":"key","userId":"u1"}
        """
        XCTAssertNil(QRPairingData.parse(json))
    }

    func testParseQRDataMissingAllUserIdentifiers() {
        // No syncEmail, userId, or analyticsId
        let json = """
        {"encryptionKeySeed":"key","serverUrl":"https://example.com"}
        """
        XCTAssertNil(QRPairingData.parse(json))
    }

    func testParseQRDataEmptySeed() {
        let json = """
        {"seed":"","serverUrl":"https://example.com","userId":"u1"}
        """
        XCTAssertNil(QRPairingData.parse(json))
    }

    func testParseQRDataInvalidJSON() {
        XCTAssertNil(QRPairingData.parse("not json"))
    }

    func testParseQRDataEmptyString() {
        XCTAssertNil(QRPairingData.parse(""))
    }

    func testParseQRDataURLAsPlainText() {
        XCTAssertNil(QRPairingData.parse("https://example.com"))
    }

    // MARK: - Push Token Registration Message

    func testRegisterPushTokenMessageEncoding() throws {
        let message = NotificationManager.makeRegisterTokenMessage(
            token: "abc123token",
            deviceId: "device-789"
        )
        let data = try JSONEncoder().encode(message)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "registerPushToken")
        XCTAssertEqual(json["token"] as? String, "abc123token")
        XCTAssertEqual(json["platform"] as? String, "ios")
        XCTAssertEqual(json["deviceId"] as? String, "device-789")
    }

    // MARK: - QR Pairing Data Equality

    func testQRPairingDataEquality() {
        let a = QRPairingData(seed: "s", serverUrl: "u", userId: "i", analyticsId: nil, personalOrgId: nil, personalUserId: nil)
        let b = QRPairingData(seed: "s", serverUrl: "u", userId: "i", analyticsId: nil, personalOrgId: nil, personalUserId: nil)
        let c = QRPairingData(seed: "x", serverUrl: "u", userId: "i", analyticsId: nil, personalOrgId: nil, personalUserId: nil)

        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
    }

    // MARK: - AppState Unpair

    @MainActor
    func testUnpairClearsState() throws {
        let db = try DatabaseManager()
        let appState = AppState(databaseManager: db)

        XCTAssertTrue(appState.isPaired)
        XCTAssertNotNil(appState.databaseManager)

        appState.unpair()

        XCTAssertFalse(appState.isPaired)
        XCTAssertNil(appState.databaseManager)
    }

    // MARK: - Push Notification Defaults

    func testPushNotificationDefaultOff() {
        // Clean state: push should default to off
        UserDefaults.standard.removeObject(forKey: "pushNotificationsEnabled")
        let enabled = UserDefaults.standard.bool(forKey: "pushNotificationsEnabled")
        XCTAssertFalse(enabled)
    }

    func testPushNotificationPersistence() {
        UserDefaults.standard.set(true, forKey: "pushNotificationsEnabled")
        XCTAssertTrue(UserDefaults.standard.bool(forKey: "pushNotificationsEnabled"))

        UserDefaults.standard.set(false, forKey: "pushNotificationsEnabled")
        XCTAssertFalse(UserDefaults.standard.bool(forKey: "pushNotificationsEnabled"))

        // Cleanup
        UserDefaults.standard.removeObject(forKey: "pushNotificationsEnabled")
    }
}
