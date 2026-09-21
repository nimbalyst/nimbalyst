import XCTest
@testable import NimbalystNative

/// The golden fixtures in `packages/collab-protocol/fixtures/` are the executable
/// contract between the hand-mirrored TypeScript wire types and the Swift
/// Codables in `SyncProtocol.swift` / `IndexReplicationProtocol.swift`.
///
/// A TypeScript test pins each fixture to its desktop type. This is the Swift
/// half: every fixture is decoded into its Swift counterpart and re-encoded, and
/// the two key sets must match exactly. A field the TypeScript side gained and
/// Swift silently drops fails here; so does a Swift field the fixture does not
/// carry. Direction does not change the assertion — decode-then-encode proves the
/// shape for a message iOS only sends just as well as for one it only receives.
final class WireFixtureTests: XCTestCase {

    // MARK: - Fixture location

    /// `packages/collab-protocol/fixtures`, reached from `#filePath` the same way
    /// `DocumentSyncTransportTests` reaches `packages/ios/scripts`.
    private static var fixturesDirectory: URL {
        var url = URL(fileURLWithPath: #filePath)
        // WireFixtureTests.swift -> Tests -> NimbalystNative -> ios -> packages
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("collab-protocol/fixtures")
    }

    // MARK: - Manifest

    private struct Manifest: Decodable {
        /// Quoted in the first revision of the manifest, a bare number since.
        /// Only ever printed, so accept either rather than failing every fixture
        /// on the shape of a label.
        let contractRevision: String
        let fixtures: [Entry]

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            if let text = try? container.decode(String.self, forKey: .contractRevision) {
                contractRevision = text
            } else {
                contractRevision = String(try container.decode(Int.self, forKey: .contractRevision))
            }
            fixtures = try container.decode([Entry].self, forKey: .fixtures)
        }

        enum CodingKeys: String, CodingKey {
            case contractRevision, fixtures
        }

        struct Entry: Decodable {
            let file: String
            let direction: String
            /// The Swift type covering the whole fixture, envelope included. A
            /// type that covers only an inner payload leaves the envelope's own
            /// fields unchecked, which is how `targetDeviceId` went missing from
            /// the worktree request for as long as it did.
            let swiftType: String?
        }
    }

    // MARK: - Round-trip registry

    private typealias RoundTrip = @Sendable (Data) throws -> Data

    private static func roundTrip<T: Codable>(_: T.Type) -> RoundTrip {
        { data in
            let decoded = try JSONDecoder().decode(T.self, from: data)
            return try JSONEncoder().encode(decoded)
        }
    }

    /// Every Swift type the manifest may name. A manifest entry naming a type
    /// absent from this table fails rather than passing unnoticed.
    private static let roundTrips: [String: RoundTrip] = [
        "AppendMessageRequest": roundTrip(AppendMessageRequest.self),
        "ClientMetadata": roundTrip(ClientMetadata.self),
        "CreateSessionRequestBroadcast": roundTrip(CreateSessionRequestBroadcast.self),
        "CreateSessionRequestMessage": roundTrip(CreateSessionRequestMessage.self),
        "CreateSessionResponseBroadcast": roundTrip(CreateSessionResponseBroadcast.self),
        "CreateSessionResponseMessage": roundTrip(CreateSessionResponseMessage.self),
        "CreateWorktreeRequestBroadcast": roundTrip(CreateWorktreeRequestBroadcast.self),
        "CreateWorktreeRequestMessage": roundTrip(CreateWorktreeRequestMessage.self),
        "CreateWorktreeResponseBroadcast": roundTrip(CreateWorktreeResponseBroadcast.self),
        "CreateWorktreeResponseMessage": roundTrip(CreateWorktreeResponseMessage.self),
        "DeviceAnnounceMessage": roundTrip(DeviceAnnounceMessage.self),
        "DeviceJoinedMessage": roundTrip(DeviceJoinedMessage.self),
        "DeviceLeftMessage": roundTrip(DeviceLeftMessage.self),
        "DevicesListMessage": roundTrip(DevicesListMessage.self),
        "FileIndexBroadcast": roundTrip(FileIndexBroadcast.self),
        "FileIndexDeleteBroadcast": roundTrip(FileIndexDeleteBroadcast.self),
        "FileIndexDeleteMessage": roundTrip(FileIndexDeleteMessage.self),
        "FileIndexUpdateMessage": roundTrip(FileIndexUpdateMessage.self),
        "IndexBroadcast": roundTrip(IndexBroadcast.self),
        "IndexChange": roundTrip(IndexChange.self),
        "IndexChangesAvailable": roundTrip(IndexChangesAvailable.self),
        "IndexClientMetadataPatchMessage": roundTrip(IndexClientMetadataPatchMessage.self),
        "IndexDeleteBroadcast": roundTrip(IndexDeleteBroadcast.self),
        "IndexPageRequest": roundTrip(IndexPageRequest.self),
        "IndexPageResponse": roundTrip(IndexPageResponse.self),
        "IndexSyncRequest": roundTrip(IndexSyncRequest.self),
        "IndexSyncResponse": roundTrip(IndexSyncResponse.self),
        "IndexUpdateMessage": roundTrip(IndexUpdateMessage.self),
        "MessageBroadcast": roundTrip(MessageBroadcast.self),
        "MetadataBroadcast": roundTrip(MetadataBroadcast.self),
        "PersonalStatePageRequest": roundTrip(PersonalStatePageRequest.self),
        "PersonalStatePageResponse": roundTrip(PersonalStatePageResponse.self),
        "ProjectBroadcast": roundTrip(ProjectBroadcast.self),
        "ReadReceiptBroadcast": roundTrip(ReadReceiptBroadcast.self),
        "ReadReceiptMessage": roundTrip(ReadReceiptMessage.self),
        "ServerError": roundTrip(ServerError.self),
        "SessionControlBroadcast": roundTrip(SessionControlBroadcast.self),
        "SessionControlMessage": roundTrip(SessionControlMessage.self),
        "SessionSyncRequest": roundTrip(SessionSyncRequest.self),
        "SessionSyncResponse": roundTrip(SessionSyncResponse.self),
        "SettingsSyncBroadcast": roundTrip(SettingsSyncBroadcast.self),
        "SettingsSyncMessage": roundTrip(SettingsSyncMessage.self),
        "SyncedSettings": roundTrip(SyncedSettings.self),
        "TrackerPersonalStateBroadcast": roundTrip(TrackerPersonalStateBroadcast.self),
        "TrackerPersonalStateMessage": roundTrip(TrackerPersonalStateMessage.self),
        "VoiceToolRequestBroadcast": roundTrip(VoiceToolRequestBroadcast.self),
        "VoiceToolRequestMessage": roundTrip(VoiceToolRequestMessage.self),
        "VoiceToolResponseBroadcast": roundTrip(VoiceToolResponseBroadcast.self),
        "VoiceToolResponseMessage": roundTrip(VoiceToolResponseMessage.self),
    ]

    // MARK: - Tests

    func testEveryFixtureRoundTripsThroughItsSwiftType() throws {
        let manifest = try loadManifest()
        var failures: [String] = []
        var covered = 0

        for entry in manifest.fixtures {
            let fixture = try Data(contentsOf: Self.fixturesDirectory.appendingPathComponent(entry.file))

            guard let typeName = entry.swiftType else {
                failures.append("\(entry.file) (\(entry.direction)): manifest declares no Swift type, so nothing checks this envelope's shape")
                continue
            }

            guard let roundTrip = Self.roundTrips[typeName] else {
                failures.append("\(entry.file): manifest names Swift type '\(typeName)', which WireFixtureTests does not know")
                continue
            }

            let reencoded: Data
            do {
                reencoded = try roundTrip(fixture)
            } catch {
                failures.append("\(entry.file) -> \(typeName): decode/encode threw: \(error)")
                continue
            }

            let expected = try Self.keyPaths(fixture)
            let actual = try Self.keyPaths(reencoded)
            covered += 1

            let dropped = expected.subtracting(actual).sorted()
            let invented = actual.subtracting(expected).sorted()
            if !dropped.isEmpty {
                failures.append("\(entry.file) -> \(typeName): dropped \(dropped.joined(separator: ", "))")
            }
            if !invented.isEmpty {
                failures.append("\(entry.file) -> \(typeName): emitted keys absent from the fixture: \(invented.joined(separator: ", "))")
            }
        }

        XCTAssertEqual(covered, manifest.fixtures.count, "every manifest entry must be checked; a fixture that quietly falls out of coverage is the hole this test exists to close")
        if !failures.isEmpty {
            XCTFail("Wire contract mismatches (contractRevision \(manifest.contractRevision)):\n - " + failures.joined(separator: "\n - "))
        }
    }

    /// The gap this slice closed: the phone could receive session hierarchy and
    /// state but not send it, so a local reparent or pin had nowhere to go.
    func testOutboundIndexUpdateCarriesHierarchyAndStateFields() throws {
        let fixture = try Data(contentsOf: Self.fixturesDirectory.appendingPathComponent("indexUpdate.json"))
        let decoded = try JSONDecoder().decode(IndexUpdateMessage.self, from: fixture)

        // Read the expected id out of the fixture rather than hardcoding it, so
        // regenerating the corpus with fresh ids does not break this test.
        let session = (try JSONSerialization.jsonObject(with: fixture) as? [String: Any])?["session"] as? [String: Any]
        XCTAssertEqual(decoded.session.parentSessionId, session?["parentSessionId"] as? String)
        XCTAssertNotNil(decoded.session.parentSessionId)
        XCTAssertEqual(decoded.session.sessionType, "session")
        XCTAssertEqual(decoded.session.isArchived, false)
        XCTAssertEqual(decoded.session.isPinned, true)

        // Absent optionals must stay absent on the wire, so a publish that knows
        // nothing about pinning does not write `false` over the desktop's value.
        let sparse = IndexUpdateEntry(
            sessionId: "sess-1",
            encryptedProjectId: "enc",
            projectIdIv: "iv",
            encryptedTitle: nil,
            titleIv: nil,
            provider: "claude-code",
            model: nil,
            mode: nil,
            messageCount: nil,
            lastMessageAt: 1,
            createdAt: 1,
            updatedAt: 1,
            isExecuting: nil,
            queuedPromptCount: nil,
            encryptedQueuedPrompts: nil
        )
        let keys = try Self.keyPaths(try JSONEncoder().encode(IndexUpdateMessage(session: sparse)))
        XCTAssertFalse(keys.contains("session.isPinned"))
        XCTAssertFalse(keys.contains("session.parentSessionId"))
        XCTAssertFalse(keys.contains("session.messageCount"))
    }

    /// The page entry is a union on the TypeScript side. Key-set equality alone
    /// cannot see a malformed one, so reject the four shapes drift produces.
    func testPersonalStatePageEntryRejectsMalformedUnionMembers() throws {
        let receipt = """
        "receipt":{"receiptKey":"k","encryptedReceipt":"c","receiptIv":"i","deviceId":"d","version":1,"timestamp":1}
        """
        let state = """
        "state":{"stateKey":"k","encryptedState":"c","stateIv":"i","deviceId":"d","version":1,"timestamp":1}
        """
        let invalid: [(String, String)] = [
            ("neither payload", #"{"type":"readReceiptBroadcast"}"#),
            ("both payloads", "{\"type\":\"readReceiptBroadcast\",\(receipt),\(state)}"),
            ("discriminator disagrees with payload", "{\"type\":\"trackerPersonalStateBroadcast\",\(receipt)}"),
            ("unknown discriminator", "{\"type\":\"sessionIndexBroadcast\",\(receipt)}"),
        ]

        for (label, json) in invalid {
            XCTAssertThrowsError(
                try JSONDecoder().decode(PersonalStatePageEntry.self, from: Data(json.utf8)),
                "a page entry with \(label) must not decode"
            )
        }

        // The valid shape still decodes, so the guards above are not simply
        // rejecting everything.
        let valid = "{\"type\":\"readReceiptBroadcast\",\(receipt),\"fromConnectionId\":\"c1\"}"
        guard case .readReceipt = try JSONDecoder().decode(PersonalStatePageEntry.self, from: Data(valid.utf8)) else {
            return XCTFail("a well-formed read-receipt entry decoded as the wrong union member")
        }
    }

    // MARK: - Helpers

    private func loadManifest() throws -> Manifest {
        let url = Self.fixturesDirectory.appendingPathComponent("index.json")
        return try JSONDecoder().decode(Manifest.self, from: try Data(contentsOf: url))
    }

    /// Every key in the document, as dotted paths. Array elements collapse onto a
    /// single `[]` segment so a one-element fixture array still pins the shape of
    /// its elements without asserting on element count.
    static func keyPaths(_ data: Data) throws -> Set<String> {
        keyPaths(try JSONSerialization.jsonObject(with: data), prefix: "")
    }

    private static func keyPaths(_ value: Any, prefix: String) -> Set<String> {
        var paths: Set<String> = []
        if let object = value as? [String: Any] {
            for (key, child) in object {
                let path = prefix.isEmpty ? key : "\(prefix).\(key)"
                paths.insert(path)
                paths.formUnion(keyPaths(child, prefix: path))
            }
        } else if let array = value as? [Any] {
            for element in array {
                paths.formUnion(keyPaths(element, prefix: "\(prefix)[]"))
            }
        }
        return paths
    }
}
