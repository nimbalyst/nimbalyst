import Foundation

/// Versioned personal-index replication. Activity timestamps never serve as cursors.
struct IndexPageRequest: Encodable, Sendable {
    let type = "indexPageRequest"
    let protocolVersion = 2
    var requestId: String
    var mode: String
    var pageToken: String? = nil
    var sinceRevision: Int? = nil
    var projectId: String? = nil
    var sessionIds: [String]? = nil
    var limit: Int? = nil
}

struct IndexPageResponse: Decodable, @unchecked Sendable {
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

struct IndexChange: Decodable, @unchecked Sendable {
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

struct IndexChangesAvailable: Decodable, Sendable {
    let type: String
    let revision: Int
}
