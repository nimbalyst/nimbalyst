package com.nimbalyst.app.pages

import java.net.URI
import java.nio.charset.StandardCharsets

/**
 * Where the team console is served. Production is fixed; tests point it at a
 * fixture origin. Only this origin may load in the Pages WebView's main frame
 * or talk to the native bridge. Mirrors iOS `ConsoleEnvironment`.
 */
class ConsoleEnvironment(origin: String) {
    private val parsed = URI(origin.trimEnd('/'))

    /** `window.location.origin` form: scheme://host[:port], no trailing slash. */
    val originString: String = origin.trimEnd('/')
    val scheme: String = parsed.scheme?.lowercase() ?: "https"
    val host: String = parsed.host?.lowercase() ?: ""
    val port: Int? = parsed.port.takeIf { it != -1 }

    /** True when [url] is on exactly this origin (scheme, host, port). */
    fun isConsoleOrigin(url: String?): Boolean {
        val uri = url?.let { runCatching { URI(it) }.getOrNull() } ?: return false
        return isConsoleOrigin(uri)
    }

    fun isConsoleOrigin(uri: URI): Boolean =
        uri.scheme?.lowercase() == scheme &&
            uri.host?.lowercase() == host &&
            effectivePort(uri.port.takeIf { it != -1 }, uri.scheme) == effectivePort(port, scheme)

    /** The absolute console URL for a route path (`/org/...`, with query and fragment). */
    fun url(path: String): String? = if (path.startsWith("/")) originString + path else null

    private fun effectivePort(port: Int?, scheme: String?): Int =
        port ?: if (scheme?.lowercase() == "http") 80 else 443

    override fun equals(other: Any?): Boolean = other is ConsoleEnvironment && other.originString == originString
    override fun hashCode(): Int = originString.hashCode()
    override fun toString(): String = originString

    companion object {
        val production = ConsoleEnvironment("https://console.nimbalyst.com")
    }
}

/**
 * A console page the Pages screen can show: a path under `/org/<org>/`.
 *
 * The org segment is a route key: today always the Stytch org id
 * (`organization-...`), and possibly a slug in the future. [orgId] is only set
 * when the key is an org id, matching the console's own `orgIdFromConsolePath`.
 */
class ConsoleRoute private constructor(
    /** Path plus query and fragment, percent-encoded as it appears in the URL. */
    val path: String,
    val orgKey: String,
    /** The team project segment, when the path is under `/project/<id>`. */
    val teamProjectId: String?,
) {
    val orgId: String? get() = orgKey.takeIf { it.startsWith("organization-") }
    val isTeamProjectPath: Boolean get() = teamProjectId != null

    override fun equals(other: Any?): Boolean = other is ConsoleRoute && other.path == path
    override fun hashCode(): Int = path.hashCode()
    override fun toString(): String = "ConsoleRoute($path)"

    companion object {
        private fun isOrgKeyChar(c: Char) = c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c == '_' || c == '-'
        private fun isSegmentChar(c: Char) = isOrgKeyChar(c) || c == '.' || c == '~' || c == '%'
        private fun isUnreserved(c: Char) = isOrgKeyChar(c) || c == '.' || c == '~'

        /**
         * Parse a console path (`/org/<org>/...`, optional `?query` and `#fragment`).
         * Rejects traversal, empty segments, control characters and anything that
         * is not under `/org/<key>`.
         */
        fun parse(path: String): ConsoleRoute? {
            if (path.length > 2048 || !path.startsWith("/org/")) return null
            if (path.any { isControl(it) || it == ' ' || it == '\\' }) return null
            val pathOnly = path.substringBefore('?').substringBefore('#')
            // Leading "/" yields an empty first element. Every other segment must
            // be non-empty except a single trailing slash.
            val parts = pathOnly.split('/').drop(1).toMutableList()
            if (parts.lastOrNull() == "") parts.removeAt(parts.lastIndex)
            if (parts.size < 2 || parts[0] != "org" || parts.contains("")) return null
            val orgKey = parts[1]
            if (orgKey.length !in 1..128 || !orgKey.all(::isOrgKeyChar)) return null
            // Judge each segment by what it decodes to: `.%2e` is `..` to the server
            // that normalizes it, and an encoded `/` or `\` splits the path there.
            val decoded = parts.drop(2).map { part ->
                if (part.length > 256 || !part.all(::isSegmentChar)) return null
                val segment = decodeSegment(part) ?: return null
                if (segment == "." || segment == ".." || segment.any { it == '/' || it == '\\' || isControl(it) }) return null
                segment
            }
            val teamProjectId = if (parts.size >= 4 && parts[2] == "project") decoded[1] else null
            return ConsoleRoute(path, orgKey, teamProjectId)
        }

        /** The route for an absolute console URL on [environment]'s origin. */
        fun fromUrl(url: String, environment: ConsoleEnvironment = ConsoleEnvironment.production): ConsoleRoute? {
            val uri = runCatching { URI(url) }.getOrNull() ?: return null
            if (!environment.isConsoleOrigin(uri)) return null
            return parse(fullPath(uri) ?: return null)
        }

        /** The team Wiki home for a project. */
        fun wiki(orgId: String, teamProjectId: String): ConsoleRoute? =
            parse("/org/${encode(orgId)}/project/${encode(teamProjectId)}/wiki")

        /** The team Trackers home for a project. */
        fun trackers(orgId: String, teamProjectId: String): ConsoleRoute? =
            parse("/org/${encode(orgId)}/project/${encode(teamProjectId)}/trackers")

        /**
         * The path a server sees after percent-decoding and removing dot segments
         * (RFC 3986 5.2.4). Classification (`/app`, `/login`, ...) reads this, never
         * the raw path, so `/org/o/.%2e/.%2e/app` is a Personal page, not a team one.
         */
        fun canonicalPath(rawPath: String): String {
            val output = ArrayDeque<String>()
            for (raw in rawPath.split('/').drop(1)) {
                when (val segment = decodeSegment(raw) ?: raw) {
                    "." -> Unit
                    ".." -> output.removeLastOrNull()
                    else -> output.addLast(segment)
                }
            }
            return "/" + output.joinToString("/")
        }

        /** Strict percent-decoding (UTF-8). Null for a malformed escape or invalid UTF-8. */
        private fun decodeSegment(raw: String): String? {
            if ('%' !in raw) return raw
            val bytes = java.io.ByteArrayOutputStream()
            var i = 0
            while (i < raw.length) {
                val c = raw[i]
                if (c == '%') {
                    if (i + 2 > raw.lastIndex) return null
                    val hex = raw.substring(i + 1, i + 3).toIntOrNull(16) ?: return null
                    bytes.write(hex)
                    i += 3
                } else {
                    bytes.write(c.toString().toByteArray(StandardCharsets.UTF_8))
                    i += 1
                }
            }
            val decoder = StandardCharsets.UTF_8.newDecoder()
            return runCatching { decoder.decode(java.nio.ByteBuffer.wrap(bytes.toByteArray())).toString() }.getOrNull()
        }

        /** Raw path plus `?query` and `#fragment`, as they appear in the URL. */
        internal fun fullPath(uri: URI): String? {
            val path = uri.rawPath ?: return null
            return buildString {
                append(path)
                uri.rawQuery?.let { append('?').append(it) }
                uri.rawFragment?.let { append('#').append(it) }
            }
        }

        private fun isControl(c: Char): Boolean {
            val type = Character.getType(c)
            return type == Character.CONTROL.toInt() || type == Character.FORMAT.toInt()
        }

        private fun encode(segment: String): String = buildString {
            for (byte in segment.toByteArray(StandardCharsets.UTF_8)) {
                val c = (byte.toInt() and 0xFF).toChar()
                if (byte >= 0 && isUnreserved(c)) append(c) else append('%').append("%02X".format(byte.toInt() and 0xFF))
            }
        }
    }
}
