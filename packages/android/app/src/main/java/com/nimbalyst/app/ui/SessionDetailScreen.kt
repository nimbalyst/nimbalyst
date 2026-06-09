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
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.google.gson.JsonObject
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.attachments.PendingAttachment
import com.nimbalyst.app.transcript.TranscriptWebView
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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

    val session by app.repository.observeSession(sessionId).collectAsState(initial = null)
    val messages by app.repository.observeMessagesForSession(sessionId)
        .collectAsState(initial = emptyList())
    val queuedPrompts by app.repository.observeQueuedPromptsForSession(sessionId)
        .collectAsState(initial = emptyList())
    // Desktop-published transcript tail for oversized sessions whose per-message
    // sync was disabled by the server; rendered in place of the (stale/empty) messages.
    val transcriptTails by app.syncManager.transcriptTails.collectAsState()
    val transcriptTail = transcriptTails[sessionId]
    val transcriptHistoryPages by app.syncManager.transcriptHistoryPages.collectAsState()
    val transcriptHistoryPage = transcriptHistoryPages[sessionId]

    // Sessions with neither synced messages nor projected transcript content
    // would otherwise render an empty transcript. Show a clear hint instead,
    // after a short grace period so it never flashes on load.
    val hasNoContent = messages.isEmpty() &&
        transcriptTail.isNullOrBlank() &&
        transcriptHistoryPage.isNullOrBlank()
    var showEmptyHint by remember(sessionId) { mutableStateOf(false) }
    LaunchedEffect(sessionId, hasNoContent) {
        showEmptyHint = false
        if (hasNoContent) {
            delay(2500)
            showEmptyHint = true
        }
    }

    LaunchedEffect(sessionId) {
        AnalyticsManager.capture("mobile_session_viewed")
        app.syncManager.joinSessionRoom(sessionId)
    }

    DisposableEffect(sessionId) {
        onDispose {
            deliveryTimeoutJob?.cancel()
            app.syncManager.leaveSessionRoom()
        }
    }

    LaunchedEffect(sessionId, messages.lastOrNull()?.createdAt) {
        val readAt = messages.lastOrNull()?.createdAt ?: session?.lastMessageAt ?: return@LaunchedEffect
        app.repository.markSessionRead(sessionId, readAt)
    }

    // Cancel delivery timeout when desktop starts executing
    LaunchedEffect(session?.isExecuting, session?.agentStatusUpdatedAt) {
        if (session?.effectiveIsExecuting() == true) {
            deliveryTimeoutJob?.cancel()
            deliveryTimeoutJob = null
            deliveryWarning = null
        }
    }

    val sessionTitle = session?.titleDecrypted ?: "Untitled session"

    val submitPrompt = { promptText: String, attachments: List<PendingAttachment> ->
        coroutineScope.launch {
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
                promptStatus = "Sent to desktop."

                // Start delivery timeout -- warn if desktop doesn't start executing within 10s
                deliveryTimeoutJob?.cancel()
                deliveryTimeoutJob = launch {
                    delay(DELIVERY_TIMEOUT_MS)
                    if (session?.effectiveIsExecuting() != true) {
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
                    val currentSession = session
                    Text(
                        text = sessionTitle,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleMedium
                    )
                    if (currentSession != null) {
                        Text(
                            text = "${currentSession.provider ?: "unknown"} -- ${currentSession.mode ?: "agent"}",
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

        if (hasNoContent && showEmptyHint) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(24.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "This session isn't synced from your desktop.\n\nVery large sessions sync only a recent-history preview — if it's missing, open the session on your desktop to refresh it.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center
                )
            }
        } else {
            TranscriptWebView(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                sessionId = sessionId,
                sessionTitle = sessionTitle,
                provider = session?.provider ?: "unknown",
                model = session?.model ?: "unknown",
                mode = session?.mode ?: "agent",
                isExecuting = session?.effectiveIsExecuting() == true,
                agentStatusKind = session?.effectiveAgentStatusKind(),
                agentStatusLabel = session?.effectiveAgentStatusLabel(),
                agentStatusDetail = session?.effectiveAgentStatusDetail(),
                messages = messages,
                transcriptTailJson = transcriptTail,
                transcriptHistoryPageJson = transcriptHistoryPage,
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
                },
                onLoadOlderHistory = { beforeRawMessageId ->
                    coroutineScope.launch {
                        app.syncManager.requestTranscriptHistoryPage(
                            sessionId = sessionId,
                            beforeRawMessageId = beforeRawMessageId,
                            count = 240
                        ).onFailure { error ->
                            promptStatus = error.message ?: "Failed to request older history."
                        }
                    }
                }
            )
        }

        // Compose bar. Pad for the navigation bar (edge-to-edge) and the IME so the
        // Send / Photo / Camera buttons are never hidden behind the system nav bar or keyboard.
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))
                .padding(8.dp)
        ) {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                if (queuedPrompts.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            text = "${queuedPrompts.size} prompt${if (queuedPrompts.size > 1) "s" else ""} queued on desktop",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary
                        )
                        queuedPrompts.forEachIndexed { index, queuedPrompt ->
                            val queuedText = queuedPrompt.promptTextDecrypted ?: "Queued prompt"
                            Card(modifier = Modifier.fillMaxWidth()) {
                                Column(
                                    modifier = Modifier.padding(8.dp),
                                    verticalArrangement = Arrangement.spacedBy(6.dp)
                                ) {
                                    Text(
                                        text = "${index + 1}. $queuedText",
                                        style = MaterialTheme.typography.bodySmall,
                                        maxLines = 3,
                                        overflow = TextOverflow.Ellipsis
                                    )
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        OutlinedButton(
                                            onClick = {
                                                coroutineScope.launch {
                                                    val payload = JsonObject().apply {
                                                        addProperty("promptId", queuedPrompt.id)
                                                    }
                                                    val result = app.syncManager.sendSessionControlMessage(
                                                        sessionId = sessionId,
                                                        messageType = "send_queued_prompt_now",
                                                        payload = payload
                                                    )
                                                    promptStatus = result.fold(
                                                        onSuccess = { "Send-now requested." },
                                                        onFailure = { it.message ?: "Failed to request send-now." }
                                                    )
                                                }
                                            }
                                        ) {
                                            Text("Send now")
                                        }
                                        OutlinedButton(
                                            onClick = {
                                                coroutineScope.launch {
                                                    val payload = JsonObject().apply {
                                                        addProperty("promptId", queuedPrompt.id)
                                                    }
                                                    val result = app.syncManager.sendSessionControlMessage(
                                                        sessionId = sessionId,
                                                        messageType = "delete_queued_prompt",
                                                        payload = payload
                                                    )
                                                    result.onSuccess {
                                                        draftPrompt = if (draftPrompt.isBlank()) {
                                                            queuedText
                                                        } else {
                                                            "${draftPrompt.trim()}\n\n$queuedText"
                                                        }
                                                        promptStatus = "Queued prompt moved to textbox."
                                                    }.onFailure { error ->
                                                        promptStatus = error.message ?: "Failed to edit queued prompt."
                                                    }
                                                }
                                            }
                                        ) {
                                            Text("Edit")
                                        }
                                        TextButton(
                                            onClick = {
                                                coroutineScope.launch {
                                                    val payload = JsonObject().apply {
                                                        addProperty("promptId", queuedPrompt.id)
                                                    }
                                                    val result = app.syncManager.sendSessionControlMessage(
                                                        sessionId = sessionId,
                                                        messageType = "delete_queued_prompt",
                                                        payload = payload
                                                    )
                                                    promptStatus = result.fold(
                                                        onSuccess = { "Queued prompt cancelled." },
                                                        onFailure = { it.message ?: "Failed to cancel queued prompt." }
                                                    )
                                                }
                                            }
                                        ) {
                                            Text("Cancel")
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                OutlinedTextField(
                    value = draftPrompt,
                    onValueChange = { newText ->
                        draftPrompt = newText
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
