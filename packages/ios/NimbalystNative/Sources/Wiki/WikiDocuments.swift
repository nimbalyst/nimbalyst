import Foundation

/// Where a project's Local wiki sits among its synced files, and the snapshot
/// read from them. The wiki folder comes from the desktop (`Project.localWikiFolder`).
public enum WikiDocuments {
    /// Wiki-relative path of a synced file, or nil when it is outside the wiki.
    public static func wikiPath(of relativePath: String, folder: String) -> String? {
        if folder.isEmpty { return relativePath }
        let prefix = folder + "/"
        guard relativePath.hasPrefix(prefix) else { return nil }
        return String(relativePath.dropFirst(prefix.count))
    }

    public static func projectPath(of wikiPath: String, folder: String) -> String {
        WikiFormat.join(folder, wikiPath)
    }

    /// Wiki files that are data rather than markdown pages: table CSVs, the
    /// marker, sidecars and trash. The Files tab leaves them to the Wiki tab.
    public static func isWikiDataFile(_ relativePath: String, folder: String?) -> Bool {
        guard let folder, let path = wikiPath(of: relativePath, folder: folder) else { return false }
        if path.split(separator: "/").contains(where: { $0.hasPrefix(".") }) { return true }
        return !path.lowercased().hasSuffix(".md")
    }

    /// What a synced file is to the wiki. Every way of opening a file (Files,
    /// Wiki, a link) goes through this, so a wiki this app cannot write is
    /// read-only everywhere.
    public enum Role: Equatable {
        case outside
        /// In a wiki whose format is newer than this app: show, never edit.
        case unsupportedFormat
        case table(WikiTable)
        case csv
        case page(WikiPage)
        /// In the wiki folder but not a page the reader found.
        case otherFile
    }

    public static func role(of relativePath: String, folder: String?, snapshot: WikiSnapshot?) -> Role {
        let isCSV = relativePath.lowercased().hasSuffix(".csv")
        guard let folder, let snapshot, let path = wikiPath(of: relativePath, folder: folder) else {
            return isCSV ? .csv : .outside
        }
        if let table = snapshot.table(atPath: path) { return .table(table) }
        if isCSV { return .csv }
        if snapshot.isUnsupportedVersion { return .unsupportedFormat }
        if let page = snapshot.page(atPath: path) { return .page(page) }
        return .otherFile
    }

    public enum LinkTarget: Equatable {
        /// A synced file, by project-relative path.
        case document(String)
        case external(URL)
        case none
    }

    /// Where a link tapped in `fromRelativePath` goes. A link written in a wiki
    /// page resolves inside the wiki only (by id, then path); a link elsewhere
    /// resolves relative to its file.
    public static func linkTarget(href: String, title: String?, fromRelativePath: String, folder: String?, snapshot: WikiSnapshot?) -> LinkTarget {
        let trimmed = href.trimmingCharacters(in: .whitespaces)
        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) {
            return .external(url)
        }
        let link = WikiFormat.link(text: "", destination: trimmed, title: title)
        guard link.isPageLink else { return .none }
        if let folder, let snapshot, let path = wikiPath(of: fromRelativePath, folder: folder) {
            guard let page = snapshot.page(atPath: path),
                  let target = snapshot.resolveLink(from: page, destination: trimmed, title: title),
                  let targetPath = snapshot.pages[target]?.path else { return .none }
            return .document(projectPath(of: targetPath, folder: folder))
        }
        guard !link.path.isEmpty,
              let path = WikiFormat.resolveLinkPath(fromDir: WikiFormat.dirname(fromRelativePath), linkPath: link.path) else { return .none }
        return .document(path)
    }
}

/// Reads wiki snapshots from synced documents, re-reading only what changed.
@MainActor
public final class WikiStore {
    public static let shared = WikiStore()

    private var texts: [String: (stamp: String, text: String)] = [:]
    private var snapshots: [String: (signature: String, snapshot: WikiSnapshot)] = [:]

    private static func stamp(_ document: SyncedDocument) -> String {
        "\(document.contentHash ?? "")|\(document.lastModifiedAt ?? 0)|\(document.updatedAt)"
    }

    /// The wiki in `folder` among `documents`. `decrypt` opens content that bulk
    /// sync stored encrypted.
    public func snapshot(
        projectId: String,
        folder: String,
        documents: [SyncedDocument],
        types: [WikiTypeDef] = [],
        decrypt: (SyncedDocument) -> String?
    ) -> WikiSnapshot {
        var byPath: [String: SyncedDocument] = [:]
        for document in documents where document.projectId == projectId {
            if let path = WikiDocuments.wikiPath(of: document.relativePath, folder: folder) { byPath[path] = document }
        }
        let signature = byPath.keys.sorted().map { "\($0):\(Self.stamp(byPath[$0]!))" }.joined(separator: "\n")
            + "#\(types.hashValue)"
        let key = projectId + "\u{1f}" + folder
        if let cached = snapshots[key], cached.signature == signature { return cached.snapshot }

        // The reader reads every page's frontmatter, so open them all up front.
        var contents: [String: String] = [:]
        for (path, document) in byPath {
            if let text = document.contentDecrypted {
                contents[path] = text
                continue
            }
            let stamp = Self.stamp(document)
            if let cached = texts[document.id], cached.stamp == stamp {
                contents[path] = cached.text
            } else if let text = decrypt(document) {
                texts[document.id] = (stamp, text)
                contents[path] = text
            }
        }
        let source = WikiPathSource(paths: Array(byPath.keys)) { contents[$0] }
        let snapshot = LocalWikiReader.read(source, types: types)
        snapshots[key] = (signature, snapshot)
        return snapshot
    }

    public func clear() {
        texts.removeAll()
        snapshots.removeAll()
    }
}
