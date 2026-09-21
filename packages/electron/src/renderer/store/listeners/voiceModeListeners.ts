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
import { createVoiceTranscriptRefresh } from './voiceTranscriptRefresh';
import { hasVoiceAudioSignal } from '../../utils/voiceAudioActivity';
import { formatGitCommitProposalForVoice } from './voiceInteractivePrompt';
import { activeSessionIdAtom, agentSessionAttentionAtom, sessionRegistryAtom, sessionHasPendingInteractivePromptAtom, sessionPendingPromptsAtom, sessionProcessingAtom, respondToPromptAtom, refreshSessionListAtom } from '../atoms/sessions';
import { windowModeAtom } from '../atoms/windowMode';
import { buildCommitPrompt } from '@nimbalyst/runtime/ui/AgentTranscript/utils/commitPromptBuilder';
import {
  VoiceEventQueue,
  type VoiceQueueEntry,
  type VoiceRunState,
} from '../../../main/services/voice/events/voiceEventQueue';

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

let lastSpeechHoldReason: string | null = null;
// Live has incremental transcripts, not VAD. A hold must be renewed by text.
const LIVE_SPEECH_LEASE_MS = 1500;
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
    if (lastSpeechHoldReason === reason) return;
    lastSpeechHoldReason = reason;
    console.log(`[voiceModeListeners] Listen window held open, user is speaking (${reason})`);
    writeDiagnosticEntry(`Listen window: held open during speech (${reason})`);
  },
  onSpeechExpired: () => {
    _userSpeaking = false;
    lastSpeechHoldReason = null;
    console.info('[VoiceSleep] Live speech hold expired without new transcript');
    if (getVoiceAudioActiveQuery()?.()) schedulePostTurnListenWindow(true);
    pumpVoiceEvents();
  },
});

// =========================================================================
// Post-Turn Listen Window
// =========================================================================
// Realtime arms on response usage; Live arms on audio activity. Both wait
// for audible playback to drain before giving the user a fresh listen window.

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

/** Wait for audible playback, with a fallback if the pipeline loses its drain. */
function schedulePostTurnListenWindow(audioStillPlaying = getVoiceAudioActiveQuery()?.() ?? false): void {
  clearPostTurnPending();
  if (!audioStillPlaying) {
    startListenWindowForPostTurn();
    return;
  }
  listenWindow.clear();
  _pendingPostTurnTimer = true;
  _postTurnFallbackTimer = setTimeout(() => {
    if (!_pendingPostTurnTimer) return;
    clearPostTurnPending();
    startListenWindowForPostTurn();
  }, 60000);
}

/**
 * Called by AudioPlayback (via VoiceModeButton) when the assistant's audio
 * queue has fully drained -- i.e. the user has actually finished hearing the
 * agent. If we deferred the post-turn listen window earlier, fire it now.
 */
export function notifyVoiceAudioPlaybackDrained(): void {
  // A drain is also the strongest evidence available that an announcement was
  // heard rather than merely accepted.
  noteAnnouncementPlaybackDrained();
  // Ordinary speech can hold queued completions too, without an announcement
  // in flight to trigger the retry above.
  pumpVoiceEvents();
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
    sendVoiceMessage('voice-mode:listen-state-changed', { sleeping: false });
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
  _userSpeaking = false;
  clearPostTurnPending();
  store.set(voiceListenStateAtom, 'sleeping');
  console.info('[VoiceSleep] Idle listening ended; requesting transport pause');
  // Tell main process to suspend the inactivity disconnect timer
  const voiceSessionId = store.get(voiceActiveSessionIdAtom);
  if (voiceSessionId) {
    sendVoiceMessage('voice-mode:listen-state-changed', { sleeping: true });
  }
  writeDiagnosticEntry('Listen window: sleeping');
}


let voiceTranscriptRefresh = createVoiceTranscriptRefresh();

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
    .then(voiceTranscriptRefresh.schedule)
    .catch(error => {
      console.error('[voiceModeListeners] Failed to write transcript entry:', error);
    });
}

/**
 * The utterance being transcribed right now, and the text accumulated for it.
 * Deltas are incremental, so the caption is their sum, keyed by the stable id
 * the engine assigns the utterance.
 */
let _captionItemId: string | null = null;
let _captionText = '';

/**
 * Append one finished user utterance to the open transcript and persist it.
 * Shared by every engine's "that utterance is done" signal.
 */
function commitUserUtterance(transcript: string): void {
  const text = transcript.trim();
  if (text.length === 0) return;
  const entry: VoiceTranscriptEntry = {
    id: `user-${Date.now()}`,
    role: 'user',
    text,
    timestamp: Date.now(),
  };
  store.set(voiceTranscriptEntriesAtom, [...store.get(voiceTranscriptEntriesAtom), entry]);
  writeTranscriptEntry(entry);
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
    .then(voiceTranscriptRefresh.schedule)
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
    .then(voiceTranscriptRefresh.schedule)
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
  // The conversation is over: queued announcements belong to it and must not
  // be waiting to speak when voice is next turned on.
  discardQueuedVoiceEvents();
  store.set(voiceListenStateAtom, 'off');
  store.set(voiceActiveSessionIdAtom, null);
  store.set(voiceTranscriptEntriesAtom, []);
  _captionItemId = null;
  _captionText = '';
  store.set(voiceCurrentUserTextAtom, '');
  store.set(voiceTokenUsageAtom, null);
  store.set(voiceSessionStartTimeAtom, null);
  store.set(voiceWorkspacePathAtom, null);
  store.set(voiceDbSessionIdAtom, null);
  store.set(voiceLastReportedFileAtom, null);
  store.set(voiceErrorAtom, null);
  store.set(voiceReconnectingAtom, false);
  // Nothing may be sent about a conversation that has ended, and the next one
  // will issue its own claim.
  _voiceClaim = null;
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

// =========================================================================
// Cross-Session Voice Event Queue
// =========================================================================
// Questions and completions from EVERY eligible agent session, not just the
// linked one, and they outlive the paid transport: on GPT-Live a sleeping
// session has no socket at all, so the decision about what is worth waking
// for cannot live in the engine.
//
// The queue itself (main/services/voice/events/voiceEventQueue) is a pure
// state machine over injected facts. Everything below is the observation
// layer: it supplies the clock, the current voice state, and the "is this
// prompt still pending" predicate, feeds it events, and carries out the plan
// it returns. It decides nothing itself.

/** This install. One announcing device per event; desktop is the only one here. */
const VOICE_DEVICE_ID = 'desktop';

/** True while the user is mid-utterance (speech-started, no stop yet). */
let _userSpeaking = false;
/** The engine the active voice session actually started on. */
let _voiceEngine: 'realtime' | 'live' = 'realtime';
/**
 * The conversation this renderer is authorized to drive, as main reported it at
 * activation.
 *
 * Main will not act on a `voice-mode:*` message that does not name its own
 * conversation and workspace, so every send goes through `sendVoiceMessage`
 * rather than assembling a payload by hand -- see voiceIpcAuthorization.ts. Null
 * until activation, which is also the correct state for a window that does not
 * own the conversation: it has nothing to quote and cannot address it.
 */
let _voiceClaim: { generation: number; workspacePath: string } | null = null;

/**
 * Send a message about the active voice conversation, naming it.
 *
 * Returns false when this renderer has no conversation to name, so callers can
 * tell "not sent" from "sent and ignored".
 */
export function sendVoiceMessage(channel: string, payload: Record<string, unknown> = {}): boolean {
  if (_voiceClaim === null) return false;
  window.electronAPI.send(channel, {
    ...payload,
    generation: _voiceClaim.generation,
    workspacePath: _voiceClaim.workspacePath,
  });
  return true;
}
/**
 * The announcement currently being spoken, and what would count as proof the
 * user heard it.
 *
 * `sawAudio` records that audio was handed to playback after the claim; the
 * presentation is confirmed only when that playback queue subsequently drains.
 * Backend acceptance is never the proof, and neither is a single fragment --
 * see noteAnnouncementAudio.
 */
let _announcement: {
  eventId: string;
  sawAudio: boolean;
} | null = null;
/**
 * Agent sessions this voice conversation handed work to. Their completions are
 * what the user is waiting to hear, as opposed to background chatter from a
 * session they never mentioned.
 */
const voiceSubmittedSessions = new Set<string>();

/**
 * Submissions this conversation queued that have not yet been seen to start,
 * oldest first, per agent session.
 *
 * An agent session runs one submission at a time and starts them in the order
 * they were queued, so the run that starts next is the oldest one still
 * waiting. That is the only place the mapping from "a run started" to "which
 * request it is" can be made -- the run itself carries no voice identity -- and
 * the alternative was for the engine to guess by recency, which bound the wrong
 * task whenever two submissions were queued before the first started.
 */
const pendingVoiceSubmissions = new Map<string, string[]>();

function notePendingVoiceSubmission(sessionId: string, submissionId: string): void {
  const queue = pendingVoiceSubmissions.get(sessionId);
  if (queue) queue.push(submissionId);
  else pendingVoiceSubmissions.set(sessionId, [submissionId]);
}

/** The submission a run that just started for this session came from, if ours. */
function takePendingVoiceSubmission(sessionId: string): string | null {
  const queue = pendingVoiceSubmissions.get(sessionId);
  if (!queue || queue.length === 0) return null;
  const submissionId = queue.shift() as string;
  if (queue.length === 0) pendingVoiceSubmissions.delete(sessionId);
  return submissionId;
}

/**
 * Per-session run bookkeeping. `revision` increments whenever a session starts
 * a new run, which is what makes a late completion from the previous run
 * recognizably superseded. An agent session runs one submission at a time, so
 * a completion always belongs to the run currently recorded here.
 */
interface SessionRun {
  revision: number;
  /**
   * What the session was doing at the last observation.
   *
   * Three states, not a boolean, because a run that stops to ask a question and
   * then carries on is ONE run. Counting the resumption as a new revision made
   * a session supersede its own outstanding task -- the user answered a
   * question and the answer to their original request was then never spoken.
   */
  state: 'idle' | 'running' | 'awaiting';
}
const sessionRuns = new Map<string, SessionRun>();

function runFor(sessionId: string): SessionRun {
  let run = sessionRuns.get(sessionId);
  if (!run) {
    run = { revision: 0, state: 'idle' };
    sessionRuns.set(sessionId, run);
  }
  return run;
}

/**
 * Voice state as the queue understands it. `conversing` is the state that
 * protects a live exchange from routine background completions, so it means
 * "someone is actually talking right now" -- the assistant is audible, or the
 * user is mid-utterance -- not merely "the mic is open".
 */
function currentVoiceRunState(): VoiceRunState {
  const listen = store.get(voiceListenStateAtom);
  if (listen === 'off' || store.get(voiceActiveSessionIdAtom) === null) return 'off';
  if (listen === 'sleeping') return 'sleeping';
  const audioActive = getVoiceAudioActiveQuery()?.() ?? false;
  return audioActive || _userSpeaking ? 'conversing' : 'listening';
}

/**
 * Does this answer fit the prompt type it claims to answer?
 *
 * Not a schema validator -- each branch below already reads the fields it
 * needs. What this rejects is an answer whose *kind* does not match, which is
 * what let a controller-chosen `promptType` select a delivery branch the real
 * prompt never asked for. Unknown types are accepted: a new prompt type must
 * not be silently unanswerable by voice, and the branch that handles it still
 * validates its own fields.
 */
function isAnswerShapeAcceptable(promptType: string, response: unknown): boolean {
  if (response === null || typeof response !== 'object') return false;
  const record = response as Record<string, unknown>;
  switch (promptType) {
    case 'ask_user_question_request':
      return record.answers !== null && typeof record.answers === 'object';
    case 'request_user_input_request':
      return (
        record.cancelled === true ||
        (record.answers !== null && typeof record.answers === 'object')
      );
    case 'git_commit_proposal_request':
      // Exactly `{ approved: boolean }`. An answer that is neither approve nor
      // reject is not a decision, and the branch below would read it as a
      // cancellation -- silently discarding a proposal the user was read.
      // Rejecting it here releases the claim so the question is asked again.
      return typeof record.approved === 'boolean';
    default:
      return true;
  }
}

/** Is the prompt this event announced still waiting for an answer? */
function isQueuedPromptPending(entry: VoiceQueueEntry): boolean {
  if (entry.kind !== 'question' || !entry.promptId) return true;
  return store
    .get(sessionPendingPromptsAtom(entry.source.sessionId))
    .some((prompt) => prompt.promptId === entry.promptId);
}

const voiceEventQueue = new VoiceEventQueue({
  now: () => Date.now(),
  getVoiceState: currentVoiceRunState,
  isPromptPending: isQueuedPromptPending,
  // A question can restore a sleeping session because a human is blocked on
  // it. A ROUTINE completion cannot: reopening a paid session to say "that
  // finished" is the interruption (and the bill) this design exists to avoid.
  // The completion of work the user handed over by voice is not routine, and
  // carries wakeOnSleep to say so -- see the task-completed listener.
  wakeForCompletions: false,
});

/**
 * Announcement details the queue does not carry, because they are delivery
 * concerns rather than scheduling ones.
 */
const announceExtras = new Map<string, { promptType: string; voiceFriendly: boolean }>();

/**
 * Drive the queue: ask what should be said next, and say it.
 *
 * Called after anything that could change the answer -- a new event, a state
 * change, an answer, an announcement being heard.
 */
/** Terminal entries older than this are of no further use to anyone. */
const VOICE_EVENT_RETENTION_MS = 5 * 60_000;

let lastQueueDecision: string | null = null;
function pumpVoiceEvents(): void {
  // A long conversation answers and announces a great many events, and every
  // terminal entry it produced stayed in the map for the renderer's lifetime
  // because nothing ever called prune. This is the natural place: it runs after
  // anything that could have retired an entry.
  voiceEventQueue.prune(VOICE_EVENT_RETENTION_MS);
  // planNext() is also what expires an announcement claim nobody confirmed, so
  // it runs first: an announcement that never produced audio must release the
  // event rather than wedge the queue behind it forever.
  let plan = voiceEventQueue.planNext();
  if (_announcement !== null) {
    if (voiceEventQueue.get(_announcement.eventId)?.status === 'announcing') return;
    _announcement = null;
    plan = voiceEventQueue.planNext();
  }
  if (plan.action !== 'announce') {
    // Log transitions only, with no session IDs, questions, or answer text.
    if (lastQueueDecision !== plan.reason) {
      lastQueueDecision = plan.reason;
      console.info('[VoiceQueue]', JSON.stringify({ action: 'defer', reason: plan.reason }));
    }
    return;
  }
  lastQueueDecision = 'announce';
  console.info('[VoiceQueue]', JSON.stringify({ action: 'announce', kind: plan.entry.kind, requiresWake: plan.requiresWake }));

  const { entry } = plan;
  if (!voiceEventQueue.beginAnnouncement(entry.eventId, VOICE_DEVICE_ID)) return;
  _announcement = { eventId: entry.eventId, sawAudio: false };

  if (plan.requiresWake) {
    // Restores an armed sleeping session (on Live, reopens the paid
    // transport). wakeVoiceListening refuses when voice is off, so an event
    // can never reopen a conversation the user explicitly ended.
    wakeVoiceListening(true);
  }

  if (entry.kind === 'question') {
    const extras = announceExtras.get(entry.eventId);
    sendVoiceMessage('voice-mode:interactive-prompt', {
      sessionId: entry.source.sessionId,
      promptId: entry.promptId,
      promptType: extras?.promptType,
      description: entry.source.sessionId === store.get(voiceActiveSessionIdAtom)
        ? entry.summary
        : `From ${entry.sourceLabel}: ${entry.summary}`,
      voiceFriendly: extras?.voiceFriendly ?? true,
    });
    return;
  }

  sendVoiceMessage('voice-mode:announce-completion', {
    sessionId: entry.source.sessionId,
    // Main resolves the engine's own durable task id for this session; it is
    // the authority on what it accepted.
    taskId: null,
    summary: entry.coalescedCount > 1
      ? `${entry.sourceLabel}: ${entry.summary} (${entry.coalescedCount} updates)`
      : `${entry.sourceLabel}: ${entry.summary}`,
  });
}

/**
 * Assistant audio was handed to playback while this announcement was in flight.
 *
 * Evidence, not proof, and two things it deliberately is not:
 *
 * Not text. An assistant text fragment is the backend having accepted the
 * announcement, and accepting is not hearing.
 *
 * Not enough on its own. There is no per-announcement identity on
 * `voice-mode:audio-received` -- the payload is the voice session and PCM -- so
 * a fragment cannot be attributed to this announcement rather than to the tail
 * of whatever the model was already producing. The one thing the application
 * does own is its own playback queue, so presentation is confirmed by the drain
 * below: everything queued after the claim has audibly finished. That holds
 * whether or not something was already playing when the claim was made, which
 * is why there is no longer a fast path for the quiet case.
 */
function noteAnnouncementAudio(): void {
  if (_announcement === null) return;
  _announcement.sawAudio = true;
}

/**
 * The playback queue drained. Anything audible that was queued after the
 * announcement was claimed has now been played.
 */
function noteAnnouncementPlaybackDrained(): void {
  if (_announcement === null || !_announcement.sawAudio) return;
  markAnnouncementPresented();
}

function markAnnouncementPresented(): void {
  if (_announcement === null) return;
  voiceEventQueue.markPresented(_announcement.eventId, VOICE_DEVICE_ID);
  _announcement = null;
  pumpVoiceEvents();
}

/** Forget everything queued for a conversation that has ended. */
function discardQueuedVoiceEvents(): void {
  // `pending()` is the announcement candidate list -- `queued` only -- so
  // dropping that left every announcing and presented question in place, still
  // holding the floor when voice was next turned on. Nothing outlives the
  // conversation it belonged to, terminal entries and dedup memory included.
  voiceEventQueue.clear();
  announceExtras.clear();
  sessionRuns.clear();
  voiceSubmittedSessions.clear();
  pendingVoiceSubmissions.clear();
  _announcement = null;
  _userSpeaking = false;
  lastSpeechHoldReason = null;
  lastQueueDecision = null;
}

function sessionLabel(sessionId: string): string {
  return store.get(sessionRegistryAtom).get(sessionId)?.title || 'a session';
}

/**
 * Initialize voice mode IPC listeners.
 * Should be called once at app startup.
 *
 * @returns Cleanup function to call on unmount
 */
export function initVoiceModeListeners(): () => void {
  voiceTranscriptRefresh.dispose();
  voiceTranscriptRefresh = createVoiceTranscriptRefresh();
  const cleanups: Array<() => void> = [voiceTranscriptRefresh.dispose];

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
      // Keep the countdown stopped while assistant audio is playing.
      if (_voiceEngine === 'live' && !hasVoiceAudioSignal(payload.audioBase64)) {
        // Preserve stream timing while awake, without cancelling the idle
        // timer, waking a sleeping session, or marking an announcement heard.
        if (store.get(voiceListenStateAtom) === 'listening') getVoiceAudioCallback()?.(payload.audioBase64);
        return;
      }
      if (store.get(voiceListenStateAtom) === 'sleeping') {
        wakeVoiceListening(false);
      }
      listenWindow.clear();

      const cb = getVoiceAudioCallback();
      // Only audio accepted by the playback pipeline counts as presented.
      const queued = cb?.(payload.audioBase64) ?? false;
      // Live usage is periodic accounting, not response.done. Audio itself
      // must arrange the countdown, even if no usage report ever arrives.
      if (_voiceEngine === 'live') {
        if (queued) schedulePostTurnListenWindow(true);
        else listenWindow.start('audio-unavailable');
      }
      if (queued) noteAnnouncementAudio();
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
      _userSpeaking = true;
      listenWindow.speechStarted(_voiceEngine === 'live' ? LIVE_SPEECH_LEASE_MS : undefined);
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
      // Live's delayed playback-flush decision is not new speech evidence.
      if (_voiceEngine !== 'live') listenWindow.speechStarted();

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
      _userSpeaking = false;
      lastSpeechHoldReason = null;
      listenWindow.speechStopped();
      pumpVoiceEvents();
    })
  );

  // =========================================================================
  // Submit Prompt (voice agent wants to send a coding task)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:submit-prompt', async (payload: {
      sessionId: string;
      workspacePath: string | null;
      prompt: string;
      submissionId?: string;
      codingAgentPrompt?: { prepend?: string; append?: string };
      resultChannel?: string;
    }) => {
      // Main waits on this answer before the voice agent is told the task was
      // accepted, so every path has to report one -- including the refusals.
      const reply = (queued: boolean, error?: string): void => {
        if (!payload.resultChannel) return;
        window.electronAPI.send(payload.resultChannel, { queued, error });
      };
      if (!isVoiceActive()) {
        reply(false, 'Voice mode is not active.');
        return;
      }
      const cb = getVoiceSubmitPromptCallback();
      if (!cb) {
        reply(false, 'The session queue is not available.');
        return;
      }
      try {
        const outcome = await cb(payload);
        if (outcome.queued) {
          voiceSubmittedSessions.add(payload.sessionId);
          // Recorded only once the queue actually accepted it, so a refused
          // submission cannot claim the next run that session starts.
          if (payload.submissionId) {
            notePendingVoiceSubmission(payload.sessionId, payload.submissionId);
          }
        }
        reply(outcome.queued, outcome.error);
      } catch (error) {
        reply(false, error instanceof Error ? error.message : String(error));
      }
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

        const message = buildCommitPrompt({
          commitContext,
          isInWorktree: false,
        });

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
      _userSpeaking = false;

      // Clear partial text
      _captionItemId = null;
      _captionText = '';
      store.set(voiceCurrentUserTextAtom, '');

      commitUserUtterance(payload.transcript);
    })
  );

  // =========================================================================
  // Transcript Delta (streaming partial transcription while user speaks)
  // =========================================================================
  // Deltas are incremental on both engines, so the caption is the utterance's
  // fragments joined -- writing each fragment over the last one showed the
  // final word of what the user said instead of the sentence. The stable id
  // main sends is the utterance the fragments belong to: a different id is a
  // new utterance and starts the caption over.
  cleanups.push(
    window.electronAPI.on('voice-mode:transcript-delta', (payload: {
      sessionId: string;
      delta: string;
      itemId: string;
    }) => {
      if (!isVoiceActive()) return;
      if (payload.itemId !== _captionItemId) {
        _captionItemId = payload.itemId;
        _captionText = '';
      }
      _captionText += payload.delta;
      store.set(voiceCurrentUserTextAtom, _captionText);

      // Live has no VAD at all, so a transcript fragment is the only evidence
      // that the user is talking, and the listen window has to hold on it. On
      // Realtime, VAD already did this and transcription lags behind
      // speech-stopped -- holding the window here would keep the mic gated open
      // after the user finished.
      if (_voiceEngine === 'live' && payload.delta.trim().length > 0) {
        _userSpeaking = true;
        listenWindow.speechStarted(LIVE_SPEECH_LEASE_MS);
      }
    })
  );

  // =========================================================================
  // Speech Window Closed (Live: an utterance's transcript stopped growing)
  // =========================================================================
  // The counterpart to the transcript-delta hold above. Live emits no
  // speech-stopped and no completed transcript, so without this the user is
  // "speaking" for the rest of the session: automatic sleep never arms, every
  // routine completion stays blocked behind a conversation that ended long ago,
  // and the microphone keeps streaming to a socket billed by the second.
  cleanups.push(
    window.electronAPI.on('voice-mode:speech-window-closed', (payload: {
      sessionId: string;
      transcript: string;
      itemId: string;
    }) => {
      if (!isVoiceActive()) return;
      if (payload.itemId === _captionItemId) {
        _userSpeaking = false;
        lastSpeechHoldReason = null;
        listenWindow.speechStopped();
        if (getVoiceAudioActiveQuery()?.()) schedulePostTurnListenWindow(true);
      }

      if (payload.itemId === _captionItemId) {
        _captionItemId = null;
        _captionText = '';
        store.set(voiceCurrentUserTextAtom, '');
      }
      // This is also the only point at which a Live user utterance can be
      // persisted: the transcript-complete path it used to rely on never fires.
      commitUserUtterance(payload.transcript);
      pumpVoiceEvents();
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

      // Live text is activity, but its accounting cannot tell us when it ends.
      if (_voiceEngine !== 'live' || payload.text.trim().length > 0) {
        if (store.get(voiceListenStateAtom) === 'sleeping') {
          wakeVoiceListening(false);
        }
        listenWindow.clear();
        if (_voiceEngine === 'live') {
          if (getVoiceAudioActiveQuery()?.()) schedulePostTurnListenWindow(true);
          else listenWindow.start('assistant-text');
        }
      }
      // Deliberately NOT noting the announcement as heard here: assistant text
      // is the backend having accepted it, and a fragment of the answer already
      // playing would otherwise mark a question the user has not heard yet.

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
      engine?: 'realtime' | 'live';
    }) => {
      if (!isVoiceActive()) return;

      // Engine fields pass through untouched -- a field this engine does not
      // report stays undefined, which is not the same as zero. Only the stamp
      // is added, so the display never has to infer the engine from which
      // fields happen to be present.
      store.set(voiceTokenUsageAtom, {
        ...payload.usage,
        engine: payload.engine ?? payload.usage.engine ?? _voiceEngine,
      });

      // Persist pending assistant text on an accounting update.
      if (pendingAssistantEntry) {
        writeTranscriptEntry(pendingAssistantEntry);
        pendingAssistantEntry = null;
      }

      // Live reports session accounting during silence and even closure. It
      // must neither postpone sleep nor wake the microphone back up.
      if (_voiceEngine === 'live') return;

      schedulePostTurnListenWindow();

      // The assistant finished a turn: if that turn was an announcement, the
      // floor may now be free for the next one.
      pumpVoiceEvents();
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

      // Route the answer to the session that ASKED, not to whatever session
      // the voice agent currently targets: the user may well have switched
      // tabs between hearing the question and answering it. The queue resolves
      // that target and claims the answer atomically, so a superseded or
      // already-answered question is rejected here instead of double-submitted.
      //
      // Fail closed when it resolves nothing. The old code fell back to the
      // session the controller supplied, which meant a prompt id this device
      // never announced -- learned from session-summary context, say -- was
      // answered anyway, bypassing announcement ownership entirely. An answer
      // is only ever an answer to a question this device asked and the user
      // was demonstrably read.
      const queued = voiceEventQueue
        .snapshot()
        .find((entry) => entry.kind === 'question' && entry.promptId === payload.promptId);
      if (!queued) {
        console.warn(
          `[voiceModeListeners] Dropping voice answer for ${payload.promptId}: not an announced question`,
        );
        return;
      }
      const plan = voiceEventQueue.resolveAnswer(queued.eventId, VOICE_DEVICE_ID);
      if (plan.action !== 'deliver') {
        console.warn(
          `[voiceModeListeners] Dropping voice answer for ${payload.promptId}: ${plan.reason}`,
        );
        pumpVoiceEvents();
        return;
      }
      const claimedEventId = queued.eventId;
      /** Hand the claim back so the question the user heard stays answerable. */
      const releaseClaim = (why: string): void => {
        console.warn(`[voiceModeListeners] Releasing voice answer claim for ${payload.promptId}: ${why}`);
        voiceEventQueue.releaseAnswer(claimedEventId, VOICE_DEVICE_ID);
        pumpVoiceEvents();
      };
      payload = { ...payload, sessionId: plan.target.sessionId };
      pumpVoiceEvents();

      // The controller supplies promptType, and it was previously used to pick
      // the delivery branch without ever being compared against the prompt it
      // claims to answer. A mismatch chose a branch whose answer shape the real
      // prompt does not accept -- at worst approving a proposal whose questions
      // the user was asked instead.
      const pending = store
        .get(sessionPendingPromptsAtom(payload.sessionId))
        .find((prompt) => prompt.promptId === payload.promptId);
      if (!pending) {
        releaseClaim('the prompt is no longer pending');
        return;
      }
      if (pending.promptType !== payload.promptType) {
        releaseClaim(
          `promptType ${payload.promptType} does not match the pending ${pending.promptType}`,
        );
        return;
      }
      if (!isAnswerShapeAcceptable(pending.promptType, payload.response)) {
        releaseClaim(`the answer does not fit a ${pending.promptType}`);
        return;
      }

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
      //
      // WHAT THIS GATE DOES AND DOES NOT GUARANTEE. Read this before loosening
      // it, and before building anything on top of it.
      //
      // Everything above this point has already run for this answer, and there
      // is deliberately no path to `git:commit` that skips it: the proposal must
      // have been announced through the event queue, must have reached
      // `presented` (audio actually queued for the speakers, and that queue
      // drained -- not merely `announcing`), the prompt id must match that
      // presented entry with no fallback to a session the controller supplied,
      // the prompt type must match the real pending prompt's type, and the
      // answer must be exactly `{ approved: boolean }`. The commit's workspace,
      // files and message are then read from the pending proposal's OWN data
      // below -- never from anything that arrived alongside the answer, and with
      // no ambient workspace fallback, so a controller cannot redirect an
      // approved commit at a different project.
      //
      // What that closes: approval of a proposal that was never announced, or
      // was announced but never presented, or belongs to a different prompt, or
      // targets data the controller chose.
      //
      // What it does NOT close, and what the user has explicitly accepted: once
      // a proposal has genuinely been read out to the user, a spoken "approve"
      // is taken at face value. The model is the thing that reports that word,
      // and a model influenced by repository- or agent-controlled text can
      // report it without the user having said it. There is no trusted consent
      // token on this path. The bound is that the user must at least have heard
      // the proposal being described; it is NOT proof they agreed to it.
      //
      // So: this gate makes a forged approval require a real, heard
      // announcement. It does not make an approval evidence of human intent. Do
      // not treat a successful commit here as a user-confirmed action in
      // anything you add downstream.
      if (payload.promptType === 'git_commit_proposal_request') {
        const approved = response?.approved === true;
        // `pending` is the prompt this answer was already validated against.
        // Re-looking it up would open a second, unvalidated read of the same
        // data -- the sort of near-duplicate that drifts apart later.
        const data = pending.data || {};
        const filesToStage: Array<string | { path: string }> = Array.isArray(data.filesToStage)
          ? data.filesToStage
          : [];
        const filePaths = filesToStage.map(f => (typeof f === 'string' ? f : f.path));
        const commitMessage: string = data.commitMessage || '';
        // No `|| voiceWorkspacePathAtom` fallback. A proposal that does not name
        // its own workspace is not one we know where to apply, and substituting
        // whichever project voice happens to be attached to would commit the
        // proposal's files against a workspace it was never about.
        const commitWorkspacePath: string =
          typeof data.workspacePath === 'string' ? data.workspacePath : '';

        if (approved && !(commitWorkspacePath && filePaths.length > 0 && commitMessage)) {
          // Approved, but the proposal's own data cannot support a commit. Not
          // a retry case -- the data will not improve -- so it is cancelled
          // cleanly rather than left pending or guessed at.
          console.warn(
            `[voiceModeListeners] Commit proposal ${payload.promptId} approved but incomplete; cancelling`,
          );
        }

        const resolveProposal = (
          proposalResponse: Record<string, unknown>,
          /**
           * Whether a commit actually happened. When it did, a failed persist
           * must NOT release the claim: the work is done, and letting the
           * proposal be approved a second time would commit twice. Losing the
           * record of a commit that happened is the lesser harm.
           */
          committed: boolean,
        ): void => {
          window.electronAPI
            .invoke('messages:respond-to-prompt', {
              sessionId: payload.sessionId,
              promptId: payload.promptId,
              promptType: 'git_commit_proposal_request',
              response: proposalResponse,
              respondedBy: 'desktop',
            })
            .then((result: any) => {
              if (result?.success === false && !committed) releaseClaim('persisting the answer failed');
            })
            .catch((error: unknown) => {
              if (committed) return;
              releaseClaim(error instanceof Error ? error.message : String(error));
            });
        };

        if (approved && commitWorkspacePath && filePaths.length > 0 && commitMessage) {
          // Run the actual commit, then forward the result so the durable
          // prompt is resolved with the same shape the widget produces.
          window.electronAPI
            .invoke('git:commit', commitWorkspacePath, commitMessage, filePaths, payload.sessionId, undefined, undefined, payload.promptId)
            .then((result: any) => {
              resolveProposal(
                {
                  action: result?.success ? 'committed' : 'error',
                  commitHash: result?.commitHash,
                  commitDate: result?.commitDate,
                  error: result?.error,
                  filesCommitted: result?.success ? filePaths : undefined,
                  commitMessage: result?.success ? commitMessage : undefined,
                },
                result?.success === true,
              );
            })
            .catch((error: unknown) => {
              // A failed IPC request does not prove whether Git completed.
              resolveProposal(
                { action: 'error', error: error instanceof Error ? error.message : String(error) },
                false,
              );
            });
        } else {
          // Reject path -- or missing data, can't safely commit. Cancel cleanly.
          resolveProposal({ action: 'cancelled' }, false);
        }
        return;
      }

      // For RequestUserInput: the voice agent emits an answer keyed by
      // field id. Persist via messages:respond-to-prompt directly so the
      // response shape matches the durable contract (answers + cancelled).
      if (payload.promptType === 'request_user_input_request') {
        const cancelled = response?.cancelled === true;
        const answers = response?.answers && typeof response.answers === 'object'
          ? response.answers as Record<string, unknown>
          : {};
        // The rich-form contract does not reach here intact: the tool registry
        // advertises a single string `answer`, main converts that to
        // `{ answer }`, and this branch wants `{ answers: { fieldId: value } }`.
        // Forwarding the empty map that mismatch produces resolved a form the
        // user was asked to fill in with no answers at all, silently. Until the
        // contract carries field ids, say so instead of inventing a response.
        if (!cancelled && Object.keys(answers).length === 0) {
          releaseClaim('a rich interactive form cannot be answered by voice yet');
          return;
        }
        window.electronAPI.invoke('messages:respond-to-prompt', {
          sessionId: payload.sessionId,
          promptId: payload.promptId,
          promptType: 'request_user_input_request',
          response: { answers, cancelled },
          respondedBy: 'desktop',
        }).then((result: any) => {
          if (result?.success === false) releaseClaim('persisting the answer failed');
        }).catch((error: unknown) => {
          releaseClaim(error instanceof Error ? error.message : String(error));
        });
        return;
      }

      // Use the respondToPromptAtom to persist and resolve the prompt. Its
      // boolean is the persist result: the claim was taken before this ran, so
      // a failure here would otherwise leave the question permanently
      // unanswerable with nothing recorded.
      void Promise.resolve(
        store.set(respondToPromptAtom, {
          sessionId: payload.sessionId,
          promptId: payload.promptId,
          promptType: payload.promptType as any,
          response,
        }),
      ).then((persisted) => {
        if (persisted === false) releaseClaim('persisting the answer failed');
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
        sendVoiceMessage('voice-mode:editor-context-changed', {
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
    sendVoiceMessage('voice-mode:update-linked-session', {
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
  // Cross-Session Questions and Run Tracking
  // =========================================================================
  // Follow all sessions awaiting input; answers belong to the asking session, not the focused tab.
  // Subscribe to prompt arrays because the pending boolean can flip before data arrives,
  // and setting that boolean true again would not notify subscribers.

  const promptSubs = new Map<string, () => void>();

  function ingestPromptsFor(sessionId: string): void {
    if (store.get(voiceActiveSessionIdAtom) === null) return;
    const workspacePath = store.get(voiceWorkspacePathAtom) || '';
    for (const prompt of store.get(sessionPendingPromptsAtom(sessionId))) {
      // Auto-approved proposals are not questions, even if present in pending state.
      // Let the coding agent's actual result announce success or failure.
      if (prompt.promptType === 'git_commit_proposal_request' && prompt.data?.autoApproved) continue;
      const eventId = `prompt:${sessionId}:${prompt.promptId}`;
      announceExtras.set(eventId, {
        promptType: prompt.promptType,
        voiceFriendly: computeVoiceFriendly(prompt),
      });
      voiceEventQueue.ingest({
        eventId,
        kind: 'question',
        promptId: prompt.promptId,
        source: {
          deviceId: VOICE_DEVICE_ID,
          workspacePath,
          sessionId,
          taskId: sessionId,
          taskRevision: runFor(sessionId).revision,
        },
        sourceLabel: sessionLabel(sessionId),
        summary: formatPromptForVoice(prompt),
        createdAt: prompt.createdAt || Date.now(),
      });
    }
    pumpVoiceEvents();
  }

  function syncAttention(): void {
    const attention = store.get(agentSessionAttentionAtom);

    // A session that just started running has begun a new revision. Anything
    // still outstanding from its previous run is superseded by that fact --
    // application state, not a voice utterance, is what decides this.
    const runningIds = new Set(attention.running.map((session) => session.id));
    const awaiting = new Set(attention.awaitingInput.map((session) => session.id));
    for (const [sessionId, run] of sessionRuns) {
      if (runningIds.has(sessionId) || awaiting.has(sessionId)) continue;
      run.state = 'idle';
    }
    for (const sessionId of awaiting) {
      const run = runFor(sessionId);
      // Blocked on a question: the run it belongs to is still the same run.
      if (run.state === 'running') run.state = 'awaiting';
    }
    for (const sessionId of runningIds) {
      const run = runFor(sessionId);
      if (run.state !== 'idle') {
        // Already running, or resuming after answering a question. Neither is a
        // new request, so neither supersedes what is already outstanding.
        run.state = 'running';
        continue;
      }
      run.state = 'running';
      run.revision += 1;
      voiceEventQueue.noteTaskRevision(sessionId, run.revision);
      if (store.get(voiceActiveSessionIdAtom) !== null) {
        sendVoiceMessage('voice-mode:task-revision', {
          sessionId,
          revision: run.revision,
          // Null when this run is the user's own work from the UI. The engine
          // then binds nothing rather than claiming it as a voice task.
          submissionId: takePendingVoiceSubmission(sessionId),
        });
      }
    }

    for (const [sessionId, unsub] of promptSubs) {
      if (awaiting.has(sessionId)) continue;
      unsub();
      promptSubs.delete(sessionId);
    }
    for (const sessionId of awaiting) {
      if (!promptSubs.has(sessionId)) {
        promptSubs.set(
          sessionId,
          store.sub(sessionPendingPromptsAtom(sessionId), () => ingestPromptsFor(sessionId)),
        );
      }
      ingestPromptsFor(sessionId);
    }

    // A prompt answered on screen is no longer worth speaking, and a session
    // that finished may have freed the floor.
    pumpVoiceEvents();
  }
  cleanups.push(store.sub(agentSessionAttentionAtom, syncAttention));
  syncAttention();
  cleanups.push(() => {
    for (const unsub of promptSubs.values()) unsub();
    promptSubs.clear();
  });

  // =========================================================================
  // Task Completions (any session) -> queue
  // =========================================================================
  // Main forwards completions it is not already answering as an
  // ask_coding_agent result. The queue decides whether each is still current
  // and whether now is the moment to say it.
  cleanups.push(
    window.electronAPI.on('voice-mode:task-completed', (payload: {
      sessionId: string;
      summary?: string;
      error?: string;
    }) => {
      if (!isVoiceActive() || !payload?.sessionId) return;
      const run = runFor(payload.sessionId);
      // The user asked for this work through voice, or it is the session voice
      // is linked to: either way they are waiting to hear about it, so it is
      // worth restoring a sleeping session for. Completions from sessions they
      // never mentioned stay queued until voice is awake anyway.
      const awaited =
        voiceSubmittedSessions.has(payload.sessionId) ||
        payload.sessionId === store.get(voiceActiveSessionIdAtom);
      voiceEventQueue.ingest({
        wakeOnSleep: awaited,
        // Stable per run: a resync or a duplicate delivery of the same
        // completion folds into the entry instead of announcing twice.
        eventId: `task:${payload.sessionId}:${run.revision}`,
        kind: 'completion',
        source: {
          deviceId: VOICE_DEVICE_ID,
          workspacePath: store.get(voiceWorkspacePathAtom) || '',
          sessionId: payload.sessionId,
          taskId: payload.sessionId,
          taskRevision: run.revision,
        },
        sourceLabel: sessionLabel(payload.sessionId),
        summary: payload.error
          ? `that failed: ${payload.error}`
          : payload.summary || 'finished, with no summary',
        createdAt: Date.now(),
      });
      pumpVoiceEvents();
    })
  );

  // =========================================================================
  // Engine Selection (which transport this session actually started on)
  // =========================================================================
  cleanups.push(
    window.electronAPI.on('voice-mode:engine-selected', (payload: {
      sessionId: string;
      engine: 'realtime' | 'live';
      fallbackFrom: 'realtime' | 'live' | null;
      reason: string;
      generation?: number;
      workspacePath?: string | null;
    }) => {
      _voiceEngine = payload.engine;
      // Main sends this once per activation, to the owning window only, which
      // is exactly the scope of the claim.
      _voiceClaim =
        typeof payload.generation === 'number' && typeof payload.workspacePath === 'string'
          ? { generation: payload.generation, workspacePath: payload.workspacePath }
          : null;
      if (payload.fallbackFrom && payload.reason) {
        // A silent fallback would have the user attributing this engine's
        // behavior to the one they asked for.
        console.warn(`[voiceModeListeners] Voice engine fallback: ${payload.reason}`);
        writeDiagnosticEntry(payload.reason);
      } else {
        writeDiagnosticEntry(`Voice engine: ${payload.engine}`);
      }
    })
  );

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
