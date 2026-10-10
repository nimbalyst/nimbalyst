package com.nimbalyst.app.ui

import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.ui.sessionlist.AggregatedStatus
import com.nimbalyst.app.ui.sessionlist.GroupKind
import com.nimbalyst.app.sync.IndexCoverage
import com.nimbalyst.app.ui.sessionlist.PhaseFilter
import com.nimbalyst.app.ui.sessionlist.SearchCoverageNotice
import com.nimbalyst.app.ui.sessionlist.SessionListSearch
import com.nimbalyst.app.ui.sessionlist.SessionListFilter
import com.nimbalyst.app.ui.sessionlist.SessionListGrouping
import com.nimbalyst.app.ui.sessionlist.TimePeriod
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

class SessionListGroupingTest {

    private fun session(
        id: String,
        updatedAt: Long,
        sessionType: String? = null,
        parentSessionId: String? = null,
        worktreeId: String? = null,
        agentRole: String? = null,
        createdBySessionId: String? = null,
        phase: String? = null,
        title: String? = null,
        isArchived: Boolean = false,
        isPinned: Boolean = false,
        isExecuting: Boolean = false,
        hasQueuedPrompts: Boolean = false,
        hostDeviceId: String? = null,
        createdAt: Long = 0L,
    ) = SessionEntity(
        id = id,
        projectId = "p",
        titleDecrypted = title,
        sessionType = sessionType,
        parentSessionId = parentSessionId,
        worktreeId = worktreeId,
        agentRole = agentRole,
        createdBySessionId = createdBySessionId,
        phase = phase,
        isArchived = isArchived,
        isPinned = isPinned,
        isExecuting = isExecuting,
        hasQueuedPrompts = hasQueuedPrompts,
        hostDeviceId = hostDeviceId,
        createdAt = createdAt,
        updatedAt = updatedAt
    )

    private fun groups(sessions: List<SessionEntity>, filter: SessionListFilter = SessionListFilter()) =
        SessionListGrouping.buildGroups(sessions, filter)

    private fun visibleIds(groups: List<SessionListGrouping.Group>) = groups.flatMap { it.sessionIds }.toSet()

    // Fixed "now" so relative-time bucketing is deterministic.
    private fun fixedNow(): Calendar = Calendar.getInstance().apply {
        set(2026, Calendar.JULY, 9, 12, 0, 0)
        set(Calendar.MILLISECOND, 0)
    }

    private fun startOfToday(): Long = (fixedNow().clone() as Calendar).apply {
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }.timeInMillis

    @Test
    fun `workstream interleaves with standalone sessions by its newest child`() {
        val today = startOfToday()
        val hour = 60 * 60 * 1000L
        val sessions = listOf(
            session("standalone-new", today + 5 * hour),
            session("ws-parent", today + 6 * hour, sessionType = "workstream"),
            session("ws-child-old", today + 2 * hour, parentSessionId = "ws-parent"),
            session("ws-child-new", today + 4 * hour, parentSessionId = "ws-parent"),
            session("standalone-old", today + 3 * hour)
        )

        val grouped = SessionListGrouping.groupByTime(groups(sessions), now = fixedNow())

        assertEquals(listOf(TimePeriod.TODAY), grouped.map { it.first })
        // The container's own 6h timestamp is ignored; its newest child (4h) orders it.
        assertEquals(
            listOf("s:standalone-new", "ws:ws-parent", "s:standalone-old"),
            grouped.single().second.map { it.key }
        )
        val ws = grouped.single().second[1]
        assertEquals(listOf("ws-child-new", "ws-child-old"), ws.children.map { it.id })
    }

    @Test
    fun `children of a non-workstream or missing parent stay visible`() {
        val result = groups(
            listOf(
                session("plain-parent", updatedAt = 1L),
                session("child-of-plain", updatedAt = 2L, parentSessionId = "plain-parent"),
                session("orphan", updatedAt = 3L, parentSessionId = "not-synced-yet")
            )
        )
        assertEquals(setOf("plain-parent", "child-of-plain", "orphan"), visibleIds(result))
        assertEquals(setOf("ws:plain-parent", "s:orphan"), result.map { it.key }.toSet())
    }

    @Test
    fun `worktree members group by worktreeId and a single member is a plain row`() {
        val result = groups(
            listOf(
                session("a", updatedAt = 10L, worktreeId = "wt1", createdAt = 2L),
                session("b", updatedAt = 20L, worktreeId = "wt1", createdAt = 1L),
                session("solo", updatedAt = 5L, worktreeId = "wt2")
            )
        )
        val wt1 = result.single { it.key == "wt:wt1" }
        assertEquals("b", wt1.parent.id) // oldest member is the header identity
        assertEquals(listOf("b", "a"), wt1.children.map { it.id })
        assertTrue(result.single { it.key == "wt:wt2" }.children.isEmpty())
    }

    @Test
    fun `three level trees use parents rather than manager roles and clamp indentation`() {
        val sessions = listOf(
            session("root", 1L, agentRole = "meta-agent"),
            session("manager", 2L, parentSessionId = "root"),
            session("worker", 3L, parentSessionId = "manager"),
            session("deep", 100L, parentSessionId = "worker", isExecuting = true),
            session("sibling", 10L, parentSessionId = "root"),
            session("isolated", 20L, createdBySessionId = "root"),
        )
        for (enabled in listOf(true, false)) {
            val result = groups(sessions, SessionListFilter(metaAgentEnabled = enabled))
            assertEquals(setOf("ws:root", "s:isolated"), result.map { it.key }.toSet())
            val tree = result.single { it.key == "ws:root" }
            assertEquals(listOf("manager", "worker", "deep", "sibling"), tree.children.map { it.id })
            assertEquals(listOf(1, 2, 2, 1), tree.children.map { SessionListGrouping.indentationLevel(it, tree) })
            assertEquals(AggregatedStatus.PROCESSING, tree.status)
        }
    }

    @Test
    fun `cycles stay visible and a filtered ancestor releases its subtree`() {
        val cycle = groups(listOf(session("a", 1L, parentSessionId = "b"), session("b", 2L, parentSessionId = "a")))
        assertEquals(setOf("a", "b"), visibleIds(cycle))
        assertEquals(1, cycle.size)
        val filtered = groups(listOf(session("root", 1L, title = "Root"),
            session("manager", 2L, parentSessionId = "root", title = "Match manager"),
            session("worker", 3L, parentSessionId = "manager", title = "Match worker")),
            SessionListFilter(searchText = "Match"))
        assertEquals("ws:manager", filtered.single().key)
        assertEquals(listOf("worker"), filtered.single().children.map { it.id })
    }

    @Test
    fun `search hiding a workstream parent releases its children as standalone rows`() {
        val result = groups(
            listOf(
                session("ws", updatedAt = 1L, sessionType = "workstream", title = "Container"),
                session("child", updatedAt = 2L, parentSessionId = "ws", title = "Fix login bug")
            ),
            SessionListFilter(searchText = "login")
        )
        assertEquals(listOf("s:child"), result.map { it.key })
    }

    @Test
    fun `phase filter keeps a workstream when any child matches`() {
        val sessions = listOf(
            session("ws", updatedAt = 1L, sessionType = "workstream"),
            session("c1", updatedAt = 2L, parentSessionId = "ws", phase = "planning"),
            session("c2", updatedAt = 3L, parentSessionId = "ws", phase = "implementing"),
            session("done", updatedAt = 4L, phase = "complete")
        )
        assertEquals(listOf("ws:ws"), groups(sessions, SessionListFilter(phase = PhaseFilter.ACTIVE)).map { it.key })
        assertEquals(listOf("s:done"), groups(sessions, SessionListFilter(phase = PhaseFilter.COMPLETE)).map { it.key })
    }

    @Test
    fun `archived sessions only appear in the archived view`() {
        val sessions = listOf(session("live", 1L), session("old", 2L, isArchived = true))
        assertEquals(setOf("live"), visibleIds(groups(sessions)))
        assertEquals(setOf("live", "old"), visibleIds(groups(sessions, SessionListFilter(includeArchived = true))))
        assertTrue(SessionListGrouping.facets(sessions).hasArchived)
        assertFalse(SessionListGrouping.facets(sessions).hasPhaseData)
    }

    @Test
    fun `host scope keeps unattributed history only when asked`() {
        val sessions = listOf(
            session("mine", 1L, hostDeviceId = "desk"),
            session("other", 2L, hostDeviceId = "vm"),
            session("legacy", 3L)
        )
        assertEquals(setOf("mine"), visibleIds(groups(sessions, SessionListFilter(hostDeviceId = "desk"))))
        assertEquals(
            setOf("mine", "legacy"),
            visibleIds(groups(sessions, SessionListFilter(hostDeviceId = "desk", includeUnattributedSessions = true)))
        )
    }

    @Test
    fun `group status reports the most urgent child`() {
        val ws = groups(
            listOf(
                session("ws", 1L, sessionType = "workstream", isExecuting = true),
                session("c1", 2L, parentSessionId = "ws", hasQueuedPrompts = true),
                session("c2", 3L, parentSessionId = "ws")
            )
        ).single()
        // The container's own isExecuting is ignored when it has children.
        assertEquals(AggregatedStatus.PENDING_PROMPT, ws.status)
    }

    @Test
    fun `pinned leave the timeline and active groups past the window stay reachable`() {
        val today = startOfToday()
        val sessions = (1..5).map { session("s$it", today + it * 1000L) } + listOf(
            session("pinned", today + 100L, isPinned = true),
            session("running-old", today - 40 * 24 * 3600 * 1000L, isExecuting = true),
            session("idle-old", today - 41 * 24 * 3600 * 1000L)
        )
        val sections = SessionListGrouping.sections(
            groups(sessions),
            SessionListGrouping.facets(sessions),
            windowSize = 3,
            now = fixedNow()
        )
        assertEquals(listOf("s:pinned"), sections.pinned.map { it.key })
        val timelineKeys = sections.timeline.flatMap { (_, list) -> list.map { it.key } }
        assertEquals(listOf("s:s5", "s:s4", "s:s3", "s:running-old"), timelineKeys)
        assertEquals(TimePeriod.OLDER, sections.timeline.last().first)
        assertTrue(sections.hasMore)
    }

    @Test
    fun `items bucket into distinct time periods newest first`() {
        val today = startOfToday()
        val day = 24 * 60 * 60 * 1000L

        val grouped = SessionListGrouping.groupByTime(
            groups(
                listOf(
                    session("a", today + 1000L),      // Today
                    session("b", today - 1000L),      // Yesterday (just before midnight)
                    session("c", today - 5 * day)     // This Week
                )
            ),
            now = fixedNow()
        )

        assertEquals(listOf(TimePeriod.TODAY, TimePeriod.YESTERDAY, TimePeriod.THIS_WEEK), grouped.map { it.first })
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `search waits for typing to pause but clearing applies at once`() = runTest {
        val typed = MutableSharedFlow<String>()
        val applied = mutableListOf<String>()
        val job = launch { SessionListSearch.debounced(typed).collect { applied += it } }
        runCurrent()

        typed.emit("r"); advanceTimeBy(100)
        typed.emit("re"); advanceTimeBy(100)
        typed.emit("ref"); runCurrent()
        assertEquals(emptyList<String>(), applied)
        advanceTimeBy(SessionListSearch.DEBOUNCE_MS + 1)
        assertEquals(listOf("ref"), applied)

        typed.emit(""); runCurrent()
        assertEquals(listOf("ref", ""), applied)
        job.cancel()
    }

    @Test
    fun `a search is only definitive once history is complete`() {
        val syncing = IndexCoverage(compatibility = IndexCoverage.Compatibility.V2, isBackfilling = true)
        assertEquals(SearchCoverageNotice.NONE, SessionListSearch.coverageNotice(isSearching = false, coverage = syncing))
        assertEquals(SearchCoverageNotice.SYNCING, SessionListSearch.coverageNotice(true, syncing))
        assertEquals(SearchCoverageNotice.FAILED, SessionListSearch.coverageNotice(true, syncing.copy(hasError = true)))
        assertEquals(
            SearchCoverageNotice.LEGACY_SERVER,
            SessionListSearch.coverageNotice(true, IndexCoverage(compatibility = IndexCoverage.Compatibility.LEGACY_SERVER))
        )
        assertEquals(SearchCoverageNotice.NONE, SessionListSearch.coverageNotice(true, IndexCoverage(historyComplete = true)))
    }
}
