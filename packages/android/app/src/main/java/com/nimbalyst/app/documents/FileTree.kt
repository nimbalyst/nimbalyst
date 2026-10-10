package com.nimbalyst.app.documents

/** One visible row of the file tree: a directory (expandable) or a file. */
data class FileTreeNode(
    val id: String,
    /** Full path; a directory's expansion key. */
    val path: String,
    /** May contain "/" when single-child directories were collapsed into one row. */
    val displayLabel: String,
    val depth: Int,
    val isDirectory: Boolean,
    val document: DocumentSummary?,
    /** Files in the directory's whole subtree; 0 for files. */
    val fileCount: Int,
    val lastModifiedAt: Long?,
)

private class TreeDir {
    val children = sortedMapOf<String, TreeDir>()
    val files = mutableListOf<DocumentSummary>()
    val totalFileCount: Int get() = files.size + children.values.sumOf { it.totalFileCount }
}

/**
 * Builds the visible rows for [documents]. Directories come before files at
 * each level, both sorted. A directory whose only content is one child
 * directory is merged with it into a single row ("src/components/ui"), and
 * that merged path is the expansion key. Mirrors iOS `buildFlattenedTree`.
 */
fun buildFlattenedTree(documents: List<DocumentSummary>, expandedPaths: Set<String>): List<FileTreeNode> {
    val root = TreeDir()
    for (document in documents) {
        var current = root
        document.relativePath.split('/').dropLast(1).forEach { name ->
            current = current.children.getOrPut(name) { TreeDir() }
        }
        current.files += document
    }
    return buildList { emit(root, depth = 0, pathPrefix = "", expandedPaths) }
}

private fun MutableList<FileTreeNode>.emit(dir: TreeDir, depth: Int, pathPrefix: String, expandedPaths: Set<String>) {
    for ((name, child) in dir.children) {
        var label = name
        var fullPath = if (pathPrefix.isEmpty()) name else "$pathPrefix/$name"
        var current = child
        while (current.children.size == 1 && current.files.isEmpty()) {
            val (onlyName, onlyChild) = current.children.entries.first()
            label += "/$onlyName"
            fullPath += "/$onlyName"
            current = onlyChild
        }
        add(
            FileTreeNode(
                id = "dir:$fullPath",
                path = fullPath,
                displayLabel = label,
                depth = depth,
                isDirectory = true,
                document = null,
                fileCount = current.totalFileCount,
                lastModifiedAt = null,
            )
        )
        if (fullPath in expandedPaths) emit(current, depth + 1, fullPath, expandedPaths)
    }
    for (document in dir.files.sortedBy { it.relativePath }) {
        add(
            FileTreeNode(
                id = "file:${document.syncId}",
                path = document.relativePath,
                displayLabel = document.displayName,
                depth = depth,
                isDirectory = false,
                document = document,
                fileCount = 0,
                lastModifiedAt = document.lastModifiedAt,
            )
        )
    }
}

/** Case-insensitive match on title or path, like the iOS search field. */
fun filterDocuments(documents: List<DocumentSummary>, query: String): List<DocumentSummary> {
    val trimmed = query.trim()
    if (trimmed.isEmpty()) return documents
    return documents.filter { it.title.contains(trimmed, ignoreCase = true) || it.relativePath.contains(trimmed, ignoreCase = true) }
}

/**
 * While searching, every directory holding a match is expanded, otherwise a
 * match inside a collapsed folder would be invisible.
 */
fun expandedPathsFor(documents: List<DocumentSummary>, query: String, persisted: Set<String>): Set<String> {
    if (query.isBlank()) return persisted
    return buildSet {
        addAll(persisted)
        for (document in documents) {
            val parts = document.relativePath.split('/').dropLast(1)
            for (i in 1..parts.size) add(parts.take(i).joinToString("/"))
        }
    }
}
