import Foundation
import CryptoKit

/// The rules of `packages/local-wiki/FORMAT.md` that a reader needs, ported
/// from the TypeScript library (`names.ts`, `ids.ts`, `frontmatter.ts`,
/// `links.ts`, `csv.ts`, `tableCodec.ts`). The shared fixtures in
/// `packages/local-wiki/fixtures` keep the two in step.
enum WikiFormat {
    static let markerFile = ".nimbalyst-wiki.yaml"
    static let trashDir = ".trash"
    static let sidecarSuffix = ".wiki.yaml"
    static let supportedFormatVersion = 1

    /// `DEFAULT_EDITOR_TYPES`: editor page suffix to document type.
    static let editorTypes: [String: String] = [
        ".excalidraw": "excalidraw",
        ".mindmap": "mindmap",
        ".prisma": "datamodel",
        ".mockup.html": "mockup.html",
        ".csv": "csv",
        ".calc.md": "calc.md",
        ".canvas": "canvas",
    ]

    // MARK: Names

    /// Clash key: NFC, lower-cased.
    static func nameKey(_ name: String) -> String {
        name.precomposedStringWithCanonicalMapping.lowercased()
    }

    static func fileStemForTitle(_ title: String) -> String {
        var stem = title.precomposedStringWithCanonicalMapping
        stem = String(stem.unicodeScalars.map { scalar -> Character in
            if scalar.value < 0x20 || scalar.value == 0x7f { return " " }
            if "/\\:*?\"<>|".unicodeScalars.contains(scalar) { return "-" }
            return Character(scalar)
        })
        stem = stem.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"^\.+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[. ]+$"#, with: "", options: .regularExpression)
        if stem.utf8.count > 200 {
            while stem.utf8.count > 200 { stem.removeLast() }
            stem = stem.replacingOccurrences(of: #"[. ]+$"#, with: "", options: .regularExpression)
        }
        if stem.isEmpty { stem = "Untitled" }
        if stem.range(of: #"^(con|prn|aux|nul|com[1-9]|lpt[1-9])$"#, options: [.regularExpression, .caseInsensitive]) != nil {
            stem += "_"
        }
        return stem
    }

    /// Frontmatter `title` while the file name still derives from it (exactly or
    /// with a clash suffix); otherwise the file name.
    static func titleForStem(_ stem: String, frontmatterTitle: String?) -> String {
        guard let title = frontmatterTitle else { return stem }
        let expected = nameKey(fileStemForTitle(title))
        let key = nameKey(stem)
        if key == expected { return title }
        let pattern = "^" + NSRegularExpression.escapedPattern(for: expected) + #" \(\d+\)$"#
        if key.range(of: pattern, options: .regularExpression) != nil { return title }
        return stem
    }

    /// `Name (conflict <date>)`: the copy project file sync writes beside a diverged file.
    static func isConflictCopyStem(_ stem: String) -> Bool {
        stem.range(of: #" \(conflict [^)]*\)$"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func conflictOriginalStem(_ stem: String) -> String {
        stem.replacingOccurrences(of: #" \(conflict [^)]*\)$"#, with: "", options: [.regularExpression, .caseInsensitive])
    }

    /// JavaScript `<` on strings: UTF-16 code units.
    static func codeUnitLess(_ a: String, _ b: String) -> Bool {
        a.utf16.lexicographicallyPrecedes(b.utf16)
    }

    // MARK: Ids

    private static let crockford = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    static func derivedId(_ prefix: String, _ relPath: String) -> String {
        let digest = Array(SHA256.hash(data: Data(relPath.utf8)))
        return prefix + "_" + String(digest.prefix(20).map { crockford[Int($0) % 32] })
    }

    static func isSafeId(_ id: String) -> Bool {
        id.count <= 200 && id.range(of: #"^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$"#, options: .regularExpression) != nil
    }

    // MARK: Frontmatter

    enum ParsedFile {
        case ok(data: WikiMap, body: String)
        case malformed(String)
    }

    /// Frontmatter split as `parseMarkdownFile`: a leading `---` line, a closing
    /// `---` or `...` line, YAML between.
    static func parseMarkdownFile(_ text: String) -> ParsedFile {
        let ns = text as NSString
        guard let open = firstMatch(#"^\x{FEFF}?---[ \t]*\r?\n"#, in: text, options: []) else {
            return .ok(data: WikiMap(), body: text)
        }
        let restStart = open.range.location + open.range.length
        let rest = ns.substring(from: restStart)
        guard let close = firstMatch(#"^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)"#, in: rest, options: [.anchorsMatchLines]) else {
            return .malformed("Frontmatter has no closing --- line")
        }
        let yamlText = (rest as NSString).substring(to: close.range.location)
        do {
            let data = try WikiYAML.parseMapping(yamlText)
            let body = (rest as NSString).substring(from: close.range.location + close.range.length)
            return .ok(data: data, body: body)
        } catch {
            return .malformed("Frontmatter is not valid YAML: \(error)")
        }
    }

    struct PageMeta {
        var id: String?
        var title: String?
        var type: String?
        var order: Double?
        var fields: [WikiField]
    }

    private static let reserved: Set<String> = ["id", "title", "type", "order"]

    private static func scalarString(_ value: WikiValue?) -> String? {
        switch value {
        case .string(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case .number(let number) where number.isFinite:
            return WikiValue.formatNumber(number)
        default:
            return nil
        }
    }

    /// `readPageMeta`: reserved keys out, a legacy `trackerStatus` block flattened in
    /// (top-level keys win).
    static func readPageMeta(_ data: WikiMap) -> PageMeta {
        var fields: [WikiField] = []
        var index: [String: Int] = [:]
        func put(_ name: String, _ value: WikiValue) {
            if let at = index[name] { fields[at] = WikiField(name: name, value: value) }
            else { index[name] = fields.count; fields.append(WikiField(name: name, value: value)) }
        }
        var type = scalarString(data["type"])
        if case .object(let block)? = data["trackerStatus"] {
            if type == nil { type = scalarString(block["type"]) }
            for key in block.keys.sorted() where key != "type" && !reserved.contains(key) {
                put(key, block[key]!)
            }
        }
        for field in data.fields where !reserved.contains(field.name) && field.name != "trackerStatus" {
            put(field.name, field.value)
        }
        var order: Double?
        if case .number(let value)? = data["order"], value.isFinite { order = value }
        return PageMeta(id: scalarString(data["id"]), title: scalarString(data["title"]), type: type, order: order, fields: fields)
    }

    // MARK: Links

    struct Link: Hashable {
        var text: String
        /// Decoded relative path, fragment removed.
        var path: String
        var fragment: String
        var id: String?
        var isPageLink: Bool
    }

    private static let linkPattern = try! NSRegularExpression(
        pattern: #"(!?)\[((?:[^\[\]\\\n]|\\.)*)\]\([ \t]*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)(?:[ \t]+"((?:[^"\\\n]|\\.)*)")?[ \t]*\)"#
    )
    private static let inlineCode = try! NSRegularExpression(pattern: #"(`+)[^`\n][\s\S]*?\1"#)

    private static func excludedRanges(_ body: NSString) -> [NSRange] {
        var ranges: [NSRange] = []
        var offset = 0
        var open: (start: Int, marker: String)?
        for line in (body as String).components(separatedBy: "\n") {
            let length = (line as NSString).length
            let lineEnd = offset + length
            let fence = firstMatch(#"^ {0,3}(`{3,}|~{3,})"#, in: line, options: []).map { (line as NSString).substring(with: $0.range(at: 1)) }
            if open == nil, let fence {
                open = (offset, fence)
            } else if let current = open, let fence, fence.first == current.marker.first,
                      fence.count >= current.marker.count, line.trimmingCharacters(in: .whitespaces) == fence {
                ranges.append(NSRange(location: current.start, length: lineEnd - current.start))
                open = nil
            }
            offset = lineEnd + 1
        }
        if let current = open { ranges.append(NSRange(location: current.start, length: body.length - current.start)) }
        for match in inlineCode.matches(in: body as String, range: NSRange(location: 0, length: body.length)) {
            let at = match.range.location
            if !ranges.contains(where: { at >= $0.location && at < $0.location + $0.length }) {
                ranges.append(match.range)
            }
        }
        return ranges
    }

    /// Parses one link destination and title as `findLinks` does.
    static func link(text: String, destination rawDestination: String, title: String?) -> Link {
        var destination = rawDestination
        if destination.hasPrefix("<"), destination.hasSuffix(">"), destination.count >= 2 {
            destination = String(destination.dropFirst().dropLast())
        }
        let hash = destination.firstIndex(of: "#")
        let fragment = hash.map { String(destination[$0...]) } ?? ""
        let pathPart = hash.map { String(destination[..<$0]) } ?? destination
        var id: String?
        if let title, let match = firstMatch(#"^id=([A-Za-z0-9_-]+)$"#, in: title, options: []) {
            id = (title as NSString).substring(with: match.range(at: 1))
        }
        let isRelative = !pathPart.isEmpty
            && pathPart.range(of: #"^[a-z][a-z0-9+.-]*:"#, options: [.regularExpression, .caseInsensitive]) == nil
            && !pathPart.hasPrefix("/")
        let looksLikePage = isRelative && (pathPart.lowercased().hasSuffix(".md") || pathPart.hasSuffix("/"))
        return Link(
            text: text,
            path: pathPart.removingPercentEncoding ?? pathPart,
            fragment: fragment,
            id: id,
            isPageLink: looksLikePage || (id != nil && (isRelative || pathPart.isEmpty))
        )
    }

    static func findLinks(_ body: String) -> [Link] {
        let ns = body as NSString
        let excluded = excludedRanges(ns)
        var out: [Link] = []
        for match in linkPattern.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            let start = match.range.location
            if ns.substring(with: match.range(at: 1)) == "!" { continue }
            if excluded.contains(where: { start >= $0.location && start < $0.location + $0.length }) { continue }
            let title = match.range(at: 4).location == NSNotFound ? nil : ns.substring(with: match.range(at: 4))
            out.append(link(text: ns.substring(with: match.range(at: 2)), destination: ns.substring(with: match.range(at: 3)), title: title))
        }
        return out
    }

    /// Wiki-relative target of a link written in a file in `fromDir`; nil when it leaves the wiki.
    static func resolveLinkPath(fromDir: String, linkPath: String) -> String? {
        var parts: [String] = []
        for part in ((fromDir.isEmpty ? "" : fromDir + "/") + linkPath).split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." {
                if parts.isEmpty { return nil }
                parts.removeLast()
                continue
            }
            parts.append(String(part))
        }
        return parts.joined(separator: "/")
    }

    static func dirname(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[..<slash])
    }

    static func basename(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return path }
        return String(path[path.index(after: slash)...])
    }

    static func join(_ dir: String, _ name: String) -> String {
        dir.isEmpty ? name : dir + "/" + name
    }

    // MARK: CSV

    struct CSVError: Error {}

    /// RFC 4180 as `parseCsv`: CRLF or LF, optional BOM, blank lines are not rows.
    static func parseCSV(_ input: String) throws -> [[String]] {
        var chars = Array(input.unicodeScalars)
        if chars.first == "\u{FEFF}" { chars.removeFirst() }
        var rows: [[String]] = []
        var row: [String] = []
        var field = String.UnicodeScalarView()
        var quoted = false
        var atFieldStart = true
        var rowHasContent = false
        var i = 0
        func endRow() {
            row.append(String(field))
            if rowHasContent { rows.append(row) }
            row = []
            field = String.UnicodeScalarView()
            atFieldStart = true
            rowHasContent = false
        }
        while i < chars.count {
            let ch = chars[i]
            if quoted {
                if ch == "\"" {
                    if i + 1 < chars.count, chars[i + 1] == "\"" {
                        field.append("\"")
                        i += 2
                        continue
                    }
                    quoted = false
                    i += 1
                    if i < chars.count, chars[i] != ",", chars[i] != "\n", chars[i] != "\r" { throw CSVError() }
                    continue
                }
                field.append(ch)
                i += 1
                continue
            }
            if ch == "\"" && atFieldStart {
                quoted = true
                atFieldStart = false
                rowHasContent = true
                i += 1
                continue
            }
            if ch == "," {
                row.append(String(field))
                field = String.UnicodeScalarView()
                atFieldStart = true
                rowHasContent = true
                i += 1
                continue
            }
            if ch == "\r" || ch == "\n" {
                endRow()
                i += (ch == "\r" && i + 1 < chars.count && chars[i + 1] == "\n") ? 2 : 1
                continue
            }
            field.append(ch)
            atFieldStart = false
            rowHasContent = true
            i += 1
        }
        if quoted { throw CSVError() }
        if rowHasContent { endRow() }
        return rows
    }

    static func splitMultiValue(_ cell: String) -> [String] {
        if cell.isEmpty { return [] }
        var out: [String] = []
        var current = ""
        var iterator = cell.makeIterator()
        while let ch = iterator.next() {
            if ch == "\\", let next = iterator.next() { current.append(next) }
            else if ch == ";" { out.append(current.trimmingCharacters(in: .whitespaces)); current = "" }
            else { current.append(ch) }
        }
        out.append(current.trimmingCharacters(in: .whitespaces))
        return out.filter { !$0.isEmpty }
    }

    /// `decodeCell`: nil for an empty cell.
    static func decodeCell(_ cell: String, field: WikiFieldDef?) -> WikiValue? {
        if cell.isEmpty { return nil }
        switch field?.type {
        case "multiselect", "label-ref":
            return .array(splitMultiValue(cell).map(WikiValue.string))
        case "array":
            if field?.itemType == "object" { return json(cell) }
            return .array(splitMultiValue(cell).map(WikiValue.string))
        case "relationship", "reference":
            return field?.multiValue == true ? .array(splitMultiValue(cell).map(WikiValue.string)) : .string(cell)
        case "object", "citation":
            return json(cell)
        case "number":
            let trimmed = cell.trimmingCharacters(in: .whitespacesAndNewlines)
            if let value = Double(trimmed), value.isFinite { return .number(value) }
            return .string(cell)
        case "boolean":
            return .bool(cell.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "true")
        default:
            return .string(cell)
        }
    }

    private static func json(_ cell: String) -> WikiValue {
        guard let data = cell.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return .string(cell)
        }
        return WikiValue(json: parsed)
    }

    // MARK: Regex helper

    static func firstMatch(_ pattern: String, in text: String, options: NSRegularExpression.Options) -> NSTextCheckingResult? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return nil }
        return regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length))
    }
}
