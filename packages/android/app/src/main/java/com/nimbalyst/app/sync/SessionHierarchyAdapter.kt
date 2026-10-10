package com.nimbalyst.app.sync

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.TypeAdapter
import com.google.gson.TypeAdapterFactory
import com.google.gson.reflect.TypeToken
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonWriter

/** Preserve explicit desktop clears without changing omitted legacy patch fields. */
internal class SessionHierarchyAdapter : TypeAdapterFactory {
    override fun <T> create(gson: Gson, type: TypeToken<T>): TypeAdapter<T>? {
        if (type.rawType != ServerSessionEntry::class.java) return null
        val delegate = gson.getDelegateAdapter(this, type)
        val elements = gson.getAdapter(JsonElement::class.java)
        return object : TypeAdapter<T>() {
            override fun read(reader: JsonReader): T {
                val tree = elements.read(reader)
                val entry = delegate.fromJsonTree(tree)
                if (entry is ServerSessionEntry && tree.isJsonObject) {
                    entry.parentSessionIdPresent = tree.asJsonObject.has("parentSessionId")
                    entry.createdBySessionIdPresent = tree.asJsonObject.has("createdBySessionId")
                }
                return entry
            }

            override fun write(writer: JsonWriter, value: T) {
                val tree = delegate.toJsonTree(value)
                // TypeAdapter.toJsonTree includes nulls even when Gson normally
                // omits them. Retain that omission except for explicit edges.
                if (tree.isJsonObject && !writer.serializeNulls) {
                    tree.asJsonObject.entrySet().removeAll { it.value.isJsonNull }
                }
                if (value is ServerSessionEntry && tree.isJsonObject) {
                    if (value.parentSessionIdPresent && value.parentSessionId == null) {
                        tree.asJsonObject.add("parentSessionId", JsonNull.INSTANCE)
                    }
                    if (value.createdBySessionIdPresent && value.createdBySessionId == null) {
                        tree.asJsonObject.add("createdBySessionId", JsonNull.INSTANCE)
                    }
                }
                val previous = writer.serializeNulls
                try {
                    writer.serializeNulls = true
                    elements.write(writer, tree)
                } finally {
                    writer.serializeNulls = previous
                }
            }
        }
    }
}
