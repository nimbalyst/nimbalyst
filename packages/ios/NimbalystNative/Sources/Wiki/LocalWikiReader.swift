import Foundation

public struct WikiDirEntry: Hashable, Sendable {
    public var name: String
    public var isDirectory: Bool
}

/// The files of one wiki, by wiki-relative path (`/`-separated, `""` = root).
public protocol WikiFileSource {
    /// Entries directly inside `dir`; nil when it is not a folder.
    func entries(in dir: String) -> [WikiDirEntry]?
    func readText(_ path: String) -> String?
}

/// Reads a wiki folder the way the library's `scanWiki` does with repair off,
/// and arranges it as a tree. Never writes; ids the library would add on its
/// next write scan read as `tmp_` ids, as they do for `nim` with repair off.
public enum LocalWikiReader {
    public static func read(_ source: WikiFileSource, types typeList: [WikiTypeDef]) -> WikiSnapshot {
        var scan = Scan(source: source, types: Dictionary(typeList.map { ($0.typeId, $0) }, uniquingKeysWith: { first, _ in first }))
        scan.walk("", parent: nil)
        scan.readTrash()
        scan.resolveLinks()
        let markerText = source.readText(WikiFormat.markerFile)
        let marker = markerText.flatMap { try? WikiYAML.parseMapping($0) }
        var formatVersion: Int?
        // A marker that is there but does not name a version this reader can
        // compare is a newer or broken format: read it, never write it.
        // A marker that synced but cannot be read (not decrypted yet) counts too.
        let markerListed = source.entries(in: "")?.contains { $0.name == WikiFormat.markerFile && !$0.isDirectory } ?? false
        var formatUnreadable = markerText != nil || markerListed
        var tableOrders: [String: Double] = [:]
        if let marker {
            if case .number(let version)? = marker["formatVersion"], version.isFinite, version == version.rounded(),
               version >= 1, version <= 1_000_000 {
                formatVersion = Int(version)
                formatUnreadable = false
            }
            if case .object(let tables)? = marker["tables"] {
                for (typeId, entry) in tables {
                    if case .object(let fields) = entry, case .number(let order)? = fields["order"] { tableOrders[typeId] = order }
                }
            }
        }
        var snapshot = WikiSnapshot(
            formatVersion: formatVersion,
            formatUnreadable: formatUnreadable,
            pages: scan.pages,
            tables: scan.tables,
            tree: [],
            trashIds: scan.trash,
            types: scan.types,
            byFile: scan.byFile,
            byDir: scan.byDir
        )
        snapshot.tree = buildTree(scan: scan, tableOrders: tableOrders)
        return snapshot
    }

    // MARK: Tree

    private struct Entry {
        var order: Double?
        var title: String
        var index: Int
        var node: () -> WikiNode
    }

    private static func compareTitles(_ a: String, _ b: String) -> ComparisonResult {
        a.compare(b, options: [.caseInsensitive, .diacriticInsensitive], range: nil, locale: Locale(identifier: "en"))
    }

    /// Siblings: explicit `order` first, then unordered by title. Equal orders
    /// fall back to the title, as the fixtures' generator does.
    private static func sorted(_ entries: [Entry]) -> [Entry] {
        entries.sorted { a, b in
            switch (a.order, b.order) {
            case let (x?, y?) where x != y: return x < y
            case (.some, nil): return true
            case (nil, .some): return false
            default:
                let byTitle = compareTitles(a.title, b.title)
                return byTitle == .orderedSame ? a.index < b.index : byTitle == .orderedAscending
            }
        }
    }

    private static func buildTree(scan: Scan, tableOrders: [String: Double]) -> [WikiNode] {
        func build(parentId: String?, parentDir: String) -> [WikiNode] {
            let siblings = scan.pageOrder.compactMap { scan.pages[$0] }.filter { $0.parentId == parentId }
            var entries: [Entry] = siblings.enumerated().map { offset, page in
                var page = page
                if page.path != nil, WikiFormat.isConflictCopyStem(page.stem) {
                    let original = WikiFormat.nameKey(WikiFormat.conflictOriginalStem(page.stem))
                    page.conflictOf = siblings.first { $0.id != page.id && WikiFormat.nameKey($0.stem) == original }?.id
                }
                return Entry(order: page.order, title: page.title, index: offset) {
                    .page(page, children: build(parentId: page.id, parentDir: page.dir))
                }
            }
            for table in scan.tables where WikiFormat.nameKey(table.parentDir) == WikiFormat.nameKey(parentDir) {
                entries.append(Entry(order: tableOrders[table.typeId], title: table.typeId, index: entries.count) { .table(table) })
            }
            return sorted(entries).map { $0.node() }
        }
        return build(parentId: nil, parentDir: "")
    }

    // MARK: Scan

    private struct Scan {
        let source: WikiFileSource
        let types: [String: WikiTypeDef]
        var pages: [String: WikiPage] = [:]
        /// Insertion order of `pages`, with the JavaScript Map's delete-then-set semantics.
        var pageOrder: [String] = []
        var byFile: [String: String] = [:]
        var byDir: [String: String] = [:]
        var tables: [WikiTable] = []
        var trash: Set<String> = []
        private var tableNames: [String: String] = [:]

        init(source: WikiFileSource, types: [String: WikiTypeDef]) {
            self.source = source
            self.types = types
            for def in types.values.sorted(by: { $0.typeId < $1.typeId }) where def.storage == "table" {
                tableNames[WikiFormat.nameKey(WikiFormat.fileStemForTitle(def.displayNamePlural))] = def.typeId
                let byId = WikiFormat.nameKey(def.typeId)
                if tableNames[byId] == nil { tableNames[byId] = def.typeId }
            }
        }

        private mutating func setPage(_ page: WikiPage) {
            if pages[page.id] == nil { pageOrder.append(page.id) }
            pages[page.id] = page
            if let path = page.path { byFile[WikiFormat.nameKey(path)] = page.id }
            byDir[WikiFormat.nameKey(page.dir)] = page.id
        }

        private mutating func removePage(_ id: String) {
            pages[id] = nil
            pageOrder.removeAll { $0 == id }
        }

        /// A later file with an existing id reads under a path-derived id; a sync
        /// conflict copy never keeps the id of the file it diverged from.
        mutating func addPage(_ incoming: WikiPage) -> WikiPage {
            var page = incoming
            if let existing = pages[page.id] {
                if existing.isConflictCopy && !page.isConflictCopy {
                    var rekeyed = existing
                    rekeyed.id = WikiFormat.derivedId("dup", existing.path ?? existing.dir)
                    removePage(existing.id)
                    setPage(rekeyed)
                    for id in pageOrder where pages[id]?.parentId == existing.id {
                        pages[id]?.parentId = rekeyed.id
                    }
                } else {
                    page.id = WikiFormat.derivedId("dup", page.path ?? page.dir)
                }
            }
            setPage(page)
            return page
        }

        func basePage(id: String, stem: String, path: String?, dir: String, parent: WikiPage?, parentDir: String) -> WikiPage {
            WikiPage(
                id: id, title: stem, type: nil, order: nil, fields: [], documentType: "markdown",
                path: path, dir: dir, parentId: parent?.id, malformed: false, conflictOf: nil,
                stem: stem, parentDir: parentDir, isSidecarPage: false, links: [], linkTargets: []
            )
        }

        func loadFilePage(_ rel: String, stem: String, dir: String, parent: WikiPage?, parentDir: String) -> WikiPage? {
            guard let text = source.readText(rel) else { return nil }
            var page = basePage(id: "", stem: stem, path: rel, dir: dir, parent: parent, parentDir: parentDir)
            switch WikiFormat.parseMarkdownFile(text) {
            case .malformed:
                page.id = WikiFormat.derivedId("bad", rel)
                page.malformed = true
            case .ok(let data, let body):
                let meta = WikiFormat.readPageMeta(data)
                if let id = meta.id, !WikiFormat.isSafeId(id) {
                    page.id = WikiFormat.derivedId("bad", rel)
                    page.malformed = true
                    return page
                }
                page.id = meta.id ?? WikiFormat.derivedId("tmp", rel)
                page.title = WikiFormat.titleForStem(stem, frontmatterTitle: meta.title)
                page.type = meta.type
                page.fields = meta.fields
                page.order = meta.order
                page.links = WikiFormat.findLinks(body).filter(\.isPageLink)
            }
            return page
        }

        func loadEditorPage(_ rel: String, stem: String, suffix: String, dir: String, hasSidecar: Bool, parent: WikiPage?, parentDir: String) -> WikiPage? {
            guard source.readText(rel) != nil else { return nil }
            var page = basePage(id: "", stem: stem, path: rel, dir: dir, parent: parent, parentDir: parentDir)
            page.isSidecarPage = true
            let sidecarRel = WikiFormat.join(parentDir, "." + WikiFormat.basename(rel) + WikiFormat.sidecarSuffix)
            var data = WikiMap()
            var sidecarError = false
            if hasSidecar, let text = source.readText(sidecarRel) {
                if let parsed = try? WikiYAML.parseMapping(text) { data = parsed } else { sidecarError = true }
            }
            var recorded: String?
            if case .string(let value)? = data["documentType"], !value.trimmingCharacters(in: .whitespaces).isEmpty {
                recorded = value.trimmingCharacters(in: .whitespaces)
            }
            page.documentType = WikiFormat.editorTypes[suffix] ?? recorded ?? String(suffix.dropFirst())
            var metaData = WikiMap()
            for field in data.fields where field.name != "documentType" { metaData.set(field.name, field.value) }
            let meta = WikiFormat.readPageMeta(metaData)
            if sidecarError {
                page.id = WikiFormat.derivedId("bad", rel)
                page.malformed = true
            } else if let id = meta.id, !WikiFormat.isSafeId(id) {
                page.id = WikiFormat.derivedId("bad", rel)
                page.malformed = true
            } else {
                page.id = meta.id ?? WikiFormat.derivedId("tmp", rel)
                // An editor page is a plain page: a `type` key in its sidecar is kept but not read.
                page.fields = meta.fields.filter { $0.name != "type" }
            }
            page.title = WikiFormat.titleForStem(stem, frontmatterTitle: meta.title)
            page.order = meta.order
            return page
        }

        private static func editorSuffix(_ name: String) -> String? {
            let lower = name.lowercased()
            var best: String?
            for suffix in WikiFormat.editorTypes.keys where lower.count > suffix.count && lower.hasSuffix(suffix) {
                if best == nil || suffix.count > best!.count { best = suffix }
            }
            return best
        }

        mutating func walk(_ dirRel: String, parent: WikiPage?) {
            guard var entries = source.entries(in: dirRel) else { return }
            let sidecarTargets = Set(entries.filter {
                !$0.isDirectory && $0.name.hasPrefix(".") && $0.name.count > 1 + WikiFormat.sidecarSuffix.count && $0.name.hasSuffix(WikiFormat.sidecarSuffix)
            }.map { String($0.name.dropFirst().dropLast(WikiFormat.sidecarSuffix.count)) })
            entries = entries.filter { !$0.name.hasPrefix(".") && $0.name != "node_modules" }
                .sorted { WikiFormat.codeUnitLess($0.name, $1.name) }
            let dirs = entries.filter(\.isDirectory).map(\.name)
            var consumedDirs = Set<String>()
            let readmeName: String? = {
                guard let parent, parent.path != nil, parent.dir == dirRel,
                      let path = parent.path, WikiFormat.dirname(path) == dirRel else { return nil }
                return WikiFormat.basename(path)
            }()
            var pagesHere: [WikiPage] = []

            func childDir(for stem: String) -> String? {
                if let exact = dirs.first(where: { $0 == stem }) { return exact }
                return dirs.first { !consumedDirs.contains($0) && WikiFormat.nameKey($0) == WikiFormat.nameKey(stem) }
            }

            for entry in entries where !entry.isDirectory {
                let lower = entry.name.lowercased()
                if lower.hasSuffix(".csv"), let typeId = tableNames[WikiFormat.nameKey(String(entry.name.dropLast(4)))] {
                    loadTable(WikiFormat.join(dirRel, entry.name), typeId: typeId, dirRel: dirRel)
                    continue
                }
                if entry.name == readmeName { continue }
                let hasSidecar = sidecarTargets.contains(entry.name)
                var suffix = Scan.editorSuffix(entry.name)
                if suffix == nil, hasSidecar, !lower.hasSuffix(".md"), let dot = lower.lastIndex(of: "."), dot != lower.startIndex {
                    suffix = String(lower[dot...])
                }
                if let suffix {
                    let stem = String(entry.name.dropLast(suffix.count))
                    if stem.isEmpty { continue }
                    let child = childDir(for: stem)
                    if let child { consumedDirs.insert(child) }
                    if let page = loadEditorPage(WikiFormat.join(dirRel, entry.name), stem: stem, suffix: suffix,
                                                 dir: WikiFormat.join(dirRel, child ?? stem), hasSidecar: hasSidecar,
                                                 parent: parent, parentDir: dirRel) {
                        pagesHere.append(page)
                    }
                    continue
                }
                guard lower.hasSuffix(".md") else { continue }
                let stem = String(entry.name.dropLast(3))
                let child = childDir(for: stem)
                if let child { consumedDirs.insert(child) }
                if let page = loadFilePage(WikiFormat.join(dirRel, entry.name), stem: stem,
                                           dir: WikiFormat.join(dirRel, child ?? stem), parent: parent, parentDir: dirRel) {
                    pagesHere.append(page)
                }
            }
            for name in dirs where !consumedDirs.contains(name) {
                let dir = WikiFormat.join(dirRel, name)
                let inner = (source.entries(in: dir) ?? []).map(\.name).sorted(by: WikiFormat.codeUnitLess)
                let readme = inner.first { $0.lowercased() == "readme.md" } ?? inner.first { $0.lowercased() == "index.md" }
                var page = readme.flatMap { loadFilePage(WikiFormat.join(dir, $0), stem: name, dir: dir, parent: parent, parentDir: dirRel) }
                if page == nil {
                    page = basePage(id: WikiFormat.derivedId("dir", dir), stem: name, path: nil, dir: dir, parent: parent, parentDir: dirRel)
                }
                pagesHere.append(page!)
            }
            // Every page in the folder is registered before any child folder is walked.
            let added = pagesHere.map { addPage($0) }
            for page in added where dirs.contains(where: { WikiFormat.join(dirRel, $0) == page.dir }) {
                walk(page.dir, parent: page)
            }
        }

        mutating func loadTable(_ rel: String, typeId: String, dirRel: String) {
            if tables.contains(where: { $0.typeId == typeId }) { return }
            guard let text = source.readText(rel), let def = types[typeId] else { return }
            var table = WikiTable(typeId: typeId, title: def.displayNamePlural, path: rel, parentId: nil, header: [], rows: [], malformed: false, parentDir: dirRel)
            if let rows = try? WikiFormat.parseCSV(text), (rows.first?.first ?? "id").trimmingCharacters(in: .whitespaces).lowercased() == "id" {
                table.header = (rows.first ?? ["id"]).map { $0.trimmingCharacters(in: .whitespaces) }
                let byName = Dictionary(def.fields.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
                table.rows = rows.dropFirst().map { row in
                    var fields: [WikiField] = []
                    for (column, name) in table.header.enumerated() where column > 0 {
                        let cell = column < row.count ? row[column] : ""
                        if let value = WikiFormat.decodeCell(cell, field: byName[name]) { fields.append(WikiField(name: name, value: value)) }
                    }
                    var title = ""
                    if case .string(let value)? = fields.first(where: { $0.name == def.titleField })?.value { title = value }
                    return WikiRow(id: (row.first ?? "").trimmingCharacters(in: .whitespacesAndNewlines), title: title, fields: fields)
                }
            } else {
                table.malformed = true
            }
            tables.append(table)
        }

        mutating func readTrash() {
            for entry in source.entries(in: WikiFormat.trashDir) ?? [] where entry.isDirectory {
                let manifestPath = WikiFormat.join(WikiFormat.join(WikiFormat.trashDir, entry.name), ".trash.json")
                guard let text = source.readText(manifestPath), let data = text.data(using: .utf8),
                      let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = manifest["id"] as? String, WikiFormat.isSafeId(id) else { continue }
                trash.insert(id)
            }
        }

        mutating func resolveLinks() {
            for id in pageOrder {
                guard var page = pages[id] else { continue }
                let base = page.path.map(WikiFormat.dirname) ?? page.dir
                page.linkTargets = page.links.map { link in
                    let target = WikiFormat.resolveLinkPath(fromDir: base, linkPath: link.path)
                    var byPath: String?
                    if let target {
                        let key = WikiFormat.nameKey(target)
                        byPath = link.path.hasSuffix("/") ? byDir[key] : (byFile[key] ?? byDir[key])
                    }
                    if let linkId = link.id, pages[linkId] != nil { return linkId }
                    return byPath
                }
                pages[id] = page
            }
            for index in tables.indices where !tables[index].parentDir.isEmpty {
                tables[index].parentId = byDir[WikiFormat.nameKey(tables[index].parentDir)]
            }
        }
    }
}

// MARK: - Sources

/// A wiki folder on disk (tests, and any host with real files).
public struct WikiDiskSource: WikiFileSource {
    public let root: URL

    public init(root: URL) { self.root = root }

    public func entries(in dir: String) -> [WikiDirEntry]? {
        let url = dir.isEmpty ? root : root.appendingPathComponent(dir)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: url.path) else { return nil }
        return names.map { name in
            var isDirectory: ObjCBool = false
            FileManager.default.fileExists(atPath: url.appendingPathComponent(name).path, isDirectory: &isDirectory)
            return WikiDirEntry(name: name.precomposedStringWithCanonicalMapping, isDirectory: isDirectory.boolValue)
        }
    }

    public func readText(_ path: String) -> String? {
        try? String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }
}

/// A wiki made of synced files: folders are implied by the paths.
public struct WikiPathSource: WikiFileSource {
    private var children: [String: [String: Bool]] = [:]
    private let read: (String) -> String?

    /// `paths` are wiki-relative file paths; `read` returns a file's text.
    public init(paths: [String], read: @escaping (String) -> String?) {
        self.read = read
        for path in paths {
            let parts = path.split(separator: "/").map(String.init)
            guard !parts.isEmpty else { continue }
            var dir = ""
            for (index, part) in parts.enumerated() {
                let isLast = index == parts.count - 1
                children[dir, default: [:]][part] = (children[dir]?[part] ?? false) || !isLast
                dir = WikiFormat.join(dir, part)
            }
        }
    }

    public func entries(in dir: String) -> [WikiDirEntry]? {
        guard let names = children[dir] else { return nil }
        return names.map { WikiDirEntry(name: $0.key, isDirectory: $0.value) }
    }

    public func readText(_ path: String) -> String? { read(path) }
}
