#if os(macOS)
import XCTest
@testable import NimbalystNative

@MainActor
final class DocumentSyncTransportTests: XCTestCase {
    func testLargeDownloadResumesWithFreshTokenAndPartialManifest() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("scripts/document-sync-fixture.cjs")
        process.arguments = ["node", script.path, "--interrupt"]
        let output = Pipe()
        process.standardOutput = output
        try process.run()
        defer { process.terminate(); process.waitUntilExit() }
        let portData = output.fileHandleForReading.availableData
        let port = try XCTUnwrap(String(data: portData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines))
        let server = "http://127.0.0.1:\(port)"
        let project = "/test/network-files"
        let db = try DatabaseManager()
        try db.upsertProject(Project(id: project, name: "Network files"))
        let crypto = CryptoManager(seed: "test-seed", userId: "test-user")
        let manager = DocumentSyncManager(crypto: crypto, database: db, serverUrl: server, userId: "test-user")
        defer { manager.disconnectAll() }
        manager.setAuth(authToken: "old-test-token", authUserId: "test-user", orgId: "test-org")
        manager.connectProject(project)
        let firstDeadline = Date().addingTimeInterval(8)
        while Date() < firstDeadline {
            if case .failed = manager.state(for: project) { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard case .failed = manager.state(for: project) else { return XCTFail("Interrupted transfer must surface an error") }
        let partial = try db.documents(forProject: project).count
        XCTAssertEqual(partial, 50)
        manager.setAuth(authToken: "fresh-test-token", authUserId: "test-user", orgId: "test-org")
        let deadline = Date().addingTimeInterval(12)
        while manager.state(for: project) != .ready && Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(manager.state(for: project), .ready)
        XCTAssertEqual(try db.documents(forProject: project).count, 2293)
        let doc = try XCTUnwrap(db.document(byId: "file-2292"))
        XCTAssertTrue(try XCTUnwrap(manager.decryptContentOnDemand(doc)).hasPrefix("# Downloaded document"))
        let (data, _) = try await URLSession.shared.data(from: URL(string: server)!)
        let status = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let requests = try XCTUnwrap(status["requests"] as? [[String: Any]])
        XCTAssertEqual(requests.count, 2, "Old connection callbacks must not create a second reconnect")
        XCTAssertEqual(requests.last?["token"] as? String, "fresh-test-token")
        XCTAssertEqual(requests.last?["count"] as? Int, partial)
    }
}
#endif
