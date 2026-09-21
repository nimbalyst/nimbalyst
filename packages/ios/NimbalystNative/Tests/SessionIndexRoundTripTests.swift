#if os(macOS)
import XCTest
import Combine
@testable import NimbalystNative

/// Real Node runtime publisher -> personal index wire -> Swift replication -> GRDB.
@MainActor
final class SessionIndexRoundTripTests: XCTestCase {
    private var process: Process!
    private var server: String!
    private var database: DatabaseManager!
    private var manager: SyncManager!
    private var stderrURL: URL!
    private var stderrHandle: FileHandle!

    override func setUp() async throws {
        process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("scripts/session-index-fixture.cjs")
        process.arguments = ["node", script.path]
        if let mutation = ProcessInfo.processInfo.environment["NIMBALYST_INDEX_FIXTURE_MUTATION"] {
            process.arguments?.append("--mutation=\(mutation)")
        }
        let output = Pipe()
        process.standardOutput = output
        stderrURL = FileManager.default.temporaryDirectory.appendingPathComponent("session-index-\(UUID().uuidString).stderr")
        FileManager.default.createFile(atPath: stderrURL.path, contents: nil)
        stderrHandle = try FileHandle(forWritingTo: stderrURL)
        process.standardError = stderrHandle
        try process.run()
        let portText = String(decoding: output.fileHandleForReading.availableData, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let port = try XCTUnwrap(Int(portText), "Fixture must print its ready port. \(fixtureDiagnostics())")
        server = "http://127.0.0.1:\(port)"
        database = try DatabaseManager()
        manager = SyncManager(crypto: CryptoManager(seed: "test-seed", userId: "test-user"),
            database: database, serverUrl: server, userId: "test-user", registerDeviceCallbacks: false)
        connect()
        try await eventually { self.manager.indexCoverage.historyComplete && !self.manager.connectedDevices.isEmpty }
    }

    override func tearDown() async throws {
        manager?.disconnect()
        if process?.isRunning == true { process.terminate(); process.waitUntilExit() }
        else if let process { XCTAssertEqual(process.terminationStatus, 0, fixtureDiagnostics()) }
        try stderrHandle?.close()
        if let stderrURL { try? FileManager.default.removeItem(at: stderrURL) }
    }

    private func fixtureDiagnostics() -> String {
        let status = process?.isRunning == true ? "running" : "exit \(process?.terminationStatus ?? -1)"
        let stderr = stderrURL.flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "<no stderr>"
        return "Fixture \(status): \(stderr)"
    }

    private func connect() { manager.connect(authToken: "phone", authUserId: "test-user", orgId: "test-org") }

    @discardableResult
    private func control(_ path: String) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: server + path)!)
        request.timeoutInterval = 4
        guard process.isRunning else {
            XCTFail(fixtureDiagnostics())
            throw FixtureFailure.exited
        }
        let data: Data
        let response: URLResponse
        do { (data, response) = try await URLSession.shared.data(for: request) }
        catch {
            XCTFail("Fixture control \(path) failed: \(error). \(fixtureDiagnostics())")
            throw error
        }
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(decoding: data, as: UTF8.self))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func eventually(_ condition: () throws -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(4)
        while !(try condition()) && Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        if !(try condition()) {
            print("Fixture failure coverage: \(manager.indexCoverage)")
            XCTFail("Round-trip condition timed out. \(fixtureDiagnostics())", file: file, line: line)
            if let snapshot = try? await control("/state") {
                print("Fixture server head: \(snapshot["revision"] ?? "missing")")
                let traffic = snapshot["traffic"] as? [[String: Any]] ?? []
                print("Fixture traffic: \(traffic.map { "\($0["role"] ?? ""):\($0["direction"] ?? ""):\(($0["message"] as? [String: Any])?["type"] ?? "")" })")
            }
            throw FixtureFailure.timeout
        }
    }

    private enum FixtureFailure: Error { case timeout, exited }

    func testForegroundRecoversStaleRunningIndexWithoutAnotherBroadcast() async throws {
        manager.setAppInForeground(false)
        let state = try await control("/dormant")
        let rows = try XCTUnwrap(state["rows"] as? [[String: Any]])
        XCTAssertTrue(rows.contains { $0["id"] as? String == "dormant-session" }, "Desktop publication must reach the server")
        XCTAssertNil(try database.session(byId: "dormant-session"))
        XCTAssertTrue(manager.isConnected, "Reproduce the stale connected flag")
        manager.setAppInForeground(true)
        try await eventually { try self.database.session(byId: "dormant-session")?.titleDecrypted == "Created while asleep" }
        XCTAssertEqual(try database.sessions(forProject: "/roundtrip").filter { $0.id == "dormant-session" }.count, 1)
    }

    func testCredentialRecoveryClearsReadinessWithoutClearingCachedSessions() async throws {
        try await control("/revision-seed")
        try await eventually { try self.database.session(byId: "revision-session") != nil }
        manager.prepareForRecovery()
        XCTAssertFalse(manager.isConnected, "Creation must wait while recovery refreshes credentials")
        XCTAssertEqual(try database.session(byId: "revision-session")?.titleDecrypted, "Older title")
        connect()
        try await eventually { self.manager.isConnected && self.manager.indexCoverage.historyComplete }
        XCTAssertEqual(try database.session(byId: "revision-session")?.titleDecrypted, "Older title")
    }

    func testSilentHandshakeFailsWithoutFalseReadinessAndNextConnectionRecovers() async throws {
        try await control("/silent-next")
        let client = WebSocketClient(readinessTimeout: 0.1)
        var connections = 0
        var failures = 0
        client.onConnectionStateChanged = { if $0 { connections += 1 } }
        client.onReconnectNeeded = { failures += 1 }
        defer { client.disconnect() }
        client.connect(serverUrl: server, roomId: "index", authToken: "phone")
        XCTAssertFalse(client.isConnected, "Starting a URLSession task is not readiness")
        try await eventually { failures == 1 }
        XCTAssertEqual(connections, 0)
        XCTAssertFalse(client.isConnected)
        client.reconnect()
        try await eventually { connections == 1 }
        // Exercise the old socket's cancellation callback and cancelled deadline.
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(client.isConnected)
        XCTAssertEqual(failures, 1)
    }

    func testQueuedPromptClearOverlappingPatchAndOlderReconnectPage() async throws {
        let seeded = try await control("/seed")
        try await eventually { try self.database.queuedPrompts(forSession: "queue-session").count == 2 }
        let cleared = try await control("/clear")
        let clearedRevision = try XCTUnwrap(cleared["revision"] as? Int)
        try await eventually { (self.manager.indexCoverage.lastCommittedRevision ?? 0) >= clearedRevision }
        XCTAssertEqual(try database.queuedPrompts(forSession: "queue-session").map(\.id), ["second"], "Consumed prompt must disappear after the overlapping patch commits")
        XCTAssertEqual(try database.session(byId: "queue-session")?.isExecuting, true)
        let state = try await control("/state")
        let logs = try XCTUnwrap(state["providerLogs"] as? [String])
        XCTAssertTrue(logs.contains { $0.contains("Dropping bulk index entry for queue-session: a newer publication landed first") }, "Real provider must exercise its publication gate")
        let rows = try XCTUnwrap(state["rows"] as? [[String: Any]])
        let row = try XCTUnwrap(rows.first?["session"] as? [String: Any])
        XCTAssertEqual(row["queuedPromptCount"] as? Int, 1, "Server must retain the clear across the metadata patch")
        XCTAssertEqual(try database.queuedPrompts(forSession: "queue-session").first?.promptTextDecrypted, "Keep me")

        let replayRevision = try await reconnectWithOldPage(sessionId: "queue-session")
        XCTAssertEqual(try database.queuedPrompts(forSession: "queue-session").map(\.id), ["second"], "Older revision must not resurrect consumed prompts")
        XCTAssertEqual(try database.session(byId: "queue-session")?.isExecuting, true)
        XCTAssertEqual(replayRevision, seeded["revision"] as? Int, "Exercise an actual older revision on the socket")
    }

    func testOlderRevisionCannotReplaceNewerTitle() async throws {
        try await control("/revision-seed")
        try await eventually { try self.database.session(byId: "revision-session")?.titleDecrypted == "Older title" }
        try await control("/revision-newer")
        try await eventually { try self.database.session(byId: "revision-session")?.titleDecrypted == "Newer title" }
        let state = try await control("/state")
        let rows = try XCTUnwrap(state["rows"] as? [[String: Any]])
        let newest = try XCTUnwrap(rows.first?["revision"] as? Int)
        let replayed = try await reconnectWithOldPage(sessionId: "revision-session")
        XCTAssertEqual(try database.session(byId: "revision-session")?.titleDecrypted, "Newer title", "Stale ciphertext must not replace a newer GRDB row")
        XCTAssertLessThan(replayed, newest)
    }

    private func reconnectWithOldPage(sessionId: String) async throws -> Int {
        let beforeReconnect = try await control("/state")
        let beforeTraffic = try XCTUnwrap(beforeReconnect["traffic"] as? [[String: Any]])
        manager.disconnect()
        try await control("/replay")
        connect()
        // Wait for the stale recent seed AND the subsequent delta to finish.
        try await eventually { self.manager.indexCoverage.historyComplete && self.manager.indexCoverage.compatibility == .v2 }
        // A delta request is sent only after the recent seed has committed.
        // Await that protocol barrier instead of guessing the ingestion duration.
        let deadline = Date().addingTimeInterval(4)
        var replayCommitted = false
        while !replayCommitted && Date() < deadline {
            let snapshot = try await control("/state")
            let events = try XCTUnwrap(snapshot["traffic"] as? [[String: Any]])
            replayCommitted = events.dropFirst(beforeTraffic.count).contains { event in
                let message = event["message"] as? [String: Any]
                return event["direction"] as? String == "in" && event["role"] as? String == "phone" &&
                    message?["type"] as? String == "indexPageRequest" && message?["mode"] as? String == "delta"
            }
            if !replayCommitted { try await Task.sleep(for: .milliseconds(10)) }
        }
        XCTAssertTrue(replayCommitted, "Reconnect must commit the replayed recent page before requesting delta")
        let replayState = try await control("/state")
        let traffic = try XCTUnwrap(replayState["traffic"] as? [[String: Any]])
        let recentPages = traffic.dropFirst(beforeTraffic.count).filter { event in
            let message = event["message"] as? [String: Any]
            let entries = message?["entries"] as? [[String: Any]] ?? []
            return event["role"] as? String == "phone" && message?["type"] as? String == "indexPageResponse" && message?["mode"] as? String == "recent" && entries.contains { $0["id"] as? String == sessionId }
        }
        XCTAssertEqual(recentPages.count, 1, "Exactly one recent page must contain the replayed session in this connection")
        let replayPage = try XCTUnwrap(recentPages.first?["message"] as? [String: Any])
        let replayEntries = try XCTUnwrap(replayPage["entries"] as? [[String: Any]])
        return try XCTUnwrap(replayEntries.first { $0["id"] as? String == sessionId }?["revision"] as? Int)
    }

    func testCreateAckWaitsForCommittedRowAndDuplicateCompletesOnce() async throws {
        try await control("/hold")
        var completions = 0
        var existedAtCompletion = false
        let subscription = manager.sessionCreations.$completion.compactMap { $0 }.sink { completion in
            completions += 1
            existedAtCompletion = (try? self.database.session(byId: completion.sessionId ?? "")) != nil
        }
        defer { subscription.cancel() }
        let requestId = try manager.createSession(projectId: "/roundtrip", initialPrompt: "Create via phone")
        try await eventually { self.manager.sessionCreation.pendingCount == 0 }
        XCTAssertNil(try database.session(byId: "created-session"))
        XCTAssertEqual(completions, 0, "The ack alone must not finish SessionCreationTracker")
        let held = try await control("/state")
        let traffic = try XCTUnwrap(held["traffic"] as? [[String: Any]])
        let inbound = traffic.filter { $0["direction"] as? String == "in" && $0["role"] as? String == "desktop" }
            .compactMap { $0["message"] as? [String: Any] }
        let publish = try XCTUnwrap(inbound.firstIndex { $0["type"] as? String == "indexBatchUpdate" || $0["type"] as? String == "indexUpdate" })
        let ack = try XCTUnwrap(inbound.firstIndex { $0["type"] as? String == "createSessionResponse" })
        XCTAssertLessThan(publish, ack, "Fixture publish barrier must precede its ack; shipped desktop handler is not covered")
        manager.setAppInForeground(false)
        manager.setAppInForeground(true)
        try await control("/release")
        try await eventually { completions == 1 }
        XCTAssertTrue(existedAtCompletion, "Completion must observe the committed GRDB row")
        XCTAssertEqual(manager.sessionCreations.completion?.requestId, requestId)
        XCTAssertEqual(manager.sessionCreations.completion?.sessionId, "created-session")
        try await control("/duplicate-ack")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(completions, 1)
        let final = try await control("/state")
        let finalTraffic = try XCTUnwrap(final["traffic"] as? [[String: Any]])
        XCTAssertEqual(finalTraffic.filter {
            $0["direction"] as? String == "in" && ($0["message"] as? [String: Any])?["type"] as? String == "createSessionRequest"
        }.count, 1, "Recovery must not replay session creation")
    }
}
#endif
