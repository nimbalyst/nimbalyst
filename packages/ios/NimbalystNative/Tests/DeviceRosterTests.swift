import XCTest
import Combine
@testable import NimbalystNative

final class DeviceRosterTests: XCTestCase {
    private static let nowMs = 100 * 86_400_000

    private func device(_ id: String, online: Bool?, seenDaysAgo: Int) -> DeviceInfo {
        DeviceInfo(inventoryHidden: nil, deviceId: id, name: "Mac", type: "desktop", platform: "macos", appVersion: nil,
                   connectedAt: 0, lastActiveAt: 0, isFocused: nil, status: nil, isOnline: online,
                   lastSeenAt: Self.nowMs - seenDaysAgo * 86_400_000)
    }

    func testKeepsOnlineAndRecentlySeenDevices() {
        let kept = DeviceRoster.recent([
            device("live", online: true, seenDaysAgo: 30),
            device("legacy-presence", online: nil, seenDaysAgo: 30),
            device("recent", online: false, seenDaysAgo: 6),
            device("old", online: false, seenDaysAgo: 8),
        ], now: Date(timeIntervalSince1970: TimeInterval(Self.nowMs / 1000)))
        XCTAssertEqual(kept.map(\.deviceId), ["live", "legacy-presence", "recent"])
    }

    @MainActor
    func testConnectionStatusTracksSelectedComputerAndReconnect() {
        let roster = PassthroughSubject<[DeviceInfo], Never>()
        let navigation = WorkspaceNavigationState()
        navigation.observeHosts(source: roster, publisher: roster.eraseToAnyPublisher())
        defer { navigation.stopObservingHosts() }
        roster.send([device("old", online: false, seenDaysAgo: 0), device("live", online: true, seenDaysAgo: 0)])
        XCTAssertTrue(navigation.isSelectedHostConnected)
        navigation.hostDeviceId = "old"
        XCTAssertFalse(navigation.isSelectedHostConnected, "Another online computer must not make this selection green")
        roster.send([device("old", online: true, seenDaysAgo: 0)])
        XCTAssertTrue(navigation.isSelectedHostConnected)
        roster.send([])
        XCTAssertFalse(navigation.isSelectedHostConnected)
        XCTAssertEqual(navigation.hostDeviceId, "old", "Reconnection preserves selection")
    }

    @MainActor
    func testDefaultHostSkipsOfflineInventoryWithoutReplacingExplicitSelection() {
        let navigation = WorkspaceNavigationState()
        let offline = device("old", online: false, seenDaysAgo: 0)
        let online = device("live", online: true, seenDaysAgo: 0)
        navigation.adoptDefaultHost(from: [offline, online])
        XCTAssertEqual(navigation.hostDeviceId, "live")
        navigation.hostDeviceId = "old"
        navigation.adoptDefaultHost(from: [offline, online])
        XCTAssertEqual(navigation.hostDeviceId, "old", "Do not redirect an explicit computer selection")
    }

    @MainActor
    func testSessionListIsUnfilteredWithOneComputerAndKeepsTheAnswerWhileReconnecting() {
        let roster = PassthroughSubject<[DeviceInfo], Never>()
        let navigation = WorkspaceNavigationState()
        navigation.observeHosts(source: roster, publisher: roster.eraseToAnyPublisher())
        defer { navigation.stopObservingHosts() }

        roster.send([device("only", online: true, seenDaysAgo: 0)])
        XCTAssertEqual(navigation.hostDeviceId, "only")
        XCTAssertNil(navigation.sessionListHostFilter, "One computer: sessions under its older ids stay listed")

        roster.send([device("a", online: true, seenDaysAgo: 0), device("b", online: true, seenDaysAgo: 0)])
        XCTAssertEqual(navigation.sessionListHostFilter, "only")
        roster.send([])
        XCTAssertEqual(navigation.sessionListHostFilter, "only", "An empty roster while reconnecting must not unfilter the list")
    }
}
