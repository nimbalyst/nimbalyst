package com.nimbalyst.app.wiki

import com.google.gson.JsonArray
import com.google.gson.JsonParser
import com.nimbalyst.app.sync.SyncedWikiField
import com.nimbalyst.app.sync.SyncedWikiType

data class WikiPage(
    val id: String,
    val title: String,
    /** Tracker type of a typed page; null for a plain page. */
    val type: String?,
    val order: Double?,
    val fields: List<WikiField>,
    /** `markdown`, or an editor page's document type (`csv`, `excalidraw`, ...). */
    val documentType: String,
    /** Wiki-relative path of the page file; null for a bare folder. */
    val path: String?,
    /** Wiki-relative path of the child folder (it may not exist). */
    val dir: String,
    val parentId: String?,
    val malformed: Boolean,
    /** Id of the page this is a sync conflict copy of, when that page is a sibling. */
    val conflictOf: String? = null,
    internal val stem: String,
    internal val parentDir: String,
    internal val isSidecarPage: Boolean = false,
    internal val links: List<WikiFormat.Link> = emptyList(),
    internal val linkTargets: List<String?> = emptyList(),
) {
    internal val isConflictCopy: Boolean
        get() = WikiFormat.isConflictCopyStem(
            if (isSidecarPage) stem else WikiFormat.basename(path ?: dir).replace(MD_SUFFIX, "")
        )

    private companion object {
        val MD_SUFFIX = Regex("\\.md$", RegexOption.IGNORE_CASE)
    }
}

data class WikiRow(
    val id: String,
    val title: String,
    /** Non-empty cells, in column order. */
    val fields: List<WikiField>,
)

data class WikiTable(
    val typeId: String,
    val title: String,
    val path: String,
    val parentId: String?,
    val header: List<String>,
    val rows: List<WikiRow>,
    val malformed: Boolean,
    internal val parentDir: String,
)

sealed interface WikiNode {
    val id: String
    val title: String

    data class Page(val page: WikiPage, val children: List<WikiNode>) : WikiNode {
        override val id get() = page.id
        override val title get() = page.title
    }

    data class Table(val table: WikiTable) : WikiNode {
        override val id get() = "table:${table.typeId}"
        override val title get() = table.title
    }
}

class WikiSnapshot internal constructor(
    /** From the marker file; null when it has not synced. */
    val formatVersion: Int?,
    /** The marker file synced but could not be read, or its `formatVersion` is not a whole number. */
    val markerUnreadable: Boolean,
    val pages: Map<String, WikiPage>,
    val tables: List<WikiTable>,
    val tree: List<WikiNode>,
    val trashIds: Set<String>,
    val types: Map<String, SyncedWikiType>,
    private val byFile: Map<String, String>,
    private val byDir: Map<String, String>,
) {
    /**
     * True when the wiki was written by a newer format than this app reads, or
     * its marker is unreadable. Its pages are then read-only from every entry point.
     */
    val isUnsupportedVersion: Boolean
        get() = markerUnreadable || (formatVersion ?: WikiFormat.SUPPORTED_FORMAT_VERSION) > WikiFormat.SUPPORTED_FORMAT_VERSION

    fun pageAtPath(path: String): WikiPage? = byFile[WikiFormat.nameKey(path)]?.let(pages::get)

    fun tableAtPath(path: String): WikiTable? = tables.firstOrNull { WikiFormat.nameKey(it.path) == WikiFormat.nameKey(path) }

    /**
     * Target of a link as written in [page]: by `id=` title first, then by
     * relative path. Null for web links, links out of the wiki, and missing pages.
     */
    fun resolveLink(page: WikiPage, destination: String, title: String?): String? {
        val link = WikiFormat.link("", destination, title)
        if (!link.isPageLink) return null
        val base = page.path?.let(WikiFormat::dirname) ?: page.dir
        link.id?.let { if (it in pages) return it }
        val target = WikiFormat.resolveLinkPath(base, link.path) ?: return null
        val key = WikiFormat.nameKey(target)
        if (link.path.endsWith("/")) return byDir[key]
        return byFile[key] ?: byDir[key]
    }

    /** Resolved targets for every page link, in body order. */
    fun linkTargets(pageId: String): List<String?> = pages[pageId]?.linkTargets ?: emptyList()

    fun typeName(typeId: String): String = types[typeId]?.displayName ?: typeId
}

/**
 * Wiki type definitions from `ProjectEntity.localWikiTypesJson`, read field by
 * field so a malformed or partial entry is skipped instead of producing a
 * half-null object (Gson would bypass the Kotlin defaults).
 */
object WikiTypes {
    fun parse(json: String?): List<SyncedWikiType> {
        if (json.isNullOrBlank()) return emptyList()
        val array = runCatching { JsonParser.parseString(json) }.getOrNull()?.takeIf { it.isJsonArray }?.asJsonArray
            ?: return emptyList()
        return parse(array)
    }

    fun parse(array: JsonArray): List<SyncedWikiType> = array.mapNotNull { element ->
        val obj = element.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
        val typeId = obj.string("typeId") ?: return@mapNotNull null
        SyncedWikiType(
            typeId = typeId,
            displayName = obj.string("displayName") ?: typeId,
            displayNamePlural = obj.string("displayNamePlural") ?: obj.string("displayName") ?: typeId,
            storage = obj.string("storage") ?: "pages",
            titleField = obj.string("titleField") ?: "title",
            fields = obj.get("fields")?.takeIf { it.isJsonArray }?.asJsonArray?.mapNotNull { field ->
                val f = field.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
                SyncedWikiField(
                    name = f.string("name") ?: return@mapNotNull null,
                    type = f.string("type") ?: "string",
                    itemType = f.string("itemType"),
                    multiValue = f.get("multiValue")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean,
                )
            } ?: emptyList(),
        )
    }

    private fun com.google.gson.JsonObject.string(key: String): String? =
        get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
}
