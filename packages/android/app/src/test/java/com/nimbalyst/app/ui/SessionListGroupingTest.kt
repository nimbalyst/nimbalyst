package com.nimbalyst.app.ui

import com.nimbalyst.app.data.SessionEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

class SessionListGroupingTest {

    private fun session(
        id: String,
        updatedAt: Long,
        sessionType: String? = null,
        parentSessionId: String? = null
    ) = SessionEntity(
        id = id,
        projectId = "p",
        sessionType = sessionType,
        parentSessionId = parentSessionId,
        createdAt = 0L,
        updatedAt = updatedAt
    )

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
    fun `workstream interleaves with standalone sessions by last update, not a separate section`() {
        val today = startOfToday()
        val hour = 60 * 60 * 1000L

        // A workstream whose newest child is more recent than one standalone but older than another.
        val sessions = listOf(
            session("standalone-new", today + 5 * hour),
            session("ws-parent", today + 1 * hour, sessionType = "workstream"),
            session("ws-child-old", today + 2 * hour, parentSessionId = "ws-parent"),
            session("ws-child-new", today + 4 * hour, parentSessionId = "ws-parent"),
            session("standalone-old", today + 3 * hour)
        )

        val grouped = SessionListGrouping.groupByTime(
            SessionListGrouping.buildItems(sessions),
            now = fixedNow()
        )

        // Everything lands in "Today" -- a single interleaved bucket, no "Workstreams" section.
        assertEquals(listOf("Today"), grouped.map { it.first })

        val order = grouped.single().second
        // Ordered by effectiveUpdatedAt desc: standalone-new(5h) > workstream(4h via newest child) > standalone-old(3h)
        assertEquals(
            listOf("standalone-new", "ws-ws-parent", "standalone-old"),
            order.map { it.key }
        )
    }

    @Test
    fun `workstream effectiveUpdatedAt is its newest child`() {
        val items = SessionListGrouping.buildItems(
            listOf(
                session("ws-parent", updatedAt = 100L, sessionType = "workstream"),
                session("c1", updatedAt = 500L, parentSessionId = "ws-parent"),
                session("c2", updatedAt = 300L, parentSessionId = "ws-parent")
            )
        )
        val workstream = items.filterIsInstance<SessionListGrouping.Item.Workstream>().single()
        assertEquals(500L, workstream.effectiveUpdatedAt)
        // Children are sorted newest-first.
        assertEquals(listOf("c1", "c2"), workstream.children.map { it.id })
    }

    @Test
    fun `childless workstream falls back to parent updatedAt`() {
        val items = SessionListGrouping.buildItems(
            listOf(session("ws-parent", updatedAt = 100L, sessionType = "workstream"))
        )
        val workstream = items.filterIsInstance<SessionListGrouping.Item.Workstream>().single()
        assertEquals(100L, workstream.effectiveUpdatedAt)
        assertTrue(workstream.children.isEmpty())
    }

    @Test
    fun `standalone excludes workstream parents and their children`() {
        val items = SessionListGrouping.buildItems(
            listOf(
                session("standalone", updatedAt = 1L),
                session("ws-parent", updatedAt = 2L, sessionType = "workstream"),
                session("child", updatedAt = 3L, parentSessionId = "ws-parent")
            )
        )
        val standaloneIds = items
            .filterIsInstance<SessionListGrouping.Item.Standalone>()
            .map { it.session.id }
        assertEquals(listOf("standalone"), standaloneIds)
    }

    @Test
    fun `items bucket into distinct time periods newest first`() {
        val today = startOfToday()
        val day = 24 * 60 * 60 * 1000L

        val grouped = SessionListGrouping.groupByTime(
            SessionListGrouping.buildItems(
                listOf(
                    session("a", today + 1000L),      // Today
                    session("b", today - 1000L),      // Yesterday (just before midnight)
                    session("c", today - 5 * day)     // This Week
                )
            ),
            now = fixedNow()
        )

        assertEquals(listOf("Today", "Yesterday", "This Week"), grouped.map { it.first })
    }
}
