import XCTest
import CryptoKit
@testable import NimbalystNative

/// Opt-in seam test launched by collabv3's owned local Wrangler suite. The account
/// and database are disposable; no paired account or production service is used.
@MainActor
final class IndexReplicationTransportTests: XCTestCase {
    func testSwiftDriverConvergesAgainstWrangler() async throws {
        guard let endpoint = ProcessInfo.processInfo.environment["NIMBALYST_INDEX_FIXTURE_URL"],
              let url = URL(string: endpoint), url.host == "localhost" || url.host == "127.0.0.1" else {
            throw XCTSkip("Run through the local collabv3 index integration suite")
        }
        let crypto = CryptoManager(key: SymmetricKey(data: Data(repeating: 7, count: 32)))
        let databaseDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("index-transport-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: databaseDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let database = try DatabaseManager(path: databaseDirectory.appendingPathComponent("cache.sqlite").path)
        let session = URLSession(configuration: .ephemeral)
        let writer = session.webSocketTask(with: url)
        let reader = session.webSocketTask(with: url)
        writer.maximumMessageSize = 16 * 1024 * 1024
        reader.maximumMessageSize = 16 * 1024 * 1024
        writer.resume()
        reader.resume()
        defer {
            writer.cancel(with: .normalClosure, reason: nil)
            reader.cancel(with: .normalClosure, reason: nil)
            session.invalidateAndCancel()
        }

        let project = try crypto.encryptProjectId("/fixture/swift")
        let title = try crypto.encrypt(plaintext: "Original title")
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let rows: [[String: Any]] = (0..<225).map { index in
            ["sessionId": "swift-\(index)", "encryptedProjectId": project,
             "projectIdIv": CryptoManager.projectIdIvBase64,
             "encryptedTitle": title.encrypted, "titleIv": title.iv,
             "provider": "claude-code", "messageCount": 17,
             "createdAt": now, "updatedAt": now]
        }
        try await send(["type": "indexBatchUpdate", "sessions": rows], on: writer)
        try await send(["type": "indexSyncRequest"], on: writer)
        while true {
            let data = try await receive(writer)
            if (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["type"] as? String == "indexSyncResponse" { break }
        }

        let bridge = ReplicationTransportBridge()
        let ingestion = IndexIngestion(generation: 1, crypto: crypto, database: database,
            onOutcome: { _ in bridge.failure = "Unexpected legacy ingestion" },
            onPageOutcome: { outcome in
                if case .failed(let reason) = outcome.result { bridge.failure = reason }
                bridge.client?.handle(outcome: outcome)
            },
            onMaintenanceOutcome: { outcome in
                if let reason = outcome.failure { bridge.failure = reason }
                bridge.client?.handle(maintenance: outcome)
            })
        let client = IndexReplicationClient(generation: 1,
            send: { json in
                Task {
                    do { try await reader.send(.string(json)) }
                    catch { bridge.failure = String(describing: error) }
                }
            },
            submitPage: { page, work in ingestion.submit(.page(page, request: work), byteCount: 0) },
            submitMaintenance: { request, id in ingestion.submit(.maintenance(request, id: id), byteCount: 0) },
            onCoverageChanged: {
                bridge.coverage = $0
                if $0.hasError { bridge.failure = "Replication driver reported failure" }
            },
            onLegacyServer: { bridge.failure = "Unexpected legacy downgrade" })
        bridge.client = client
        let receiver = Task {
            let decoder = IndexMessageDecoder()
            do {
                while !Task.isCancelled {
                    let data = try await receive(reader)
                    let decoded = await decoder.decode(data)
                    switch decoded.message {
                    case .page(let page):
                        bridge.pageCount += 1
                        XCTAssertLessThanOrEqual(page.entries.count, 100)
                        XCTAssertLessThan(data.count, 15 * 1024 * 1024)
                        if !client.handle(page: page) { bridge.failure = "Unexpected page response: \(page.requestId)" }
                    case .changesAvailable(let revision): client.handle(changesAvailable: revision)
                    case .control(let type, _) where type == "error":
                        bridge.failure = String(data: data, encoding: .utf8)
                    default: break
                    }
                }
            } catch {
                if !Task.isCancelled { bridge.failure = String(describing: error) }
            }
        }
        defer { receiver.cancel(); client.cancel(); ingestion.cancel() }
        client.start()
        try await waitUntil(bridge) { bridge.coverage.historyComplete }
        XCTAssertGreaterThan(bridge.pageCount, 2)
        XCTAssertEqual(try database.sessions(forProject: "/fixture/swift").count, 225)
        XCTAssertEqual(try database.session(byId: "swift-0")?.titleDecrypted, "Original title")
        XCTAssertTrue(try database.allProjects().contains { $0.id == "/fixture/swift" })
        let initialCursor = bridge.coverage.lastCommittedRevision

        var changed = rows[0]
        let newTitle = try crypto.encrypt(plaintext: "Updated without reordering")
        changed["encryptedTitle"] = newTitle.encrypted
        changed["titleIv"] = newTitle.iv
        try await send(["type": "indexUpdate", "session": changed], on: writer)
        try await send(["type": "indexDelete", "sessionId": "swift-1"], on: writer)
        try await waitUntil(bridge) {
            try database.session(byId: "swift-0")?.titleDecrypted == "Updated without reordering"
                && database.session(byId: "swift-1") == nil
        }
        XCTAssertEqual(try database.session(byId: "swift-0")?.updatedAt, now)
        XCTAssertGreaterThan(bridge.coverage.lastCommittedRevision ?? 0, initialCursor ?? 0)
    }

    private func send(_ payload: [String: Any], on socket: URLSessionWebSocketTask) async throws {
        let data = try JSONSerialization.data(withJSONObject: payload)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }

    private func receive(_ socket: URLSessionWebSocketTask) async throws -> Data {
        switch try await socket.receive() {
        case .data(let data): return data
        case .string(let string): return Data(string.utf8)
        @unknown default: throw URLError(.cannotParseResponse)
        }
    }

    private func waitUntil(_ bridge: ReplicationTransportBridge, _ ready: () throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(30)
        while ContinuousClock.now < deadline {
            if let failure = bridge.failure { XCTFail(failure); throw URLError(.badServerResponse) }
            if try ready() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Real server replication did not converge; coverage=\(bridge.coverage)")
        throw URLError(.timedOut)
    }
}

@MainActor
private final class ReplicationTransportBridge {
    weak var client: IndexReplicationClient?
    var coverage = IndexCoverage()
    var failure: String?
    var pageCount = 0
}
