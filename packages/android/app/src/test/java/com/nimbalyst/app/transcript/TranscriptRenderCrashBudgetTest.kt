package com.nimbalyst.app.transcript

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptRenderCrashBudgetTest {
    @Test
    fun `crashes after each load acknowledgement still exhaust the budget`() {
        val budget = TranscriptRenderCrashBudget(maxReloads = 2, windowMs = 120_000L)
        var now = 0L

        // The bundle acks loadSession before projection and render, so a
        // transcript that crashes the renderer produces ack, crash, ack, crash
        // every few seconds. The budget has no ack hook: an ack proves nothing.
        now += 3_000
        assertTrue(budget.recordCrash(now))
        now += 3_000
        assertTrue(budget.recordCrash(now))
        now += 3_000
        assertFalse("third crash in the window must stop reloading", budget.recordCrash(now))
        assertFalse(budget.recordCrash(now + 1_000))
    }

    @Test
    fun `crashes spread beyond the window reload again, and retry restores the budget`() {
        val budget = TranscriptRenderCrashBudget(maxReloads = 2, windowMs = 120_000L)

        assertTrue(budget.recordCrash(0))
        assertTrue(budget.recordCrash(10_000))
        assertFalse(budget.recordCrash(20_000))
        // An occasional background reclaim much later is not a crash loop.
        assertTrue(budget.recordCrash(200_000))
        assertTrue(budget.recordCrash(201_000))
        assertFalse(budget.recordCrash(202_000))

        budget.reset()
        assertTrue(budget.recordCrash(203_000))
    }
}
