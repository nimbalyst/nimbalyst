package com.nimbalyst.app.ui.sessiondetail

import com.nimbalyst.app.attachments.StoredAttachment
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Runs prompt sends in [scope], which must outlive the session screen:
 * leaving mid-send neither cancels the send nor loses the text, because
 * [compose] outlives the ViewModel too. The cleared draft is written before
 * the send and the restored one after it, in one coroutine, so the empty
 * draft can never land on top of the restore.
 */
internal class PromptSubmission(
    private val scope: CoroutineScope,
    private val compose: SessionComposeState,
    private val writeDraft: suspend (String) -> Unit,
    private val clock: () -> Long = System::currentTimeMillis,
    /** Compose state is snapshot state; it is only touched here. */
    private val main: CoroutineContext = Dispatchers.Main.immediate,
) {
    /**
     * [clearDraft] is set for a composer submit, which emptied the field.
     * On failure the prompt text goes back ahead of anything typed since and
     * [attachments] ahead of any added since; [beforeRestore] runs first on
     * [main] so a pending debounced draft cannot overwrite the restore.
     * [onResult] runs on [main] once the outcome is settled.
     */
    fun start(
        promptText: String,
        attachments: List<StoredAttachment>,
        clearDraft: Boolean,
        send: suspend () -> Result<Unit>,
        beforeRestore: () -> Unit = {},
        onResult: suspend (Result<Unit>) -> Unit = {},
    ): Job = scope.launch {
        if (clearDraft) writeDraft("")
        val result = send()
        if (result.isFailure) {
            val restored = withContext(main) {
                beforeRestore()
                val sentIds = attachments.mapTo(HashSet()) { it.id }
                compose.attachments = attachments + compose.attachments.filterNot { it.id in sentIds }
                compose.restoreFailedSend(promptText, clock())
            }
            writeDraft(restored)
        }
        withContext(main) { onResult(result) }
    }
}
