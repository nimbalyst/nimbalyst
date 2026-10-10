package com.nimbalyst.app.wiki

import com.google.gson.JsonParser
import com.nimbalyst.app.sync.SyncedWikiField
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.text.Normalizer

/**
 * The rules of `packages/local-wiki/FORMAT.md` that a reader needs, ported from
 * iOS `WikiFormat` (itself ported from the TypeScript library's `names.ts`,
 * `ids.ts`, `frontmatter.ts`, `links.ts`, `csv.ts`, `tableCodec.ts`). The
 * shared fixtures in `packages/local-wiki/fixtures` keep the three in step.
 */
object WikiFormat {
    const val MARKER_FILE = ".nimbalyst-wiki.yaml"
    const val TRASH_DIR = ".trash"
    const val SIDECAR_SUFFIX = ".wiki.yaml"
    const val SUPPORTED_FORMAT_VERSION = 1

    /** `DEFAULT_EDITOR_TYPES`: editor page suffix to document type. */
    val editorTypes: Map<String, String> = mapOf(
        ".excalidraw" to "excalidraw",
        ".mindmap" to "mindmap",
        ".prisma" to "datamodel",
        ".mockup.html" to "mockup.html",
        ".csv" to "csv",
        ".calc.md" to "calc.md",
        ".canvas" to "canvas",
    )

    // region Names

    fun nfc(text: String): String = Normalizer.normalize(text, Normalizer.Form.NFC)

    /** Clash key: NFC, lower-cased. */
    fun nameKey(name: String): String = nfc(name).lowercase()

    /** JavaScript's `\s` (and what `String.prototype.trim` strips), which the library's names follow. */
    private const val JS_SPACE = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    private val WHITESPACE_RUN = Regex("[$JS_SPACE]+")
    private val EDGE_SPACE = Regex("^[$JS_SPACE]+|[$JS_SPACE]+$")
    private val LEADING_DOTS = Regex("^\\.+")
    private val TRAILING_DOTS_SPACES = Regex("[. ]+$")
    private val DEVICE_NAME = Regex("^(con|prn|aux|nul|com[1-9]|lpt[1-9])$", RegexOption.IGNORE_CASE)

    fun fileStemForTitle(title: String): String {
        val mapped = StringBuilder()
        nfc(title).codePoints().forEach { code ->
            when {
                code < 0x20 || code == 0x7f -> mapped.append(' ')
                code < 0x80 && code.toChar() in "/\\:*?\"<>|" -> mapped.append('-')
                else -> mapped.appendCodePoint(code)
            }
        }
        var stem = mapped.toString().replace(WHITESPACE_RUN, " ").replace(EDGE_SPACE, "")
            .replace(LEADING_DOTS, "")
            .replace(TRAILING_DOTS_SPACES, "")
        if (stem.toByteArray(Charsets.UTF_8).size > 200) {
            while (stem.toByteArray(Charsets.UTF_8).size > 200) {
                stem = stem.dropLast(if (stem.length >= 2 && Character.isLowSurrogate(stem.last())) 2 else 1)
            }
            stem = stem.replace(TRAILING_DOTS_SPACES, "")
        }
        if (stem.isEmpty()) stem = "Untitled"
        if (DEVICE_NAME.matches(stem)) stem += "_"
        return stem
    }

    /**
     * Frontmatter `title` while the file name still derives from it (exactly or
     * with a clash suffix); otherwise the file name.
     */
    fun titleForStem(stem: String, frontmatterTitle: String?): String {
        val title = frontmatterTitle ?: return stem
        val expected = nameKey(fileStemForTitle(title))
        val key = nameKey(stem)
        if (key == expected) return title
        if (Regex("^" + Regex.escape(expected) + " \\(\\d+\\)$").matches(key)) return title
        return stem
    }

    private val CONFLICT_SUFFIX = Regex(" \\(conflict [^)]*\\)$", RegexOption.IGNORE_CASE)

    /** `Name (conflict <date>)`: the copy project file sync writes beside a diverged file. */
    fun isConflictCopyStem(stem: String): Boolean = CONFLICT_SUFFIX.containsMatchIn(stem)

    fun conflictOriginalStem(stem: String): String = stem.replace(CONFLICT_SUFFIX, "")

    // endregion

    // region Ids

    private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    fun derivedId(prefix: String, relPath: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(relPath.toByteArray(Charsets.UTF_8))
        return prefix + "_" + digest.take(20).joinToString("") { CROCKFORD[(it.toInt() and 0xff) % 32].toString() }
    }

    private val SAFE_ID = Regex("^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$")

    fun isSafeId(id: String): Boolean = id.length <= 200 && SAFE_ID.matches(id)

    // endregion

    // region Frontmatter

    sealed interface ParsedFile {
        data class Ok(val data: WikiMap, val body: String) : ParsedFile
        data class Malformed(val reason: String) : ParsedFile
    }

    private val FRONTMATTER_OPEN = Regex("^\\uFEFF?---[ \\t]*\\r?\\n")
    private val FRONTMATTER_CLOSE = Regex("^(?:---|\\.\\.\\.)[ \\t]*(?:\\r?\\n|$)", RegexOption.MULTILINE)

    /** Frontmatter split as `parseMarkdownFile`: a leading `---` line, a closing `---` or `...` line, YAML between. */
    fun parseMarkdownFile(text: String): ParsedFile {
        val open = FRONTMATTER_OPEN.find(text) ?: return ParsedFile.Ok(WikiMap(), text)
        val rest = text.substring(open.range.last + 1)
        val close = FRONTMATTER_CLOSE.find(rest) ?: return ParsedFile.Malformed("Frontmatter has no closing --- line")
        return try {
            val data = WikiYaml.parseMapping(rest.substring(0, close.range.first))
            ParsedFile.Ok(data, rest.substring(close.range.last + 1))
        } catch (error: WikiYaml.ParseError) {
            ParsedFile.Malformed("Frontmatter is not valid YAML: ${error.message}")
        }
    }

    data class PageMeta(
        val id: String?,
        val title: String?,
        val type: String?,
        val order: Double?,
        val fields: List<WikiField>,
    )

    private val RESERVED = setOf("id", "title", "type", "order")

    private fun scalarString(value: WikiValue?): String? = when (value) {
        is WikiValue.Str -> value.value.trim().takeIf { it.isNotEmpty() }
        is WikiValue.Num -> if (value.value.isFinite()) WikiValue.formatNumber(value.value) else null
        else -> null
    }

    /** `readPageMeta`: reserved keys out, a legacy `trackerStatus` block flattened in (top-level keys win). */
    fun readPageMeta(data: WikiMap): PageMeta {
        val fields = LinkedHashMap<String, WikiValue>()
        var type = scalarString(data["type"])
        val block = data["trackerStatus"]
        if (block is WikiValue.Obj) {
            if (type == null) type = scalarString(block.map["type"])
            for (key in block.map.keys.sorted()) {
                if (key != "type" && key !in RESERVED) fields[key] = block.map.getValue(key)
            }
        }
        for (field in data.fields) {
            if (field.name !in RESERVED && field.name != "trackerStatus") fields[field.name] = field.value
        }
        val order = (data["order"] as? WikiValue.Num)?.value?.takeIf { it.isFinite() }
        return PageMeta(
            id = scalarString(data["id"]),
            title = scalarString(data["title"]),
            type = type,
            order = order,
            fields = fields.map { (name, value) -> WikiField(name, value) },
        )
    }

    // endregion

    // region Links

    data class Link(
        val text: String,
        /** Decoded relative path, fragment removed. */
        val path: String,
        val fragment: String,
        val id: String?,
        val isPageLink: Boolean,
    )

    private val LINK = Regex(
        """(!?)\[((?:[^\[\]\\\n]|\\.)*)\]\([ \t]*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)(?:[ \t]+"((?:[^"\\\n]|\\.)*)")?[ \t]*\)"""
    )
    private val INLINE_CODE = Regex("""(`+)[^`\n][\s\S]*?\1""")
    private val FENCE = Regex("^ {0,3}(`{3,}|~{3,})")
    private val ID_TITLE = Regex("^id=([A-Za-z0-9_-]+)$")
    private val SCHEME = Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE)

    /** Fenced code blocks and inline code spans: links inside them are not links. */
    private fun excludedRanges(body: String): List<IntRange> {
        val ranges = mutableListOf<IntRange>()
        var offset = 0
        var openStart = -1
        var openMarker = ""
        for (line in body.split("\n")) {
            val lineEnd = offset + line.length
            val fence = FENCE.find(line)?.groupValues?.get(1)
            if (openStart < 0 && fence != null) {
                openStart = offset
                openMarker = fence
            } else if (openStart >= 0 && fence != null && fence[0] == openMarker[0] &&
                fence.length >= openMarker.length && line.trim(' ', '\t') == fence
            ) {
                ranges += openStart until lineEnd
                openStart = -1
            }
            offset = lineEnd + 1
        }
        if (openStart >= 0) ranges += openStart until body.length
        for (match in INLINE_CODE.findAll(body)) {
            val at = match.range.first
            if (ranges.none { at in it }) ranges += match.range
        }
        return ranges
    }

    /** Parses one link destination and title as `findLinks` does. */
    fun link(text: String, destination: String, title: String?): Link {
        var dest = destination
        if (dest.length >= 2 && dest.startsWith("<") && dest.endsWith(">")) dest = dest.substring(1, dest.length - 1)
        val hash = dest.indexOf('#')
        val fragment = if (hash >= 0) dest.substring(hash) else ""
        val pathPart = if (hash >= 0) dest.substring(0, hash) else dest
        val id = title?.let { ID_TITLE.find(it)?.groupValues?.get(1) }
        val isRelative = pathPart.isNotEmpty() && !SCHEME.containsMatchIn(pathPart) && !pathPart.startsWith("/")
        val looksLikePage = isRelative && (pathPart.lowercase().endsWith(".md") || pathPart.endsWith("/"))
        return Link(
            text = text,
            path = percentDecode(pathPart) ?: pathPart,
            fragment = fragment,
            id = id,
            isPageLink = looksLikePage || (id != null && (isRelative || pathPart.isEmpty())),
        )
    }

    fun findLinks(body: String): List<Link> {
        val excluded = excludedRanges(body)
        return LINK.findAll(body).mapNotNull { match ->
            val start = match.range.first
            if (match.groupValues[1] == "!") return@mapNotNull null
            if (excluded.any { start in it }) return@mapNotNull null
            link(match.groupValues[2], match.groupValues[3], match.groups[4]?.value)
        }.toList()
    }

    /** `%XX` sequences as UTF-8; null when an escape is malformed (as Swift's `removingPercentEncoding`). */
    internal fun percentDecode(text: String): String? {
        if ('%' !in text) return text
        val out = ByteArrayOutputStream()
        var i = 0
        while (i < text.length) {
            if (text[i] == '%') {
                val byte = text.substring(i + 1, minOf(i + 3, text.length)).takeIf { it.length == 2 }?.toIntOrNull(16) ?: return null
                out.write(byte)
                i += 3
            } else {
                // By code point: a surrogate pair encoded half by half would come out as `?`.
                val code = text.codePointAt(i)
                out.write(String(Character.toChars(code)).toByteArray(Charsets.UTF_8))
                i += Character.charCount(code)
            }
        }
        val bytes = out.toByteArray()
        val decoder = Charsets.UTF_8.newDecoder()
        return runCatching { decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString() }.getOrNull()
    }

    /** Wiki-relative target of a link written in a file in [fromDir]; null when it leaves the wiki. */
    fun resolveLinkPath(fromDir: String, linkPath: String): String? {
        val parts = mutableListOf<String>()
        for (part in ((if (fromDir.isEmpty()) "" else "$fromDir/") + linkPath).split('/')) {
            if (part.isEmpty() || part == ".") continue
            if (part == "..") {
                if (parts.isEmpty()) return null
                parts.removeAt(parts.lastIndex)
                continue
            }
            parts += part
        }
        return parts.joinToString("/")
    }

    fun dirname(path: String): String = path.substringBeforeLast('/', missingDelimiterValue = "")

    fun basename(path: String): String = path.substringAfterLast('/')

    fun join(dir: String, name: String): String = if (dir.isEmpty()) name else "$dir/$name"

    // endregion

    // region CSV

    class CsvError : Exception("Malformed CSV")

    /** RFC 4180 as `parseCsv`: CRLF or LF, optional BOM, blank lines are not rows. */
    fun parseCsv(input: String): List<List<String>> {
        val text = input.removePrefix("﻿")
        val rows = mutableListOf<List<String>>()
        var row = mutableListOf<String>()
        val field = StringBuilder()
        var quoted = false
        var atFieldStart = true
        var rowHasContent = false
        var i = 0
        fun endRow() {
            row += field.toString()
            if (rowHasContent) rows += row
            row = mutableListOf()
            field.setLength(0)
            atFieldStart = true
            rowHasContent = false
        }
        while (i < text.length) {
            val ch = text[i]
            if (quoted) {
                if (ch == '"') {
                    if (i + 1 < text.length && text[i + 1] == '"') {
                        field.append('"')
                        i += 2
                        continue
                    }
                    quoted = false
                    i++
                    if (i < text.length && text[i] != ',' && text[i] != '\n' && text[i] != '\r') throw CsvError()
                    continue
                }
                field.append(ch)
                i++
                continue
            }
            if (ch == '"' && atFieldStart) {
                quoted = true
                atFieldStart = false
                rowHasContent = true
                i++
                continue
            }
            if (ch == ',') {
                row += field.toString()
                field.setLength(0)
                atFieldStart = true
                rowHasContent = true
                i++
                continue
            }
            if (ch == '\r' || ch == '\n') {
                endRow()
                i += if (ch == '\r' && i + 1 < text.length && text[i + 1] == '\n') 2 else 1
                continue
            }
            field.append(ch)
            atFieldStart = false
            rowHasContent = true
            i++
        }
        if (quoted) throw CsvError()
        if (rowHasContent) endRow()
        return rows
    }

    fun splitMultiValue(cell: String): List<String> {
        if (cell.isEmpty()) return emptyList()
        val out = mutableListOf<String>()
        val current = StringBuilder()
        var i = 0
        while (i < cell.length) {
            val ch = cell[i]
            when {
                ch == '\\' && i + 1 < cell.length -> {
                    current.append(cell[i + 1])
                    i++
                }
                ch == '\\' -> Unit
                ch == ';' -> {
                    out += current.toString().trim(' ', '\t')
                    current.setLength(0)
                }
                else -> current.append(ch)
            }
            i++
        }
        out += current.toString().trim(' ', '\t')
        return out.filter { it.isNotEmpty() }
    }

    private val DECIMAL = Regex("^[-+]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][-+]?[0-9]+)?$")

    /** `decodeCell`: null for an empty cell. */
    fun decodeCell(cell: String, field: SyncedWikiField?): WikiValue? {
        if (cell.isEmpty()) return null
        fun strings() = WikiValue.Arr(splitMultiValue(cell).map(WikiValue::Str))
        return when (field?.type) {
            "multiselect", "label-ref" -> strings()
            "array" -> if (field.itemType == "object") json(cell) else strings()
            "relationship", "reference" -> if (field.multiValue == true) strings() else WikiValue.Str(cell)
            "object", "citation" -> json(cell)
            "number" -> {
                val trimmed = cell.trim()
                trimmed.takeIf { DECIMAL.matches(it) }?.toDoubleOrNull()?.takeIf { it.isFinite() }
                    ?.let(WikiValue::Num) ?: WikiValue.Str(cell)
            }
            "boolean" -> WikiValue.Bool(cell.trim().lowercase() == "true")
            else -> WikiValue.Str(cell)
        }
    }

    private fun json(cell: String): WikiValue =
        runCatching { WikiValue.fromJson(JsonParser.parseString(cell)) }.getOrElse { WikiValue.Str(cell) }

    // endregion
}
