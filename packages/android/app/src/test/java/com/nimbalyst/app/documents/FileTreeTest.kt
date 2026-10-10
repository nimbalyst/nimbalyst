package com.nimbalyst.app.documents

import org.junit.Assert.assertEquals
import org.junit.Test

class FileTreeTest {
    private fun doc(path: String) = DocumentSummary("p", path, path, path.substringAfterLast('/'), null, 1, false, 0)

    private val docs = listOf(
        "README.md",
        "src/components/ui/Button.tsx",
        "src/components/ui/Card.tsx",
        "docs/guide.md",
        "docs/api/index.md",
        "a.json",
    ).map(::doc)

    @Test
    fun singleChildDirectoriesCollapseIntoOneRowAndDirectoriesComeFirst() {
        val rows = buildFlattenedTree(docs, expandedPaths = emptySet())
        assertEquals(listOf("docs", "src/components/ui", "README.md", "a.json"), rows.map { it.displayLabel })
        assertEquals(listOf(2, 2, 0, 0), rows.map { it.fileCount })
        assertEquals("The merged chain is the expansion key", "src/components/ui", rows[1].path)
    }

    @Test
    fun expandingShowsChildrenOneLevelDeeper() {
        val rows = buildFlattenedTree(docs, expandedPaths = setOf("docs", "src/components/ui"))
        assertEquals(
            listOf("docs", "api", "guide.md", "src/components/ui", "Button.tsx", "Card.tsx", "README.md", "a.json"),
            rows.map { it.displayLabel },
        )
        assertEquals(listOf(0, 1, 1, 0, 1, 1, 0, 0), rows.map { it.depth })
        assertEquals("A collapsed child stays collapsed", false, rows.any { it.displayLabel == "index.md" })
    }

    @Test
    fun searchMatchesTitleOrPathAndExpandsFoldersHoldingMatches() {
        val matches = filterDocuments(docs, "  CARD ")
        assertEquals(listOf("src/components/ui/Card.tsx"), matches.map { it.relativePath })
        val expanded = expandedPathsFor(matches, "card", persisted = emptySet())
        assertEquals(listOf("src/components/ui", "Card.tsx"), buildFlattenedTree(matches, expanded).map { it.displayLabel })
        assertEquals(docs, filterDocuments(docs, ""))
        assertEquals(setOf("x"), expandedPathsFor(matches, "", setOf("x")))
    }
}
