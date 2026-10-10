package com.nimbalyst.app.wiki

import com.google.gson.JsonParser
import com.nimbalyst.app.sync.SyncedWikiType
import java.io.File
import java.text.Collator
import java.util.Locale

data class WikiDirEntry(val name: String, val isDirectory: Boolean)

/** The files of one wiki, by wiki-relative path (`/`-separated, `""` = root). */
interface WikiFileSource {
    /** Entries directly inside [dir]; null when it is not a folder. */
    fun entries(dir: String): List<WikiDirEntry>?
    fun readText(path: String): String?
}

/**
 * Reads a wiki folder the way the library's `scanWiki` does with repair off,
 * and arranges it as a tree. Never writes; ids the library would add on its
 * next write scan read as `tmp_` ids, as they do for `nim` with repair off.
 * Ported from iOS `LocalWikiReader`.
 */
object LocalWikiReader {
    fun read(source: WikiFileSource, types: List<SyncedWikiType>): WikiSnapshot {
        val byType = LinkedHashMap<String, SyncedWikiType>()
        for (type in types) byType.putIfAbsent(type.typeId, type)
        val scan = Scan(source, byType)
        scan.walk("", null)
        scan.readTrash()
        scan.resolveLinks()

        val markerText = source.readText(WikiFormat.MARKER_FILE)
        val marker = markerText?.let { runCatching { WikiYaml.parseMapping(it) }.getOrNull() }
        val formatVersion = formatVersion(marker?.get("formatVersion"))
        val tableOrders = mutableMapOf<String, Double>()
        (marker?.get("tables") as? WikiValue.Obj)?.map?.forEach { (typeId, entry) ->
            ((entry as? WikiValue.Obj)?.map?.get("order") as? WikiValue.Num)?.let { tableOrders[typeId] = it.value }
        }
        return WikiSnapshot(
            formatVersion = formatVersion,
            // A marker that has synced but could not be read, or names no usable version, is not a
            // wiki this app can trust to edit. Presence comes from the listing, not the read, so a
            // marker whose content failed to decrypt still locks the wiki.
            markerUnreadable = (markerText != null || markerListed(source)) && formatVersion == null,
            pages = scan.pages.toMap(),
            tables = scan.tables.toList(),
            tree = buildTree(scan, tableOrders),
            trashIds = scan.trash.toSet(),
            types = byType,
            byFile = scan.byFile.toMap(),
            byDir = scan.byDir.toMap(),
        )
    }

    private fun markerListed(source: WikiFileSource): Boolean =
        source.entries("")?.any { !it.isDirectory && it.name == WikiFormat.MARKER_FILE } == true

    /** A whole number from 1 up; `.inf`, `.nan`, fractions and strings are not versions. */
    internal fun formatVersion(value: WikiValue?): Int? {
        val number = (value as? WikiValue.Num)?.value ?: return null
        if (!number.isFinite() || number != Math.rint(number) || number < 1 || number > Int.MAX_VALUE) return null
        return number.toInt()
    }

    // region Tree

    private class Entry(val order: Double?, val title: String, val index: Int, val node: () -> WikiNode)

    private val collator: Collator = Collator.getInstance(Locale.ENGLISH).apply { strength = Collator.PRIMARY }

    /**
     * Siblings: explicit `order` first, then unordered by title. Equal orders
     * fall back to the title, as the fixtures' generator does.
     */
    private val siblingOrder = Comparator<Entry> { a, b ->
        val x = a.order
        val y = b.order
        when {
            x != null && y != null && x != y -> x.compareTo(y)
            x != null && y == null -> -1
            x == null && y != null -> 1
            else -> collator.compare(a.title, b.title).takeIf { it != 0 } ?: a.index.compareTo(b.index)
        }
    }

    private fun buildTree(scan: Scan, tableOrders: Map<String, Double>): List<WikiNode> {
        fun build(parentId: String?, parentDir: String): List<WikiNode> {
            val siblings = scan.pageOrder.mapNotNull(scan.pages::get).filter { it.parentId == parentId }
            val entries = siblings.mapIndexed { offset, original ->
                var page = original
                if (page.path != null && WikiFormat.isConflictCopyStem(page.stem)) {
                    val key = WikiFormat.nameKey(WikiFormat.conflictOriginalStem(page.stem))
                    page = page.copy(conflictOf = siblings.firstOrNull { it.id != page.id && WikiFormat.nameKey(it.stem) == key }?.id)
                }
                val built = page
                Entry(built.order, built.title, offset) { WikiNode.Page(built, build(built.id, built.dir)) }
            }.toMutableList()
            for (table in scan.tables) {
                if (WikiFormat.nameKey(table.parentDir) == WikiFormat.nameKey(parentDir)) {
                    entries += Entry(tableOrders[table.typeId], table.typeId, entries.size) { WikiNode.Table(table) }
                }
            }
            return entries.sortedWith(siblingOrder).map { it.node() }
        }
        return build(null, "")
    }

    // endregion

    // region Scan

    private class Scan(val source: WikiFileSource, val types: Map<String, SyncedWikiType>) {
        val pages = HashMap<String, WikiPage>()
        /** Insertion order of [pages], with the JavaScript Map's delete-then-set semantics. */
        val pageOrder = mutableListOf<String>()
        val byFile = HashMap<String, String>()
        val byDir = HashMap<String, String>()
        val tables = mutableListOf<WikiTable>()
        val trash = mutableSetOf<String>()
        private val tableNames = HashMap<String, String>()

        init {
            for (def in types.values.sortedBy { it.typeId }) {
                if (def.storage != "table") continue
                tableNames[WikiFormat.nameKey(WikiFormat.fileStemForTitle(def.displayNamePlural))] = def.typeId
                tableNames.putIfAbsent(WikiFormat.nameKey(def.typeId), def.typeId)
            }
        }

        private fun setPage(page: WikiPage) {
            if (page.id !in pages) pageOrder += page.id
            pages[page.id] = page
            page.path?.let { byFile[WikiFormat.nameKey(it)] = page.id }
            byDir[WikiFormat.nameKey(page.dir)] = page.id
        }

        private fun removePage(id: String) {
            pages.remove(id)
            pageOrder.remove(id)
        }

        /**
         * A later file with an existing id reads under a path-derived id; a sync
         * conflict copy never keeps the id of the file it diverged from.
         */
        fun addPage(incoming: WikiPage) {
            var page = incoming
            val existing = pages[page.id]
            if (existing != null) {
                if (existing.isConflictCopy && !page.isConflictCopy) {
                    val rekeyed = existing.copy(id = WikiFormat.derivedId("dup", existing.path ?: existing.dir))
                    removePage(existing.id)
                    setPage(rekeyed)
                    for (id in pageOrder.toList()) {
                        val child = pages[id] ?: continue
                        if (child.parentId == existing.id) pages[id] = child.copy(parentId = rekeyed.id)
                    }
                } else {
                    page = page.copy(id = WikiFormat.derivedId("dup", page.path ?: page.dir))
                }
            }
            setPage(page)
        }

        fun basePage(id: String, stem: String, path: String?, dir: String, parent: WikiPage?, parentDir: String) = WikiPage(
            id = id, title = stem, type = null, order = null, fields = emptyList(), documentType = "markdown",
            path = path, dir = dir, parentId = parent?.id, malformed = false, stem = stem, parentDir = parentDir,
        )

        fun loadFilePage(rel: String, stem: String, dir: String, parent: WikiPage?, parentDir: String): WikiPage? {
            val text = source.readText(rel) ?: return null
            val page = basePage("", stem, rel, dir, parent, parentDir)
            return when (val parsed = WikiFormat.parseMarkdownFile(text)) {
                is WikiFormat.ParsedFile.Malformed -> page.copy(id = WikiFormat.derivedId("bad", rel), malformed = true)
                is WikiFormat.ParsedFile.Ok -> {
                    val meta = WikiFormat.readPageMeta(parsed.data)
                    if (meta.id != null && !WikiFormat.isSafeId(meta.id)) {
                        return page.copy(id = WikiFormat.derivedId("bad", rel), malformed = true)
                    }
                    page.copy(
                        id = meta.id ?: WikiFormat.derivedId("tmp", rel),
                        title = WikiFormat.titleForStem(stem, meta.title),
                        type = meta.type,
                        fields = meta.fields,
                        order = meta.order,
                        links = WikiFormat.findLinks(parsed.body).filter { it.isPageLink },
                    )
                }
            }
        }

        fun loadEditorPage(
            rel: String, stem: String, suffix: String, dir: String, hasSidecar: Boolean, parent: WikiPage?, parentDir: String,
        ): WikiPage? {
            source.readText(rel) ?: return null
            val sidecarRel = WikiFormat.join(parentDir, "." + WikiFormat.basename(rel) + WikiFormat.SIDECAR_SUFFIX)
            var data = WikiMap()
            var sidecarError = false
            if (hasSidecar) {
                source.readText(sidecarRel)?.let { text ->
                    runCatching { WikiYaml.parseMapping(text) }.onSuccess { data = it }.onFailure { sidecarError = true }
                }
            }
            val recorded = (data["documentType"] as? WikiValue.Str)?.value?.trim()?.takeIf { it.isNotEmpty() }
            val metaData = WikiMap()
            for (field in data.fields) if (field.name != "documentType") metaData.set(field.name, field.value)
            val meta = WikiFormat.readPageMeta(metaData)
            val base = basePage("", stem, rel, dir, parent, parentDir).copy(
                isSidecarPage = true,
                documentType = WikiFormat.editorTypes[suffix] ?: recorded ?: suffix.drop(1),
                title = WikiFormat.titleForStem(stem, meta.title),
                order = meta.order,
            )
            return when {
                sidecarError || (meta.id != null && !WikiFormat.isSafeId(meta.id)) ->
                    base.copy(id = WikiFormat.derivedId("bad", rel), malformed = true)
                // An editor page is a plain page: a `type` key in its sidecar is kept but not read.
                else -> base.copy(id = meta.id ?: WikiFormat.derivedId("tmp", rel), fields = meta.fields.filter { it.name != "type" })
            }
        }

        private fun editorSuffix(name: String): String? {
            val lower = name.lowercase()
            return WikiFormat.editorTypes.keys
                .filter { lower.length > it.length && lower.endsWith(it) }
                .maxByOrNull { it.length }
        }

        fun walk(dirRel: String, parent: WikiPage?) {
            val all = source.entries(dirRel) ?: return
            val sidecarTargets = all
                .filter { !it.isDirectory && it.name.startsWith(".") && it.name.length > 1 + WikiFormat.SIDECAR_SUFFIX.length && it.name.endsWith(WikiFormat.SIDECAR_SUFFIX) }
                .map { it.name.substring(1, it.name.length - WikiFormat.SIDECAR_SUFFIX.length) }
                .toSet()
            // String.compareTo orders by UTF-16 code unit, as JavaScript's sort does.
            val entries = all.filter { !it.name.startsWith(".") && it.name != "node_modules" }.sortedBy { it.name }
            val dirs = entries.filter { it.isDirectory }.map { it.name }
            val consumedDirs = mutableSetOf<String>()
            val readmeName = parent?.path?.takeIf { parent.dir == dirRel && WikiFormat.dirname(it) == dirRel }?.let(WikiFormat::basename)
            val pagesHere = mutableListOf<WikiPage>()

            fun childDir(stem: String): String? =
                dirs.firstOrNull { it == stem }
                    ?: dirs.firstOrNull { it !in consumedDirs && WikiFormat.nameKey(it) == WikiFormat.nameKey(stem) }

            for (entry in entries) {
                if (entry.isDirectory) continue
                val lower = entry.name.lowercase()
                if (lower.endsWith(".csv")) {
                    val typeId = tableNames[WikiFormat.nameKey(entry.name.dropLast(4))]
                    if (typeId != null) {
                        loadTable(WikiFormat.join(dirRel, entry.name), typeId, dirRel)
                        continue
                    }
                }
                if (entry.name == readmeName) continue
                val hasSidecar = entry.name in sidecarTargets
                var suffix = editorSuffix(entry.name)
                if (suffix == null && hasSidecar && !lower.endsWith(".md")) {
                    val dot = lower.lastIndexOf('.')
                    if (dot > 0) suffix = lower.substring(dot)
                }
                if (suffix != null) {
                    val stem = entry.name.dropLast(suffix.length)
                    if (stem.isEmpty()) continue
                    val child = childDir(stem)?.also { consumedDirs += it }
                    loadEditorPage(
                        WikiFormat.join(dirRel, entry.name), stem, suffix, WikiFormat.join(dirRel, child ?: stem),
                        hasSidecar, parent, dirRel,
                    )?.let { pagesHere += it }
                    continue
                }
                if (!lower.endsWith(".md")) continue
                val stem = entry.name.dropLast(3)
                val child = childDir(stem)?.also { consumedDirs += it }
                loadFilePage(WikiFormat.join(dirRel, entry.name), stem, WikiFormat.join(dirRel, child ?: stem), parent, dirRel)
                    ?.let { pagesHere += it }
            }
            for (name in dirs) {
                if (name in consumedDirs) continue
                val dir = WikiFormat.join(dirRel, name)
                val inner = (source.entries(dir) ?: emptyList()).map { it.name }.sorted()
                val readme = inner.firstOrNull { it.lowercase() == "readme.md" } ?: inner.firstOrNull { it.lowercase() == "index.md" }
                val page = readme?.let { loadFilePage(WikiFormat.join(dir, it), name, dir, parent, dirRel) }
                    ?: basePage(WikiFormat.derivedId("dir", dir), name, null, dir, parent, dirRel)
                pagesHere += page
            }
            // Every page in the folder is registered before any child folder is walked.
            pagesHere.forEach(::addPage)
            for (page in pagesHere) {
                if (dirs.none { WikiFormat.join(dirRel, it) == page.dir }) continue
                // Re-read by folder: a conflict copy added first may have been re-keyed since.
                val current = byDir[WikiFormat.nameKey(page.dir)]?.let(pages::get) ?: page
                walk(current.dir, current)
            }
        }

        fun loadTable(rel: String, typeId: String, dirRel: String) {
            if (tables.any { it.typeId == typeId }) return
            val text = source.readText(rel) ?: return
            val def = types[typeId] ?: return
            val rows = runCatching { WikiFormat.parseCsv(text) }.getOrNull()
            val headerOk = rows != null && (rows.firstOrNull()?.firstOrNull() ?: "id").trim().lowercase() == "id"
            if (rows == null || !headerOk) {
                tables += WikiTable(typeId, def.displayNamePlural, rel, null, emptyList(), emptyList(), malformed = true, parentDir = dirRel)
                return
            }
            val header = (rows.firstOrNull() ?: listOf("id")).map { it.trim(' ', '\t') }
            val byName = LinkedHashMap<String, com.nimbalyst.app.sync.SyncedWikiField>()
            for (field in def.fields) byName.putIfAbsent(field.name, field)
            val parsedRows = rows.drop(1).map { row ->
                val fields = mutableListOf<WikiField>()
                header.forEachIndexed { column, name ->
                    if (column == 0) return@forEachIndexed
                    val cell = row.getOrElse(column) { "" }
                    WikiFormat.decodeCell(cell, byName[name])?.let { fields += WikiField(name, it) }
                }
                val title = (fields.firstOrNull { it.name == def.titleField }?.value as? WikiValue.Str)?.value ?: ""
                WikiRow(row.firstOrNull().orEmpty().trim(), title, fields)
            }
            tables += WikiTable(typeId, def.displayNamePlural, rel, null, header, parsedRows, malformed = false, parentDir = dirRel)
        }

        fun readTrash() {
            for (entry in source.entries(WikiFormat.TRASH_DIR) ?: emptyList()) {
                if (!entry.isDirectory) continue
                val manifest = source.readText(WikiFormat.join(WikiFormat.join(WikiFormat.TRASH_DIR, entry.name), ".trash.json")) ?: continue
                val id = runCatching { JsonParser.parseString(manifest).asJsonObject.get("id")?.asString }.getOrNull() ?: continue
                if (WikiFormat.isSafeId(id)) trash += id
            }
        }

        fun resolveLinks() {
            for (id in pageOrder) {
                val page = pages[id] ?: continue
                val base = page.path?.let(WikiFormat::dirname) ?: page.dir
                val targets = page.links.map { link ->
                    link.id?.takeIf { it in pages }
                        ?: WikiFormat.resolveLinkPath(base, link.path)?.let { target ->
                            val key = WikiFormat.nameKey(target)
                            if (link.path.endsWith("/")) byDir[key] else byFile[key] ?: byDir[key]
                        }
                }
                pages[id] = page.copy(linkTargets = targets)
            }
            for (index in tables.indices) {
                val table = tables[index]
                if (table.parentDir.isNotEmpty()) tables[index] = table.copy(parentId = byDir[WikiFormat.nameKey(table.parentDir)])
            }
        }
    }

    // endregion
}

/** A wiki folder on disk (tests, and any host with real files). */
class WikiDiskSource(private val root: File) : WikiFileSource {
    override fun entries(dir: String): List<WikiDirEntry>? {
        val folder = if (dir.isEmpty()) root else File(root, dir)
        val children = folder.listFiles() ?: return null
        return children.map { WikiDirEntry(WikiFormat.nfc(it.name), it.isDirectory) }
    }

    override fun readText(path: String): String? = runCatching { File(root, path).readText(Charsets.UTF_8) }.getOrNull()
}

/** A wiki made of synced files: folders are implied by the paths. */
class WikiPathSource(paths: Collection<String>, private val read: (String) -> String?) : WikiFileSource {
    private val children = HashMap<String, MutableMap<String, Boolean>>()

    init {
        for (path in paths) {
            val parts = path.split('/').filter { it.isNotEmpty() }
            var dir = ""
            parts.forEachIndexed { index, part ->
                val isLast = index == parts.lastIndex
                val names = children.getOrPut(dir) { HashMap() }
                names[part] = (names[part] ?: false) || !isLast
                dir = WikiFormat.join(dir, part)
            }
        }
    }

    override fun entries(dir: String): List<WikiDirEntry>? =
        children[dir]?.map { (name, isDirectory) -> WikiDirEntry(name, isDirectory) }

    override fun readText(path: String): String? = read(path)
}
