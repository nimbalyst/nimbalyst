package com.nimbalyst.app.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.attachments.PendingAttachment
import com.nimbalyst.app.transcript.TranscriptWebView
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val DRAFT_DEBOUNCE_MS = 500L
private const val DELIVERY_TIMEOUT_MS = 10_000L

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionDetailScreen(
    sessionId: String,
    onBack: () -> Unit
) {
    val context = LocalContext.current
    val app = context.applicationContext as NimbalystApplication
    val coroutineScope = rememberCoroutineScope()
    var draftPrompt by remember { mutableStateOf("") }
    var promptStatus by remember { mutableStateOf<String?>(null) }
    var isSendingPrompt by remember { mutableStateOf(false) }
    var pendingAttachments by remember { mutableStateOf<List<PendingAttachment>>(emptyList()) }
    // Draft sync state
    var isApplyingRemoteDraft by remember { mutableStateOf(false) }
    var lastSubmitAt by remember { mutableLongStateOf(0L) }
    // Timestamp of the user's most recent keystroke. Guards the remote-apply
    // LaunchedEffect against overwriting live typing with a stale echo of an
    // earlier debounced push. Without this, "hello world" → server echoes
    // "hello wor" back mid-typing → local text jumps back to "hello wor",
    // producing the dropped-words behavior.
    var lastLocalEditAt by remember { mutableLongStateOf(0L) }
    var draftDebounceJob by remember { mutableStateOf<Job?>(null) }
    // Delivery timeout state
    var deliveryWarning by remember { mutableStateOf<String?>(null) }
    var deliveryTimeoutJob by remember { mutableStateOf<Job?>(null) }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val bitmap = decodeBitmap(context, uri)
        if (bitmap == null) {
            promptStatus = "Failed to load the selected image."
        } else {
            pendingAttachments = pendingAttachments + PendingAttachment(bitmap = bitmap)
            promptStatus = "Added photo attachment."
        }
    }
    val cameraPreviewLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.TakePicturePreview()
    ) { bitmap ->
        if (bitmap != null) {
            pendingAttachments = pendingAttachments + PendingAttachment(
                bitmap = bitmap,
                filename = "camera.jpg"
            )
            promptStatus = "Captured camera attachment."
        }
    }

    val sessions by app.repository.observeActiveSessions().collectAsState(initial = emptyList())
    val session = sessions.firstOrNull { it.id == sessionId }
    val messages by app.repository.observeMessagesForSession(sessionId)
        .collectAsState(initial = emptyList())
    val queuedPrompts by app.repository.observeQueuedPromptsForSession(sessionId)
        .collectAsState(initial = emptyList())

    LaunchedEffect(sessionId) {
        AnalyticsManager.capture("mobile_session_viewed")
        app.syncManager.joinSessionRoom(sessionId)
    }

    DisposableEffect(sessionId) {
        onDispose {
            draftDebounceJob?.cancel()
            deliveryTimeoutJob?.cancel()
            app.syncManager.leaveSessionRoom()
        }
    }

    LaunchedEffect(sessionId, messages.lastOrNull()?.createdAt) {
        val readAt = messages.lastOrNull()?.createdAt ?: session?.lastMessageAt ?: return@LaunchedEffect
        app.repository.markSessionRead(sessionId, readAt)
    }

    // Seed compose text from synced draft on enter
    LaunchedEffect(sessionId) {
        val existingDraft = app.repository.getSession(sessionId)?.draftInput
        if (draftPrompt.isEmpty() && !existingDraft.isNullOrBlank()) {
            isApplyingRemoteDraft = true
            draftPrompt = existingDraft
            isApplyingRemoteDraft = false
        }
    }

    // Apply incoming remote draft updates
    LaunchedEffect(session?.draftInput, session?.draftUpdatedAt) {
        val remoteDraft = session?.draftInput ?: ""
        if (remoteDraft == draftPrompt) return@LaunchedEffect
        val remoteTs = session?.draftUpdatedAt ?: 0L
        // Reject remote drafts that don't strictly beat both our last submit AND
        // our most recent keystroke. lastLocalEditAt is the critical guard here:
        // without it, a stale server echo (which necessarily has an older ts than
        // the keystrokes typed after the echoed push was sent) would clobber the
        // in-flight text.
        val localFrontier = maxOf(lastSubmitAt, lastLocalEditAt)
        if (remoteDraft.isNotEmpty() && remoteTs <= localFrontier) return@LaunchedEffect

        isApplyingRemoteDraft = true
        draftPrompt = remoteDraft
        isApplyingRemoteDraft = false
    }

    // Cancel delivery timeout when desktop starts executing
    LaunchedEffect(session?.isExecuting) {
        if (session?.isExecuting == true) {
            deliveryTimeoutJob?.cancel()
            deliveryTimeoutJob = null
            deliveryWarning = null
        }
    }

    val sessionTitle = session?.titleDecrypted ?: "Untitled session"

    val submitPrompt = { promptText: String, attachments: List<PendingAttachment> ->
        coroutineScope.launch {
            // Clear draft immediately before sending to prevent stale echo
            draftDebounceJob?.cancel()
            draftDebounceJob = null
            lastSubmitAt = System.currentTimeMillis()
            launch { app.syncManager.updateDraftInput(sessionId, "") }

            isSendingPrompt = true
            AnalyticsManager.capture(
                "mobile_ai_message_sent",
                mapOf(
                    "hasAttachments" to attachments.isNotEmpty(),
                    "attachmentCount" to attachments.size
                )
            )
            val result = app.syncManager.sendPrompt(
                sessionId = sessionId,
                text = promptText,
                attachments = attachments
            )
            result.onSuccess {
                draftPrompt = ""
                pendingAttachments = emptyList()
                promptStatus = "Prompt queued on desktop."

                // Start delivery timeout -- warn if desktop doesn't start executing within 10s
                deliveryTimeoutJob?.cancel()
                deliveryTimeoutJob = launch {
                    delay(DELIVERY_TIMEOUT_MS)
                    if (session?.isExecuting != true) {
                        deliveryWarning = "Your prompt was sent but the desktop hasn't started processing it. Make sure the desktop app is running and connected."
                    }
                }
            }.onFailure { error ->
                // Restore draft so user doesn't lose their text
                draftPrompt = promptText
                promptStatus = error.message ?: "Failed to queue prompt."
            }
            isSendingPrompt = false
        }
    }

    // Delivery warning dialog
    if (deliveryWarning != null) {
        AlertDialog(
            onDismissRequest = { deliveryWarning = null },
            title = { Text("Delivery Warning") },
            text = { Text(deliveryWarning ?: "") },
            confirmButton = {
                TextButton(onClick = { deliveryWarning = null }) {
                    Text("OK")
                }
            }
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        TopAppBar(
            title = {
                Column {
                    Text(
                        text = sessionTitle,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleMedium
                    )
                    if (session != null) {
                        Text(
                            text = "${session.provider ?: "unknown"} -- ${session.mode ?: "agent"}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            }
        )

        TranscriptWebView(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            sessionId = sessionId,
            sessionTitle = sessionTitle,
            provider = session?.provider ?: "unknown",
            model = session?.model ?: "unknown",
            mode = session?.mode ?: "agent",
            messages = messages,
            onPromptSubmitted = { text -> submitPrompt(text, emptyList()) },
            onInteractiveResponse = { bridgeMessage ->
                coroutineScope.launch {
                    val promptId = bridgeMessage.promptId
                        ?: bridgeMessage.requestId
                        ?: bridgeMessage.questionId
                        ?: bridgeMessage.proposalId
                        ?: ""
                    val action = bridgeMessage.action
                    if (promptId.isBlank() || action.isNullOrBlank()) {
                        promptStatus = "Transcript sent an invalid interactive response."
                    } else {
                        val result = app.syncManager.handleInteractiveResponse(
                            sessionId = sessionId,
                            action = action,
                            promptId = promptId,
                            body = bridgeMessage.raw
                        )
                        result.onSuccess {
                            promptStatus = "Interactive response sent to desktop."
                        }.onFailure { error ->
                            promptStatus = error.message ?: "Failed to send interactive response."
                        }
                    }
                }
            }
        )

        // Compose bar
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp)
        ) {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                if (queuedPrompts.isNotEmpty()) {
                    Text(
                        text = "${queuedPrompts.size} prompt${if (queuedPrompts.size > 1) "s" else ""} queued",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary
                    )
                }

                OutlinedTextField(
                    value = draftPrompt,
                    onValueChange = { newText ->
                        draftPrompt = newText
                        // Debounced draft sync push (skip if applying remote draft)
                        if (!isApplyingRemoteDraft) {
                            // Mark the local edit frontier so any concurrent stale
                            // remote echo is rejected by the remote-apply guard above.
                            lastLocalEditAt = System.currentTimeMillis()
                            draftDebounceJob?.cancel()
                            draftDebounceJob = coroutineScope.launch {
                                delay(DRAFT_DEBOUNCE_MS)
                                app.syncManager.updateDraftInput(sessionId, newText)
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isSendingPrompt,
                    minLines = 1,
                    maxLines = 6,
                    placeholder = { Text("Send prompt to desktop") }
                )

                if (pendingAttachments.isNotEmpty()) {
                    pendingAttachments.forEach { attachment ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = attachment.filename,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.weight(1f)
                            )
                            OutlinedButton(
                                onClick = {
                                    pendingAttachments = pendingAttachments.filterNot {
                                        it.id == attachment.id
                                    }
                                }
                            ) {
                                Text("Remove")
                            }
                        }
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    OutlinedButton(
                        onClick = {
                            photoPickerLauncher.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                            )
                        },
                        enabled = !isSendingPrompt
                    ) {
                        Text("Photo")
                    }
                    OutlinedButton(
                        onClick = { cameraPreviewLauncher.launch(null) },
                        enabled = !isSendingPrompt
                    ) {
                        Text("Camera")
                    }
                    Spacer(modifier = Modifier.weight(1f))
                    Button(
                        enabled = !isSendingPrompt && (draftPrompt.isNotBlank() || pendingAttachments.isNotEmpty()),
                        onClick = { submitPrompt(draftPrompt, pendingAttachments) }
                    ) {
                        Text(if (isSendingPrompt) "Sending..." else "Send")
                    }
                }

                promptStatus?.let { status ->
                    Text(
                        text = status,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

private fun decodeBitmap(context: Context, uri: Uri): Bitmap? {
    return runCatching {
        val source = ImageDecoder.createSource(context.contentResolver, uri)
        ImageDecoder.decodeBitmap(source)
    }.getOrNull()
}
