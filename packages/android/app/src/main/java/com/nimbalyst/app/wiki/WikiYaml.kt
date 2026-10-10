package com.nimbalyst.app.wiki

/**
 * The YAML the local wiki writes and people hand-edit in frontmatter and
 * sidecars, read with the core schema as `js-yaml` does (dates stay strings):
 * block mappings and sequences, flow `[...]` / `{...}`, quoted and plain
 * scalars, `|` and `>` block scalars, comments. Anchors, tags and multi-line
 * plain scalars are not supported; such a file reads as malformed, which the
 * wiki treats as read-only, never as data to rewrite. Ported from iOS `WikiYAML`.
 */
object WikiYaml {
    class ParseError(message: String) : Exception(message)

    /** The document as a mapping; an empty document is an empty mapping. */
    fun parseMapping(text: String): WikiMap {
        val parser = Parser(text)
        val first = parser.nextSignificant(0) ?: return WikiMap()
        if (parser.peekKind(first) != Kind.OBJECT) throw ParseError("Frontmatter is not a mapping")
        val (map, next) = parser.parseMapping(first, parser.indentOf(first))
        parser.nextSignificant(next)?.let { throw ParseError("Unexpected content on line ${it + 1}") }
        return map
    }

    private enum class Kind { OBJECT, ARRAY, SCALAR }

    private fun isSpace(ch: Char) = ch == ' ' || ch == '\t'
    private val BLOCK_HEADER = Regex("^[|>][+-]?$")
    private fun trimSpaces(text: String) = text.trim(::isSpace)

    private class Parser(text: String) {
        val lines: MutableList<String> = text.replace("\r\n", "\n").split("\n").toMutableList()

        fun indentOf(index: Int): Int = lines[index].takeWhile { it == ' ' }.length

        fun isBlankOrComment(index: Int): Boolean {
            val trimmed = trimSpaces(lines[index])
            return trimmed.isEmpty() || trimmed.startsWith("#")
        }

        fun nextSignificant(from: Int): Int? {
            var i = from
            while (i < lines.size) {
                if (!isBlankOrComment(i)) return i
                i++
            }
            return null
        }

        fun content(index: Int): String = lines[index].trimStart(' ')

        fun peekKind(index: Int): Kind {
            val body = content(index)
            if (body == "-" || body.startsWith("- ")) return Kind.ARRAY
            if (splitKey(body) != null) return Kind.OBJECT
            return Kind.SCALAR
        }

        /** `key: rest` (or `key:` at end of line). Quoted keys are allowed. */
        fun splitKey(body: String): Pair<String, String>? {
            val quote = body.firstOrNull()
            if (quote == '"' || quote == '\'') {
                val (key, after) = runCatching { readQuoted(body) }.getOrNull() ?: return null
                val rest = after.trimStart(::isSpace)
                if (!rest.startsWith(":")) return null
                val value = rest.substring(1)
                if (!(value.isEmpty() || isSpace(value[0]))) return null
                return key to value
            }
            var index = 0
            while (index < body.length) {
                if (body[index] == ':') {
                    val next = index + 1
                    if (next == body.length || isSpace(body[next])) {
                        val key = trimSpaces(body.substring(0, index))
                        if (key.isEmpty() || key.startsWith("#") || key.startsWith("[") || key.startsWith("{")) return null
                        return key to body.substring(next)
                    }
                }
                if (body[index] == '#' && index > 0 && body[index - 1] == ' ') return null
                index++
            }
            return null
        }

        fun parseBlock(index: Int, indent: Int): Pair<WikiValue, Int> = when (peekKind(index)) {
            Kind.OBJECT -> parseMapping(index, indent).let { (map, next) -> map.asValue to next }
            Kind.ARRAY -> parseSequence(index, indent)
            Kind.SCALAR -> inlineValue(content(index)) to index + 1
        }

        fun parseMapping(start: Int, indent: Int): Pair<WikiMap, Int> {
            val map = WikiMap()
            var i = start
            while (true) {
                val line = nextSignificant(i) ?: break
                val lineIndent = indentOf(line)
                if (lineIndent < indent) return map to line
                if (lineIndent > indent) throw ParseError("Bad indentation on line ${line + 1}")
                val split = splitKey(content(line))
                if (split == null) {
                    if (peekKind(line) == Kind.ARRAY) return map to line
                    throw ParseError("Expected a key on line ${line + 1}")
                }
                val (key, rest) = split
                val value: WikiValue
                val trimmed = trimSpaces(stripComment(rest))
                if (trimmed.isEmpty()) {
                    val child = nextSignificant(line + 1)
                    val childIsValue = child != null &&
                        (indentOf(child) > indent || (indentOf(child) == indent && peekKind(child) == Kind.ARRAY))
                    if (child != null && childIsValue) {
                        val parsed = parseBlock(child, indentOf(child))
                        value = parsed.first
                        i = parsed.second
                    } else {
                        value = WikiValue.Null
                        i = line + 1
                    }
                } else if (trimmed.startsWith("|") || trimmed.startsWith(">")) {
                    val parsed = blockScalar(trimmed, line, indent)
                    value = WikiValue.Str(parsed.first)
                    i = parsed.second
                } else {
                    value = inlineValue(rest)
                    i = line + 1
                }
                if (!map.set(key, value)) throw ParseError("Duplicated mapping key $key")
            }
            return map to lines.size
        }

        fun parseSequence(start: Int, indent: Int): Pair<WikiValue, Int> {
            val items = mutableListOf<WikiValue>()
            var i = start
            while (true) {
                val line = nextSignificant(i) ?: break
                val lineIndent = indentOf(line)
                if (lineIndent < indent) break
                if (lineIndent > indent) throw ParseError("Bad indentation on line ${line + 1}")
                val body = content(line)
                if (!(body == "-" || body.startsWith("- "))) break
                val item = body.substring(1).trimStart(' ')
                if (trimSpaces(stripComment(item)).isEmpty()) {
                    val child = nextSignificant(line + 1)
                    if (child != null && indentOf(child) > indent) {
                        val parsed = parseBlock(child, indentOf(child))
                        items += parsed.first
                        i = parsed.second
                    } else {
                        items += WikiValue.Null
                        i = line + 1
                    }
                } else if (splitKey(item) != null) {
                    // `- key: value` starts a mapping indented to the item's content.
                    val itemIndent = lines[line].length - item.length
                    lines[line] = " ".repeat(itemIndent) + item
                    val (map, next) = parseMapping(line, itemIndent)
                    items += map.asValue
                    i = next
                } else {
                    items += inlineValue(item)
                    i = line + 1
                }
            }
            return WikiValue.Arr(items) to i
        }

        /**
         * `|` keeps newlines, `>` folds them; `-` strips the final newline, `+` keeps all.
         * Explicit indentation indicators (`|2`) and more-indented lines in a folded
         * scalar are rejected rather than read with the wrong value.
         */
        fun blockScalar(header: String, line: Int, parentIndent: Int): Pair<String, Int> {
            if (!BLOCK_HEADER.matches(header)) throw ParseError("Unsupported block scalar header on line ${line + 1}: $header")
            val folded = header.startsWith(">")
            val chomp = header.drop(1).firstOrNull { it == '-' || it == '+' }
            val body = mutableListOf<String>()
            var blockIndent: Int? = null
            var i = line + 1
            while (i < lines.size) {
                val raw = lines[i]
                if (trimSpaces(raw).isEmpty()) {
                    body += ""
                    i++
                    continue
                }
                val lineIndent = raw.takeWhile { it == ' ' }.length
                if (lineIndent <= parentIndent) break
                if (blockIndent == null) blockIndent = lineIndent
                if (lineIndent < blockIndent) break
                if (folded && lineIndent > blockIndent) throw ParseError("Unsupported more-indented line in a folded scalar on line ${i + 1}")
                if (raw.substring(lineIndent).startsWith("\t") && folded) throw ParseError("Unsupported tab in a folded scalar on line ${i + 1}")
                body += raw.substring(blockIndent)
                i++
            }
            var trailingBlank = 0
            while (body.isNotEmpty() && body.last().isEmpty()) {
                body.removeAt(body.lastIndex)
                trailingBlank++
            }
            val text = StringBuilder()
            if (folded) {
                body.forEachIndexed { offset, piece ->
                    if (offset == 0) {
                        text.append(piece)
                        return@forEachIndexed
                    }
                    val previous = body[offset - 1]
                    when {
                        piece.isEmpty() -> text.append("\n")
                        previous.isEmpty() || piece.startsWith(" ") || previous.startsWith(" ") -> text.append(piece)
                        else -> text.append(" ").append(piece)
                    }
                }
            } else {
                text.append(body.joinToString("\n"))
            }
            when (chomp) {
                '-' -> Unit
                '+' -> if (body.isNotEmpty()) text.append("\n".repeat(trailingBlank + 1))
                else -> if (body.isNotEmpty()) text.append("\n")
            }
            return text.toString() to i
        }
    }

    // Inline values

    internal fun stripComment(text: String): String {
        var inSingle = false
        var inDouble = false
        var previous = ' '
        for (index in text.indices) {
            val ch = text[index]
            if (ch == '\'' && !inDouble) inSingle = !inSingle
            else if (ch == '"' && !inSingle && previous != '\\') inDouble = !inDouble
            else if (ch == '#' && !inSingle && !inDouble && isSpace(previous)) return text.substring(0, index)
            previous = ch
        }
        return text
    }

    internal fun inlineValue(raw: String): WikiValue {
        val text = trimSpaces(raw)
        val first = text.firstOrNull() ?: return WikiValue.Null
        if (first == '"' || first == '\'') {
            val (value, rest) = readQuoted(text)
            if (trimSpaces(stripComment(rest)).isNotEmpty()) throw ParseError("Unexpected text after a quoted value")
            return WikiValue.Str(value)
        }
        if (first == '[' || first == '{') {
            val flow = FlowReader(text)
            val value = flow.value()
            flow.skipSpaces()
            if (trimSpaces(stripComment(text.substring(flow.position))).isNotEmpty()) {
                throw ParseError("Unexpected text after a flow value")
            }
            return value
        }
        if (first in "&*!%@`") throw ParseError("Unsupported YAML: $text")
        // Quotes inside a plain scalar are literal, so only ` #` starts a comment.
        val cut = text.indexOf(" #")
        return resolvePlain(trimSpaces(if (cut >= 0) text.substring(0, cut) else text))
    }

    /** Reads a quoted scalar at the start of [text]; returns it and what follows. */
    internal fun readQuoted(text: String): Pair<String, String> {
        val quote = text[0]
        val out = StringBuilder()
        var index = 1
        while (index < text.length) {
            val ch = text[index]
            if (quote == '\'') {
                if (ch == '\'') {
                    val next = index + 1
                    if (next < text.length && text[next] == '\'') {
                        out.append('\'')
                        index = next + 1
                        continue
                    }
                    return out.toString() to text.substring(next)
                }
                out.append(ch)
            } else {
                if (ch == '"') return out.toString() to text.substring(index + 1)
                if (ch == '\\') {
                    index++
                    if (index >= text.length) break
                    when (val escape = text[index]) {
                        'n' -> out.append('\n')
                        't' -> out.append('\t')
                        'r' -> out.append('\r')
                        '0' -> out.append('\u0000')
                        '"' -> out.append('"')
                        '\\' -> out.append('\\')
                        '/' -> out.append('/')
                        ' ' -> out.append(' ')
                        'u', 'x', 'U' -> {
                            val length = when (escape) { 'x' -> 2; 'u' -> 4; else -> 8 }
                            val start = index + 1
                            val end = start + length
                            val code = if (end <= text.length) text.substring(start, end).toIntOrNull(16) else null
                            if (code == null || !Character.isValidCodePoint(code)) throw ParseError("Bad escape in a quoted value")
                            out.appendCodePoint(code)
                            index = end - 1
                        }
                        else -> throw ParseError("Bad escape in a quoted value")
                    }
                } else {
                    out.append(ch)
                }
            }
            index++
        }
        throw ParseError("Unterminated quoted value")
    }

    private val INTEGER = Regex("^[-+]?[0-9]+$")
    private val HEX = Regex("^0x[0-9a-fA-F]+$")
    private val OCTAL = Regex("^0o[0-7]+$")
    private val FLOAT = Regex("^[-+]?(\\.[0-9]+|[0-9]+(\\.[0-9]*)?)([eE][-+]?[0-9]+)?$")

    /** Core schema: null, booleans, integers and floats; anything else is a string. */
    internal fun resolvePlain(text: String): WikiValue {
        when (text) {
            "", "~", "null", "Null", "NULL" -> return WikiValue.Null
            "true", "True", "TRUE" -> return WikiValue.Bool(true)
            "false", "False", "FALSE" -> return WikiValue.Bool(false)
            ".inf", ".Inf", ".INF", "+.inf", "+.Inf", "+.INF" -> return WikiValue.Num(Double.POSITIVE_INFINITY)
            "-.inf", "-.Inf", "-.INF" -> return WikiValue.Num(Double.NEGATIVE_INFINITY)
            ".nan", ".NaN", ".NAN" -> return WikiValue.Num(Double.NaN)
        }
        if (INTEGER.matches(text)) text.toDoubleOrNull()?.let { return WikiValue.Num(it) }
        if (HEX.matches(text)) text.drop(2).toLongOrNull(16)?.let { return WikiValue.Num(it.toDouble()) }
        if (OCTAL.matches(text)) text.drop(2).toLongOrNull(8)?.let { return WikiValue.Num(it.toDouble()) }
        if (FLOAT.matches(text)) text.toDoubleOrNull()?.let { return WikiValue.Num(it) }
        return WikiValue.Str(text)
    }

    /** `[a, "b", {c: d}]` and `{a: b}`. */
    private class FlowReader(val text: String) {
        var position = 0

        fun skipSpaces() {
            while (position < text.length && isSpace(text[position])) position++
        }

        fun value(): WikiValue {
            skipSpaces()
            if (position >= text.length) throw ParseError("Unterminated flow value")
            return when (text[position]) {
                '[' -> {
                    position++
                    val items = mutableListOf<WikiValue>()
                    skipSpaces()
                    if (position < text.length && text[position] == ']') {
                        position++
                        return WikiValue.Arr(items)
                    }
                    while (true) {
                        items += value()
                        skipSpaces()
                        if (position >= text.length) throw ParseError("Unterminated flow sequence")
                        if (text[position] == ',') {
                            position++
                            skipSpaces()
                            if (position < text.length && text[position] == ']') {
                                position++
                                return WikiValue.Arr(items)
                            }
                            continue
                        }
                        if (text[position] == ']') {
                            position++
                            return WikiValue.Arr(items)
                        }
                        throw ParseError("Bad flow sequence")
                    }
                    @Suppress("UNREACHABLE_CODE")
                    WikiValue.Arr(items)
                }
                '{' -> {
                    position++
                    val map = WikiMap()
                    skipSpaces()
                    if (position < text.length && text[position] == '}') {
                        position++
                        return map.asValue
                    }
                    while (true) {
                        val key = scalar(stopAtColon = true)
                        skipSpaces()
                        var entry: WikiValue = WikiValue.Null
                        if (position < text.length && text[position] == ':') {
                            position++
                            entry = value()
                        }
                        if (!map.set(key.displayText, entry)) throw ParseError("Duplicated mapping key")
                        skipSpaces()
                        if (position >= text.length) throw ParseError("Unterminated flow mapping")
                        if (text[position] == ',') {
                            position++
                            continue
                        }
                        if (text[position] == '}') {
                            position++
                            return map.asValue
                        }
                        throw ParseError("Bad flow mapping")
                    }
                    @Suppress("UNREACHABLE_CODE")
                    map.asValue
                }
                else -> scalar(stopAtColon = false)
            }
        }

        fun scalar(stopAtColon: Boolean): WikiValue {
            skipSpaces()
            if (position < text.length && (text[position] == '"' || text[position] == '\'')) {
                val (value, after) = readQuoted(text.substring(position))
                position = text.length - after.length
                return WikiValue.Str(value)
            }
            val start = position
            while (position < text.length) {
                val ch = text[position]
                if (ch == ',' || ch == ']' || ch == '}') break
                if (ch == ':' && stopAtColon && (position + 1 >= text.length || text[position + 1] == ' ')) break
                position++
            }
            return resolvePlain(trimSpaces(text.substring(start, position)))
        }
    }
}
