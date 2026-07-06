package com.nimbalyst.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionDetailScreenDraftSyncTest {

    @Test
    fun `stale non-empty draft echo is rejected after local edit`() {
        assertFalse(
            shouldApplyRemoteDraft(
                currentDraft = "hello world",
                remoteDraft = "hello wor",
                remoteDraftUpdatedAt = 100L,
                lastSubmitAt = 0L,
                lastLocalEditAt = 200L
            )
        )
    }

    @Test
    fun `stale empty clear is rejected after local edit`() {
        assertFalse(
            shouldApplyRemoteDraft(
                currentDraft = "new prompt",
                remoteDraft = "",
                remoteDraftUpdatedAt = 100L,
                lastSubmitAt = 0L,
                lastLocalEditAt = 200L
            )
        )
    }

    @Test
    fun `shorter prefix echo is rejected defensively`() {
        assertFalse(
            shouldApplyRemoteDraft(
                currentDraft = "hello world",
                remoteDraft = "hello",
                remoteDraftUpdatedAt = 300L,
                lastSubmitAt = 0L,
                lastLocalEditAt = 0L
            )
        )
    }

    @Test
    fun `newer remote draft is accepted`() {
        assertTrue(
            shouldApplyRemoteDraft(
                currentDraft = "local",
                remoteDraft = "remote",
                remoteDraftUpdatedAt = 300L,
                lastSubmitAt = 0L,
                lastLocalEditAt = 200L
            )
        )
    }

    @Test
    fun `newer empty clear is accepted`() {
        assertTrue(
            shouldApplyRemoteDraft(
                currentDraft = "submitted prompt",
                remoteDraft = "",
                remoteDraftUpdatedAt = 300L,
                lastSubmitAt = 250L,
                lastLocalEditAt = 200L
            )
        )
    }
}
