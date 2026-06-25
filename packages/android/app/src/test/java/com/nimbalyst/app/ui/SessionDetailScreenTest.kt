package com.nimbalyst.app.ui

import com.nimbalyst.app.data.NimbalystRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionDetailScreenTest {
    @Test
    fun `uses projected transcript tail only when raw session is empty or oversized`() {
        val tail = """[{"type":"assistant_message","text":"Projected tail"}]"""

        assertFalse(shouldUseProjectedTranscriptTail(rawMessageCount = 3_419, transcriptTailJson = tail))
        assertTrue(shouldUseProjectedTranscriptTail(rawMessageCount = 0, transcriptTailJson = tail))
        assertTrue(shouldUseProjectedTranscriptTail(rawMessageCount = 5_001, transcriptTailJson = tail))
        assertFalse(shouldUseProjectedTranscriptTail(rawMessageCount = 20_000, transcriptTailJson = null))
        assertEquals(5_001, NimbalystRepository.MOBILE_SESSION_MESSAGE_LIMIT)
    }
}
