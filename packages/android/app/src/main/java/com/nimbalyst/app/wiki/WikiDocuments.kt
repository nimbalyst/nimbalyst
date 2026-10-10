package com.nimbalyst.app.wiki

import com.nimbalyst.app.documents.DocumentSummary
import com.nimbalyst.app.sync.SyncedWikiType
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Where a project's Local wiki sits among its synced files. The wiki folder
 * comes from the desktop (`ProjectEntity.localWikiFolder`). Mirrors iOS `WikiDocuments`.
 */
object WikiDocuments {
    /** Wiki-relative path of a synced file, or null when it is outside the wiki. */
    fun wikiPath(relativePath: String, folder: String): String? {
        if (folder.isEmpty()) return relativePath
        return relativePath.removePrefix("$folder/").takeIf { it != relativePath }
    }

    fun projectPath(wikiPath: String, folder: String): String = WikiFormat.join(folder, wikiPath)

    /**
     * Wiki files that are data rather than markdown pages: table CSVs, the
     * marker, sidecars and trash. The Files tab leaves them to the Wiki tab.
     */
    fun isWikiDataFile(relativePath: String, folder: String?): Boolean {
        val path = folder?.let { wikiPath(relativePath, it) } ?: return false
        if (path.split('/').any { it.startsWith(".") }) return true
        return !path.lowercase().endsWith(".md")
    }
}

/** Where a link tapped in the editor goes. */
sealed interface EditorLinkTarget {
    /** A synced file of the same project, by project-relative path. */
    data class Document(val relativePath: String) : EditorLinkTarget
    data class External(val url: String) : EditorLinkTarget
    data object None : EditorLinkTarget
}

private val EXTERNAL_SCHEMES = setOf("http", "https", "mailto")

/**
 * Links from a wiki file stay inside the wiki: they open their target page (by
 * `id=` first, then by relative path), else a synced file the relative path
 * names inside the wiki, never a path that leaves it. Relative `.md` links in
 * other files resolve against [documentPath]. Web and mail links leave the app.
 * Whether the resulting document has synced is the opener's check.
 */
fun resolveEditorLink(
    href: String,
    title: String?,
    documentPath: String,
    folder: String?,
    snapshot: WikiSnapshot?,
): EditorLinkTarget {
    val scheme = href.substringBefore(':', missingDelimiterValue = "").lowercase()
    if (scheme in EXTERNAL_SCHEMES) return EditorLinkTarget.External(href)
    val link = WikiFormat.link("", href, title)
    val inWiki = folder?.let { WikiDocuments.wikiPath(documentPath, it) }
    if (folder != null && inWiki != null) {
        val page = snapshot?.pageAtPath(inWiki)
        val target = page?.let { snapshot.resolveLink(it, href, title) }?.let(snapshot.pages::get)
        target?.path?.let { return EditorLinkTarget.Document(WikiDocuments.projectPath(it, folder)) }
        if (!link.isPageLink || link.path.isEmpty()) return EditorLinkTarget.None
        // resolveLinkPath is null for a path that climbs out of the wiki root.
        val path = WikiFormat.resolveLinkPath(WikiFormat.dirname(inWiki), link.path) ?: return EditorLinkTarget.None
        if (path.split('/').any { it.startsWith(".") }) return EditorLinkTarget.None
        return EditorLinkTarget.Document(WikiDocuments.projectPath(path, folder))
    }
    if (!link.isPageLink || link.path.isEmpty()) return EditorLinkTarget.None
    val path = WikiFormat.resolveLinkPath(WikiFormat.dirname(documentPath), link.path) ?: return EditorLinkTarget.None
    return EditorLinkTarget.Document(path)
}

/**
 * Reads wiki snapshots from a project's synced documents, re-reading only the
 * files whose content changed. The reader reads every page's frontmatter, so
 * each wiki file is opened once and then served from here until its hash moves.
 */
class WikiStore {
    private class CachedText(val stamp: String, val text: String)
    private class CachedSnapshot(val signature: String, val snapshot: WikiSnapshot)

    private val texts = HashMap<String, CachedText>()
    private val snapshots = HashMap<String, CachedSnapshot>()
    /** The tree and the editor can both ask for a snapshot at once. */
    private val lock = Mutex()

    private fun stamp(document: DocumentSummary) = "${document.contentHash.orEmpty()}|${document.lastModifiedAt ?: 0}"

    /** The wiki in [folder] among [documents]; [read] opens a file's text by project-relative path. */
    suspend fun snapshot(
        projectId: String,
        folder: String,
        documents: List<DocumentSummary>,
        types: List<SyncedWikiType>,
        read: suspend (relativePath: String) -> String?,
    ): WikiSnapshot = lock.withLock {
        val byPath = HashMap<String, DocumentSummary>()
        for (document in documents) {
            if (document.projectId != projectId) continue
            WikiDocuments.wikiPath(document.relativePath, folder)?.let { byPath[it] = document }
        }
        val signature = byPath.keys.sorted().joinToString("\n") { "$it:${stamp(byPath.getValue(it))}" } + "#${types.hashCode()}"
        val key = "$projectId\u001f$folder"
        snapshots[key]?.takeIf { it.signature == signature }?.let { return@withLock it.snapshot }

        val contents = HashMap<String, String>()
        for ((path, document) in byPath) {
            val stamp = stamp(document)
            val cacheKey = "$projectId\u001f${document.syncId}"
            val cached = texts[cacheKey]?.takeIf { it.stamp == stamp }
            val text = cached?.text ?: read(document.relativePath)?.also { texts[cacheKey] = CachedText(stamp, it) }
            if (text != null) contents[path] = text
        }
        val snapshot = LocalWikiReader.read(WikiPathSource(byPath.keys) { contents[it] }, types)
        snapshots[key] = CachedSnapshot(signature, snapshot)
        snapshot
    }

    companion object {
        val shared = WikiStore()
    }
}
