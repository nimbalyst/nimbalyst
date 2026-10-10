package com.nimbalyst.app.ui

import android.widget.Toast
import androidx.annotation.VisibleForTesting
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.FormatListNumbered
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.HasDefaultViewModelProviderFactory
import androidx.lifecycle.viewmodel.CreationExtras
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.R
import com.nimbalyst.app.documents.DocumentFileSheet
import com.nimbalyst.app.transcript.TranscriptPrompt
import com.nimbalyst.app.transcript.TranscriptWebView
import com.nimbalyst.app.transcript.rememberTranscriptController
import com.nimbalyst.app.ui.navigation.DocumentSurfaceMarker
import com.nimbalyst.app.ui.sessiondetail.ActionPickerSheet
import com.nimbalyst.app.ui.sessiondetail.ComposeBar
import com.nimbalyst.app.ui.sessiondetail.PromptPickerSheet
import com.nimbalyst.app.ui.sessiondetail.QueuedPromptsList
import com.nimbalyst.app.ui.sessiondetail.SessionDetailStores
import com.nimbalyst.app.ui.sessiondetail.SessionDetailViewModel
import com.nimbalyst.app.ui.sessiondetail.SessionNotice
import com.nimbalyst.app.ui.sessiondetail.SessionStatusBar
import com.nimbalyst.app.ui.sessiondetail.rememberAttachmentLaunchers
import com.nimbalyst.app.ui.theme.NimbalystColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val PROMPT_LIST_REFRESH_DEBOUNCE_MS = 500L

@VisibleForTesting
internal fun shouldApplyRemoteDraft(
    currentDraft: String,
    remoteDraft: String,
    remoteDraftUpdatedAt: Long?,
    lastSubmitAt: Long,
    lastLocalEditAt: Long
): Boolean {
    if (remoteDraft == currentDraft) return false
    if (remoteDraft.isNotEmpty() && currentDraft.startsWith(remoteDraft) && currentDraft.length > remoteDraft.length) {
        return false
    }

    val remoteTs = remoteDraftUpdatedAt ?: 0L
    if (remoteDraft.isNotEmpty() && remoteTs <= lastSubmitAt) return false
    if (lastLocalEditAt > 0L && remoteTs <= lastLocalEditAt) return false

    return true
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionDetailScreen(
    sessionId: String,
    onBack: () -> Unit,
    /** Opens a session a launcher action created. Hosts should push it like a list selection. */
    onOpenSession: (String) -> Unit = {},
) {
    val context = LocalContext.current
    var openFilePath by rememberSaveable(sessionId) { mutableStateOf<String?>(null) }
    val app = context.applicationContext as NimbalystApplication
    // Each session's ViewModel lives in a bounded per-session store, not the
    // Activity's, so leaving sessions releases their collectors and bitmaps.
    val stores: SessionDetailStores = viewModel()
    val activityOwner = checkNotNull(LocalViewModelStoreOwner.current)
    val sessionOwner = remember(sessionId) { stores.owner(sessionId) }
    val viewModel: SessionDetailViewModel = viewModel(
        viewModelStoreOwner = sessionOwner,
        key = "session-detail",
        factory = remember(sessionId) { SessionDetailViewModel.factory(sessionId, stores.composeState(sessionId)) },
        extras = (activityOwner as? HasDefaultViewModelProviderFactory)?.defaultViewModelCreationExtras
            ?: CreationExtras.Empty
    )
    val coroutineScope = rememberCoroutineScope()
    val transcriptController = rememberTranscriptController()
    val launchers = rememberAttachmentLaunchers(viewModel)

    val session by viewModel.session.collectAsState()
    val messages by viewModel.messages.collectAsState()
    val queuedPrompts by viewModel.queuedPrompts.collectAsState()
    val attachments by viewModel.attachments.collectAsState()
    val sendError by viewModel.sendError.collectAsState()
    val deliveryWarning by viewModel.deliveryWarning.collectAsState()
    val notice by viewModel.notice.collectAsState()
    val commands by viewModel.commands.collectAsState()
    val actions by viewModel.actions.collectAsState()
    val openSession by viewModel.openSession.collectAsState()
    val sessionCreateError by viewModel.sessionCreateError.collectAsState()
    val stopError by viewModel.stopError.collectAsState()

    var promptList by remember { mutableStateOf<List<TranscriptPrompt>>(emptyList()) }
    var showPromptPicker by rememberSaveable { mutableStateOf(false) }
    var showTitleMenu by remember { mutableStateOf(false) }
    var showOverflowMenu by remember { mutableStateOf(false) }
    var showActionPicker by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(sessionId) {
        app.syncManager.joinSessionRoom(sessionId)
    }

    DisposableEffect(sessionId) {
        onDispose {
            app.syncManager.leaveSessionRoom(expectedSessionId = sessionId)
        }
    }

    LaunchedEffect(sessionId, messages.lastOrNull()?.createdAt) {
        val readAt = messages.lastOrNull()?.createdAt ?: session?.lastMessageAt ?: return@LaunchedEffect
        app.syncManager.markSessionRead(sessionId, readAt)
    }

    // Debounced so a burst of synced messages is one bridge call.
    LaunchedEffect(messages.size) {
        delay(PROMPT_LIST_REFRESH_DEBOUNCE_MS)
        promptList = transcriptController.getPromptList()
    }

    LaunchedEffect(openSession) {
        val created = openSession ?: return@LaunchedEffect
        viewModel.consumeOpenSession()
        onOpenSession(created)
    }

    LaunchedEffect(notice) {
        val current = notice ?: return@LaunchedEffect
        val message = when (current) {
            SessionNotice.LoadFailed -> context.getString(R.string.session_detail_attachment_load_failed)
            SessionNotice.LimitReached -> context.getString(
                R.string.session_detail_attachment_limit,
                SessionDetailViewModel.MAX_ATTACHMENTS
            )
            SessionNotice.ClipboardEmpty -> context.getString(R.string.session_detail_clipboard_empty)
            SessionNotice.InteractiveInvalid -> context.getString(R.string.session_detail_interactive_invalid)
            SessionNotice.InteractiveFailed -> context.getString(R.string.session_detail_interactive_failed)
            SessionNotice.SessionStarting -> context.getString(R.string.session_detail_session_starting)
        }
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
        viewModel.dismissNotice()
    }

    val sessionTitle = session?.titleDecrypted ?: stringResource(R.string.session_detail_untitled)

    sendError?.let { error ->
        AlertDialog(
            onDismissRequest = viewModel::dismissSendError,
            title = { Text(stringResource(R.string.session_detail_send_error_title)) },
            text = {
                Text(
                    if (error.isBlank()) {
                        stringResource(R.string.session_detail_send_error_unknown)
                    } else {
                        stringResource(R.string.session_detail_send_error, error)
                    }
                )
            },
            confirmButton = {
                TextButton(onClick = viewModel::dismissSendError) { Text(stringResource(R.string.session_detail_ok)) }
            }
        )
    }

    sessionCreateError?.let { error ->
        AlertDialog(
            onDismissRequest = viewModel::dismissSessionCreateError,
            title = { Text(stringResource(R.string.session_detail_session_create_failed_title)) },
            text = { Text(error.ifBlank { stringResource(R.string.session_detail_session_create_failed) }) },
            confirmButton = {
                TextButton(onClick = viewModel::dismissSessionCreateError) {
                    Text(stringResource(R.string.session_detail_ok))
                }
            }
        )
    }

    stopError?.let { error ->
        AlertDialog(
            onDismissRequest = viewModel::dismissStopError,
            text = {
                Text(
                    if (error.isBlank()) {
                        stringResource(R.string.session_detail_stop_failed_unknown)
                    } else {
                        stringResource(R.string.session_detail_stop_failed, error)
                    }
                )
            },
            confirmButton = {
                TextButton(onClick = viewModel::dismissStopError) { Text(stringResource(R.string.session_detail_ok)) }
            }
        )
    }

    if (showActionPicker) {
        ActionPickerSheet(
            actions = actions,
            onSelect = { action ->
                showActionPicker = false
                viewModel.applyAction(action)
            },
            onDismiss = { showActionPicker = false }
        )
    }

    if (deliveryWarning) {
        AlertDialog(
            onDismissRequest = viewModel::dismissDeliveryWarning,
            title = { Text(stringResource(R.string.session_detail_delivery_warning_title)) },
            text = { Text(stringResource(R.string.session_detail_delivery_warning)) },
            confirmButton = {
                TextButton(onClick = viewModel::dismissDeliveryWarning) {
                    Text(stringResource(R.string.session_detail_ok))
                }
            }
        )
    }

    if (showPromptPicker) {
        PromptPickerSheet(
            prompts = promptList,
            onSelect = { prompt ->
                showPromptPicker = false
                transcriptController.scrollToMessage(prompt.index)
            },
            onDismiss = { showPromptPicker = false }
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .imePadding()
    ) {
        TopAppBar(
            colors = TopAppBarDefaults.topAppBarColors(containerColor = NimbalystColors.backgroundSecondary),
            title = {
                Box {
                    Text(
                        text = sessionTitle,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.clickable { showTitleMenu = true }
                    )
                    DropdownMenu(expanded = showTitleMenu, onDismissRequest = { showTitleMenu = false }) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.session_detail_scroll_to_top)) },
                            leadingIcon = { Icon(Icons.Filled.ArrowUpward, contentDescription = null) },
                            onClick = {
                                showTitleMenu = false
                                transcriptController.scrollToTop()
                            }
                        )
                    }
                }
            },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(
                        Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = stringResource(R.string.session_detail_back)
                    )
                }
            },
            actions = {
                Box {
                    IconButton(onClick = {
                        showOverflowMenu = true
                        coroutineScope.launch { promptList = transcriptController.getPromptList() }
                    }) {
                        Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.session_detail_more))
                    }
                    DropdownMenu(expanded = showOverflowMenu, onDismissRequest = { showOverflowMenu = false }) {
                        if (promptList.isNotEmpty()) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.session_detail_jump_to_prompt)) },
                                leadingIcon = { Icon(Icons.Filled.FormatListNumbered, contentDescription = null) },
                                onClick = {
                                    showOverflowMenu = false
                                    showPromptPicker = true
                                }
                            )
                        }
                        val provider = session?.provider
                        val model = session?.model
                        if (provider != null && model != null) {
                            if (promptList.isNotEmpty()) HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text(provider) },
                                leadingIcon = { Icon(Icons.Filled.Memory, contentDescription = null) },
                                enabled = false,
                                onClick = {}
                            )
                            DropdownMenuItem(
                                text = { Text(model) },
                                leadingIcon = { Icon(Icons.Filled.AutoAwesome, contentDescription = null) },
                                enabled = false,
                                onClick = {}
                            )
                        }
                    }
                }
            }
        )

        session?.let { SessionStatusBar(session = it) }

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
            onPromptSubmitted = viewModel::sendTranscriptPrompt,
            onInteractiveResponse = viewModel::sendInteractiveResponse,
            controller = transcriptController,
            onOpenFile = { path ->
                if (session?.projectId != null) {
                    openFilePath = path
                } else {
                    Toast.makeText(context, R.string.session_detail_open_file_unavailable, Toast.LENGTH_SHORT).show()
                }
            }
        )

        val projectIdForFile = session?.projectId
        val pathToOpen = openFilePath
        if (projectIdForFile != null && pathToOpen != null) {
            DocumentSurfaceMarker()
            DocumentFileSheet(projectIdForFile, pathToOpen, onDismiss = { openFilePath = null })
        }

        QueuedPromptsList(prompts = queuedPrompts)

        ComposeBar(
            text = viewModel.compose.text,
            onTextChange = viewModel::onTextChange,
            onFocusChanged = viewModel::onFocusChanged,
            attachments = attachments,
            onRemoveAttachment = viewModel::removeAttachment,
            isExecuting = session?.isExecuting == true,
            commands = commands,
            hasActions = actions.isNotEmpty(),
            onOpenActions = { showActionPicker = true },
            onPickPhotos = launchers.pickPhotos,
            onTakePhoto = launchers.takePhoto,
            onPaste = launchers.paste,
            onSubmit = viewModel::submit,
            onStop = viewModel::stop
        )
    }
}
