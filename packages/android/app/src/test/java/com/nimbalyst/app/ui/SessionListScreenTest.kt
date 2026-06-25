package com.nimbalyst.app.ui

import com.nimbalyst.app.data.SessionEntity
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionListScreenTest {
    @Test
    fun `only children of visible workstream parents are nested`() {
        val workstream = session("workstream", sessionType = "workstream")
        val workstreamChild = session("workstream-child", parentSessionId = workstream.id)
        val regularParent = session("regular-parent")
        val regularChild = session("regular-child", parentSessionId = regularParent.id)
        val orphanChild = session("orphan-child", parentSessionId = "archived-parent")

        assertEquals(
            setOf(workstreamChild.id),
            nestedWorkstreamChildIds(
                listOf(
                    workstream,
                    workstreamChild,
                    regularParent,
                    regularChild,
                    orphanChild
                )
            )
        )
    }

    private fun session(
        id: String,
        sessionType: String? = null,
        parentSessionId: String? = null
    ): SessionEntity = SessionEntity(
        id = id,
        projectId = "project",
        titleDecrypted = id,
        sessionType = sessionType,
        parentSessionId = parentSessionId,
        createdAt = 1L,
        updatedAt = 1L
    )
}
