import XCTest
@testable import NimbalystNative

@MainActor
final class SyncRecoveryCoordinatorTests: XCTestCase {
    private func token(expiresIn: TimeInterval) -> String {
        let data = try! JSONSerialization.data(withJSONObject: ["exp": Date().addingTimeInterval(expiresIn).timeIntervalSince1970])
        return "header.\(data.base64EncodedString()).signature"
    }

    private func eventually(_ condition: () async -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(1)
        while !(await condition()) && ContinuousClock.now < deadline { await Task.yield() }
        let result = await condition()
        XCTAssertTrue(result)
    }

    func testOverlappingWakeNetworkAndTimerWaitForOneCredentialRefresh() async {
        var jwt = token(expiresIn: -300)
        let fresh = token(expiresIn: 300)
        var refreshes = 0
        var connectedTokens: [String] = []
        var refresh: CheckedContinuation<Bool, Never>?
        let coordinator = SyncRecoveryCoordinator {
            guard let token = await SyncCredentials.freshToken(read: { jwt }, isCurrent: { true }, refresh: {
                refreshes += 1
                return await withCheckedContinuation { refresh = $0 }
            }) else { return false }
            connectedTokens.append(token)
            return true
        }
        defer { coordinator.cancel() }
        coordinator.configure(identity: "account")
        coordinator.setForeground(false)
        coordinator.setForeground(true)
        await eventually { refresh != nil }
        coordinator.request(reason: "network")
        coordinator.request(reason: "credential timer")
        coordinator.setForeground(true)
        XCTAssertEqual(refreshes, 1)
        XCTAssertTrue(connectedTokens.isEmpty, "No stale token may open a connection")
        jwt = fresh
        refresh?.resume(returning: true)
        await eventually { connectedTokens.count == 1 }
        XCTAssertEqual(connectedTokens, [fresh])
    }

    func testLateCredentialRefreshCannotConnectAfterAccountSwitchOrLogout() async {
        for replacement: String? in ["new-account", nil] {
            var selected: String? = "old-account"
            var jwt = token(expiresIn: -300)
            let fresh = token(expiresIn: 300)
            var refresh: CheckedContinuation<Bool, Never>?
            var connections = 0
            var completed = false
            let coordinator = SyncRecoveryCoordinator {
                let captured = selected
                let result = await SyncCredentials.freshToken(read: { jwt }, isCurrent: { selected == captured }, refresh: {
                    await withCheckedContinuation { refresh = $0 }
                })
                if result != nil { connections += 1 }
                completed = true
                return result != nil
            }
            coordinator.configure(identity: selected)
            coordinator.request(reason: "startup")
            await eventually { refresh != nil }
            selected = replacement
            coordinator.configure(identity: replacement)
            jwt = fresh
            refresh?.resume(returning: true)
            await eventually { completed }
            XCTAssertEqual(connections, 0)
            coordinator.cancel()
        }
    }

    func testDisconnectDuringSuccessfulAttemptStillSchedulesRecovery() async {
        let clock = RecoveryTestClock()
        var finish: CheckedContinuation<Bool, Never>?
        let coordinator = SyncRecoveryCoordinator(sleep: { try await clock.sleep($0) }) {
            await withCheckedContinuation { finish = $0 }
        }
        coordinator.configure(identity: "account")
        coordinator.request(reason: "startup")
        await eventually { finish != nil }
        coordinator.connectionFailed()
        finish?.resume(returning: true)
        await eventually { await clock.pendingCount == 1 }
        coordinator.cancel()
        await clock.advance()
    }

    func testAttemptSuspendedAcrossBackgroundCannotSatisfyNextWake() async {
        let clock = RecoveryTestClock()
        var attempts: [CheckedContinuation<Bool, Never>] = []
        let coordinator = SyncRecoveryCoordinator(sleep: { try await clock.sleep($0) }) {
            await withCheckedContinuation { attempts.append($0) }
        }
        coordinator.configure(identity: "account")
        coordinator.request(reason: "startup")
        await eventually { attempts.count == 1 }
        coordinator.setForeground(false)
        coordinator.setForeground(true)
        await eventually { attempts.count == 2 }
        attempts[0].resume(returning: true)
        attempts[1].resume(returning: false)
        await eventually { await clock.pendingCount == 1 }
        coordinator.cancel()
        await clock.advance()
        await Task.yield()
        XCTAssertEqual(attempts.count, 2)
    }

    func testOfflineRetryPausesInBackgroundAndNetworkReturnCancelsOldRetry() async {
        let clock = RecoveryTestClock()
        var attempts = 0
        var online = false
        let coordinator = SyncRecoveryCoordinator(sleep: { try await clock.sleep($0) }, retryDelay: { _ in .seconds(2) }) {
            attempts += 1
            return online
        }
        defer { coordinator.cancel() }
        coordinator.configure(identity: "account")
        coordinator.request(reason: "startup")
        await eventually { await clock.pendingCount == 1 }
        coordinator.setForeground(false)
        await clock.advance()
        await Task.yield()
        XCTAssertEqual(attempts, 1)
        coordinator.setForeground(true)
        await eventually { await clock.pendingCount == 1 }
        XCTAssertEqual(attempts, 2)
        online = true
        coordinator.request(reason: "network")
        await eventually { attempts == 3 }
        await clock.advance()
        await Task.yield()
        XCTAssertEqual(attempts, 3, "Cancelled backoff must not replace the recovered socket")
        coordinator.setForeground(true)
        await Task.yield()
        XCTAssertEqual(attempts, 3, "Repeated active notifications do not reconnect")
    }
}

private actor RecoveryTestClock {
    private var pending: [CheckedContinuation<Void, Error>] = []
    var pendingCount: Int { pending.count }
    func sleep(_ duration: Duration) async throws {
        try await withCheckedThrowingContinuation { pending.append($0) }
    }
    func advance() {
        let work = pending
        pending.removeAll()
        work.forEach { $0.resume() }
    }
}
