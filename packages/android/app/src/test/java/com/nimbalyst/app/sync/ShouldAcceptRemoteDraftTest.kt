package com.nimbalyst.app.sync

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShouldAcceptRemoteDraftTest {

    @Test
    fun `incoming greater than local push is accepted`() {
        assertTrue(SessionEntryDecoder.shouldAcceptRemoteDraft(incomingDraftUpdatedAt = 200L, lastLocalPushAt = 100L))
    }

    @Test
    fun `incoming equal to local push is rejected as self echo`() {
        assertFalse(SessionEntryDecoder.shouldAcceptRemoteDraft(incomingDraftUpdatedAt = 100L, lastLocalPushAt = 100L))
    }

    @Test
    fun `incoming less than local push is rejected as stale`() {
        assertFalse(SessionEntryDecoder.shouldAcceptRemoteDraft(incomingDraftUpdatedAt = 50L, lastLocalPushAt = 100L))
    }

    @Test
    fun `missing incoming timestamp is rejected`() {
        assertFalse(SessionEntryDecoder.shouldAcceptRemoteDraft(incomingDraftUpdatedAt = null, lastLocalPushAt = 100L))
    }

    @Test
    fun `positive incoming is accepted when device has never pushed`() {
        assertTrue(SessionEntryDecoder.shouldAcceptRemoteDraft(incomingDraftUpdatedAt = 1L, lastLocalPushAt = 0L))
    }
}
