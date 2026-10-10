import XCTest
import GRDB
@testable import NimbalystNative

/// Tests for PostHog analytics integration.
/// Covers QR analyticsId parsing, opt-out persistence, and AnalyticsManager state.
final class AnalyticsTests: XCTestCase {

    // MARK: - QR Pairing Data analyticsId

    func testParseV4CapturesAnalyticsIdSeparately() {
        let futureMs = Int(Date().timeIntervalSince1970 * 1000) + 900_000
        let json = """
        {"version":4,"serverUrl":"wss://sync.example.com","encryptionKeySeed":"seed123","expiresAt":\(futureMs),"analyticsId":"phog_abc123","syncEmail":"user@test.com"}
        """
        let result = QRPairingData.parse(json)
        XCTAssertNotNil(result)
        // userId should be syncEmail (primary), not analyticsId
        XCTAssertEqual(result?.userId, "user@test.com")
        // analyticsId should be captured separately
        XCTAssertEqual(result?.analyticsId, "phog_abc123")
    }

    func testParseLegacyPayloadHasNilAnalyticsId() {
        let json = """
        {"seed":"abc123","serverUrl":"https://sync.example.com","userId":"user-456"}
        """
        let result = QRPairingData.parse(json)
        XCTAssertNotNil(result)
        XCTAssertNil(result?.analyticsId)
    }

    func testParseV4WithAnalyticsIdOnlyAsUserId() {
        // When only analyticsId is present (no syncEmail, no userId)
        let futureMs = Int(Date().timeIntervalSince1970 * 1000) + 900_000
        let json = """
        {"version":4,"serverUrl":"wss://sync.example.com","encryptionKeySeed":"key","expiresAt":\(futureMs),"analyticsId":"only-analytics"}
        """
        let result = QRPairingData.parse(json)
        XCTAssertNotNil(result)
        // analyticsId serves as both userId fallback and analytics identity
        XCTAssertEqual(result?.userId, "only-analytics")
        XCTAssertEqual(result?.analyticsId, "only-analytics")
    }

    // MARK: - Analytics Opt-out Persistence

    private static let analyticsEnabledKey = "analytics_enabled"

    func testOptOutPersistence() {
        // Default should be enabled (key not set)
        UserDefaults.standard.removeObject(forKey: Self.analyticsEnabledKey)
        let defaultValue = UserDefaults.standard.object(forKey: Self.analyticsEnabledKey) as? Bool
        XCTAssertNil(defaultValue, "Default should be nil (treated as enabled)")

        // Set to false (opt out)
        UserDefaults.standard.set(false, forKey: Self.analyticsEnabledKey)
        XCTAssertFalse(UserDefaults.standard.bool(forKey: Self.analyticsEnabledKey))

        // Set to true (opt in)
        UserDefaults.standard.set(true, forKey: Self.analyticsEnabledKey)
        XCTAssertTrue(UserDefaults.standard.bool(forKey: Self.analyticsEnabledKey))

        // Cleanup
        UserDefaults.standard.removeObject(forKey: Self.analyticsEnabledKey)
    }

    // MARK: - AnalyticsManager State

    @MainActor
    func testAnalyticsManagerDefaultEnabled() {
        // AnalyticsManager.shared.isEnabled defaults to true
        XCTAssertTrue(AnalyticsManager.shared.isEnabled)
    }

    // MARK: - QRPairingData Equality with analyticsId

    func testQRPairingDataEqualityWithAnalyticsId() {
        let a = QRPairingData(seed: "s", serverUrl: "u", userId: "i", analyticsId: "a1", personalOrgId: nil, personalUserId: nil)
        let b = QRPairingData(seed: "s", serverUrl: "u", userId: "i", analyticsId: "a1", personalOrgId: nil, personalUserId: nil)
        let c = QRPairingData(seed: "s", serverUrl: "u", userId: "i", analyticsId: "a2", personalOrgId: nil, personalUserId: nil)
        let d = QRPairingData(seed: "s", serverUrl: "u", userId: "i", analyticsId: nil, personalOrgId: nil, personalUserId: nil)

        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
        XCTAssertNotEqual(a, d)
    }

    // MARK: - Session load error properties

    func testSessionLoadErrorPropertiesCarryCountsButNoDetailText() {
        let decrypt = SessionLoadError.decryptionFailed(decryptedCount: 0, totalCount: 12)
            .analyticsProperties(localMessageCount: 3)
        XCTAssertEqual(decrypt["errorType"] as? String, "decryptionFailed")
        XCTAssertEqual(decrypt["decryptedCount"] as? Int, 0)
        XCTAssertEqual(decrypt["serverMessageCount"] as? Int, 12)
        XCTAssertEqual(decrypt["localMessageCount"] as? Int, 3)

        // Detail strings can contain session ids and server error text.
        let sync = SessionLoadError.syncFailed("room abc-123 rejected")
            .analyticsProperties(localMessageCount: 0)
        XCTAssertEqual(sync["errorType"] as? String, "syncFailed")
        XCTAssertFalse(sync.values.contains { ($0 as? String)?.contains("abc-123") == true })
    }

    func testSessionListFailureReportsSQLiteMessageWithoutStatement() throws {
        let queue = try DatabaseQueue()
        var thrown: Error?
        do { _ = try queue.read { try Row.fetchAll($0, sql: "SELECT missingColumn FROM sqlite_master WHERE name = ?", arguments: ["secret-session-id"]) } }
        catch { thrown = error }

        let failure = SessionListLoadFailure(stage: .projection, error: try XCTUnwrap(thrown))
        XCTAssertTrue(failure.detail.contains("no such column: missingColumn"), failure.detail)
        XCTAssertFalse(failure.detail.contains("secret-session-id"))
        XCTAssertFalse(failure.detail.contains("SELECT"))
        XCTAssertEqual(failure.analyticsProperties["stage"] as? String, "projection")
        XCTAssertEqual(failure.analyticsProperties["sqliteResultCode"] as? Int, 1)
    }
}
