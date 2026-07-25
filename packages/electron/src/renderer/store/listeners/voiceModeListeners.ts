/**
 * Centralized Voice Mode IPC Listeners
 *
 * Subscribes to voice-mode IPC events ONCE and updates atoms.
 * Components read from atoms, never subscribe to IPC directly.
 *
 * Voice sessions are persisted incrementally:
 * - Session row created in ai_sessions when voice activates
 * - Each transcript entry written to ai_agent_messages as it arrives
 * - Final metadata (token usage, duration) updated when voice stops
 *
 * Call initVoiceModeListeners() once in index.tsx at startup.
 */

import { store, activeTabIdAtom, getFilePathFromKey, makeEditorContext } from '@nimbalyst/runtime/store';
import {
  voiceActiveSessionIdAtom,
  voiceTranscriptEntriesAtom,
  voiceCurrentUserTextAtom,
  voiceTokenUsageAtom,
  voiceSessionStartTimeAtom,
  voiceWorkspacePathAtom,
  voiceDbSessionIdAtom,
  voiceLastReportedFileAtom,
  voiceListenStateAtom,
  voiceErrorAtom,
  voiceReconnectingAtom,
  voiceModePreviewAudioAtom,
  getVoiceAudioCallback,
  getVoiceInterruptCallback,
  getVoiceSubmitPromptCallback,
  getVoiceAgentTaskCompleteCallback,
  getVoiceStoppedCallback,
  getVoiceResponseDoneCallback,
  getVoiceAudioActiveQuery,
  type VoiceTranscriptEntry,
  type VoiceTokenUsage,
} from '../atoms/voiceModeState';
import { voiceModeSettingsAtom, type VoiceModeSettings } from '../atoms/appSettings';
import { VoiceListenWindowController } from './voiceListenWindow';
import { formatGitCommitProposalForVoice } from './voiceInteractivePrompt';
import { activeSessionIdAtom, sessionRegistryAtom, sessionHasPendingInteractivePromptAtom, sessionPendingPromptsAtom, sessionProcessingAtom, respondToPromptAtom, refreshSessionListAtom, reloadSessionDataAtom } from '../atoms/sessions';
import { windowModeAtom } from '../atoms/windowMode';

/**
 * Callback for notifying VoiceModeButton when the linked session changes.
 * VoiceModeButton keeps a module-level activeVoiceSessionId that must stay in sync.
 */
let _onLinkedSessionChanged: ((newSessionId: string) => void) | null = null;

/**
 * Register a callback to be notified when voice follows a session switch.
 * Used by VoiceModeButton to keep its module-level activeVoiceSessionId in sync.
 */
export function onLinkedSessionChanged(callback: ((newSessionId: string) => void) | null): void {
  _onLinkedSessionChanged = callback;
}

export function getCurrentVoiceFilePath(): string | null {
  const mode = store.get(windowModeAtom);

  if (mode === 'files') {
    const activeTabKey = store.get(activeTabIdAtom('main'));
    return activeTabKey ? getFilePathFromKey(activeTabKey) : null;
  }

  if (mode === 'agent') {
    const sessionId = store.get(activeSessionIdAtom);
    if (!sessionId) return null;
    const context = makeEditorContext(sessionId);
    const activeTabKey = store.get(activeTabIdAtom(context));
    return activeTabKey ? getFilePathFromKey(activeTabKey) : null;
  }

  return null;
}

// =========================================================================
// Listen Window Timer
// =========================================================================
// Centralized timer that transitions voice from 'listening' to 'sleeping'
// after a configurable period of inactivity. Reset on speech events,
// restarted when the voice agent responds. The controller holds every arm
// request while the user is mid-utterance (NIM-1594): a token-usage from a
// barge-in-cancelled response, a late transcript-complete for the previous
// utterance, or a playback drain must not start a countdown that expires
// while the user is still talking.

const listenWindow = new VoiceListenWindowController({
  getWindowMs: () => store.get(voiceModeSettingsAtom).listenWindowMs ?? 15000,
  onExpire: () => {
    // Only sleep if still in listening state
    if (store.get(voiceListenStateAtom) === 'listening') {
      // console.log('[voiceModeListeners] Listen window expired -> sleeping');
      sleepVoiceListening();
    }
  },
  onHeldDuringSpeech: (reason) => {
    console.log(`[voiceModeListeners] Listen window held open, user is speaking (${reason})`);
    writeDiagnosticEntry(`Listen window: held open during speech (${reason})`);
  },
});

// =========================================================================
// Post-Turn Listen Window
// =========================================================================
// When the assistant finishes a turn (token-usage), we want to start the
// 15s listen window from the moment the user *stops hearing* the assistant,
// not from when the server finished generating audio chunks. Long responses
// stream chunks fast (~3s) but play back slowly (~30s), so starting the
// timer at server-done used to expire it mid-playback and gate the mic.

let _pendingPostTurnTimer = false;
let _postTurnFallbackTimer: ReturnType<typeof setTimeout> | null = null;

/** Wake from sleep if needed, start the 15s listen timer, fire ready cue. */
function startListenWindowForPostTurn(): void {
  const wokeFromSleep = store.get(voiceListenStateAtom) === 'sleeping';
  if (wokeFromSleep) {
    wakeVoiceListening(false);
  }
  listenWindow.start('post-turn');
  const responseDoneCb = getVoiceResponseDoneCallback();
  if (responseDoneCb) responseDoneCb(wokeFromSleep);
}

function clearPostTurnPending(): void {
  _pendingPostTurnTimer = false;
  if (_postTurnFallbackTimer) {
    clearTimeout(_postTurnFallbackTimer);
    _postTurnFallbackTimer = null;
  }
}

/**
 * Called by AudioPlayback (via VoiceModeButton) when the assistant's audio
 * queue has fully drained -- i.e. the user has actually finished hearing the
 * agent. If we deferred the post-turn listen window earlier, fire it now.
 */
export function notifyVoiceAudioPlaybackDrained(): void {
  if (!_pendingPostTurnTimer) return;
  clearPostTurnPending();
  startListenWindowForPostTurn();
}

/**
 * Transition to listening state so the mic is open.
 *
 * @param startTimer If true, starts the listen window timer immediately.
 *   Pass true for user-initiated wake (manual tap). Pass false when waking
 *   because the assistant is about to speak -- text-received and token-usage
 *   will manage the timer so the countdown starts from the LAST activity,
 *   not from the moment of wake.
 */
export function wakeVoiceListening(startTimer = true): void {
  const current = store.get(voiceListenStateAtom);
  if (current === 'off') return; // can't wake if not active
  store.set(voiceListenStateAtom, 'listening');
  if (startTimer) {
    listenWindow.start('wake');
  }
  if (current === 'sleeping') {
    // Tell main process to resume the inactivity disconnect timer
    window.electronAPI.send('voice-mode:listen-state-changed', { sleeping: false });
    writeDiagnosticEntry('Listen window: woke up');
  }
}

/**
 * Transition to sleeping state and stop the listen window timer.
 * Audio capture will be gated in VoiceModeButton.
 * Notifies main process to suspend its inactivity monitor.
 */
export function sleepVoiceListening(): void {
  if (store.get(voiceListenStateAtom) !== 'listening') return;
  // console.log('[voiceModeListeners] sleepVoiceListening: transitioning to sleeping');
  // reset (not clear): the mic is gated while sleeping, so no speech_stopped
  // will arrive for an in-flight utterance -- a stale speech flag would hold
  // the next listen window open forever.
  listenWindow.reset();
  store.set(voiceListenStateAtom, 'sleeping');
  // Tell main process to suspend the inactivity disconnect timer
  const voiceSessionId = store.get(voiceActiveSessionIdAtom);
  if (voiceSessionId) {
    window.electronAPI.send('voice-mode:listen-state-changed', { sleeping: true });
  }
  writeDiagnosticEntry('Listen window: sleeping');
}


/**
 * Refresh the open transcript for the active voice DB session.
 *
 * Voice messages (speech turns, [system] diagnostics, and voiceToolCall
 * entries) are written straight to ai_agent_messages via
 * voice-mode:appendMessage. Unlike provider streaming, that path emits NO
 * `transcript:event`, so the TranscriptStreamAccumulator never sees them and
 * the open transcript wouldn't reflect new entries until the session is
 * reloaded for some other reason. That's why voice tool calls (memory
 * lookups, ask_coding_agent, etc.) "didn't show up" live even though they
 * were persisted correctly and project fine on reload.
 *
 * Reloading from the DB re-runs the same canonical projection (VoiceRawParser
 * -> tool_call_started/completed), so tool widgets and speech appear live.
 * Debounced (trailing edge) so a started+completed tool-call burst that lands
 * a few ms apart coalesces into a single reload that picks up both rows.
 */
let voiceTranscriptRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleVoiceTranscriptRefresh(): void {
  if (voiceTranscriptRefreshTimer) return;
  voiceTranscriptRefreshTimer = setTimeout(() => {
    voiceTranscriptRefreshTimer = null;
    const sessionId = store.get(voiceDbSessionIdAtom);
    const workspacePath = store.get(voiceWorkspacePathAtom);
    if (!sessionId || !workspacePath) return;
    void store.set(reloadSessionDataAtom, { sessionId, workspacePath });
  }, 250);
}

/**
 * Write a single transcript entry to the database.
 * Fire-and-forget -- errors are logged but don't block the UI.
 */
function writeTranscriptEntry(entry: VoiceTranscriptEntry): void {
  const dbSessionId = store.get(voiceDbSessionIdAtom);
  if (!dbSessionId) return;

  window.electronAPI.invoke('voice-mode:appendMessage', {
    sessionId: dbSessionId,
    direction: entry.role === 'user' ? 'input' : 'output',
    content: entry.text,
    entryId: entry.id,
    timestamp: entry.timestamp,
  })
    .then(scheduleVoiceTranscriptRefresh)
    .catch(error => {
      console.error('[voiceModeListeners] Failed to write transcript entry:', error);
    });
}

/**
 * Write a diagnostic/system entry to the voice session for debugging.
 * These use direction 'output' with a special entryId prefix so they
 * can be distinguished from real transcript entries.
 */
function writeDiagnosticEntry(message: string): void {
  const dbSessionId = store.get(voiceDbSessionIdAtom);
  if (!dbSessionId) return;

  window.electronAPI.invoke('voice-mode:appendMessage', {
    sessionId: dbSessionId,
    direction: 'output',
    content: `[system] ${message}`,
    entryId: `diag-${Date.now()}`,
    timestamp: Date.now(),
  })
    .then(scheduleVoiceTranscriptRefresh)
    .catch(error => {
      console.error('[voiceModeListeners] Failed to write diagnostic entry:', error);
    });
}

/**
 * A function/tool call event forwarded from the voice agent (main process).
 * Mirrors VoiceToolCallEvent in RealtimeAPIClient.ts.
 */
type VoiceToolCallEvent =
  | {
      phase: 'started';
      callId: string;
      name: string;
      displayName: string;
      args: Record<string, unknown>;
    }
  | {
      phase: 'completed';
      callId: string;
      name: string;
      displayName: string;
      success: boolean;
      summary?: string;
    };

/**
 * Write a voice-agent tool call to the session transcript. Persisted as a JSON
 * payload (direction 'output') that the VoiceRawParser turns into a real
 * tool_call event so it renders with the standard tool widget. Without this,
 * voice tool calls (memory lookups, ask_coding_agent, etc.) are invisible.
 */
function writeToolCallEntry(event: VoiceToolCallEvent): void {
  const dbSessionId = store.get(voiceDbSessionIdAtom);
  if (!dbSessionId) return;

  const content = JSON.stringify({ kind: 'voiceToolCall', ...event });

  window.electronAPI.invoke('voice-mode:appendMessage', {
    sessionId: dbSessionId,
    direction: 'output',
    content,
    entryId: `tool-${event.phase}-${event.callId}`,
    timestamp: Date.now(),
  })
    .then(scheduleVoiceTranscriptRefresh)
    .catch(error => {
      console.error('[voiceModeListeners] Failed to write tool-call entry:', error);
    });
}

/**
 * Update voice session metadata in the database (token usage, duration).
 */
async function updateSessionMetadata(tokenUsage?: VoiceTokenUsage | null): Promise<void> {
  const dbSessionId = store.get(voiceDbSessionIdAtom);
  if (!dbSessionId) return;

  const finalTokenUsage = tokenUsage || store.get(voiceTokenUsageAtom);
  const startTime = store.get(voiceSessionStartTimeAtom);
  const durationMs = startTime ? Date.now() - startTime : 0;

  try {
    await window.electronAPI.invoke('voice-mode:updateSessionMetadata', {
      sessionId: dbSessionId,
      tokenUsage: finalTokenUsage,
      durationMs,
    });
  } catch (error) {
    console.error('[voiceModeListeners] Failed to update voice session metadata:', error);
  }
}

/**
 * Reset all voice state atoms.
 */
function resetVoiceAtoms(): void {
  listenWindow.reset();
  clearPostTurnPending();
  store.set(voiceListenStateAtom, 'off');
  store.set(voiceActiveSessionIdAtom, null);
  store.set(voiceTranscriptEntriesAtom, []);
  store.set(voiceCurrentUserTextAtom, '');
  store.set(voiceTokenUsageAtom, null);
  store.set(voiceSessionStartTimeAtom, null);
  store.set(voiceWorkspacePathAtom, null);
  store.set(voiceDbSessionIdAtom, null);
  store.set(voiceLastReportedFileAtom, null);
  store.set(voiceErrorAtom, null);
  store.set(voiceReconnectingAtom, false);
}

/**
 * Format a PendingPrompt into a voice-friendly description for the voice agent.
 */
function formatPromptForVoice(prompt: { promptType: string; promptId: string; data: any }): string {
  if (prompt.promptType === 'ask_user_question_request') {
    const questions = prompt.data?.questions || [];
    const parts: string[] = [];
    for (const q of questions) {
      const options = (q.options || []).map((o: any) => o.label).join(', ');
      parts.push(`Question: ${q.question}\nOptions: ${options}`);
    }
    return parts.join('\n\n') || 'The coding agent has a question for you.';
  }

  if (prompt.promptType === 'exit_plan_mode_request') {
    return 'The coding agent has finished planning and wants your approval to proceed with implementation. Say "approve" to proceed or "reject" to revise.';
  }

  if (prompt.promptType === 'git_commit_proposal_request') {
    return formatGitCommitProposalForVoice(prompt.data);
  }

  if (prompt.promptType === 'request_user_input_request') {
    const args = prompt.data?.args || {};
    const fields = Array.isArray(args.fields) ? args.fields : [];
    const parts: string[] = [];
    if (args.title) parts.push(args.title);
    if (args.intro) parts.push(args.intro);
    for (const f of fields) {
      switch (f.type) {
        case 'multiSelect': {
          const items = (f.items || []).map((i: any) => i.title).join(', ');
          parts.push(`Pick from: ${items}`);
          break;
        }
        case 'singleSelect': {
          const opts = (f.options || []).map((o: any) => o.label).join(', ');
          parts.push(`Choose one: ${opts}`);
          break;
        }
        case 'reorder': {
          const items = (f.items || []).map((i: any) => i.title).join(', ');
          parts.push(`Confirm or reorder: ${items}`);
          break;
        }
        case 'editText':
          parts.push(f.label || 'Edit text');
          break;
        case 'confirm':
          parts.push(`Yes or no: ${f.label}`);
          break;
      }
    }
    return parts.join('. ') || 'The coding agent needs your input.';
  }

  return 'The coding agent needs your input.';
}

/**
 * Compute whether the voice agent can handle this prompt or should defer to
 * the screen. Computed in the renderer (NOT trusted from the agent) to avoid
 * a confused agent forcing voice into reading out a 50-item drag-to-order.
 *
 * Rules:
 *  - reorder fields > 6 items defer
 *  - editText with initialText > 240 chars defer
 *  - everything else: voice-friendly
 */
function computeVoiceFriendly(prompt: { promptType: string; data: any }): boolean {
  if (prompt.promptType !== 'request_user_input_request') return true;
  const args = prompt.data?.args || {};
  const fields = Array.isArray(args.fields) ? args.fields : [];
  for (const f of fields) {
    if (f.type === 'reorder' && Array.isArray(f.items) && f.items.length > 6) {
      return false;
    }
    if (f.type === 'editText' && typeof f.initialText === 'string' && f.initialText.length > 240) {
      return false;
    }
  }
  return true;
}

/**
 * Initialize voice mode IPC listeners.
 * Should be called once at app startup.
 *
 * @returns Cleanup function to call on unmount
 */
export function initVoiceModeListeners(): () => void {
  const cleanups: Array<() => void> = [];

  // Helper: check whether voice is active. Voice is a singleton so we don't
  // need to compare session IDs -- just check that *any* voice session is running.
  const isVoiceActive = () => store.get(voiceActiveSessionIdAtom) !== null;

  // =========================================================================
  // Settings Changed (broadcast from main process when any window saves)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:settings-changed', (settings: VoiceModeSettings) => {
      store.set(voiceModeSettingsAtom, settings);
    })
  );

  // =========================================================================
  // Current UI Context (voice tool request/response)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:request-ui-context', (payload: {
      workspacePath: string;
      resultChannel: string;
    }) => {
      const activeWorkspacePath = store.get(voiceWorkspacePathAtom);
      if (!isVoiceActive()) {
        window.electronAPI.send(payload.resultChannel, {
          workspacePath: payload.workspacePath,
          error: 'Voice mode is not active.',
        });
        return;
      }
      if (!payload.workspacePath || payload.workspacePath !== activeWorkspacePath) {
        window.electronAPI.send(payload.resultChannel, {
          workspacePath: payload.workspacePath,
          error: 'The UI context request does not match the active voice workspace.',
        });
        return;
      }

      const activeSessionId = store.get(activeSessionIdAtom);
      const sessionMeta = activeSessionId
        ? store.get(sessionRegistryAtom).get(activeSessionId)
        : undefined;
      const sessionStatus = activeSessionId && store.get(sessionHasPendingInteractivePromptAtom(activeSessionId))
        ? 'waiting_for_input'
        : activeSessionId && store.get(sessionProcessingAtom(activeSessionId))
          ? 'running'
          : 'idle';

      window.electronAPI.send(payload.resultChannel, {
        workspacePath: payload.workspacePath,
        context: {
          activeView: store.get(windowModeAtom),
          selectedFilePath: getCurrentVoiceFilePath(),
          activeSession: activeSessionId
            ? {
                id: activeSessionId,
                title: sessionMeta?.title || 'Untitled',
                status: sessionStatus,
              }
            : null,
        },
      });
    })
  );

  // =========================================================================
  // Preview Audio (response to voice-mode:preview-voice invoke)
  // =========================================================================
  // The Settings > Voice Mode panel triggers a preview via invoke; main
  // streams the audio back via this event. We bump a request atom so the
  // panel can play it without subscribing to IPC directly.
  let previewAudioVersion = 0;
  cleanups.push(
    window.electronAPI.on('voice-mode:preview-audio', (payload: {
      voiceId: string;
      audioBase64: string;
      format: string;
    }) => {
      if (!payload?.audioBase64) return;
      previewAudioVersion += 1;
      store.set(voiceModePreviewAudioAtom, {
        version: previewAudioVersion,
        payload,
      });
    })
  );

  // =========================================================================
  // Audio Received (play audio from voice agent)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:audio-received', (payload: {
      sessionId: string;
      audioBase64: string;
    }) => {
      if (!isVoiceActive()) return;

      // Wake from sleeping when assistant starts speaking so the mic
      // is open for the user to interrupt or respond.
      // Clear the timer -- it should only start AFTER the assistant finishes
      // (via token-usage), not while audio is still playing.
      if (store.get(voiceListenStateAtom) === 'sleeping') {
        wakeVoiceListening(false);
      }
      listenWindow.clear();

      const cb = getVoiceAudioCallback();
      if (cb) cb(payload.audioBase64);
    })
  );

  // =========================================================================
  // Speech Started (unconditional VAD signal)
  // =========================================================================
  // Sent for EVERY input_audio_buffer.speech_started, unlike voice-mode:interrupt
  // which only fires when the barge-in policy decides to interrupt playback
  // (an echo-suspect trigger whose playback drains inside the probation window
  // never interrupts at all). This is the authoritative "user is talking"
  // signal that holds the listen window open until speech_stopped (NIM-1594).
  cleanups.push(
    window.electronAPI.on('voice-mode:speech-started', (_payload: {
      sessionId: string;
    }) => {
      if (!isVoiceActive()) return;
      listenWindow.speechStarted();
    })
  );

  // =========================================================================
  // Interrupt / Speech Started (VAD detected voice)
  // =========================================================================
  // PAUSES the idle timer (user is actively speaking) AND stops audio playback.
  cleanups.push(
    window.electronAPI.on('voice-mode:interrupt', (_payload: {
      sessionId: string;
    }) => {
      if (!isVoiceActive()) return;

      // User started speaking -- hold the timer entirely.
      // speech_started fires once at the beginning of an utterance.
      // We don't get any more events until speech_stopped, so a simple
      // reset would still expire mid-speech. speechStarted() clears the
      // countdown AND holds later arm requests until speech_stopped.
      // (voice-mode:speech-started normally set this already; interrupt can
      // arrive up to 500ms later on the deferred barge-in path.)
      listenWindow.speechStarted();

      // Discard any pending post-turn timer: the user is now driving the
      // turn. If we left it pending, the AudioPlayback.stop() below would
      // synthesize a drain via onended-after-stop and we'd start a 15s
      // window mid-utterance.
      clearPostTurnPending();

      // Stop audio playback (user is interrupting the assistant)
      const cb = getVoiceInterruptCallback();
      if (cb) cb();
    })
  );

  // =========================================================================
  // Speech Stopped (VAD detected silence after speech)
  // =========================================================================
  // User stopped speaking -- NOW start the idle countdown.
  cleanups.push(
    window.electronAPI.on('voice-mode:speech-stopped', (_payload: {
      sessionId: string;
    }) => {
      if (!isVoiceActive()) return;

      // User stopped speaking. Release the speech hold and start the idle
      // timer from NOW. If the assistant responds, text-received will pause
      // it again.
      // console.log('[voiceModeListeners] speech_stopped -> starting listen window timer');
      listenWindow.speechStopped();
    })
  );

  // =========================================================================
  // Submit Prompt (voice agent wants to send a coding task)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:submit-prompt', (payload: {
      sessionId: string;
      workspacePath: string | null;
      prompt: string;
      codingAgentPrompt?: { prepend?: string; append?: string };
    }) => {
      if (!isVoiceActive()) return;
      const cb = getVoiceSubmitPromptCallback();
      if (cb) cb(payload);
    })
  );

  // =========================================================================
  // Propose Commit (voice agent triggered the "Commit with AI" feature)
  // =========================================================================
  // Mirrors handleSmartCommit() in GitOperationsPanel.tsx exactly: pre-fetch
  // the file list via git:get-commit-context, build the message that
  // CommitRequestCard recognizes (so the "Requesting commit proposal"
  // widget appears in the transcript), and dispatch via ai:sendMessage so
  // it lands in the session as a regular user message. The coding agent
  // then invokes developer_git_commit_proposal, and the resulting widget +
  // git_commit_proposal_request interactive prompt flow back through the
  // existing forwarding pipeline.
  cleanups.push(
    window.electronAPI.on('voice-mode:propose-commit', async (payload: {
      sessionId: string;
      workspacePath: string | null;
    }) => {
      if (!isVoiceActive()) return;
      const { sessionId, workspacePath } = payload;
      if (!sessionId || !workspacePath) {
        console.warn('[voiceModeListeners] propose-commit missing sessionId or workspacePath');
        return;
      }

      try {
        const commitContext = await window.electronAPI.invoke(
          'git:get-commit-context',
          workspacePath,
          sessionId,
          undefined,
        ) as {
          success: boolean;
          files: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>;
          scenario: 'single' | 'workstream';
          error?: string;
        };

        let message = 'Use the developer_git_commit_proposal tool to create a commit. If its schema is not loaded, use ToolSearch to load it first.';

        if (commitContext.success && commitContext.files.length > 0) {
          const fileList = commitContext.files
            .map(f => `- ${f.path} (${f.status})`)
            .join('\n');
          message += `\n\nHere are the files edited in this session that have uncommitted changes:\n${fileList}`;
          message += '\n\nThis list covers files edited directly. If you ALSO ran commands this session that change files as a side effect ' +
            '(e.g. npm install rewriting package-lock.json, a build/codegen step, license regeneration), include those changed files too -- ' +
            'check git status for them. If you ran no such commands, the list above is complete; do not go looking. ' +
            'Either way, do NOT add unrelated uncommitted changes -- other concurrent sessions may have their own work in this repo.';
          message += '\n\nThen call developer_git_commit_proposal with the file list.';
          message += '\nDo NOT call get_session_edited_files or get_workstream_edited_files -- the edited-file data is already provided above.';
        } else if (commitContext.success && commitContext.files.length === 0) {
          message += '\n\nNo session-edited files have uncommitted changes. Check git status to see if there are any other uncommitted changes to commit.';
        } else {
          message += '\n\nFirst call get_session_edited_files to find all files edited, ' +
            'then cross-reference with git status to include all session-edited files that have uncommitted changes.';
        }

        const docContext = {
          filePath: undefined,
          content: undefined,
          fileType: undefined,
          attachments: undefined,
          mode: 'agent',
          inputType: 'user' as const,
        };
        await window.electronAPI.invoke('ai:sendMessage', message, docContext, sessionId, workspacePath);
      } catch (error) {
        console.error('[voiceModeListeners] propose-commit failed:', error);
      }
    })
  );

  // =========================================================================
  // Error (quota exceeded, rate limits, etc.)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:error', (payload: {
      sessionId: string;
      error: { type: string; message: string };
    }) => {
      if (!isVoiceActive()) return;
      // Retries exhausted -- clear the transient reconnect state and surface the
      // hard error.
      store.set(voiceReconnectingAtom, false);
      store.set(voiceErrorAtom, payload.error);
    })
  );

  // =========================================================================
  // Reconnect (transient socket drop -> backoff reconnect)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:reconnecting', (_payload: {
      sessionId: string;
      attempt: number;
    }) => {
      if (!isVoiceActive()) return;
      store.set(voiceReconnectingAtom, true);
    })
  );
  cleanups.push(
    window.electronAPI.on('voice-mode:reconnected', (_payload: {
      sessionId: string;
    }) => {
      if (!isVoiceActive()) return;
      store.set(voiceReconnectingAtom, false);
      // A speech_stopped may have been lost with the socket; drop any stale
      // speech hold and start a fresh listen window if the mic is open.
      listenWindow.reset();
      if (store.get(voiceListenStateAtom) === 'listening') {
        listenWindow.start('reconnected');
      }
    })
  );

  // =========================================================================
  // Transcript Complete (user finished speaking)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:transcript-complete', (payload: {
      sessionId: string;
      transcript: string;
    }) => {
      if (!isVoiceActive()) return;
      if (!payload.transcript || payload.transcript.trim() === '') return;

      // Transcript arrived = THAT utterance is done. Arm the idle timer in
      // case speech_stopped was missed -- but transcription lags, so this can
      // land after the user already started the NEXT utterance; the controller
      // holds the arm in that case instead of expiring mid-speech (NIM-1594).
      // console.log('[voiceModeListeners] transcript-complete -> starting listen window timer');
      listenWindow.start('transcript-complete');

      // Clear partial text
      store.set(voiceCurrentUserTextAtom, '');

      // Append completed user entry
      const entries = store.get(voiceTranscriptEntriesAtom);
      const entry: VoiceTranscriptEntry = {
        id: `user-${Date.now()}`,
        role: 'user',
        text: payload.transcript.trim(),
        timestamp: Date.now(),
      };
      store.set(voiceTranscriptEntriesAtom, [...entries, entry]);

      // Write to DB immediately
      writeTranscriptEntry(entry);
    })
  );

  // =========================================================================
  // Transcript Delta (streaming partial transcription while user speaks)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:transcript-delta', (payload: {
      sessionId: string;
      delta: string;
      itemId: string;
    }) => {
      if (!isVoiceActive()) return;
      store.set(voiceCurrentUserTextAtom, payload.delta);
    })
  );

  // =========================================================================
  // Text Received (assistant response text deltas)
  // =========================================================================
  // Track the last assistant entry ID so we can update it in-place in the atom
  // but only write to DB once when the entry is "complete" (next user turn or stop).
  // Actually, we write each new assistant entry to DB when it starts,
  // then update its content as deltas arrive. But writing every delta is too much.
  // Instead: write assistant entries on response.done or when the next user speaks.
  let pendingAssistantEntry: VoiceTranscriptEntry | null = null;

  cleanups.push(
    window.electronAPI.on('voice-mode:text-received', (payload: {
      sessionId: string;
      text: string;
    }) => {
      if (!isVoiceActive()) return;

      // Assistant is responding -- wake up if sleeping so user can reply,
      // and CLEAR the timer while speaking. The timer should only start
      // when the assistant FINISHES (via token-usage), not during speech.
      // This prevents the mic from timing out while the assistant talks.
      if (store.get(voiceListenStateAtom) === 'sleeping') {
        wakeVoiceListening(false);
      }
      listenWindow.clear();

      const entries = store.get(voiceTranscriptEntriesAtom);
      const lastEntry = entries[entries.length - 1];

      if (lastEntry && lastEntry.role === 'assistant') {
        // Append to existing assistant entry
        const updated = entries.map((e, i) =>
          i === entries.length - 1
            ? { ...e, text: e.text + payload.text, timestamp: Date.now() }
            : e
        );
        store.set(voiceTranscriptEntriesAtom, updated);
        // Update pending entry for batch write
        pendingAssistantEntry = updated[updated.length - 1];
      } else {
        // Flush any previous pending assistant entry
        if (pendingAssistantEntry) {
          writeTranscriptEntry(pendingAssistantEntry);
          pendingAssistantEntry = null;
        }
        // Start new assistant entry
        const entry: VoiceTranscriptEntry = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          text: payload.text,
          timestamp: Date.now(),
        };
        store.set(voiceTranscriptEntriesAtom, [...entries, entry]);
        pendingAssistantEntry = entry;
      }
    })
  );

  // =========================================================================
  // Tool Calls -- persist voice-agent tool calls so they're visible in the
  // session transcript (rendered via VoiceRawParser as real tool widgets).
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:tool-call', (payload: {
      sessionId: string;
      event: VoiceToolCallEvent;
    }) => {
      if (!isVoiceActive()) return;
      // Flush any in-progress assistant entry first so transcript ordering is
      // preserved (the tool call happened before the next spoken reply).
      if (pendingAssistantEntry) {
        writeTranscriptEntry(pendingAssistantEntry);
        pendingAssistantEntry = null;
      }
      writeToolCallEntry(payload.event);
    })
  );

  // =========================================================================
  // Token Usage -- also flush pending assistant entry
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:token-usage', (payload: {
      sessionId: string;
      usage: VoiceTokenUsage;
    }) => {
      if (!isVoiceActive()) return;

      store.set(voiceTokenUsageAtom, payload.usage);

      // Token usage arrives after response.done, so flush the assistant entry
      if (pendingAssistantEntry) {
        writeTranscriptEntry(pendingAssistantEntry);
        pendingAssistantEntry = null;
      }

      // Assistant finished a turn server-side. Decide when to start the 15s
      // listen window: if audio is still playing in the user's speakers,
      // wait for the playback queue to drain. Otherwise (function-call-only
      // turn or text-only response), start it now.
      const audioActiveQuery = getVoiceAudioActiveQuery();
      const audioStillPlaying = audioActiveQuery ? audioActiveQuery() : false;

      if (audioStillPlaying) {
        // Defer until AudioPlayback fires onDrained (then notifyVoiceAudioPlaybackDrained).
        _pendingPostTurnTimer = true;
        // Fallback: if the drain notification never arrives (e.g. AudioPlayback
        // is destroyed or the callback wiring breaks), start the timer after a
        // generous max-playback duration so the mic doesn't stay open forever.
        if (_postTurnFallbackTimer) clearTimeout(_postTurnFallbackTimer);
        _postTurnFallbackTimer = setTimeout(() => {
          if (!_pendingPostTurnTimer) return;
          clearPostTurnPending();
          startListenWindowForPostTurn();
        }, 60000);
      } else {
        // No audio playing -- start the timer immediately.
        clearPostTurnPending();
        startListenWindowForPostTurn();
      }
    })
  );

  // =========================================================================
  // Agent Task Complete (forward coding agent completion to voice agent)
  // =========================================================================
  cleanups.push(
    window.electronAPI.onAIStreamResponse((data: any) => {
      if (!isVoiceActive()) return;
      if (!data.isComplete) return;

      const cb = getVoiceAgentTaskCompleteCallback();
      if (cb) cb(data);
    })
  );

  // =========================================================================
  // Voice Session Stopped (update metadata, reset state)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:stopped', async (payload: {
      sessionId: string;
      tokenUsage?: VoiceTokenUsage;
    }) => {
      if (!isVoiceActive()) return;

      // Flush any pending assistant entry
      if (pendingAssistantEntry) {
        writeTranscriptEntry(pendingAssistantEntry);
        pendingAssistantEntry = null;
      }

      // Write stop diagnostic before clearing state
      const startTime = store.get(voiceSessionStartTimeAtom);
      const durationSec = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
      writeDiagnosticEntry(`Voice stopped (duration: ${durationSec}s)`);

      // Update final metadata
      await updateSessionMetadata(payload.tokenUsage);

      // Notify component for audio cleanup
      const stoppedCb = getVoiceStoppedCallback();
      if (stoppedCb) stoppedCb();

      // Reset atoms
      resetVoiceAtoms();
    })
  );

  // =========================================================================
  // Pause Listening (voice agent tool or programmatic)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:pause-listening', (_payload: {
      sessionId: string;
    }) => {
      if (!isVoiceActive()) return;
      sleepVoiceListening();
    })
  );

  // =========================================================================
  // Respond to Interactive Prompt (voice agent answered a question)
  // =========================================================================
  // The voice agent called respond_to_interactive_prompt, and the main process
  // forwarded the response here. Use respondToPromptAtom to submit the answer.
  cleanups.push(
    window.electronAPI.on('voice-mode:respond-to-prompt', (payload: {
      sessionId: string;
      promptId: string;
      promptType: string;
      response: any;
    }) => {
      if (!isVoiceActive()) return;

      // console.log('[voiceModeListeners] Responding to interactive prompt via voice:', payload.promptId);

      let response = payload.response;

      // For AskUserQuestion: the voice agent sends { answers: { _voice: "answer" } }
      // but the widget expects answers keyed by the actual question text.
      // Look up the pending prompt to get the real question text and rebuild the answers.
      if (payload.promptType === 'ask_user_question_request' && response?.answers?._voice) {
        const pendingPrompts = store.get(sessionPendingPromptsAtom(payload.sessionId));
        const prompt = pendingPrompts.find(p => p.promptId === payload.promptId);
        const questions = prompt?.data?.questions;
        if (questions && Array.isArray(questions) && questions.length > 0) {
          const voiceAnswer = response.answers._voice;
          const rebuiltAnswers: Record<string, string> = {};
          // Map the voice answer to the first question (most common case)
          // For multi-question prompts, the voice answer applies to the first unanswered question
          rebuiltAnswers[questions[0].question] = voiceAnswer;
          response = { ...response, answers: rebuiltAnswers };
          // console.log('[voiceModeListeners] Rebuilt voice answer with question key:', questions[0].question);
        }
      }

      // GitCommitProposal: the widget click flow invokes git:commit and then
      // sends messages:respond-to-prompt with { action: 'committed' | 'cancelled' }.
      // The voice agent's "approve"/"reject" answer arrives here as
      // { approved: true|false } -- mirror the widget flow so the voice path
      // produces the same end state.
      if (payload.promptType === 'git_commit_proposal_request') {
        const approved = response?.approved === true;
        const pendingPrompts = store.get(sessionPendingPromptsAtom(payload.sessionId));
        const prompt = pendingPrompts.find(p => p.promptId === payload.promptId);
        const data = prompt?.data || {};
        const filesToStage: Array<string | { path: string }> = Array.isArray(data.filesToStage)
          ? data.filesToStage
          : [];
        const filePaths = filesToStage.map(f => (typeof f === 'string' ? f : f.path));
        const commitMessage: string = data.commitMessage || '';
        const commitWorkspacePath: string =
          data.workspacePath || store.get(voiceWorkspacePathAtom) || '';

        if (approved && commitWorkspacePath && filePaths.length > 0 && commitMessage) {
          // Run the actual commit, then forward the result so the durable
          // prompt is resolved with the same shape the widget produces.
          window.electronAPI
            .invoke('git:commit', commitWorkspacePath, commitMessage, filePaths)
            .then((result: any) => {
              window.electronAPI.invoke('messages:respond-to-prompt', {
                sessionId: payload.sessionId,
                promptId: payload.promptId,
                promptType: 'git_commit_proposal_request',
                response: {
                  action: result?.success ? 'committed' : 'cancelled',
                  commitHash: result?.commitHash,
                  commitDate: result?.commitDate,
                  error: result?.error,
                  filesCommitted: result?.success ? filePaths : undefined,
                  commitMessage: result?.success ? commitMessage : undefined,
                },
                respondedBy: 'desktop',
              });
            })
            .catch((error: unknown) => {
              window.electronAPI.invoke('messages:respond-to-prompt', {
                sessionId: payload.sessionId,
                promptId: payload.promptId,
                promptType: 'git_commit_proposal_request',
                response: {
                  action: 'cancelled',
                  error: error instanceof Error ? error.message : String(error),
                },
                respondedBy: 'desktop',
              });
            });
        } else {
          // Reject path -- or missing data, can't safely commit. Cancel cleanly.
          window.electronAPI.invoke('messages:respond-to-prompt', {
            sessionId: payload.sessionId,
            promptId: payload.promptId,
            promptType: 'git_commit_proposal_request',
            response: { action: 'cancelled' },
            respondedBy: 'desktop',
          });
        }
        return;
      }

      // For RequestUserInput: the voice agent emits an answer keyed by
      // field id. Persist via messages:respond-to-prompt directly so the
      // response shape matches the durable contract (answers + cancelled).
      if (payload.promptType === 'request_user_input_request') {
        const answers = response?.answers && typeof response.answers === 'object'
          ? response.answers
          : {};
        const cancelled = response?.cancelled === true;
        window.electronAPI.invoke('messages:respond-to-prompt', {
          sessionId: payload.sessionId,
          promptId: payload.promptId,
          promptType: 'request_user_input_request',
          response: { answers, cancelled },
          respondedBy: 'desktop',
        });
        return;
      }

      // Use the respondToPromptAtom to persist and resolve the prompt
      store.set(respondToPromptAtom, {
        sessionId: payload.sessionId,
        promptId: payload.promptId,
        promptType: payload.promptType as any,
        response,
      });
    })
  );

  // =========================================================================
  // Editor Context Tracking (active file -> voice agent)
  // =========================================================================
  // When voice is active, track which file the user is viewing and notify
  // the main process so the voice agent knows what document is open.
  // This is pure Jotai -- no React state involved.

  let editorContextDebounce: ReturnType<typeof setTimeout> | null = null;
  function checkAndReportFileChange(): void {
    const voiceSessionId = store.get(voiceActiveSessionIdAtom);
    if (!voiceSessionId) return;

    if (editorContextDebounce) clearTimeout(editorContextDebounce);
    editorContextDebounce = setTimeout(() => {
      const currentFile = getCurrentVoiceFilePath();
      const lastReported = store.get(voiceLastReportedFileAtom);

      if (currentFile !== lastReported) {
        store.set(voiceLastReportedFileAtom, currentFile);
        window.electronAPI.send('voice-mode:editor-context-changed', {
          sessionId: voiceSessionId,
          filePath: currentFile,
        });

        const shortPrev = lastReported ? lastReported.split('/').pop() : '(none)';
        const shortCurr = currentFile ? currentFile.split('/').pop() : '(none)';
        writeDiagnosticEntry(`File changed: ${shortPrev} -> ${shortCurr}`);
      }
    }, 300);
  }

  // =========================================================================
  // Session Switch Tracking (voice follows the active coding session)
  // =========================================================================
  // When the user switches coding sessions while voice is active,
  // update the linked session so voice commands go to the right place.
  function syncLinkedSession(): void {
    const voiceSessionId = store.get(voiceActiveSessionIdAtom);
    if (!voiceSessionId) return; // voice not active

    const newSessionId = store.get(activeSessionIdAtom);
    if (!newSessionId || newSessionId === voiceSessionId) return;

    // Update the atom so renderer-side filtering matches
    store.set(voiceActiveSessionIdAtom, newSessionId);

    // Look up the session name for the voice agent
    const registry = store.get(sessionRegistryAtom);
    const sessionMeta = registry.get(newSessionId);
    const sessionName = sessionMeta?.title || 'Untitled';

    // Notify main process so voice agent callbacks target the new session
    window.electronAPI.send('voice-mode:update-linked-session', {
      newSessionId,
      sessionName,
    });

    // Notify VoiceModeButton's module-level variable
    if (_onLinkedSessionChanged) {
      _onLinkedSessionChanged(newSessionId);
    }

    console.log(`[voiceModeListeners] Voice session followed active session switch -> "${sessionName}"`);
    writeDiagnosticEntry(`Switched linked session to "${sessionName}"`);
  }
  cleanups.push(store.sub(activeSessionIdAtom, syncLinkedSession));

  // =========================================================================
  // Interactive Prompt Wake (AskUserQuestion, GitCommitProposal, etc.)
  // =========================================================================
  // When the coding agent presents an interactive prompt that needs user input,
  // wake voice from sleeping so the user can respond verbally.
  //
  // We subscribe to sessionPendingPromptsAtom (the actual data array) rather
  // than sessionHasPendingInteractivePromptAtom (boolean) because:
  // 1. The boolean was set before the DB-backed prompt data was loaded,
  //    so reading sessionPendingPromptsAtom would find it empty.
  // 2. Setting a boolean to the same value (true->true) doesn't trigger
  //    Jotai subscriptions, so repeated prompts wouldn't wake voice.
  // The prompts array changes reference on each refresh, reliably firing.
  let promptUnsub: (() => void) | null = null;
  let lastForwardedPromptId: string | null = null;
  function updatePromptSubscription(): void {
    if (promptUnsub) {
      promptUnsub();
      promptUnsub = null;
    }
    lastForwardedPromptId = null;
    const voiceSessionId = store.get(voiceActiveSessionIdAtom);
    if (!voiceSessionId) return;

    promptUnsub = store.sub(sessionPendingPromptsAtom(voiceSessionId), () => {
      const pendingPrompts = store.get(sessionPendingPromptsAtom(voiceSessionId));
      if (pendingPrompts.length === 0) return;

      const latestPrompt = pendingPrompts[pendingPrompts.length - 1];
      // Skip if we already forwarded this exact prompt
      if (latestPrompt.promptId === lastForwardedPromptId) return;

      // Wake voice from sleeping so user can respond
      if (store.get(voiceListenStateAtom) === 'sleeping') {
        // console.log('[voiceModeListeners] Interactive prompt detected -> waking voice');
        wakeVoiceListening(true);
      }

      // Forward the prompt content to the voice agent so it can speak it
      lastForwardedPromptId = latestPrompt.promptId;
      const description = formatPromptForVoice(latestPrompt);
      const voiceFriendly = computeVoiceFriendly(latestPrompt);
      // console.log('[voiceModeListeners] Sending interactive-prompt IPC:', {
      //   sessionId: voiceSessionId,
      //   promptId: latestPrompt.promptId,
      //   promptType: latestPrompt.promptType,
      //   descriptionLength: description.length,
      //   voiceFriendly,
      // });
      window.electronAPI.send('voice-mode:interactive-prompt', {
        sessionId: voiceSessionId,
        promptId: latestPrompt.promptId,
        promptType: latestPrompt.promptType,
        description,
        voiceFriendly,
      });
    });
  }
  // Re-subscribe when the linked session changes
  cleanups.push(store.sub(voiceActiveSessionIdAtom, updatePromptSubscription));
  updatePromptSubscription();
  cleanups.push(() => {
    if (promptUnsub) {
      promptUnsub();
      promptUnsub = null;
    }
  });

  cleanups.push(store.sub(activeTabIdAtom('main'), checkAndReportFileChange));
  cleanups.push(store.sub(activeSessionIdAtom, checkAndReportFileChange));
  cleanups.push(store.sub(windowModeAtom, checkAndReportFileChange));
  cleanups.push(store.sub(voiceActiveSessionIdAtom, checkAndReportFileChange));

  let sessionTabUnsub: (() => void) | null = null;
  function updateSessionTabSubscription(): void {
    if (sessionTabUnsub) {
      sessionTabUnsub();
      sessionTabUnsub = null;
    }
    const sessionId = store.get(activeSessionIdAtom);
    if (!sessionId) return;
    const context = makeEditorContext(sessionId);
    sessionTabUnsub = store.sub(activeTabIdAtom(context), checkAndReportFileChange);
  }
  updateSessionTabSubscription();
  cleanups.push(store.sub(activeSessionIdAtom, updateSessionTabSubscription));
  cleanups.push(() => {
    if (sessionTabUnsub) {
      sessionTabUnsub();
      sessionTabUnsub = null;
    }
    if (editorContextDebounce) {
      clearTimeout(editorContextDebounce);
    }
    listenWindow.reset();
  });

  return () => {
    cleanups.forEach(fn => fn?.());
  };
}

/** How long before a voice session is considered "expired" and a new one is created */
const VOICE_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Set the active voice session ID and create or resume the DB session row.
 *
 * If a recent voice session exists for this workspace (updated within the
 * timeout window), we resume it so transcript entries continue appending
 * to the same session. Otherwise we create a new one.
 *
 * Called when a voice session starts (from VoiceModeButton).
 */
export async function setVoiceActiveSession(sessionId: string, workspacePath?: string | null): Promise<void> {
  // Set atoms immediately so the UI reflects active state
  store.set(voiceActiveSessionIdAtom, sessionId);
  store.set(voiceListenStateAtom, 'listening');
  store.set(voiceTranscriptEntriesAtom, []);
  store.set(voiceCurrentUserTextAtom, '');
  store.set(voiceTokenUsageAtom, null);
  store.set(voiceSessionStartTimeAtom, Date.now());
  store.set(voiceWorkspacePathAtom, workspacePath || null);
  store.set(voiceLastReportedFileAtom, null);

  // Start the listen window timer (fresh session -- no in-flight speech)
  listenWindow.reset();
  listenWindow.start('session-start');

  // Try to find and resume a recent voice session
  const wp = workspacePath || '';
  try {
    const result = await window.electronAPI.invoke('voice-mode:findRecentSession', {
      workspacePath: wp,
      timeoutMs: VOICE_SESSION_TIMEOUT_MS,
    }) as { found: boolean; sessionId?: string };

    if (result.found && result.sessionId) {
      // Resume existing session
      store.set(voiceDbSessionIdAtom, result.sessionId);
      window.electronAPI.invoke('voice-mode:resumeSession', {
        sessionId: result.sessionId,
        linkedSessionId: sessionId,
      }).catch(error => {
        console.error('[voiceModeListeners] Failed to resume voice session:', error);
      });
      // console.log('[voiceModeListeners] Resumed voice session:', result.sessionId);
      writeDiagnosticEntry(`Resumed voice session (linked to ${sessionId.slice(0, 8)}...)`);
      return;
    }
  } catch (error) {
    console.error('[voiceModeListeners] Failed to check for recent session:', error);
  }

  // No recent session -- create a new one
  const dbSessionId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  store.set(voiceDbSessionIdAtom, dbSessionId);

  window.electronAPI.invoke('voice-mode:createSession', {
    id: dbSessionId,
    workspacePath: wp,
    linkedSessionId: sessionId,
  }).then(() => {
    // Refresh the session-history list so the new voice session appears
    // immediately instead of only after a manual refresh. The DB row exists
    // now; re-query the registry from the database.
    void store.set(refreshSessionListAtom);
  }).catch(error => {
    console.error('[voiceModeListeners] Failed to create voice session in DB:', error);
  });
  // console.log('[voiceModeListeners] Created new voice session:', dbSessionId);
  writeDiagnosticEntry(`New voice session created (linked to ${sessionId.slice(0, 8)}...)`);
}

/**
 * Persist final metadata and clear voice session state.
 * Called when a voice session is stopped by the user (not via voice-mode:stopped IPC).
 */
export async function persistAndClearVoiceSession(
  _sessionId: string,
  tokenUsage?: VoiceTokenUsage | null,
): Promise<void> {
  await updateSessionMetadata(tokenUsage);
  resetVoiceAtoms();
}

/**
 * Clear the active voice session without persisting.
 * Used for error paths and cleanup where no persistence is needed.
 */
export function clearVoiceActiveSession(): void {
  resetVoiceAtoms();
}
