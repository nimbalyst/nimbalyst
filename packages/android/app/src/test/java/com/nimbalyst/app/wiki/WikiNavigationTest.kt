package com.nimbalyst.app.wiki

import com.google.gson.JsonParser
import com.nimbalyst.app.documents.DocumentKind
import com.nimbalyst.app.documents.classifyDocument
import com.nimbalyst.app.documents.editorSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** How the Wiki tab, the Files tab and the editor use a snapshot, on the shared `basic` fixture. */
class WikiNavigationTest {
    private val root = File("../../local-wiki/fixtures/basic")
    private val types = WikiTypes.parse(JsonParser.parseString(File(root, "expected.json").readText()).asJsonObject.getAsJsonArray("types"))

    /** The fixture as it arrives through sync into a project whose wiki lives in `notes/wiki`. */
    private val folder = "notes/wiki"
    private val wikiRoot = File(root, "wiki")
    private val synced = wikiRoot.walkTopDown().filter { it.isFile }.map { it.relativeTo(wikiRoot).invariantSeparatorsPath }
        .filter { !it.startsWith(".trash") }.toList()
    private val snapshot = LocalWikiReader.read(WikiPathSource(synced) { File(wikiRoot, it).readText() }, types)
    private val syncedPaths = synced.map { "$folder/$it" }.toSet()

    @Test
    fun treeRowsListHomeFirstAndGroupConflictCopiesUnderTheirPage() {
        val collapsed = wikiTreeRows(snapshot, folder, syncedPaths, expanded = emptySet())
        assertEquals(listOf("Home", "Competitors", "Partners", "Docs", "Ops"), collapsed.map { it.title })
        assertEquals("notes/wiki/Partners.csv", collapsed[2].documentPath)
        assertEquals(WikiRowKind.TABLE, collapsed[2].kind)
        assertNull("A bare folder has no file to open", collapsed[4].documentPath)

        val acme = "01JACME0000000000000000000"
        val competitors = "01JCOMPETITORS0000000000000"
        val open = wikiTreeRows(snapshot, folder, syncedPaths, expanded = setOf(competitors))
        val children = open.filter { it.depth == 1 }
        assertEquals("The conflict copy is not a sibling", listOf("Acme", "Beta: Corp"), children.map { it.title })
        assertTrue("Acme can expand to show its conflict copy", children[0].hasChildren)
        assertEquals("Competitor", children[0].badge)

        val withCopies = wikiTreeRows(snapshot, folder, syncedPaths, expanded = setOf(competitors, acme))
        val underAcme = withCopies.filter { it.depth == 2 }
        assertEquals(listOf(WikiRowKind.CONFLICT, WikiRowKind.PAGE), underAcme.map { it.kind })
        assertEquals("notes/wiki/Competitors/Acme (conflict 2026-10-01 120000).md", underAcme[0].documentPath)

        assertNull("A page that has not synced cannot be opened", wikiTreeRows(snapshot, folder, emptySet(), emptySet())[0].documentPath)
        assertEquals(listOf("Pricing"), wikiTreeRows(snapshot, folder, syncedPaths, emptySet(), query = " pric ").map { it.title })
    }

    @Test
    fun editorLinksOpenWikiPagesByIdThenPathAndWebLinksLeaveTheApp() {
        val pricing = "$folder/Competitors/Acme/Pricing.md"
        assertEquals(
            "An id wins over a stale path",
            EditorLinkTarget.Document("$folder/Home.md"),
            resolveEditorLink("Old/Home.md", "id=01JHOME0000000000000000000", pricing, folder, snapshot),
        )
        assertEquals(EditorLinkTarget.Document("$folder/Competitors/Beta- Corp.md"), resolveEditorLink("../Beta-%20Corp.md", null, pricing, folder, snapshot))
        assertEquals(EditorLinkTarget.External("https://example.com"), resolveEditorLink("https://example.com", null, pricing, folder, snapshot))
        assertEquals(
            "Outside a wiki a relative .md link resolves against the file",
            EditorLinkTarget.Document("docs/guide.md"),
            resolveEditorLink("../docs/guide.md", null, "plans/a.md", null, null),
        )
        assertEquals(EditorLinkTarget.None, resolveEditorLink("../../x.md", null, "a.md", null, null))
        assertEquals(EditorLinkTarget.None, resolveEditorLink("javascript:alert(1)", null, "a.md", null, null))
    }

    /** R1-9: a link in a wiki page never leaves the wiki, even when the project path exists. */
    @Test
    fun wikiLinksResolveOnlyInsideTheWiki() {
        val home = "$folder/Home.md"
        assertEquals(EditorLinkTarget.None, resolveEditorLink("../README.md", null, home, folder, snapshot))
        assertEquals(EditorLinkTarget.None, resolveEditorLink("../../plans/a.md", null, "$folder/Competitors/Acme.md", folder, snapshot))
        assertEquals("No hidden folders", EditorLinkTarget.None, resolveEditorLink(".trash/x/Old.md", null, home, folder, snapshot))
        assertEquals(
            "A synced wiki file the reader does not list still opens by its in-wiki path",
            EditorLinkTarget.Document("$folder/Ops/Notes.md"),
            resolveEditorLink("Ops/Notes.md", null, home, folder, snapshot),
        )
        assertEquals(
            "Without a snapshot the same rule holds",
            EditorLinkTarget.None,
            resolveEditorLink("../../outside.md", null, "$folder/Ops/Runbook.md", folder, null),
        )
    }

    private fun withMarker(marker: String): WikiSnapshot {
        val files = mapOf(".nimbalyst-wiki.yaml" to marker, "Home.md" to "---\nid: 01JH\n---\nHi\n", "T.csv" to "a\n1\n")
        return LocalWikiReader.read(WikiPathSource(files.keys) { files[it] }, emptyList())
    }

    /** R1-11: a version that is not a whole number reads as unsupported instead of trapping or passing. */
    @Test
    fun markerVersionMustBeAWholeNumber() {
        for (bad in listOf(".inf", "-.inf", ".nan", "1.5", "0", "-1", "\"1\"", "99999999999")) {
            val snapshot = withMarker("formatVersion: $bad\n")
            assertNull(bad, snapshot.formatVersion)
            assertTrue(bad, snapshot.isUnsupportedVersion)
        }
        assertTrue("A newer format", withMarker("formatVersion: 2\n").isUnsupportedVersion)
        assertTrue("Unparseable marker", withMarker("formatVersion: [\n").isUnsupportedVersion)
        assertFalse(withMarker("formatVersion: 1\n").isUnsupportedVersion)
        assertFalse("No marker yet: it has not synced", LocalWikiReader.read(WikiPathSource(listOf("Home.md")) { if (it == "Home.md") "Hi" else null }, emptyList()).isUnsupportedVersion)
    }

    /** R1-8: every entry point goes through classifyDocument, so an unsupported wiki is read-only from all of them. */
    @Test
    fun anUnsupportedWikiIsReadOnlyWhereverAPageIsOpened() {
        val newer = withMarker("formatVersion: 2\n")
        assertEquals(DocumentKind.Locked, classifyDocument("$folder/Home.md", folder, newer))
        assertEquals("A CSV is a read-only grid either way", DocumentKind.Csv, classifyDocument("$folder/T.csv", folder, newer))
        assertEquals("Outside the wiki nothing changes", DocumentKind.Plain, classifyDocument("README.md", folder, newer))
    }

    @Test
    fun theFilesTabLeavesWikiDataToTheWikiTab() {
        assertTrue(WikiDocuments.isWikiDataFile("$folder/Partners.csv", folder))
        assertTrue(WikiDocuments.isWikiDataFile("$folder/.nimbalyst-wiki.yaml", folder))
        assertTrue(WikiDocuments.isWikiDataFile("$folder/.trash/1-x/Old.md", folder))
        assertFalse(WikiDocuments.isWikiDataFile("$folder/Home.md", folder))
        assertFalse("Outside the wiki nothing is hidden", WikiDocuments.isWikiDataFile("data/Partners.csv", folder))
        assertFalse(WikiDocuments.isWikiDataFile("$folder/Partners.csv", null))
    }

    @Test
    fun documentsOpenAsTablePageCsvOrPlainMarkdown() {
        assertEquals("partner", (classifyDocument("$folder/Partners.csv", folder, snapshot) as DocumentKind.Table).table.typeId)
        val acme = classifyDocument("$folder/Competitors/Acme.md", folder, snapshot) as DocumentKind.Page
        assertEquals("competitor", acme.page.type)
        assertEquals(DocumentKind.Csv, classifyDocument("data/budget.csv", folder, snapshot))
        assertEquals(DocumentKind.Plain, classifyDocument("README.md", folder, snapshot))
        assertEquals(DocumentKind.Plain, classifyDocument("$folder/Home.md", null, null))
    }

    /** R1-A2: the kind an open file resolves to can change; the editor follows the current one. */
    @Test
    fun editorPermissionFollowsTheCurrentKind() {
        val path = "$folder/Home.md"
        assertFalse("Before the wiki config arrives", editorSpec(classifyDocument(path, null, null)).readOnly)
        assertTrue("Then found in an unsupported wiki", editorSpec(classifyDocument(path, folder, withMarker("formatVersion: 2\n"))).readOnly)
        val valid = classifyDocument(path, folder, snapshot)
        assertFalse(editorSpec(valid).readOnly)
        assertTrue("Links resolve in the snapshot the page was classified with", editorSpec(valid).snapshot === snapshot)
        val broken = mapOf("Home.md" to "---\nid: [\n---\nHi\n")
        val malformed = LocalWikiReader.read(WikiPathSource(broken.keys) { broken[it] }, emptyList())
        assertTrue("A page whose frontmatter breaks turns read-only", editorSpec(classifyDocument(path, folder, malformed)).readOnly)
        assertEquals("Competitor", editorSpec(classifyDocument("$folder/Competitors/Acme.md", folder, snapshot)).typeName)
    }

    /** R1-A4: a marker that synced but could not be read (decrypt failed) locks the wiki. */
    @Test
    fun aListedMarkerThatCannotBeReadLocksTheWiki() {
        val listed = LocalWikiReader.read(WikiPathSource(listOf(".nimbalyst-wiki.yaml", "Home.md")) { if (it == "Home.md") "Hi" else null }, emptyList())
        assertTrue(listed.isUnsupportedVersion)
        assertEquals(DocumentKind.Locked, classifyDocument("$folder/Home.md", folder, listed))
    }

    /** R1-A5: percent-decoding keeps characters outside the BMP whole. */
    @Test
    fun linkPathsDecodeByCodePoint() {
        assertEquals("\uD83D\uDE80 Notes.md", WikiFormat.link("", "\uD83D\uDE80%20Notes.md", null).path)
        assertEquals("caf\u00e9.md", WikiFormat.link("", "caf%C3%A9.md", null).path)
        assertEquals("Malformed escapes stay as written", "50%.md", WikiFormat.link("", "50%.md", null).path)
        val files = mapOf("Home.md" to "[Notes](\uD83D\uDE80%20Notes.md)\n", "\uD83D\uDE80 Notes.md" to "---\nid: 01JN\n---\n")
        val wiki = LocalWikiReader.read(WikiPathSource(files.keys) { files[it] }, emptyList())
        assertEquals(listOf<String?>("01JN"), wiki.linkTargets(wiki.pageAtPath("Home.md")!!.id))
    }

    /** R1-A6: block scalar forms the reader cannot read exactly are rejected, never read altered. */
    @Test
    fun unsupportedBlockScalarsAreRejected() {
        for (yaml in listOf("a: |2\n   x\n", "a: >\n  one\n    more\n  two\n", "a: >-1\n  x\n", "a: |x\n  y\n")) {
            org.junit.Assert.assertThrows(yaml, WikiYaml.ParseError::class.java) { WikiYaml.parseMapping(yaml) }
        }
        assertEquals(WikiValue.Str("one two\n"), WikiYaml.parseMapping("a: >\n  one\n  two\n")["a"])
        assertEquals(WikiValue.Str("one\n  more\n"), WikiYaml.parseMapping("a: |\n  one\n    more\n")["a"])
        val files = mapOf("Home.md" to "---\nid: 01JH\nnote: |2\n   x\n---\nHi\n")
        val page = LocalWikiReader.read(WikiPathSource(files.keys) { files[it] }, emptyList()).pageAtPath("Home.md")!!
        assertTrue("The page is read-only, not rewritten", page.malformed)
    }

    /** R1-A7: file stems collapse whitespace the way the library (JavaScript `\\s`) does. */
    @Test
    fun tableFileNamesFollowTheLibraryWhitespaceRules() {
        assertEquals("Key Partners", WikiFormat.fileStemForTitle("Key\u00A0\u2003Partners\u3000"))
        val type = com.nimbalyst.app.sync.SyncedWikiType("kp", "Key Partner", "Key\u00A0Partners", "table", "title")
        val files = mapOf("Key Partners.csv" to "id,title\n01JK,Acme\n")
        val wiki = LocalWikiReader.read(WikiPathSource(files.keys) { files[it] }, listOf(type))
        assertEquals(listOf("kp"), wiki.tables.map { it.typeId })
    }
}
