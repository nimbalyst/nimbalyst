import Foundation

/// Versioned personal-index replication. Activity timestamps never serve as cursors.
/// `Codable` rather than `Encodable`: the fixture contract in `WireFixtureTests`
/// proves the shape by decoding the golden JSON and re-encoding it, which needs
/// both halves even for a message iOS only ever sends.
struct IndexPageRequest: Codable, Sendable {
    var type: String = "indexPageRequest"
    var protocolVersion: Int = 2
    var requestId: String
    var mode: String
    var pageToken: String? = nil
    var sinceRevision: Int? = nil
    var projectId: String? = nil
    var sessionIds: [String]? = nil
    var limit: Int? = nil
}

struct IndexPageResponse: Codable, @unchecked Sendable {
    let type: String
    let protocolVersion: Int
    let requestId: String
    let mode: String
    let entries: [IndexChange]
    let nextPageToken: String?
    let cursor: Int?
    let complete: Bool
    let resetRequired: Bool?
}

struct IndexChange: Codable, @unchecked Sendable {
    let entity: String
    let id: String
    let revision: Int
    let deleted: Bool
    var removalReason: String? = nil
    let session: ServerSessionEntry?
    let project: ServerProjectEntry?
    let file: ServerIndexFileEntry?
}

/// The personal index carries file metadata, not the separately synced document body.
struct ServerIndexFileEntry: Codable, Sendable {
    let docId: String
    let encryptedProjectId: String
    let projectIdIv: String
    let encryptedRelativePath: String
    let relativePathIv: String
    let encryptedTitle: String
    let titleIv: String
    let lastModifiedAt: Int
    let syncedAt: Int
}

extension ServerIndexFileEntry {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        docId = try container.decode(String.self, forKey: .docId)
        encryptedProjectId = try container.decode(String.self, forKey: .encryptedProjectId)
        projectIdIv = try container.decode(String.self, forKey: .projectIdIv)
        encryptedRelativePath = try container.decode(String.self, forKey: .encryptedRelativePath)
        relativePathIv = try container.decode(String.self, forKey: .relativePathIv)
        encryptedTitle = try container.decode(String.self, forKey: .encryptedTitle)
        titleIv = try container.decode(String.self, forKey: .titleIv)
        syncedAt = try container.decode(Int.self, forKey: .syncedAt)
        // Desktop filesystem mtimeMs can include fractional milliseconds. Match
        // the file-sync lane's whole-millisecond storage without rejecting the
        // entire mixed session/file page or trapping on an out-of-range value.
        if let integer = try? container.decode(Int.self, forKey: .lastModifiedAt) {
            lastModifiedAt = integer
        } else {
            let milliseconds = try container.decode(Double.self, forKey: .lastModifiedAt)
            guard let integer = Int(exactly: milliseconds.rounded(.down)) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .lastModifiedAt, in: container,
                    debugDescription: "File modification time is outside the supported millisecond range")
            }
            lastModifiedAt = integer
        }
    }
}

struct IndexChangesAvailable: Codable, Sendable {
    let type: String
    let revision: Int
}

// MARK: - File index lane

/// Publish or refresh one file's metadata in the personal index.
struct FileIndexUpdateMessage: Codable, Sendable {
    var type: String = "fileIndexUpdate"
    let file: ServerIndexFileEntry
}

struct FileIndexDeleteMessage: Codable, Sendable {
    var type: String = "fileIndexDelete"
    let docId: String
}

/// The server's fan-out of a file-index publish to the other devices.
struct FileIndexBroadcast: Codable, Sendable {
    let type: String
    let file: ServerIndexFileEntry
    let fromConnectionId: String?
}

struct FileIndexDeleteBroadcast: Codable, Sendable {
    let type: String
    let docId: String
    let fromConnectionId: String?
}

// MARK: - Personal state lanes (read receipts, tracker personal state)

/// Server-visible envelope of a read receipt. The entity it refers to and the
/// position within it stay encrypted; `receiptKey` is only a routing and
/// last-writer-wins key, and `version` is advance-only.
struct EncryptedReadReceiptPayload: Codable, Sendable {
    let receiptKey: String
    let encryptedReceipt: String
    let receiptIv: String
    let deviceId: String
    let version: Int
    let timestamp: Int
}

struct ReadReceiptMessage: Codable, Sendable {
    var type: String = "readReceipt"
    let receipt: EncryptedReadReceiptPayload
}

struct ReadReceiptBroadcast: Codable, Sendable {
    let type: String
    let receipt: EncryptedReadReceiptPayload
    let fromConnectionId: String?
}

/// Server-visible envelope of a tracker favorite/open mutation.
struct EncryptedTrackerPersonalStatePayload: Codable, Sendable {
    let stateKey: String
    let encryptedState: String
    let stateIv: String
    let deviceId: String
    let version: Int
    let timestamp: Int
}

struct TrackerPersonalStateMessage: Codable, Sendable {
    var type: String = "trackerPersonalState"
    let state: EncryptedTrackerPersonalStatePayload
}

struct TrackerPersonalStateBroadcast: Codable, Sendable {
    let type: String
    let state: EncryptedTrackerPersonalStatePayload
    let fromConnectionId: String?
}

/// Bounded replay of the personal-state streams. These pages carry no revisions
/// and never establish index coverage, so they cannot be used as a cursor.
struct PersonalStatePageRequest: Codable, Sendable {
    var type: String = "personalStatePageRequest"
    let requestId: String
    var pageToken: String? = nil
    var limit: Int? = nil
}

struct PersonalStatePageResponse: Codable, Sendable {
    let type: String
    let requestId: String
    let entries: [PersonalStatePageEntry]
    let nextPageToken: String?
    let complete: Bool
}

/// One replayed entry. The TypeScript side is a union of the two broadcasts, so
/// this is an enum rather than a struct with two optionals: a flattened struct
/// decodes an entry with neither payload, both payloads, or a discriminator that
/// disagrees with the payload present, and re-encodes it unchanged — which is
/// exactly the union drift the fixture contract exists to catch.
enum PersonalStatePageEntry: Codable, Sendable {
    case readReceipt(ReadReceiptBroadcast)
    case trackerPersonalState(TrackerPersonalStateBroadcast)

    private enum CodingKeys: String, CodingKey {
        case type, receipt, state
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "readReceiptBroadcast":
            guard !container.contains(.state) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .state, in: container,
                    debugDescription: "readReceiptBroadcast entry also carries a tracker personal-state payload")
            }
            self = .readReceipt(try ReadReceiptBroadcast(from: decoder))
        case "trackerPersonalStateBroadcast":
            guard !container.contains(.receipt) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .receipt, in: container,
                    debugDescription: "trackerPersonalStateBroadcast entry also carries a read-receipt payload")
            }
            self = .trackerPersonalState(try TrackerPersonalStateBroadcast(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container,
                debugDescription: "unknown personal-state page entry type '\(type)'")
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .readReceipt(let broadcast):
            try broadcast.encode(to: encoder)
        case .trackerPersonalState(let broadcast):
            try broadcast.encode(to: encoder)
        }
    }
}
