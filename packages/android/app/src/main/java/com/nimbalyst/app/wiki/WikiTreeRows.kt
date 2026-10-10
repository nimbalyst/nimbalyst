package com.nimbalyst.app.wiki

enum class WikiRowKind { PAGE, TYPED_PAGE, EDITOR_PAGE, TABLE, CONFLICT }

/** One visible row of the wiki tree. */
data class WikiTreeRow(
    val id: String,
    val title: String,
    val depth: Int,
    /** The synced file to open; null for a bare folder or a file that has not synced. */
    val documentPath: String?,
    val kind: WikiRowKind,
    /** Type display name, table row count, or null. */
    val badge: String?,
    val hasChildren: Boolean,
)

/**
 * The visible rows of [snapshot]'s tree, mirroring iOS `WikiTreeView.rows`:
 * nodes in tree order (Home first by its `order`), children only under an
 * expanded node, and sync conflict copies listed under the page they diverged
 * from rather than as siblings. A non-blank [query] lists matching titles flat.
 * [syncedPaths] are the project-relative paths that can be opened.
 */
fun wikiTreeRows(
    snapshot: WikiSnapshot,
    folder: String,
    syncedPaths: Set<String>,
    expanded: Set<String>,
    query: String = "",
): List<WikiTreeRow> {
    fun opened(path: String?) = path?.let { WikiDocuments.projectPath(it, folder) }?.takeIf { it in syncedPaths }

    fun row(node: WikiNode, depth: Int, conflict: Boolean): WikiTreeRow = when (node) {
        is WikiNode.Page -> WikiTreeRow(
            id = node.id,
            title = node.title,
            depth = depth,
            documentPath = opened(node.page.path),
            kind = when {
                conflict -> WikiRowKind.CONFLICT
                node.page.type != null -> WikiRowKind.TYPED_PAGE
                node.page.documentType != "markdown" -> WikiRowKind.EDITOR_PAGE
                else -> WikiRowKind.PAGE
            },
            badge = if (conflict) null else node.page.type?.let(snapshot::typeName),
            hasChildren = node.children.isNotEmpty(),
        )
        is WikiNode.Table -> WikiTreeRow(
            id = node.id,
            title = node.title,
            depth = depth,
            documentPath = opened(node.table.path),
            kind = WikiRowKind.TABLE,
            badge = node.table.rows.size.toString(),
            hasChildren = false,
        )
    }

    val out = mutableListOf<WikiTreeRow>()
    val trimmed = query.trim()
    if (trimmed.isNotEmpty()) {
        fun search(nodes: List<WikiNode>) {
            for (node in nodes) {
                if (node.title.contains(trimmed, ignoreCase = true)) out += row(node, 0, conflict = false)
                if (node is WikiNode.Page) search(node.children)
            }
        }
        search(snapshot.tree)
        return out
    }

    fun emit(nodes: List<WikiNode>, depth: Int) {
        val copies = nodes.filterIsInstance<WikiNode.Page>().filter { it.page.conflictOf != null }.groupBy { it.page.conflictOf }
        for (node in nodes) {
            if (node is WikiNode.Page && node.page.conflictOf != null) continue
            val conflicts = copies[node.id].orEmpty()
            val base = row(node, depth, conflict = false)
            out += base.copy(hasChildren = base.hasChildren || conflicts.isNotEmpty())
            if (node.id !in expanded) continue
            conflicts.forEach { out += row(it, depth + 1, conflict = true) }
            if (node is WikiNode.Page) emit(node.children, depth + 1)
        }
    }
    emit(snapshot.tree, 0)
    return out
}
