package com.nimbalyst.app.sync

import org.junit.Assert.assertEquals
import org.junit.Test

/** The JWT refresh failure policy, ported from iOS `AppState.refreshJWT`. */
class AuthHealthTest {
    private var now = 0L
    private val tracker = AuthHealthTracker(clock = { now })

    private fun failAfter(minutes: Long): AuthHealth {
        now += minutes * 60_000
        return tracker.recordFailure()
    }

    @Test
    fun `three counted failures degrade, five sign out, and a success resets the count`() {
        assertEquals(AuthHealth.Ok, failAfter(0))
        assertEquals(AuthHealth.Ok, failAfter(5))
        assertEquals(AuthHealth.Degraded(3), failAfter(5))

        tracker.recordSuccess()
        assertEquals(AuthHealth.Ok, tracker.health.value)
        assertEquals("the count restarts after a success", AuthHealth.Ok, failAfter(5))

        failAfter(5)
        failAfter(5)
        failAfter(5)
        assertEquals(AuthHealth.SignedOut::class, failAfter(5)::class)
    }

    @Test
    fun `retries inside one refresh interval count once`() {
        tracker.recordFailure()
        repeat(10) { failAfter(0) }
        now += 60_000
        repeat(10) { tracker.recordFailure() }
        assertEquals("401 retries during an outage must not race to a logout", AuthHealth.Ok, tracker.health.value)
    }
}
