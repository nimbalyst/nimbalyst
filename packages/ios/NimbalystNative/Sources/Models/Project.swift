import Foundation
import GRDB

/// A project represents a workspace path synced from the desktop app.
public struct Project: Codable, Identifiable, Hashable, Sendable {
    /// Workspace path (e.g., "/Users/alex/sources/my-project")
    public var id: String
    /// Display name (last path component)
    public var name: String
    public var sessionCount: Int
    public var lastUpdatedAt: Int?
    public var sortOrder: Int
    /// JSON-encoded array of SyncedSlashCommand synced from desktop
    public var commandsJson: String?
    /// SHA-256 hash of the git remote URL, used for ProjectSyncRoom document sync routing
    public var gitRemoteHash: String?

    public init(id: String, name: String, sessionCount: Int = 0, lastUpdatedAt: Int? = nil, sortOrder: Int = 0, commandsJson: String? = nil, gitRemoteHash: String? = nil) {
        self.id = id
        self.name = name
        self.sessionCount = sessionCount
        self.lastUpdatedAt = lastUpdatedAt
        self.sortOrder = sortOrder
        self.commandsJson = commandsJson
        self.gitRemoteHash = gitRemoteHash
    }

    /// Decoded slash commands from the commandsJson blob.
    public var commands: [SyncedSlashCommand] {
        guard let json = commandsJson,
              let data = json.data(using: .utf8),
              let commands = try? JSONDecoder().decode([SyncedSlashCommand].self, from: data) else {
            return []
        }
        return commands
    }

    /// Create a Project from a workspace path, deriving the name from the last path component.
    public static func from(workspacePath: String) -> Project {
        let name = (workspacePath as NSString).lastPathComponent
        return Project(id: workspacePath, name: name)
    }
}

// MARK: - GRDB Conformance

extension Project: FetchableRecord, PersistableRecord {
    public static let databaseTableName = "projects"

    public enum Columns: String, ColumnExpression {
        case id, name, sessionCount, lastUpdatedAt, sortOrder, commandsJson, gitRemoteHash
    }
}
