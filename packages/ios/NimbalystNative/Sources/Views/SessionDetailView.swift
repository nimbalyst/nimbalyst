import SwiftUI
import GRDB
import os
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Session Load Error

enum SessionLoadError {
    case decryptionFailed(decryptedCount: Int, totalCount: Int)
    case syncFailed(String)
    case webViewFailed(String)
    case noMessages
    case timeout(messageCount: Int, webViewReady: Bool, isTranscriptReady: Bool)

    var title: String {
        switch self {
        case .decryptionFailed: return "Decryption Failed"
        case .syncFailed: return "Sync Failed"
        case .webViewFailed: return "Display Error"
        case .noMessages: return "No Messages"
        case .timeout: return "Load Timeout"
        }
    }

    var description: String {
        switch self {
        case .decryptionFailed(let decrypted, let total):
            return "Only \(decrypted) of \(total) messages could be decrypted. The encryption key may be out of sync."
        case .syncFailed(let detail):
            return "Failed to sync session data: \(detail)"
        case .webViewFailed(let detail):
            return "Transcript display error: \(detail)"
        case .noMessages:
            return "No messages received from server. The transcript may not exist yet."
        case .timeout(let msgCount, let wvReady, let trReady):
            return "Transcript did not load within 15s. Local messages: \(msgCount), WebView ready: \(wvReady), Transcript ready: \(trReady)"
        }
    }
}

/// Session detail view with an embedded web transcript and native compose bar.
///
/// Uses GRDB observation to reactively update when:
/// - Session metadata changes (title, executing state)
/// - New messages are synced or appended
///
/// The transcript is rendered by a WKWebView running the shared AgentTranscriptPanel
/// from @nimbalyst/runtime. Swift sends pre-decrypted messages to JS, and JS renders
/// them with full tool call, code block, and interactive widget support.
///
/// Joins the session room on appear and leaves on disappear.
public struct SessionDetailView: View {
    @EnvironmentObject var appState: AppState
    let session: Session
    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "SessionDetailView")

    /// Live session data from GRDB observation.
    @State private var liveSession: Session?
    @State private var sessionCancellable: AnyDatabaseCancellable?

    /// Tracks the last-rendered session id so we can detach observers /
    /// diagnostic handlers / sync rooms scoped to the *previous* session when
    /// `session` is swapped in place (iPad split-view sidebar selection
    /// change). Set in `.onAppear` for the initial render and updated each
    /// time `.onChange(of: session.id)` fires.
    @State private var previousSessionId: String?

    /// Live message list from GRDB observation.
    @State private var messages: [Message] = []
    @State private var messagesCancellable: AnyDatabaseCancellable?
    /// Whether GRDB has emitted the first message snapshot for this session.
    @State private var hasObservedInitialMessages = false
    /// Whether the session room has explicitly reported no transcript messages.
    @State private var serverConfirmedNoMessages = false
    /// Whether the current session room has returned its initial sync response.
    @State private var hasCompletedInitialSessionSync = false

    /// Compose bar state.
    @State private var composeText = ""
    /// Debounce work item for pushing draft input changes to sync.
    @State private var draftDebounceItem: DispatchWorkItem?
    /// Whether we are currently applying a synced draft (suppress push-back).
    @State private var isApplyingRemoteDraft = false
    /// Epoch ms of last local submit -- used to reject stale remote drafts.
    @State private var lastSubmitAt: Int = 0
    /// Epoch ms of last local keystroke -- used to reject stale sync echoes.
    /// Mirrors desktop's sessionDraftLocalModifiedAtAtom pattern.
    @State private var lastLocalEditAt: Int = 0
    /// Whether the compose TextField currently has keyboard focus. While true,
    /// we never overwrite `composeText` from sync -- mutating the binding under
    /// an active TextField reorders characters via IME/autocorrect/dictation
    /// candidate buffers (the "jumbled while typing fast" bug).
    @FocusState private var composeFocused: Bool
    /// Error message shown when prompt send fails.
    @State private var sendError: String?
    /// Warning shown when prompt was sent but desktop hasn't picked it up.
    @State private var deliveryWarning: String?
    /// Timer that fires if desktop doesn't start executing after a prompt send.
    @State private var deliveryTimeoutItem: DispatchWorkItem?

    /// Queued prompts for this session (from GRDB observation).
    @State private var queuedPrompts: [QueuedPrompt] = []
    @State private var queuedPromptsCancellable: AnyDatabaseCancellable?

    /// Slash commands synced from desktop for this project.
    @State private var projectCommands: [SyncedSlashCommand] = []
    @State private var projectCancellable: AnyDatabaseCancellable?

    /// Controller for transcript web view actions (scroll, prompts).
    #if canImport(UIKit)
    @StateObject private var transcriptController = TranscriptController()
    #endif

    /// Cached prompt list for the jump-to-prompt sheet.
    @State private var promptList: [PromptEntry] = []

    /// Whether the jump-to-prompt sheet is presented.
    @State private var showPromptPicker = false

    /// Whether the transcript web view has loaded and rendered its first data.
    @State private var isTranscriptReady = false

    /// Whether the web view JS bridge signalled ready (may fire before messages arrive).
    @State private var isWebViewReady = false

    /// Error state for diagnosing load failures.
    @State private var loadError: SessionLoadError?

    /// Timeout work item for detecting stuck loads.
    @State private var timeoutWorkItem: DispatchWorkItem?

    /// Debounce work item for refreshPromptList to avoid IPC spam.
    @State private var promptRefreshWorkItem: DispatchWorkItem?

    /// Diagnostic info from sync, used in debug copy.
    @State private var lastDiagnostic: SyncManager.SessionSyncDiagnostic?

    /// Document to present in a sheet when a file link is tapped.
    @State private var fileSheetDocument: SyncedDocument?
    /// Toast message when a tapped file is not available on this device.
    @State private var fileNotAvailableToast: String?

    private var displaySession: Session {
        liveSession ?? session
    }

    public init(session: Session) {
        self.session = session
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Status bar
            statusBar

            // Web transcript (iOS) or native fallback (macOS)
            #if canImport(UIKit)
            ZStack {
                TranscriptWebView(
                    session: displaySession,
                    messages: messages,
                    waitForInitialMessages: shouldWaitForInitialTranscriptMessages,
                    onSendPrompt: { text in sendPrompt(text) },
                    onInteractiveResponse: handleInteractiveResponse,
                    controller: transcriptController,
                    onReady: {
                        isWebViewReady = true
                        tryRevealTranscript()
                    },
                    onError: { errorMessage in
                        if loadError == nil {
                            withAnimation {
                                loadError = .webViewFailed(errorMessage)
                            }
                        }
                    },
                    onOpenFile: { filePath in
                        handleOpenFile(filePath)
                    }
                )

                if !isTranscriptReady {
                    if let error = loadError {
                        errorBanner(error: error)
                    } else {
                        VStack(spacing: 12) {
                            ProgressView()
                                .controlSize(.regular)
                                .tint(NimbalystColors.primary)
                            Text("Loading transcript...")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(red: 0x1a/255, green: 0x1a/255, blue: 0x1a/255))
                    }
                }
            }
            #else
            nativeMessageList
            #endif

            // Queued prompts display
            if !queuedPrompts.isEmpty {
                QueuedPromptsList(prompts: queuedPrompts)
            }

            // Compose bar
            //
            // The text binding stamps `lastLocalEditAt` synchronously inside
            // its setter rather than waiting for `onChange(of: composeText)`
            // to fire. SwiftUI fires onChange handlers in declaration order
            // within a single render pass, so a GRDB self-echo arriving in
            // the same pass as a keystroke could otherwise see a stale
            // `lastLocalEditAt`, fail the rejection guard below, and
            // overwrite the just-typed character.
            ComposeBar(
                text: Binding(
                    get: { composeText },
                    set: { newValue in
                        composeText = newValue
                        lastLocalEditAt = Int(Date().timeIntervalSince1970 * 1000)
                    }
                ),
                isExecuting: displaySession.isExecuting,
                commands: projectCommands,
                onSend: sendPrompt,
                onCancel: cancelSession,
                onQueue: { text, attachments in sendPrompt(text, attachments) },
                focused: $composeFocused
            )
        }
        .navigationTitle(displaySession.titleDecrypted ?? "Session")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarTitleMenu {
            Button {
                transcriptController.scrollToTop()
            } label: {
                Label("Scroll to Top", systemImage: "arrow.up")
            }
        }
        #endif
        .toolbar {
            #if os(iOS)
            if let voice = appState.voiceAgent, voice.state != .disconnected {
                ToolbarItem(placement: .principal) {
                    VoiceStatusPill(state: voice.state)
                }
            }
            #endif
            ToolbarItem(placement: .primaryAction) {
                sessionMenu
            }
        }
        .onAppear {
            // First render: remember which session we're bound to so
            // `.onChange(of: session.id)` can detect an in-place swap (iPad
            // sidebar selection) versus the first appearance.
            if previousSessionId == nil {
                previousSessionId = session.id
            }
            startObserving()
            startLoadTimeout()
            subscribeToDiagnostics()
            startObservingQueuedPrompts()
            // Seed compose text from synced draft if local compose is empty
            if composeText.isEmpty, let draft = session.draftInput, !draft.isEmpty {
                isApplyingRemoteDraft = true
                composeText = draft
                DispatchQueue.main.async { isApplyingRemoteDraft = false }
            }
            // Mark session as read when viewing it
            appState.syncManager?.markSessionRead(sessionId: session.id)
            AnalyticsManager.shared.capture("mobile_session_viewed")
        }
        .onChange(of: liveSession?.draftInput) { _ in
            // While the user is actively typing, never overwrite composeText from
            // sync. Externally mutating the TextField binding while it is focused
            // reorders characters via IME/autocorrect/dictation candidate buffers
            // (the "jumbled while typing fast" bug). Pending remote drafts will be
            // applied when focus is lost (see .onChange(of: composeFocused) below).
            guard !composeFocused else { return }
            applyRemoteDraftIfNewer()
        }
        .onChange(of: composeFocused) { focused in
            // When the keyboard is dismissed, reconcile with any draft that
            // arrived from another device while we were typing.
            if !focused {
                applyRemoteDraftIfNewer()
            }
        }
        .onChange(of: session.id) { _ in
            // Without `.id(session.id)` on the iPad split-view detail, SwiftUI
            // reuses this view across sidebar selection changes — so we need
            // to do the teardown/reinit that a fresh mount would otherwise
            // have done. `previousSessionId` is set in `.onAppear` for the
            // initial render, so the first onChange fires here is a real swap.
            guard let oldId = previousSessionId, oldId != session.id else {
                previousSessionId = session.id
                return
            }
            swapSession(fromOldId: oldId)
            previousSessionId = session.id
        }
        .onChange(of: composeText) { newText in
            // Push draft changes back to sync (debounced).
            // `lastLocalEditAt` is stamped synchronously by the TextField's
            // binding setter above, not here, to avoid a render-order race
            // where a self-echo could otherwise overwrite a just-typed
            // character.
            guard !isApplyingRemoteDraft else { return }
            draftDebounceItem?.cancel()
            let item = DispatchWorkItem { [weak appState] in
                appState?.syncManager?.updateDraftInput(
                    sessionId: session.id,
                    draftInput: newText
                )
            }
            draftDebounceItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: item)
        }
        .task {
            // Join session room async to avoid blocking navigation transition
            appState.syncManager?.joinSessionRoom(sessionId: session.id)
        }
        .onDisappear {
            sessionCancellable?.cancel()
            messagesCancellable?.cancel()
            projectCancellable?.cancel()
            queuedPromptsCancellable?.cancel()
            timeoutWorkItem?.cancel()
            promptRefreshWorkItem?.cancel()
            draftDebounceItem?.cancel()
            // Remove only THIS session's diagnostic handler. The incoming
            // view may have already registered its own; a blanket
            // `onSessionSyncDiagnostic = nil` would drop its registration and
            // cause its diagnostic to be silently swallowed.
            appState.syncManager?.removeSessionSyncDiagnosticHandler(sessionId: session.id)
            // Scope the leave to THIS session: SwiftUI often fires the new
            // view's `.task { joinSessionRoom(next) }` before this onDisappear,
            // so a bare leaveSessionRoom() would tear down the next session's
            // socket and leave it stuck forever.
            appState.syncManager?.leaveSessionRoom(expectedSessionId: session.id)
        }
        #if canImport(UIKit)
        .sheet(isPresented: $showPromptPicker) {
            NavigationStack {
                PromptPickerList(
                    promptList: promptList,
                    onSelect: { prompt in
                        showPromptPicker = false
                        transcriptController.scrollToMessage(messageId: prompt.id)
                    }
                )
                .navigationTitle("Jump to Prompt")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showPromptPicker = false }
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
        #endif
        #if canImport(UIKit)
        .modifier(FileSheetModifier(
            document: $fileSheetDocument,
            toast: $fileNotAvailableToast,
            appState: appState
        ))
        #endif
        .alert("Send Error", isPresented: Binding(
            get: { sendError != nil },
            set: { if !$0 { sendError = nil } }
        )) {
            Button("OK") { sendError = nil }
        } message: {
            Text(sendError ?? "")
        }
        .alert("Delivery Warning", isPresented: Binding(
            get: { deliveryWarning != nil },
            set: { if !$0 { deliveryWarning = nil } }
        )) {
            Button("OK") { deliveryWarning = nil }
        } message: {
            Text(deliveryWarning ?? "")
        }
        .onChange(of: liveSession?.isExecuting) { isExec in
            // Desktop picked up the prompt - cancel the delivery timeout
            if isExec == true {
                deliveryTimeoutItem?.cancel()
                deliveryTimeoutItem = nil
                deliveryWarning = nil
            }
        }
        .onChange(of: messages.count) { _ in
            // Re-check reveal: messages may have arrived after onReady fired
            tryRevealTranscript()
            // Debounce prompt list refresh to avoid IPC spam when many messages arrive at once
            promptRefreshWorkItem?.cancel()
            let item = DispatchWorkItem { refreshPromptList() }
            promptRefreshWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: item)
        }
        .onChange(of: hasCompletedInitialSessionSync) { _ in
            tryRevealTranscript()
        }
        .onChange(of: serverConfirmedNoMessages) { _ in
            tryRevealTranscript()
        }
    }

    // MARK: - Status Bar

    private var hasExpectedTranscriptMessages: Bool {
        displaySession.lastSyncedSeq > 0 || (displaySession.lastMessageAt ?? 0) > 0
    }

    private var hasAllExpectedLocalMessages: Bool {
        displaySession.lastSyncedSeq > 0 && messages.count >= displaySession.lastSyncedSeq
    }

    private var shouldWaitForInitialTranscriptMessages: Bool {
        // Only block the initial JS load until GRDB delivers its first local
        // snapshot. Previously this also waited on the session sync round-trip
        // (hasCompletedInitialSessionSync / hasAllExpectedLocalMessages), which
        // added a full network RTT to every session switch even when all the
        // messages were already in the local store — the main cause of the
        // "switching back isn't instant" lag. The transcript reveal overlay
        // (isTranscriptReady) still covers any brief empty state, and the
        // React side keeps the cached transcript mounted across switches.
        !hasObservedInitialMessages
    }

    private var canRevealTranscript: Bool {
        hasObservedInitialMessages
            && !shouldWaitForInitialTranscriptMessages
            && (!messages.isEmpty || serverConfirmedNoMessages || !hasExpectedTranscriptMessages)
    }

    /// Apply the most recent synced draft to composeText if it represents
    /// genuinely newer text than what we have locally. Callers MUST ensure the
    /// TextField is not currently focused before calling this -- mutating the
    /// binding under an active TextField scrambles the user's input.
    private func applyRemoteDraftIfNewer() {
        let draft = liveSession?.draftInput ?? ""
        guard draft != composeText else { return }
        // Defense-in-depth: if the local compose already contains the incoming
        // draft as a prefix, the user is ahead of the remote (almost always a
        // self-echo arriving after they kept typing). Don't ever overwrite
        // their input with a shorter prefix.
        if !draft.isEmpty && composeText.hasPrefix(draft) && composeText.count > draft.count {
            return
        }
        // Reject stale drafts: if the remote draftUpdatedAt is older than our
        // last submit, this is an echo of the pre-submit draft -- ignore it.
        if let remoteTs = liveSession?.draftUpdatedAt, !draft.isEmpty, remoteTs <= lastSubmitAt {
            return
        }
        // Reject sync echoes older than our local typing. Only accept remote
        // drafts that are genuinely newer (e.g., typed on desktop after we
        // stopped typing here). Mirrors desktop's sessionDraftLocalModifiedAtAtom.
        if let remoteTs = liveSession?.draftUpdatedAt, lastLocalEditAt > 0, remoteTs <= lastLocalEditAt {
            return
        }
        isApplyingRemoteDraft = true
        composeText = draft
        DispatchQueue.main.async { isApplyingRemoteDraft = false }
    }

    /// Re-check whether the transcript overlay can be dismissed.
    /// Called from multiple onChange handlers so the reveal isn't gated
    /// on a single one-shot callback (onReady).
    private func tryRevealTranscript() {
        guard !isTranscriptReady, isWebViewReady, canRevealTranscript else { return }
        withAnimation(.easeOut(duration: 0.2)) {
            isTranscriptReady = true
            loadError = nil
        }
        timeoutWorkItem?.cancel()
    }

    private var hasStatusInfo: Bool {
        displaySession.isExecuting || displaySession.hasQueuedPrompts || displaySession.contextUsagePercent != nil
    }

    @ViewBuilder
    private var statusBar: some View {
        if hasStatusInfo {
            HStack(spacing: 12) {
                if displaySession.hasQueuedPrompts {
                    HStack(spacing: 6) {
                        Image(systemName: "clock.fill")
                            .foregroundStyle(NimbalystColors.warning)
                            .font(.caption)
                        Text("Waiting for response")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else if displaySession.isExecuting {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                            .tint(NimbalystColors.primary)
                        Text("Executing...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                if let pct = displaySession.contextUsagePercent {
                    ContextUsageBar(percent: pct)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial)
        }
    }

    // MARK: - Session Menu

    private var sessionMenu: some View {
        Menu {
            #if canImport(UIKit)
            // Jump to prompt sheet trigger
            if !promptList.isEmpty {
                Button {
                    showPromptPicker = true
                } label: {
                    Label("Jump to Prompt", systemImage: "text.line.first.and.arrowtriangle.forward")
                }
            }
            #endif

            #if os(iOS)
            if let voice = appState.voiceAgent {
                Button {
                    if voice.state == .disconnected {
                        voice.activeSessionId = session.id
                        voice.activate()
                    } else {
                        voice.deactivate()
                    }
                } label: {
                    if voice.state == .disconnected {
                        Label("Start Voice Mode", systemImage: "mic.fill")
                    } else {
                        Label("Stop Voice Mode", systemImage: "mic.slash")
                    }
                }
            }
            #endif

            if let provider = displaySession.provider,
               let model = displaySession.model {
                Section {
                    Label(provider, systemImage: "cpu")
                    Label(model, systemImage: "sparkle")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
    }

    // MARK: - Native Message List (macOS fallback)

    #if !canImport(UIKit)
    private var nativeMessageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(messages) { message in
                        MessageBubbleView(message: message)
                            .id(message.id)
                    }
                }
                .padding(.vertical, 8)
            }
            .onChange(of: messages.count) { _ in
                if let lastId = messages.last?.id {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
        }
    }
    #endif

    // MARK: - Prompt List

    private func refreshPromptList() {
        #if canImport(UIKit)
        transcriptController.getPromptList { prompts in
            DispatchQueue.main.async {
                self.promptList = prompts.enumerated().map { index, dict in
                    let id = dict["id"] as? String ?? ""
                    let text = dict["text"] as? String ?? ""
                    let createdAt = dict["createdAt"] as? Int ?? 0
                    let displayText = text.isEmpty ? "Prompt \(index + 1)" : text
                    return PromptEntry(id: id, number: index + 1, text: displayText, createdAt: createdAt)
                }
            }
        }
        #endif
    }

    // MARK: - Error Banner

    @ViewBuilder
    private func errorBanner(error: SessionLoadError) -> some View {
        VStack(spacing: 16) {
            Spacer()

            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(NimbalystColors.warning)

                Text(error.title)
                    .font(.headline)
                    .foregroundStyle(.primary)

                Text(error.description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)

                Text("Session: \(session.id.prefix(12))...")
                    .font(.caption)
                    .monospaced()
                    .foregroundStyle(NimbalystColors.textFaint)

                HStack(spacing: 12) {
                    Button {
                        copyDebugInfo(error: error)
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                            .font(.subheadline)
                    }
                    .buttonStyle(.bordered)
                    .tint(.secondary)

                    Button {
                        dismissLoadError()
                    } label: {
                        Label("Dismiss", systemImage: "xmark")
                            .font(.subheadline)
                    }
                    .buttonStyle(.bordered)
                    .tint(.secondary)

                    Button {
                        retryLoad()
                    } label: {
                        Label("Retry", systemImage: "arrow.clockwise")
                            .font(.subheadline)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(NimbalystColors.primary)
                }
                .padding(.top, 4)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0x1a/255, green: 0x1a/255, blue: 0x1a/255))
    }

    // MARK: - Load Timeout

    private func resetTranscriptLoadState() {
        isTranscriptReady = false
        isWebViewReady = false
        loadError = nil
        lastDiagnostic = nil
        hasObservedInitialMessages = false
        serverConfirmedNoMessages = false
        hasCompletedInitialSessionSync = false
        timeoutWorkItem?.cancel()
        startLoadTimeout()
    }

    /// Tear down every binding scoped to `oldId` and re-init for the current
    /// `session`. Only used on iPad in-place session swap; iPhone destroys and
    /// rebuilds the view on each navigation push so this code path doesn't
    /// fire there.
    ///
    /// By the time this runs, `session` already refers to the new session, so
    /// callees that read `session.*` automatically use the new values.
    private func swapSession(fromOldId oldId: String) {
        // Drop the previous session's GRDB observations. `projectCancellable`
        // is included even when the new session is in the same project — the
        // observation re-registers in `startObserving()`, and we'd rather pay
        // a no-op re-registration than carry a stale capture.
        sessionCancellable?.cancel()
        messagesCancellable?.cancel()
        queuedPromptsCancellable?.cancel()
        projectCancellable?.cancel()

        // Drop the previous session's sync subscriptions.
        appState.syncManager?.removeSessionSyncDiagnosticHandler(sessionId: oldId)
        appState.syncManager?.leaveSessionRoom(expectedSessionId: oldId)

        // Cancel any pending per-session debounces/timers.
        draftDebounceItem?.cancel()
        draftDebounceItem = nil
        deliveryTimeoutItem?.cancel()
        deliveryTimeoutItem = nil
        promptRefreshWorkItem?.cancel()
        promptRefreshWorkItem = nil

        // Clear per-session UI state. liveSession/messages/queuedPrompts will
        // be re-populated by the new observations; the rest are user-driven.
        liveSession = nil
        messages = []
        queuedPrompts = []
        promptList = []
        composeText = ""
        composeFocused = false
        isApplyingRemoteDraft = false
        lastLocalEditAt = 0
        lastSubmitAt = 0
        sendError = nil
        deliveryWarning = nil
        fileSheetDocument = nil
        fileNotAvailableToast = nil

        resetTranscriptLoadState()

        // Re-init for the new session.
        startObserving()
        startObservingQueuedPrompts()
        subscribeToDiagnostics()
        appState.syncManager?.joinSessionRoom(sessionId: session.id)
        appState.syncManager?.markSessionRead(sessionId: session.id)

        // Seed compose from the new session's draft.
        if let draft = session.draftInput, !draft.isEmpty {
            isApplyingRemoteDraft = true
            composeText = draft
            DispatchQueue.main.async { isApplyingRemoteDraft = false }
        }

        AnalyticsManager.shared.capture("mobile_session_viewed")
    }

    private func startLoadTimeout() {
        timeoutWorkItem?.cancel()
        let item = DispatchWorkItem { [self] in
            guard !isTranscriptReady else { return }
            // Fire the timeout regardless of whether we're still "waiting for
            // initial messages". Previously the guard
            //   guard !shouldWaitForInitialTranscriptMessages else { return }
            // suppressed this error whenever session sync never completed --
            // which is exactly the failure case we want to surface. If we've
            // been stuck 15s waiting on the sync response, the user needs to
            // see an error and a retry option, not an infinite spinner.
            withAnimation {
                loadError = .timeout(
                    messageCount: messages.count,
                    webViewReady: isWebViewReady,
                    isTranscriptReady: isTranscriptReady
                )
            }
        }
        timeoutWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: item)
    }

    // MARK: - Diagnostic Subscription

    private func subscribeToDiagnostics() {
        // Use the per-session handler API so the outgoing view's teardown can't
        // accidentally drop our registration. Previously we replaced (and the
        // outgoing view's .onDisappear nulled) a single shared callback on
        // SyncManager, which caused the incoming session's diagnostic to be
        // silently swallowed -- leaving the transcript spinner forever.
        appState.syncManager?.addSessionSyncDiagnosticHandler(sessionId: session.id) { [self] diagnostic in
            lastDiagnostic = diagnostic
            hasCompletedInitialSessionSync = true

            if diagnostic.error == nil, diagnostic.totalServerMessages == 0 {
                // No error but also no messages — could be normal for a brand new session.
                serverConfirmedNoMessages = true
                return
            }

            if let error = diagnostic.error {
                if diagnostic.decryptedCount == 0 && diagnostic.totalServerMessages > 0 {
                    withAnimation {
                        loadError = .decryptionFailed(
                            decryptedCount: diagnostic.decryptedCount,
                            totalCount: diagnostic.totalServerMessages
                        )
                    }
                } else {
                    withAnimation {
                        loadError = .syncFailed(error)
                    }
                }
            }
        }
    }

    // MARK: - Retry

    private func retryLoad() {
        resetTranscriptLoadState()
        appState.syncManager?.leaveSessionRoom()
        appState.syncManager?.joinSessionRoom(sessionId: session.id)
    }

    private func dismissLoadError() {
        loadError = nil
        isTranscriptReady = true
        timeoutWorkItem?.cancel()
    }

    // MARK: - Copy Debug Info

    private func copyDebugInfo(error: SessionLoadError) {
        var lines: [String] = [
            "Session Load Error Report",
            "========================",
            "Error: \(error.title)",
            "Detail: \(error.description)",
            "Session ID: \(session.id)",
            "Project ID: \(session.projectId)",
            "Local message count: \(messages.count)",
            "Provider: \(session.provider ?? "nil")",
            "Model: \(session.model ?? "nil")",
            "Created: \(session.createdAt)",
            "Updated: \(session.updatedAt)",
        ]

        if let diag = lastDiagnostic {
            lines.append("")
            lines.append("Sync Diagnostic:")
            lines.append("  Server messages: \(diag.totalServerMessages)")
            lines.append("  Decrypted: \(diag.decryptedCount)")
            lines.append("  Stored: \(diag.storedCount)")
            if !diag.failedMessageIds.isEmpty {
                lines.append("  Failed IDs: \(diag.failedMessageIds.prefix(5).joined(separator: ", "))")
                lines.append("  Failed sequences: \(diag.failedSequences.prefix(5).map(String.init).joined(separator: ", "))")
            }
            if let syncError = diag.error {
                lines.append("  Sync error: \(syncError)")
            }
        }

        let text = lines.joined(separator: "\n")
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }

    // MARK: - Observation

    private func startObserving() {
        guard let db = appState.databaseManager else { return }

        let sessionId = session.id

        // Observe session metadata
        let sessionObservation = ValueObservation.tracking { db in
            try Session.fetchOne(db, id: sessionId)
        }
        sessionCancellable = sessionObservation.start(
            in: db.writer,
            onError: { error in
                print("Session observation error: \(error)")
            },
            onChange: { updatedSession in
                liveSession = updatedSession
            }
        )

        // Observe messages
        let messageObservation = ValueObservation.tracking { db in
            try Message
                .filter(Message.Columns.sessionId == sessionId)
                .order(Message.Columns.sequence)
                .fetchAll(db)
        }
        messagesCancellable = messageObservation.start(
            in: db.writer,
            onError: { error in
                print("Message observation error: \(error)")
            },
            onChange: { newMessages in
                hasObservedInitialMessages = true
                messages = newMessages
            }
        )

        // Observe project commands (for slash command typeahead)
        let projectId = session.projectId
        let projectObservation = ValueObservation.tracking { db in
            try Project.fetchOne(db, id: projectId)
        }
        projectCancellable = projectObservation.start(
            in: db.writer,
            onError: { error in
                print("Project observation error: \(error)")
            },
            onChange: { project in
                projectCommands = project?.commands ?? []
            }
        )
    }

    private func startObservingQueuedPrompts() {
        guard let db = appState.databaseManager else { return }
        let sessionId = session.id

        let observation = ValueObservation.tracking { db in
            try QueuedPrompt
                .filter(QueuedPrompt.Columns.sessionId == sessionId)
                .order(QueuedPrompt.Columns.createdAt)
                .fetchAll(db)
        }
        queuedPromptsCancellable = observation.start(
            in: db.writer,
            onError: { error in
                print("Queued prompts observation error: \(error)")
            },
            onChange: { prompts in
                queuedPrompts = prompts
            }
        )
    }

    // MARK: - Actions

    private func sendPrompt(_ text: String, _ attachments: [PendingAttachment] = []) {
        guard let syncManager = appState.syncManager else {
            sendError = "Sync not connected. Try closing and reopening the session."
            return
        }

        // Immediately clear draft input to prevent stale draft from bouncing back via sync.
        // Cancel the pending debounce so it doesn't race with the immediate clear.
        // Record submit timestamp so we can reject any remote draft older than this.
        draftDebounceItem?.cancel()
        draftDebounceItem = nil
        lastSubmitAt = Int(Date().timeIntervalSince1970 * 1000)
        syncManager.updateDraftInput(sessionId: session.id, draftInput: "")

        Task {
            do {
                try await syncManager.sendPrompt(sessionId: session.id, text: text, attachments: attachments)
                AnalyticsManager.shared.capture("mobile_ai_message_sent", properties: [
                    "hasAttachments": !attachments.isEmpty,
                    "attachmentCount": attachments.count,
                ])

                // Start a delivery timeout -- if the session doesn't start executing
                // within 10s, warn the user that the desktop may not have received it.
                deliveryTimeoutItem?.cancel()
                let timeout = DispatchWorkItem { [self] in
                    // Only warn if session still hasn't started executing
                    if !(liveSession?.isExecuting ?? false) {
                        deliveryWarning = "Your prompt was sent but the desktop hasn't started processing it. Make sure the desktop app is running and connected."
                    }
                }
                deliveryTimeoutItem = timeout
                DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
            } catch {
                // Restore the draft so the user doesn't lose their text
                composeText = text
                sendError = "Failed to send: \(error.localizedDescription)"
            }
        }
    }

    private func handleOpenFile(_ filePath: String) {
        let logger = Logger(subsystem: "com.nimbalyst.app", category: "SessionDetailView")
        logger.info("handleOpenFile called with: \(filePath)")

        guard let db = appState.databaseManager else {
            logger.error("handleOpenFile: no database manager")
            return
        }

        // Project.id is the workspace path. Strip it to get the relative path.
        let projectId = session.projectId
        logger.info("handleOpenFile: projectId = \(projectId)")

        let relativePath: String
        if filePath.hasPrefix(projectId + "/") {
            relativePath = String(filePath.dropFirst(projectId.count + 1))
        } else {
            logger.warning("handleOpenFile: path doesn't match project. filePath=\(filePath), projectId=\(projectId)")
            withAnimation { fileNotAvailableToast = "This file is on your Mac and not available on this device" }
            return
        }

        logger.info("handleOpenFile: relativePath = \(relativePath)")

        // Look up the synced document by relative path
        do {
            let document = try db.writer.read { db in
                try SyncedDocument
                    .filter(SyncedDocument.Columns.projectId == projectId)
                    .filter(SyncedDocument.Columns.relativePath == relativePath)
                    .fetchOne(db)
            }

            if let document {
                logger.info("handleOpenFile: found document id=\(document.id), title=\(document.title)")
                fileSheetDocument = document
            } else {
                // Debug: list all synced docs for this project to see what's available
                let allDocs = try db.writer.read { db in
                    try SyncedDocument
                        .filter(SyncedDocument.Columns.projectId == projectId)
                        .fetchAll(db)
                }
                logger.info("handleOpenFile: no match for '\(relativePath)'. Available docs (\(allDocs.count)): \(allDocs.map { $0.relativePath }.joined(separator: ", "))")
                withAnimation { fileNotAvailableToast = "This file is not synced to this device" }
            }
        } catch {
            logger.error("handleOpenFile: DB error: \(error.localizedDescription)")
            withAnimation { fileNotAvailableToast = "Could not look up file" }
        }
    }

    private func cancelSession() {
        guard let syncManager = appState.syncManager else { return }
        syncManager.sendSessionControlMessage(sessionId: session.id, messageType: "cancel")
        AnalyticsManager.shared.capture("mobile_session_cancelled")
    }

    private func handleInteractiveResponse(_ action: String, _ promptId: String, _ body: [String: Any]) {
        guard let syncManager = appState.syncManager else { return }

        switch action {
        case "askUserQuestionSubmit":
            let answers = body["answers"] as? [String: String] ?? [:]
            syncManager.sendSessionControlMessage(
                sessionId: session.id,
                messageType: "prompt_response",
                payload: [
                    "promptType": "ask_user_question",
                    "promptId": promptId,
                    "response": ["answers": answers],
                ]
            )
            // Persist response to transcript
            if let json = try? JSONSerialization.data(withJSONObject: ["answers": answers]),
               let jsonStr = String(data: json, encoding: .utf8) {
                syncManager.appendToolResult(sessionId: session.id, toolResultId: promptId, content: jsonStr)
            }
            AnalyticsManager.shared.capture("mobile_ask_user_question_response", properties: [
                "action": "submitted",
                "question_count": answers.count,
            ])

        case "requestUserInputSubmit":
            let answers = body["answers"] as? [String: Any] ?? [:]
            syncManager.sendSessionControlMessage(
                sessionId: session.id,
                messageType: "prompt_response",
                payload: [
                    "promptType": "request_user_input",
                    "promptId": promptId,
                    "response": ["answers": answers, "cancelled": false],
                ]
            )
            if let json = try? JSONSerialization.data(withJSONObject: ["answers": answers, "cancelled": false]),
               let jsonStr = String(data: json, encoding: .utf8) {
                syncManager.appendToolResult(sessionId: session.id, toolResultId: promptId, content: jsonStr)
            }
            AnalyticsManager.shared.capture("mobile_request_user_input_response", properties: [
                "action": "submitted",
                "field_count": answers.count,
            ])

        case "requestUserInputCancel":
            syncManager.sendSessionControlMessage(
                sessionId: session.id,
                messageType: "prompt_response",
                payload: [
                    "promptType": "request_user_input",
                    "promptId": promptId,
                    "response": ["answers": [String: Any](), "cancelled": true],
                ]
            )
            if let json = try? JSONSerialization.data(withJSONObject: ["cancelled": true]),
               let jsonStr = String(data: json, encoding: .utf8) {
                syncManager.appendToolResult(sessionId: session.id, toolResultId: promptId, content: jsonStr)
            }
            AnalyticsManager.shared.capture("mobile_request_user_input_response", properties: [
                "action": "cancelled",
            ])

        case "toolPermissionSubmit":
            let response = body["response"] as? [String: Any] ?? [:]
            syncManager.sendSessionControlMessage(
                sessionId: session.id,
                messageType: "prompt_response",
                payload: [
                    "promptType": "tool_permission",
                    "promptId": promptId,
                    "response": response,
                ]
            )
            // Persist response to transcript
            if let json = try? JSONSerialization.data(withJSONObject: response),
               let jsonStr = String(data: json, encoding: .utf8) {
                syncManager.appendToolResult(sessionId: session.id, toolResultId: promptId, content: jsonStr)
            }
            AnalyticsManager.shared.capture("mobile_tool_permission_response", properties: [
                "decision": response["decision"] as? String ?? "unknown",
                "scope": response["scope"] as? String ?? "unknown",
            ])

        case "exitPlanModeApprove":
            syncManager.sendSessionControlMessage(
                sessionId: session.id,
                messageType: "prompt_response",
                payload: [
                    "promptType": "exit_plan_mode",
                    "promptId": promptId,
                    "response": ["approved": true],
                ]
            )
            AnalyticsManager.shared.capture("mobile_exit_plan_mode_response", properties: [
                "action": "approved",
            ])

        case "exitPlanModeDeny":
            let feedback = body["feedback"] as? String
            var response: [String: Any] = ["approved": false]
            if let feedback { response["feedback"] = feedback }
            syncManager.sendSessionControlMessage(
                sessionId: session.id,
                messageType: "prompt_response",
                payload: [
                    "promptType": "exit_plan_mode",
                    "promptId": promptId,
                    "response": response,
                ]
            )
            AnalyticsManager.shared.capture("mobile_exit_plan_mode_response", properties: [
                "action": "denied",
                "has_feedback": feedback != nil,
            ])

        case "gitCommit":
            let files = body["files"] as? [String] ?? []
            let message = body["message"] as? String ?? ""
            syncManager.sendSessionControlMessage(
                sessionId: session.id,
                messageType: "prompt_response",
                payload: [
                    "promptType": "git_commit",
                    "promptId": promptId,
                    "response": [
                        "action": "committed",
                        "files": files,
                        "message": message,
                    ],
                ]
            )
            AnalyticsManager.shared.capture("mobile_git_commit_response", properties: [
                "action": "approved",
                "file_count": files.count,
            ])

        case "gitCommitCancel":
            syncManager.sendSessionControlMessage(
                sessionId: session.id,
                messageType: "prompt_response",
                payload: [
                    "promptType": "git_commit",
                    "promptId": promptId,
                    "response": [
                        "action": "cancelled",
                    ],
                ]
            )
            if let json = try? JSONSerialization.data(withJSONObject: ["action": "cancelled"]),
               let jsonStr = String(data: json, encoding: .utf8) {
                syncManager.appendToolResult(sessionId: session.id, toolResultId: promptId, content: jsonStr)
            }
            AnalyticsManager.shared.capture("mobile_git_commit_response", properties: [
                "action": "cancelled",
            ])

        default:
            print("Unhandled interactive response: \(action)")
        }
    }
}

// MARK: - Prompt Entry

struct PromptEntry: Identifiable {
    let id: String
    let number: Int
    let text: String
    let createdAt: Int
}

// MARK: - Prompt Picker List

#if canImport(UIKit)
private struct PromptPickerList: View {
    let promptList: [PromptEntry]
    let onSelect: (PromptEntry) -> Void

    @State private var searchText = ""

    private var filteredPrompts: [PromptEntry] {
        if searchText.isEmpty {
            return promptList
        }
        return promptList.filter { $0.text.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        List(filteredPrompts) { prompt in
            Button {
                onSelect(prompt)
            } label: {
                HStack(spacing: 12) {
                    Text("#\(prompt.number)")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(NimbalystColors.primary)
                        .frame(minWidth: 30, alignment: .trailing)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(prompt.text)
                            .font(.body)
                            .foregroundStyle(.primary)
                            .lineLimit(2)

                        if prompt.createdAt > 0 {
                            Text(RelativeTimestamp.format(epochMs: prompt.createdAt))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        }
        .listStyle(.plain)
        .searchable(text: $searchText, prompt: "Search prompts")
        .overlay {
            if filteredPrompts.isEmpty && !searchText.isEmpty {
                ContentUnavailableView.search(text: searchText)
            }
        }
    }
}
#endif

// MARK: - File Sheet Modifier

#if canImport(UIKit)
/// Extracted to reduce type-checker complexity in SessionDetailView.body.
private struct FileSheetModifier: ViewModifier {
    @Binding var document: SyncedDocument?
    @Binding var toast: String?
    var appState: AppState

    func body(content: Content) -> some View {
        content
            .sheet(item: $document) { doc in
                NavigationStack {
                    DocumentEditorView(document: doc)
                        .environmentObject(appState)
                        .navigationTitle(doc.displayName)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { document = nil }
                            }
                        }
                }
            }
            .overlay(alignment: .bottom) {
                if let toastText = toast {
                    Text(toastText)
                        .font(.subheadline)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Color(white: 0.2), in: Capsule())
                        .padding(.bottom, 80)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .onAppear {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                withAnimation { toast = nil }
                            }
                        }
                }
            }
    }
}
#endif
