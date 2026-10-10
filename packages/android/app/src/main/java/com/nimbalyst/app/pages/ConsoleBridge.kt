package com.nimbalyst.app.pages

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.URI

/** The JS object name the console posts to. Sent in the embed marker. */
const val CONSOLE_BRIDGE_NAME = "nimbalystConsole"

/** Outcome of the console's `flushPending`. */
data class ConsoleFlushResult(val status: Status, val detail: String? = null) {
    enum class Status(val raw: String) {
        ACKNOWLEDGED("acknowledged"),
        NOT_REQUIRED("not-required"),
        TIMED_OUT("timed-out"),
        FAILED("failed");

        companion object {
            fun from(raw: String?): Status? = entries.firstOrNull { it.raw == raw }
        }
    }
}

/**
 * Console -> native messages (`web-console/src/embedded/bridge.ts`). Tokens
 * never travel in this direction; anything malformed is dropped.
 */
sealed interface ConsoleBridgeMessage {
    /** Posted by native's own document-start script: the per-document nonce a session delivery must match. */
    data class DocumentStart(val nonce: String) : ConsoleBridgeMessage
    data class Ready(val protocolVersion: Int) : ConsoleBridgeMessage
    data class Route(val path: String, val title: String, val canGoBack: Boolean) : ConsoleBridgeMessage
    data class EditState(val editing: Boolean, val unsynced: Boolean) : ConsoleBridgeMessage
    data class RequestSession(val requestId: String, val orgId: String) : ConsoleBridgeMessage
    data class SessionExpired(val requestId: String, val orgId: String?) : ConsoleBridgeMessage
    data class OrgAuthRequired(val orgId: String, val reason: String?) : ConsoleBridgeMessage
    data class OpenExternal(val url: String) : ConsoleBridgeMessage
    data class OpenPersonal(val path: String) : ConsoleBridgeMessage
    data class FlushResult(val requestId: String, val result: ConsoleFlushResult) : ConsoleBridgeMessage

    companion object {
        private val NONCE = Regex("^[0-9a-f]{32}$")

        fun parse(body: String?): ConsoleBridgeMessage? {
            if (body == null || body.length > 64 * 1024) return null
            val record = runCatching { JsonParser.parseString(body) }.getOrNull()?.takeIf { it.isJsonObject }?.asJsonObject
                ?: return null
            fun string(key: String, max: Int = 2048): String? =
                record.stringOrNull(key)?.takeIf { it.isNotEmpty() && it.length <= max }
            fun bool(key: String): Boolean =
                record.get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean ?: false

            return when (record.stringOrNull("type")) {
                "documentStart" -> string("nonce", max = 64)?.takeIf { NONCE.matches(it) }?.let(::DocumentStart)
                "ready" -> Ready(record.get("protocol")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asInt ?: 0)
                "route" -> string("path")?.let { path ->
                    Route(path, record.stringOrNull("title")?.take(256).orEmpty(), bool("canGoBack"))
                }
                "editState" -> EditState(bool("editing"), bool("unsynced"))
                "requestSession" -> {
                    val requestId = string("requestId", 128) ?: return null
                    val orgId = string("orgId", 128) ?: return null
                    RequestSession(requestId, orgId)
                }
                "sessionExpired" -> string("requestId", 128)?.let { SessionExpired(it, string("orgId", 128)) }
                "orgAuthRequired" -> string("orgId", 128)?.let { OrgAuthRequired(it, string("reason", 128)) }
                "openExternal" -> string("url")?.takeIf { runCatching { URI(it) }.isSuccess }?.let(::OpenExternal)
                "openPersonal" -> string("path")?.let(::OpenPersonal)
                "flushResult" -> string("requestId", 128)?.let { requestId ->
                    val status = ConsoleFlushResult.Status.from(record.stringOrNull("status"))
                    FlushResult(
                        requestId,
                        if (status == null) ConsoleFlushResult(ConsoleFlushResult.Status.FAILED, "malformed-flush-result")
                        else ConsoleFlushResult(status, record.stringOrNull("detail")),
                    )
                }
                else -> null
            }
        }

        /**
         * The only door into [parse] from the WebView: main frame, console origin.
         * `addWebMessageListener` reports both for every post.
         */
        fun accept(body: String?, sourceOrigin: String?, isMainFrame: Boolean, environment: ConsoleEnvironment): ConsoleBridgeMessage? {
            if (!isMainFrame) return null
            if (!environment.isConsoleOrigin(sourceOrigin)) return null
            return parse(body)
        }
    }
}

internal fun JsonObject.stringOrNull(key: String): String? =
    get(key)?.takeIf(JsonElement::isJsonPrimitive)?.asJsonPrimitive?.takeIf { it.isString }?.asString

/**
 * The scripts native runs in the console. Every value is a JSON literal built by
 * [jsString], never spliced in raw, and every script that hands something to
 * the page first checks it is still on the console origin.
 */
object ConsoleScripts {
    /**
     * Document-start marker. Runs only in the top frame on the console origin, so a
     * page elsewhere never sees the bridge name. A fresh random nonce per document
     * is fixed on `window` before any console code runs and announced to native
     * first; a session delivery checks it in-page.
     */
    fun embedMarker(environment: ConsoleEnvironment, appVersion: String): String = """
        (function () {
          if (window.top !== window) return;
          if (window.location.origin !== ${jsString(environment.originString)}) return;
          var bridge = window[${jsString(CONSOLE_BRIDGE_NAME)}];
          if (!bridge || typeof bridge.postMessage !== 'function') return;
          var bytes = new Uint8Array(16);
          window.crypto.getRandomValues(bytes);
          var nonce = Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
          Object.defineProperty(window, '__nimbalystDocumentNonce', { value: nonce, configurable: false, writable: false });
          Object.defineProperty(window, '__NIMBALYST_EMBED__', {
            value: Object.freeze({ platform: 'android', appVersion: ${jsString(appVersion.take(64))}, bridge: ${jsString(CONSOLE_BRIDGE_NAME)} }),
            configurable: false, writable: false
          });
          bridge.postMessage(JSON.stringify({ type: 'documentStart', nonce: nonce }));
        })();
    """.trimIndent()

    /**
     * `evaluateJavascript` runs in whatever main-frame document is current when it
     * executes, so the script itself checks it is still the console origin and the
     * very document that asked. Returns `'wrong-document'`, `true` or `false`.
     */
    fun deliverSession(payload: Map<String, String>, environment: ConsoleEnvironment, documentNonce: String): String = """
        (function () {
          if (window.location.origin !== ${jsString(environment.originString)} || window.__nimbalystDocumentNonce !== ${jsString(documentNonce)}) return 'wrong-document';
          var b = window.__nimbalystConsoleBridge;
          return b ? b.deliverSession(${jsObject(payload)}) === true : false;
        })();
    """.trimIndent()

    /** Starts a flush; the answer comes back as a `flushResult` message with [requestId]. */
    fun flushPending(timeoutMs: Int, requestId: String, environment: ConsoleEnvironment): String = """
        (function () {
          if (window.location.origin !== ${jsString(environment.originString)}) return 'wrong-document';
          var b = window.__nimbalystConsoleBridge;
          if (!b) return null;
          Promise.resolve(b.flushPending($timeoutMs, ${jsString(requestId)})).catch(function () {});
          return 'started';
        })();
    """.trimIndent()

    /** After "Leave without saving": returns the number of edits dropped, or null with no bridge. */
    fun discardUnsynced(environment: ConsoleEnvironment): String = """
        (function () {
          if (window.location.origin !== ${jsString(environment.originString)}) return null;
          var b = window.__nimbalystConsoleBridge;
          return b && b.discardUnsynced ? b.discardUnsynced() : null;
        })();
    """.trimIndent()

    /** A JSON string literal, safe inside a script: quotes, backslashes, controls, line separators and `<` escaped. */
    fun jsString(value: String): String = buildString(value.length + 2) {
        append('"')
        for (c in value) {
            when {
                c == '"' -> append("\\\"")
                c == '\\' -> append("\\\\")
                c < ' ' || c == ' ' || c == ' ' || c == '<' || c == '>' || c.code == 0x7F ->
                    append("\\u").append("%04x".format(c.code))
                else -> append(c)
            }
        }
        append('"')
    }

    fun jsObject(values: Map<String, String>): String =
        values.entries.joinToString(prefix = "{", postfix = "}", separator = ",") { (key, value) -> "${jsString(key)}:${jsString(value)}" }

    /** What `evaluateJavascript` handed back: the JSON encoding of the script's value. */
    fun decodeResult(raw: String?): Any? {
        if (raw == null || raw == "null" || raw.isEmpty()) return null
        val element = runCatching { JsonParser.parseString(raw) }.getOrNull() ?: return null
        if (!element.isJsonPrimitive) return null
        val primitive = element.asJsonPrimitive
        return when {
            primitive.isBoolean -> primitive.asBoolean
            primitive.isNumber -> primitive.asDouble
            primitive.isString -> primitive.asString
            else -> null
        }
    }
}
