import Foundation

/// Wiki type definitions arrive with the project config (`Project.localWikiTypes`).
public typealias WikiTypeDef = SyncedWikiType
public typealias WikiFieldDef = SyncedWikiField

public struct WikiPage: Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String
    /// Tracker type of a typed page; nil for a plain page.
    public var type: String?
    public var order: Double?
    public var fields: [WikiField]
    /// `markdown`, or an editor page's document type (`csv`, `excalidraw`, ...).
    public var documentType: String
    /// Wiki-relative path of the page file; nil for a bare folder.
    public var path: String?
    /// Wiki-relative path of the child folder (it may not exist).
    public var dir: String
    public var parentId: String?
    public var malformed: Bool
    /// Id of the page this is a sync conflict copy of, when that page is a sibling.
    public var conflictOf: String?

    var stem: String
    var parentDir: String
    var isSidecarPage: Bool
    var links: [WikiFormat.Link]
    var linkTargets: [String?]

    var isConflictCopy: Bool {
        WikiFormat.isConflictCopyStem(isSidecarPage ? stem : WikiFormat.basename(path ?? dir).replacingOccurrences(of: #"\.md$"#, with: "", options: [.regularExpression, .caseInsensitive]))
    }
}

public struct WikiRow: Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String
    /// Non-empty cells, in column order.
    public var fields: [WikiField]
}

public struct WikiTable: Hashable, Sendable {
    public var typeId: String
    public var title: String
    public var path: String
    public var parentId: String?
    public var header: [String]
    public var rows: [WikiRow]
    public var malformed: Bool
    var parentDir: String
}

public indirect enum WikiNode: Identifiable, Hashable, Sendable {
    case page(WikiPage, children: [WikiNode])
    case table(WikiTable)

    public var id: String {
        switch self {
        case .page(let page, _): return page.id
        case .table(let table): return "table:\(table.typeId)"
        }
    }

    public var title: String {
        switch self {
        case .page(let page, _): return page.title
        case .table(let table): return table.title
        }
    }

    public var children: [WikiNode]? {
        if case .page(_, let children) = self, !children.isEmpty { return children }
        return nil
    }
}

public struct WikiSnapshot: Sendable {
    /// From the marker file; nil when it has not synced.
    public var formatVersion: Int?
    /// The marker is there but its `formatVersion` is missing or not a usable number.
    public var formatUnreadable: Bool
    public var pages: [String: WikiPage]
    public var tables: [WikiTable]
    public var tree: [WikiNode]
    public var trashIds: Set<String>
    public var types: [String: WikiTypeDef]
    var byFile: [String: String]
    var byDir: [String: String]

    /// True when the wiki was written by a newer (or unreadable) format than
    /// this app reads. Its files must not be edited here.
    public var isUnsupportedVersion: Bool {
        formatUnreadable || (formatVersion ?? WikiFormat.supportedFormatVersion) > WikiFormat.supportedFormatVersion
    }

    public func page(atPath path: String) -> WikiPage? {
        byFile[WikiFormat.nameKey(path)].flatMap { pages[$0] }
    }

    public func table(atPath path: String) -> WikiTable? {
        tables.first { WikiFormat.nameKey($0.path) == WikiFormat.nameKey(path) }
    }

    /// Target of a link as written in `page`: by `id=` title first, then by
    /// relative path. Nil for web links, links out of the wiki, and missing pages.
    public func resolveLink(from page: WikiPage, destination: String, title: String?) -> String? {
        let link = WikiFormat.link(text: "", destination: destination, title: title)
        guard link.isPageLink else { return nil }
        return resolve(link, base: page.path.map(WikiFormat.dirname) ?? page.dir)
    }

    func resolve(_ link: WikiFormat.Link, base: String) -> String? {
        if let id = link.id, pages[id] != nil { return id }
        guard let target = WikiFormat.resolveLinkPath(fromDir: base, linkPath: link.path) else { return nil }
        let key = WikiFormat.nameKey(target)
        if link.path.hasSuffix("/") { return byDir[key] }
        return byFile[key] ?? byDir[key]
    }

    /// Resolved targets for every page link, keyed by page id, in body order.
    public func linkTargets(of pageId: String) -> [String?] {
        pages[pageId]?.linkTargets ?? []
    }

    public func typeName(_ typeId: String) -> String {
        types[typeId]?.displayName ?? typeId
    }
}
