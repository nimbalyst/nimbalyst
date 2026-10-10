package com.nimbalyst.app.ui.sessiondetail

import android.app.Application
import android.graphics.Bitmap
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.attachments.AttachmentStore
import com.nimbalyst.app.attachments.PendingAttachment
import com.nimbalyst.app.attachments.StoredAttachment
import com.nimbalyst.app.data.MessageEntity
import com.nimbalyst.app.data.QueuedPromptEntity
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.sync.SessionCreationOutcome
import com.nimbalyst.app.sync.SyncedActionPrompt
import com.nimbalyst.app.transcript.TranscriptBridgeMessage
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A pending attachment with its decoded image, for the preview bar and the send. */
data class ComposeAttachment(val stored: StoredAttachment, val bitmap: Bitmap)

/**
 * Owns the session detail state that must outlive the composable: the send and
 * its delivery tracking (a send in flight survives rotation), the draft sync
 * debounce, and the decoded attachments. Lives in a bounded per-session store
 * ([SessionDetailStores]); the compose state it edits outlives it there.
 */
class SessionDetailViewModel(
    application: Application,
    /** Held by [SessionDetailStores], so it outlives this ViewModel. */
    val compose: SessionComposeState,
    val sessionId: String,
) : AndroidViewModel(application) {
    private val app = application as NimbalystApplication
    private val repository = app.repository
    private val syncManager = app.syncManager

    val session: StateFlow<SessionEntity?> = repository.observeSession(sessionId)
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)
    val messages: StateFlow<List<MessageEntity>> = repository.observeMessagesForSession(sessionId)
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val queuedPrompts: StateFlow<List<QueuedPromptEntity>> = repository.observeQueuedPromptsForSession(sessionId)
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    private val project = combine(session, repository.observeProjects()) { row, projects ->
        row?.let { current -> projects.firstOrNull { it.id == current.projectId } }
    }

    /** Slash-command typeahead source, from the project config the desktop syncs. */
    val commands: StateFlow<List<SlashCommand>> = project.map { it?.commandsJson }.distinctUntilChanged()
        .map { ProjectConfig.commands(it) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** Actions the phone can run; worktree launchers are filtered out. */
    val actions: StateFlow<List<SyncedActionPrompt>> = project.map { it?.actionsJson }.distinctUntilChanged()
        .map { ProjectConfig.mobileActions(it) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    private val _attachments = MutableStateFlow<List<ComposeAttachment>>(emptyList())
    val attachments: StateFlow<List<ComposeAttachment>> = _attachments.asStateFlow()

    private val _sendError = MutableStateFlow<String?>(null)
    val sendError: StateFlow<String?> = _sendError.asStateFlow()

    /** Transient notices, shown as a toast then cleared. */
    private val _notice = MutableStateFlow<SessionNotice?>(null)
    val notice: StateFlow<SessionNotice?> = _notice.asStateFlow()

    /** The session a launcher action created, for the host to navigate to; cleared by [consumeOpenSession]. */
    private val _openSession = MutableStateFlow<String?>(null)
    val openSession: StateFlow<String?> = _openSession.asStateFlow()

    private val _sessionCreateError = MutableStateFlow<String?>(null)
    val sessionCreateError: StateFlow<String?> = _sessionCreateError.asStateFlow()

    val delivery = PromptDeliveryTracker()
    val deliveryWarning: StateFlow<Boolean> = delivery.warning

    /** Sends outlive this ViewModel: leaving mid-send must not cancel it or lose the text. */
    private val submission = PromptSubmission(
        scope = app.applicationScope,
        compose = compose,
        writeDraft = { syncManager.updateDraftInput(sessionId, it) }
    )

    private var draftDebounceJob: Job? = null
    private var pendingDraft: String? = null
    private var deliveryTimeoutJob: Job? = null
    private var isFocused = false

    init {
        AnalyticsManager.capture("mobile_session_viewed")
        viewModelScope.launch { restoreAttachments() }
        viewModelScope.launch {
            session.collect { row ->
                if (row == null) return@collect
                delivery.observeSession(sessionId, row.isExecuting, row.hasQueuedPrompts, row.pendingExecution)
                // The first row seeds the synced draft. Later rows never replace
                // text under an active IME; they are reconciled on blur.
                if (!isFocused) compose.applyRemoteDraft(row.draftInput, row.draftUpdatedAt)
            }
        }
        viewModelScope.launch {
            messages.collect { delivery.observeMessages(it) }
        }
        // Transitions catch a short turn the conflated row flow can skip entirely.
        viewModelScope.launch {
            syncManager.executionTransitions.collect { transition ->
                delivery.observeSession(
                    sessionId = transition.sessionId,
                    isExecuting = transition.isExecuting,
                    hasQueuedPrompts = null,
                    pendingExecution = transition.pendingExecution
                )
            }
        }
    }

    fun onFocusChanged(focused: Boolean) {
        isFocused = focused
        if (!focused) {
            session.value?.let { compose.applyRemoteDraft(it.draftInput, it.draftUpdatedAt) }
        }
    }

    fun onTextChange(newText: String) {
        if (!compose.edit(newText, System.currentTimeMillis())) return
        pendingDraft = newText
        draftDebounceJob?.cancel()
        draftDebounceJob = viewModelScope.launch {
            delay(DRAFT_DEBOUNCE_MS)
            pendingDraft = null
            syncManager.updateDraftInput(sessionId, newText)
        }
    }

    /**
     * Apply a picked action, mirroring iOS `ComposeBar.insert`. A launcher opens
     * a new session; anything else prefills the composer and never sends, since
     * the user has not read the full prompt on a phone.
     */
    fun applyAction(action: SyncedActionPrompt) {
        if (action.launchesNewSession) launchAction(action) else onTextChange(action.body)
    }

    private fun launchAction(action: SyncedActionPrompt) {
        val row = session.value ?: return
        syncManager.createSession(ProjectConfig.launchOptions(action, row))
            .onFailure { _sessionCreateError.value = it.message.orEmpty() }
            .onSuccess { requestId ->
                AnalyticsManager.capture(
                    "mobile_action_prompt_launched_new_session",
                    mapOf("model" to (action.model ?: "inherit"))
                )
                _notice.value = SessionNotice.SessionStarting
                viewModelScope.launch {
                    when (val outcome = syncManager.awaitSessionCreation(requestId)) {
                        is SessionCreationOutcome.Created -> _openSession.value = outcome.sessionId
                        is SessionCreationOutcome.Failed -> _sessionCreateError.value = outcome.message
                    }
                }
            }
    }

    fun consumeOpenSession() {
        _openSession.value = null
    }

    fun dismissSessionCreateError() {
        _sessionCreateError.value = null
    }

    /** The Stop button: cancel the running turn on the desktop. */
    fun stop() {
        AnalyticsManager.capture("mobile_session_cancelled")
        viewModelScope.launch {
            syncManager.cancelSession(sessionId).onFailure { _stopError.value = it.message.orEmpty() }
        }
    }

    private val _stopError = MutableStateFlow<String?>(null)
    val stopError: StateFlow<String?> = _stopError.asStateFlow()

    fun dismissStopError() {
        _stopError.value = null
    }

    /**
     * Send or queue a prompt. The composer is cleared immediately; on failure
     * the text and attachments come back, even if the user has left the
     * session. Never resends on its own.
     */
    fun submit() {
        val promptText = compose.text.trim()
        val sending = _attachments.value
        if (promptText.isEmpty() && sending.isEmpty()) return

        draftDebounceJob?.cancel()
        draftDebounceJob = null
        pendingDraft = null
        compose.lastSubmitAt = System.currentTimeMillis()
        compose.setText("")
        setAttachments(emptyList())
        send(promptText, sending, clearDraft = true)
    }

    /** A prompt submitted from inside the transcript; the composer is untouched unless the send fails. */
    fun sendTranscriptPrompt(text: String) {
        val promptText = text.trim()
        if (promptText.isNotEmpty()) send(promptText, emptyList(), clearDraft = false)
    }

    private fun send(promptText: String, sending: List<ComposeAttachment>, clearDraft: Boolean) {
        val now = System.currentTimeMillis()

        val requestId = delivery.begin(
            sessionId = sessionId,
            isExecuting = session.value?.isExecuting == true,
            messages = messages.value,
            now = now,
            pendingExecution = session.value?.pendingExecution
        )
        submission.start(
            promptText = promptText,
            attachments = sending.map { it.stored },
            clearDraft = clearDraft,
            send = {
                syncManager.sendPrompt(
                    sessionId = sessionId,
                    text = promptText,
                    attachments = sending.map {
                        PendingAttachment(bitmap = it.bitmap, filename = it.stored.filename, id = it.stored.id)
                    }
                )
            },
            beforeRestore = {
                draftDebounceJob?.cancel()
                draftDebounceJob = null
                pendingDraft = null
            },
            onResult = { result ->
                result.onSuccess {
                    AnalyticsManager.capture(
                        "mobile_ai_message_sent",
                        mapOf("hasAttachments" to sending.isNotEmpty(), "attachmentCount" to sending.size)
                    )
                    withContext(Dispatchers.IO) { sending.forEach { AttachmentStore.delete(it.stored) } }
                    if (delivery.sent(requestId)) {
                        deliveryTimeoutJob?.cancel()
                        deliveryTimeoutJob = viewModelScope.launch {
                            delay(DELIVERY_TIMEOUT_MS)
                            delivery.expire(requestId)
                        }
                    }
                }.onFailure { error ->
                    delivery.failed(requestId)
                    // The submission already put the text and files back in the compose state.
                    _attachments.update { sending + it.filterNot { current -> current in sending } }
                    // Blank selects the generic message; null would hide the dialog.
                    _sendError.value = error.message.orEmpty()
                }
            }
        )
    }

    fun sendInteractiveResponse(message: TranscriptBridgeMessage) {
        val promptId = message.promptId ?: message.requestId ?: message.questionId ?: message.proposalId
        val action = message.action
        if (promptId.isNullOrBlank() || action.isNullOrBlank()) {
            _notice.value = SessionNotice.InteractiveInvalid
            return
        }
        syncManager.handleInteractiveResponse(
            sessionId = sessionId,
            action = action,
            promptId = promptId,
            body = message.raw
        ).onFailure { _notice.value = SessionNotice.InteractiveFailed }
    }

    fun dismissSendError() {
        _sendError.value = null
    }

    fun dismissDeliveryWarning() = delivery.dismissWarning()

    fun dismissNotice() {
        _notice.value = null
    }

    val canAddAttachment: Boolean get() = _attachments.value.size < MAX_ATTACHMENTS
    val remainingAttachmentSlots: Int get() = (MAX_ATTACHMENTS - _attachments.value.size).coerceAtLeast(0)

    fun addImages(uris: List<Uri>, filename: String = "photo.jpg") {
        if (uris.isEmpty()) return
        viewModelScope.launch {
            val accepted = uris.take(remainingAttachmentSlots)
            val added = withContext(Dispatchers.IO) {
                accepted.mapNotNull { uri ->
                    AttachmentStore.decode(app, uri)?.let { store(it, filename) }
                }
            }
            appendAttachments(added)
            _notice.value = when {
                added.size < accepted.size -> SessionNotice.LoadFailed
                accepted.size < uris.size -> SessionNotice.LimitReached
                else -> null
            }
        }
    }

    /** A target file for a full-resolution capture, remembered across process death. */
    fun prepareCameraCapture(): File {
        val file = AttachmentStore.newCameraFile(app)
        compose.pendingCameraPath = file.absolutePath
        return file
    }

    fun onCameraResult(captured: Boolean) {
        val path = compose.pendingCameraPath ?: return
        compose.pendingCameraPath = null
        val file = File(path)
        viewModelScope.launch {
            val added = withContext(Dispatchers.IO) {
                val bitmap = if (captured) AttachmentStore.decode(file) else null
                file.delete()
                bitmap?.let { store(it, "camera.jpg") }
            }
            if (added != null) appendAttachments(listOf(added)) else if (captured) {
                _notice.value = SessionNotice.LoadFailed
            }
        }
    }

    fun onClipboardEmpty() {
        _notice.value = SessionNotice.ClipboardEmpty
    }

    fun removeAttachment(id: String) {
        val removed = _attachments.value.firstOrNull { it.stored.id == id } ?: return
        setAttachments(_attachments.value - removed)
        viewModelScope.launch(Dispatchers.IO) { AttachmentStore.delete(removed.stored) }
    }

    override fun onCleared() {
        // Commit a debounced draft the user typed just before leaving.
        val draft = pendingDraft
        draftDebounceJob?.cancel()
        if (draft != null) {
            app.applicationScope.launch { syncManager.updateDraftInput(sessionId, draft) }
        }
        delivery.cancel()
        super.onCleared()
    }

    private fun store(bitmap: Bitmap, filename: String): ComposeAttachment? =
        AttachmentStore.save(app, sessionId, bitmap, filename)?.let { ComposeAttachment(it, bitmap) }

    private suspend fun restoreAttachments() {
        val stored = compose.attachments
        if (stored.isEmpty()) return
        val loaded = withContext(Dispatchers.IO) {
            stored.mapNotNull { ref -> AttachmentStore.load(ref)?.let { ComposeAttachment(ref, it) } }
        }
        // Attachments added while loading are kept after the restored ones.
        val restoredIds = loaded.mapTo(HashSet()) { it.stored.id }
        setAttachments(loaded + _attachments.value.filterNot { it.stored.id in restoredIds })
    }

    private fun appendAttachments(added: List<ComposeAttachment>) {
        if (added.isEmpty()) return
        setAttachments((_attachments.value + added).take(MAX_ATTACHMENTS))
    }

    private fun setAttachments(list: List<ComposeAttachment>) {
        _attachments.update { list }
        compose.attachments = list.map { it.stored }
    }

    companion object {
        const val MAX_ATTACHMENTS = 10
        private const val DRAFT_DEBOUNCE_MS = 500L
        private const val DELIVERY_TIMEOUT_MS = 10_000L

        fun factory(sessionId: String, compose: SessionComposeState): ViewModelProvider.Factory = viewModelFactory {
            initializer {
                SessionDetailViewModel(
                    application = this[ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY]!!,
                    compose = compose,
                    sessionId = sessionId
                )
            }
        }
    }
}

enum class SessionNotice { LoadFailed, LimitReached, ClipboardEmpty, InteractiveInvalid, InteractiveFailed, SessionStarting }
