package com.nimbalyst.app.ui.sessiondetail

import androidx.lifecycle.SavedStateHandle
import com.nimbalyst.app.attachments.StoredAttachment
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class PromptSubmissionTest {
    @Test
    fun `a send that fails after the screen is gone puts the prompt back, and the cleared draft never lands last`() = runBlocking {
        val compose = SessionComposeState(SavedStateHandle())
        val photo = StoredAttachment("a1", "photo.jpg", "/files/a1.jpg")
        val drafts = mutableListOf<String>()
        val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val socketDropped = CompletableDeferred<Result<Unit>>()
        val submission = PromptSubmission(appScope, compose, writeDraft = { drafts += it }, clock = { 42L }, main = Dispatchers.Unconfined)

        val job = submission.start(
            promptText = "hello",
            attachments = listOf(photo),
            clearDraft = true,
            send = { socketDropped.await() }
        )
        // Nothing here depends on the screen: it may be long gone when the send fails.
        socketDropped.complete(Result.failure(IllegalStateException("socket dropped")))
        job.join()

        assertEquals("hello", compose.text)
        assertEquals(listOf(photo), compose.attachments)
        assertEquals(listOf("", "hello"), drafts)
        appScope.cancel()
    }
}
