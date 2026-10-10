package com.nimbalyst.app.wiki

import com.google.gson.JsonElement
import kotlin.math.abs

/**
 * A frontmatter, sidecar or table cell value as the local wiki library reads it
 * (YAML core schema, or a decoded CSV cell). Numbers are always doubles, as in
 * JavaScript, so values compare equal to the shared fixtures' JSON.
 * Mirrors iOS `WikiValue`.
 */
sealed interface WikiValue {
    data object Null : WikiValue
    data class Bool(val value: Boolean) : WikiValue
    data class Num(val value: Double) : WikiValue
    data class Str(val value: String) : WikiValue
    data class Arr(val items: List<WikiValue>) : WikiValue
    data class Obj(val map: Map<String, WikiValue>) : WikiValue

    /** Short read-only rendering for field rows and table cells. */
    val displayText: String
        get() = when (this) {
            Null -> ""
            is Bool -> if (value) "Yes" else "No"
            is Num -> formatNumber(value)
            is Str -> value
            is Arr -> items.joinToString(", ") { it.displayText }
            is Obj -> map.keys.sorted().joinToString(", ") { "$it: ${map.getValue(it).displayText}" }
        }

    companion object {
        /** `String(n)` in JavaScript: integers without a decimal point. */
        fun formatNumber(value: Double): String =
            if (value.isFinite() && value == Math.rint(value) && abs(value) < 1e15) value.toLong().toString() else value.toString()

        fun fromJson(json: JsonElement?): WikiValue = when {
            json == null || json.isJsonNull -> Null
            json.isJsonArray -> Arr(json.asJsonArray.map(::fromJson))
            json.isJsonObject -> Obj(json.asJsonObject.entrySet().associate { (key, value) -> key to fromJson(value) })
            else -> {
                val primitive = json.asJsonPrimitive
                when {
                    primitive.isBoolean -> Bool(primitive.asBoolean)
                    primitive.isNumber -> Num(primitive.asDouble)
                    else -> Str(primitive.asString)
                }
            }
        }
    }
}

/** A named value, kept in the order the file wrote it. */
data class WikiField(val name: String, val value: WikiValue)

/** A YAML mapping with its key order. */
class WikiMap {
    private val entries = LinkedHashMap<String, WikiValue>()

    val keys: List<String> get() = entries.keys.toList()

    operator fun get(key: String): WikiValue? = entries[key]

    /** False when the key was already present (YAML forbids duplicate keys). */
    fun set(key: String, value: WikiValue): Boolean {
        if (key in entries) return false
        entries[key] = value
        return true
    }

    val fields: List<WikiField> get() = entries.map { (name, value) -> WikiField(name, value) }
    val asValue: WikiValue get() = WikiValue.Obj(LinkedHashMap(entries))
}
