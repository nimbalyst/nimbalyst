package com.nimbalyst.app.sync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class SyncIngestionQueueTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val errors = mutableListOf<Throwable>()
    private val queue = SyncIngestionQueue(scope, "test") { errors += it }

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Test
    fun `work applies in submission order even when an earlier item is slow`() = runBlocking {
        val applied = mutableListOf<Int>()
        queue.submit { delay(50); applied += 1 }
        queue.submit { applied += 2 }
        queue.awaitIdle()
        assertEquals(listOf(1, 2), applied)
    }

    @Test
    fun `a failing item is reported and ingestion continues`() = runBlocking {
        val applied = mutableListOf<Int>()
        queue.submit { throw IllegalStateException("FOREIGN KEY constraint failed") }
        queue.submit { applied += 2 }
        queue.awaitIdle()
        assertEquals(listOf(2), applied)
        assertEquals("FOREIGN KEY constraint failed", errors.single().message)
    }

    @Test
    fun `reset drops work the previous generation had not applied`() = runBlocking {
        val applied = mutableListOf<Int>()
        queue.submit { delay(200); applied += 1 }
        queue.reset()
        queue.submit { applied += 2 }
        queue.awaitIdle()
        assertEquals(listOf(2), applied)
    }
}
