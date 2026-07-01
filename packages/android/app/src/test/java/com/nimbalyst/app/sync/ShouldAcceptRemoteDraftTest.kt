package com.nimbalyst.app.sync

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the [SyncManager.shouldAcceptRemoteDraft] gate.
 *
 * The gate suppresses self-echoes and stale second-device broadcasts so the
 * mobile prompt input doesn't get overwritten mid-typing by a server round-trip
 * of a value we sent moments earlier.
 *
 * The rule is: incoming timestamp MUST be strictly greater than our last local
 * push timestamp. Equal timestamps are rejected because the server echoes back
 * the exact push timestamp we sent.
 */
class ShouldAcceptRemoteDraftTest {

    @Test
    fun `incoming greater than local push is accepted`() {
        assertTrue(SyncManager.shouldAcceptRemoteDraft(incomingDraftUpdatedAt = 200L, lastLocalPushAt = 100L))
    }

    @Test
    fun `incoming equal to local push is rejected as self-echo`() {
        assertFalse(SyncManager.shouldAcceptRemoteDraft(incomingDraftUpdatedAt = 100L, lastLocalPushAt = 100L))
    }

    @Test
    fun `incoming less than local push is rejected as stale`() {
        assertFalse(SyncManager.shouldAcceptRemoteDraft(incomingDraftUpdatedAt = 50L, lastLocalPushAt = 100L))
    }

    @Test
    fun `null incoming timestamp is rejected`() {
        assertFalse(SyncManager.shouldAcceptRemoteDraft(incomingDraftUpdatedAt = null, lastLocalPushAt = 100L))
    }

    @Test
    fun `null incoming with zero local push is rejected`() {
        // 0 is not strictly greater than 0.
        assertFalse(SyncManager.shouldAcceptRemoteDraft(incomingDraftUpdatedAt = null, lastLocalPushAt = 0L))
    }

    @Test
    fun `any positive incoming is accepted when we have never pushed`() {
        assertTrue(SyncManager.shouldAcceptRemoteDraft(incomingDraftUpdatedAt = 1L, lastLocalPushAt = 0L))
    }

    @Test
    fun `zero incoming with zero local push is rejected`() {
        assertFalse(SyncManager.shouldAcceptRemoteDraft(incomingDraftUpdatedAt = 0L, lastLocalPushAt = 0L))
    }
}
