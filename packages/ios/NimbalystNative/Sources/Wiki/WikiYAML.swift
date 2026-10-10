import Foundation

/// The YAML the local wiki writes and people hand-edit in frontmatter and
/// sidecars, read with the core schema as `js-yaml` does (dates stay strings):
/// block mappings and sequences, flow `[...]` / `{...}`, quoted and plain
/// scalars, `|` and `>` block scalars, comments. Anchors, tags and multi-line
/// plain scalars are not supported; such a file reads as malformed, which the
/// wiki treats as read-only, never as data to rewrite.
enum WikiYAML {
    struct ParseError: Error, CustomStringConvertible {
        let message: String
        var description: String { message }
    }

    /// The document as a mapping; an empty document is an empty mapping.
    static func parseMapping(_ text: String) throws -> WikiMap {
        var parser = Parser(text: text)
        guard let first = parser.nextSignificant(from: 0) else { return WikiMap() }
        let indent = parser.indentOf(first)
        guard case .object = parser.peekKind(first) else {
            throw ParseError(message: "Frontmatter is not a mapping")
        }
        let (map, next) = try parser.parseMapping(at: first, indent: indent)
        if let extra = parser.nextSignificant(from: next) {
            throw ParseError(message: "Unexpected content on line \(extra + 1)")
        }
        return map
    }

    private enum Kind { case object, array, scalar }

    private struct Parser {
        var lines: [String]

        init(text: String) {
            lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
            // The newline that ends the last line does not start another (it matters for `|+`).
            if lines.count > 1, lines.last == "" { lines.removeLast() }
        }

        func indentOf(_ index: Int) -> Int {
            lines[index].prefix(while: { $0 == " " }).count
        }

        func isBlankOrComment(_ index: Int) -> Bool {
            let trimmed = lines[index].trimmingCharacters(in: .whitespaces)
            return trimmed.isEmpty || trimmed.hasPrefix("#")
        }

        func nextSignificant(from index: Int) -> Int? {
            var i = index
            while i < lines.count {
                if !isBlankOrComment(i) { return i }
                i += 1
            }
            return nil
        }

        func content(_ index: Int) -> Substring {
            lines[index].drop(while: { $0 == " " })
        }

        func peekKind(_ index: Int) -> Kind {
            let body = content(index)
            if body == "-" || body.hasPrefix("- ") { return .array }
            if splitKey(body) != nil { return .object }
            return .scalar
        }

        /// `key: rest` (or `key:` at end of line). Quoted keys are allowed.
        func splitKey(_ body: Substring) -> (key: String, rest: Substring)? {
            if let quote = body.first, quote == "\"" || quote == "'" {
                guard let (key, after) = try? Parser.readQuoted(body) else { return nil }
                let rest = after.drop(while: { $0 == " " || $0 == "\t" })
                guard rest.first == ":" else { return nil }
                let value = rest.dropFirst()
                guard value.isEmpty || value.first == " " || value.first == "\t" else { return nil }
                return (key, value)
            }
            var index = body.startIndex
            while index < body.endIndex {
                if body[index] == ":" {
                    let next = body.index(after: index)
                    if next == body.endIndex || body[next] == " " || body[next] == "\t" {
                        let key = body[..<index].trimmingCharacters(in: .whitespaces)
                        if key.isEmpty || key.hasPrefix("#") || key.hasPrefix("[") || key.hasPrefix("{") { return nil }
                        return (key, body[next...])
                    }
                }
                if body[index] == "#", index > body.startIndex, body[body.index(before: index)] == " " { return nil }
                index = body.index(after: index)
            }
            return nil
        }

        mutating func parseBlock(at index: Int, indent: Int) throws -> (WikiValue, Int) {
            switch peekKind(index) {
            case .object:
                let (map, next) = try parseMapping(at: index, indent: indent)
                return (map.asValue, next)
            case .array:
                return try parseSequence(at: index, indent: indent)
            case .scalar:
                return (try Parser.inlineValue(content(index)), index + 1)
            }
        }

        mutating func parseMapping(at start: Int, indent: Int) throws -> (WikiMap, Int) {
            var map = WikiMap()
            var i = start
            while let line = nextSignificant(from: i) {
                let lineIndent = indentOf(line)
                if lineIndent < indent { return (map, line) }
                if lineIndent > indent { throw ParseError(message: "Bad indentation on line \(line + 1)") }
                guard let (key, rest) = splitKey(content(line)) else {
                    if peekKind(line) == .array { return (map, line) }
                    throw ParseError(message: "Expected a key on line \(line + 1)")
                }
                let value: WikiValue
                let trimmed = Parser.stripComment(rest).trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty {
                    let child = nextSignificant(from: line + 1)
                    let childIsValue = child.map { indentOf($0) > indent || (indentOf($0) == indent && peekKind($0) == .array) } ?? false
                    if let child, childIsValue {
                        let parsed = try parseBlock(at: child, indent: indentOf(child))
                        value = parsed.0
                        i = parsed.1
                    } else {
                        value = .null
                        i = line + 1
                    }
                } else if trimmed.hasPrefix("|") || trimmed.hasPrefix(">") {
                    let parsed = try blockScalar(header: trimmed, after: line, parentIndent: indent)
                    value = .string(parsed.0)
                    i = parsed.1
                } else {
                    value = try Parser.inlineValue(rest)
                    i = line + 1
                }
                if !map.set(key, value) { throw ParseError(message: "Duplicated mapping key \(key)") }
            }
            return (map, lines.count)
        }

        mutating func parseSequence(at start: Int, indent: Int) throws -> (WikiValue, Int) {
            var items: [WikiValue] = []
            var i = start
            while let line = nextSignificant(from: i) {
                let lineIndent = indentOf(line)
                if lineIndent < indent { break }
                if lineIndent > indent { throw ParseError(message: "Bad indentation on line \(line + 1)") }
                let body = content(line)
                guard body == "-" || body.hasPrefix("- ") else { break }
                let item = body.dropFirst().drop(while: { $0 == " " })
                if Parser.stripComment(item).trimmingCharacters(in: .whitespaces).isEmpty {
                    if let child = nextSignificant(from: line + 1), indentOf(child) > indent {
                        let parsed = try parseBlock(at: child, indent: indentOf(child))
                        items.append(parsed.0)
                        i = parsed.1
                    } else {
                        items.append(.null)
                        i = line + 1
                    }
                } else if splitKey(item) != nil {
                    // `- key: value` starts a mapping indented to the item's content.
                    let itemIndent = lines[line].count - item.count
                    lines[line] = String(repeating: " ", count: itemIndent) + item
                    let (map, next) = try parseMapping(at: line, indent: itemIndent)
                    items.append(map.asValue)
                    i = next
                } else {
                    items.append(try Parser.inlineValue(item))
                    i = line + 1
                }
            }
            return (.array(items), i)
        }

        /// `|` keeps newlines, `>` folds them; `-` strips the final newline, `+` keeps all.
        /// Forms this reader cannot reproduce exactly (an explicit indentation
        /// indicator, a folded scalar with more-indented lines) throw, so the file
        /// reads as malformed rather than with an altered value.
        func blockScalar(header: String, after line: Int, parentIndent: Int) throws -> (String, Int) {
            let folded = header.hasPrefix(">")
            let indicators = header.dropFirst()
            guard indicators.count <= 1, indicators.allSatisfy({ $0 == "-" || $0 == "+" }) else {
                throw ParseError(message: "Unsupported block scalar header \(header)")
            }
            let chomp = indicators.first
            var body: [String] = []
            var blockIndent: Int?
            var i = line + 1
            while i < lines.count {
                let raw = lines[i]
                if raw.trimmingCharacters(in: .whitespaces).isEmpty {
                    body.append("")
                    i += 1
                    continue
                }
                let lineIndent = raw.prefix(while: { $0 == " " }).count
                if lineIndent <= parentIndent { break }
                if blockIndent == nil { blockIndent = lineIndent }
                if lineIndent < blockIndent! { break }
                if folded && lineIndent > blockIndent! {
                    throw ParseError(message: "Unsupported folded scalar with more-indented lines on line \(i + 1)")
                }
                body.append(String(raw.dropFirst(blockIndent!)))
                i += 1
            }
            var trailingBlank = 0
            while let last = body.last, last.isEmpty {
                body.removeLast()
                trailingBlank += 1
            }
            // Blank lines after the block belong to whatever follows.
            var text: String
            if folded {
                text = ""
                for (offset, piece) in body.enumerated() {
                    if offset == 0 { text = piece; continue }
                    let previous = body[offset - 1]
                    if piece.isEmpty { text += "\n" }
                    else if previous.isEmpty || piece.hasPrefix(" ") || previous.hasPrefix(" ") { text += piece }
                    else { text += " " + piece }
                }
            } else {
                text = body.joined(separator: "\n")
            }
            switch chomp {
            case "-": break
            case "+": if !body.isEmpty { text += String(repeating: "\n", count: trailingBlank + 1) }
            default: if !body.isEmpty { text += "\n" }
            }
            return (text, i)
        }

        // MARK: Inline values

        static func stripComment(_ text: Substring) -> Substring {
            var inSingle = false
            var inDouble = false
            var previous: Character = " "
            for index in text.indices {
                let ch = text[index]
                if ch == "'" && !inDouble { inSingle.toggle() }
                else if ch == "\"" && !inSingle && previous != "\\" { inDouble.toggle() }
                else if ch == "#" && !inSingle && !inDouble && (previous == " " || previous == "\t") {
                    return text[..<index]
                }
                previous = ch
            }
            return text
        }

        static func inlineValue(_ raw: Substring) throws -> WikiValue {
            let text = raw.trimmingCharacters(in: .whitespaces)
            guard let first = text.first else { return .null }
            if first == "\"" || first == "'" {
                let (value, rest) = try readQuoted(Substring(text))
                let tail = stripComment(rest).trimmingCharacters(in: .whitespaces)
                if !tail.isEmpty { throw ParseError(message: "Unexpected text after a quoted value") }
                return .string(value)
            }
            if first == "[" || first == "{" {
                var flow = FlowReader(text: Array(text))
                let value = try flow.value()
                flow.skipSpaces()
                let tail = stripComment(Substring(String(flow.text[flow.position...]))).trimmingCharacters(in: .whitespaces)
                if !tail.isEmpty { throw ParseError(message: "Unexpected text after a flow value") }
                return value
            }
            if first == "&" || first == "*" || first == "!" || first == "%" || first == "@" || first == "`" {
                throw ParseError(message: "Unsupported YAML: \(text)")
            }
            // Quotes inside a plain scalar are literal, so only ` #` starts a comment.
            let plain = (text.range(of: " #").map { String(text[..<$0.lowerBound]) } ?? text)
                .trimmingCharacters(in: .whitespaces)
            return resolvePlain(plain)
        }

        /// Reads a quoted scalar at the start of `text`; returns it and what follows.
        static func readQuoted(_ text: Substring) throws -> (String, Substring) {
            let quote = text.first!
            var out = ""
            var index = text.index(after: text.startIndex)
            while index < text.endIndex {
                let ch = text[index]
                if quote == "'" {
                    if ch == "'" {
                        let next = text.index(after: index)
                        if next < text.endIndex && text[next] == "'" {
                            out.append("'")
                            index = text.index(after: next)
                            continue
                        }
                        return (out, text[next...])
                    }
                    out.append(ch)
                } else {
                    if ch == "\"" { return (out, text[text.index(after: index)...]) }
                    if ch == "\\" {
                        index = text.index(after: index)
                        guard index < text.endIndex else { break }
                        let escape = text[index]
                        switch escape {
                        case "n": out.append("\n")
                        case "t": out.append("\t")
                        case "r": out.append("\r")
                        case "0": out.append("\0")
                        case "\"": out.append("\"")
                        case "\\": out.append("\\")
                        case "/": out.append("/")
                        case " ": out.append(" ")
                        case "u", "x", "U":
                            let length = escape == "x" ? 2 : escape == "u" ? 4 : 8
                            let start = text.index(after: index)
                            guard let end = text.index(start, offsetBy: length, limitedBy: text.endIndex),
                                  let code = UInt32(text[start..<end], radix: 16),
                                  let scalar = Unicode.Scalar(code) else {
                                throw ParseError(message: "Bad escape in a quoted value")
                            }
                            out.unicodeScalars.append(scalar)
                            index = text.index(before: end)
                        default:
                            throw ParseError(message: "Bad escape in a quoted value")
                        }
                    } else {
                        out.append(ch)
                    }
                }
                index = text.index(after: index)
            }
            throw ParseError(message: "Unterminated quoted value")
        }

        /// Core schema: null, booleans, integers and floats; anything else is a string.
        static func resolvePlain(_ text: String) -> WikiValue {
            switch text {
            case "", "~", "null", "Null", "NULL": return .null
            case "true", "True", "TRUE": return .bool(true)
            case "false", "False", "FALSE": return .bool(false)
            case ".inf", ".Inf", ".INF", "+.inf", "+.Inf", "+.INF": return .number(.infinity)
            case "-.inf", "-.Inf", "-.INF": return .number(-.infinity)
            case ".nan", ".NaN", ".NAN": return .number(.nan)
            default: break
            }
            if text.range(of: #"^[-+]?[0-9]+$"#, options: .regularExpression) != nil, let value = Double(text) {
                return .number(value)
            }
            if text.range(of: #"^0x[0-9a-fA-F]+$"#, options: .regularExpression) != nil, let value = Int64(text.dropFirst(2), radix: 16) {
                return .number(Double(value))
            }
            if text.range(of: #"^0o[0-7]+$"#, options: .regularExpression) != nil, let value = Int64(text.dropFirst(2), radix: 8) {
                return .number(Double(value))
            }
            if text.range(of: #"^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$"#, options: .regularExpression) != nil,
               let value = Double(text) {
                return .number(value)
            }
            return .string(text)
        }
    }

    /// `[a, "b", {c: d}]` and `{a: b}`.
    private struct FlowReader {
        let text: [Character]
        var position = 0

        init(text: [Character]) { self.text = text }

        mutating func skipSpaces() {
            while position < text.count, text[position] == " " || text[position] == "\t" { position += 1 }
        }

        mutating func value() throws -> WikiValue {
            skipSpaces()
            guard position < text.count else { throw ParseError(message: "Unterminated flow value") }
            switch text[position] {
            case "[":
                position += 1
                var items: [WikiValue] = []
                skipSpaces()
                if position < text.count, text[position] == "]" { position += 1; return .array(items) }
                while true {
                    items.append(try value())
                    skipSpaces()
                    guard position < text.count else { throw ParseError(message: "Unterminated flow sequence") }
                    if text[position] == "," {
                        position += 1
                        skipSpaces()
                        if position < text.count, text[position] == "]" { position += 1; return .array(items) }
                        continue
                    }
                    if text[position] == "]" { position += 1; return .array(items) }
                    throw ParseError(message: "Bad flow sequence")
                }
            case "{":
                position += 1
                var map = WikiMap()
                skipSpaces()
                if position < text.count, text[position] == "}" { position += 1; return map.asValue }
                while true {
                    let key = try scalar(stopAtColon: true)
                    skipSpaces()
                    var entry: WikiValue = .null
                    if position < text.count, text[position] == ":" {
                        position += 1
                        entry = try value()
                    }
                    if !map.set(key.displayText, entry) { throw ParseError(message: "Duplicated mapping key") }
                    skipSpaces()
                    guard position < text.count else { throw ParseError(message: "Unterminated flow mapping") }
                    if text[position] == "," { position += 1; continue }
                    if text[position] == "}" { position += 1; return map.asValue }
                    throw ParseError(message: "Bad flow mapping")
                }
            default:
                return try scalar(stopAtColon: false)
            }
        }

        mutating func scalar(stopAtColon: Bool) throws -> WikiValue {
            skipSpaces()
            if position < text.count, text[position] == "\"" || text[position] == "'" {
                let rest = Substring(String(text[position...]))
                let (value, after) = try Parser.readQuoted(rest)
                position = text.count - after.count
                return .string(value)
            }
            let start = position
            while position < text.count {
                let ch = text[position]
                if ch == "," || ch == "]" || ch == "}" { break }
                if ch == ":", stopAtColon, position + 1 >= text.count || text[position + 1] == " " { break }
                position += 1
            }
            return Parser.resolvePlain(String(text[start..<position]).trimmingCharacters(in: .whitespaces))
        }
    }
}
