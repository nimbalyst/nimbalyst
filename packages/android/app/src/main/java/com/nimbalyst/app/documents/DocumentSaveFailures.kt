package com.nimbalyst.app.documents

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nimbalyst.app.R
import com.nimbalyst.app.ui.theme.NimbalystColors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** An edit a closing editor handed over that is not on this device's disk yet. [markdown] is the only copy. */
data class DocumentSaveFailure(
    val projectId: String,
    val relativePath: String,
    val message: String,
    val markdown: String,
    internal val accountKey: String?,
)

private typealias Saver = (projectId: String, relativePath: String, markdown: String) -> SaveOutcome

/**
 * Edits from editors that are gone, held in memory until a save succeeds, so
 * a storage failure or a sign-out between the last keystroke and the save
 * does not drop them silently. An edit belongs to the account it was made
 * under and is only ever saved into that account's cache. Touched only on the
 * manager's dispatcher.
 */
internal class UnsavedEdits {
    private data class Key(val accountKey: String?, val projectId: String, val relativePath: String)

    private val edits = LinkedHashMap<Key, String>()
    private val messages = mutableMapOf<Key, String>()
    /** An edit arriving just after sign-out still belongs to the account that was signed in. */
    private var lastAccountKey: String? = null

    private val _failures = MutableStateFlow<List<DocumentSaveFailure>>(emptyList())
    val failures: StateFlow<List<DocumentSaveFailure>> = _failures.asStateFlow()

    fun save(currentAccountKey: String?, projectId: String, relativePath: String, markdown: String, save: Saver) {
        if (currentAccountKey != null) lastAccountKey = currentAccountKey
        val key = Key(currentAccountKey ?: lastAccountKey, projectId, relativePath)
        edits[key] = markdown
        attempt(key, currentAccountKey, save)
    }

    /** [accountKey] signed in: retry what was left under it. */
    fun retry(accountKey: String, save: Saver) {
        lastAccountKey = accountKey
        edits.keys.filter { it.accountKey == accountKey }.forEach { attempt(it, accountKey, save) }
    }

    fun retryOne(failure: DocumentSaveFailure, currentAccountKey: String?, save: Saver) =
        attempt(failure.key, currentAccountKey, save)

    fun discard(failure: DocumentSaveFailure) {
        edits -= failure.key
        messages -= failure.key
        publish()
    }

    fun content(accountKey: String?, projectId: String, relativePath: String): String? =
        edits[Key(accountKey, projectId, relativePath)]

    private fun attempt(key: Key, currentAccountKey: String?, save: Saver) {
        val markdown = edits[key] ?: return
        val outcome = if (key.accountKey != null && key.accountKey == currentAccountKey) {
            save(key.projectId, key.relativePath, markdown)
        } else {
            SaveOutcome.Failed("File sync is not signed in. These changes are kept until you sign back in.")
        }
        if (outcome is SaveOutcome.Failed) {
            messages[key] = outcome.message
        } else if (edits[key] == markdown) {
            edits -= key
            messages -= key
        }
        publish()
    }

    private fun publish() {
        _failures.value = edits.mapNotNull { (key, markdown) ->
            messages[key]?.let { DocumentSaveFailure(key.projectId, key.relativePath, it, markdown, key.accountKey) }
        }
    }

    private val DocumentSaveFailure.key get() = Key(accountKey, projectId, relativePath)
}

/** Unsaved edits, each with a way to copy the text out, retry, or discard it. */
@Composable
internal fun SaveFailureBanner(
    failures: List<DocumentSaveFailure>,
    onRetry: (DocumentSaveFailure) -> Unit,
    onDiscard: (DocumentSaveFailure) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (failures.isEmpty()) return
    val clipboard = LocalClipboardManager.current
    val shape = RoundedCornerShape(12.dp)
    Column(modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        failures.forEach { failure ->
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(NimbalystColors.background, shape)
                    .border(1.dp, NimbalystColors.warning, shape)
                    .padding(12.dp),
            ) {
                Text(
                    stringResource(R.string.document_save_failed_title, failure.relativePath.substringAfterLast('/')),
                    color = NimbalystColors.text,
                    fontSize = 14.sp,
                )
                Text(failure.message, color = NimbalystColors.textMuted, fontSize = 12.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { clipboard.setText(AnnotatedString(failure.markdown)) }) {
                        Text(stringResource(R.string.document_save_failed_copy))
                    }
                    TextButton(onClick = { onRetry(failure) }) { Text(stringResource(R.string.documents_retry)) }
                    TextButton(onClick = { onDiscard(failure) }) { Text(stringResource(R.string.document_save_failed_discard)) }
                }
            }
        }
    }
}
