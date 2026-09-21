import { claimDesktopVoiceEvent, type DesktopVoiceClaim } from './mobileVoiceEvents';
import { voicePresentationAuthority, registerDesktopVoicePresence } from './voicePresentationAuthority';
import { getLocalHostDeviceId } from '../ai/sessionHostAttribution';
import { VoiceStartupTiming } from '../../../shared/voiceStartupTiming';
import { getProviderCredentials } from '../credentials/providerCredentials';
/**
 * Voice Mode Service - manages voice mode sessions and integrates with OpenAI Realtime API
 */

import { BrowserWindow, ipcMain, systemPreferences, type WebContents } from 'electron';
import { RealtimeAPIClient, BUILTIN_VOICE_TOOL_NAMES, type RealtimeModel, type RealtimeReasoningEffort } from './RealtimeAPIClient';
import { LiveAPIClient } from './engine/live/liveAPIClient';
import { LiveBargeInCoordinator } from './engine/live/liveBargeIn';
import {
  asDeferredCallEngine,
  asDurableTaskEngine,
  registerVoiceEngine,
  type VoiceEngineRegistrar,
  type VoiceEngineUsage,
} from './engine/voiceEngine';
import type { VoiceToolHandlers } from './engine/voiceToolRegistry';
import { realtimeModelForEngine, resolveVoiceEngine } from './VoiceModeSettingsHandler';
import { buildVoiceToolSet } from './voiceToolBridge';
import { mapAiSessionStatusToTaskStatus } from './taskStatus';
import {
  getVoiceEnabledExtensionTools,
  getVoiceEnabledBackendToolsForWorkspace,
  resolveBackendWorkspacePath,
} from '../../mcp/mcpWorkspaceResolver';
import { handleExtensionTool } from '../../mcp/tools/extensionToolHandler';
import { handleBackendTool, isBackendTool } from '../../mcp/tools/backendToolHandler';
import { safeHandle } from '../../utils/ipcRegistry';
import Store from '../../utils/privateSettingsStore';
import { AnalyticsService } from '../analytics/AnalyticsService';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { searchSessionsForVoice } from './sessionSearch';
import { getSessionSummaryForVoice } from './sessionSummary';
import { getDatabase } from '../../database/initialize';
import { getDefaultAIModel, getPreferredAgentLanguage } from '../../utils/store';
import { randomUUID } from 'crypto';
import { resolveSessionModelSelection } from '../ai/sessionModelSelection';
import { buildVoiceTaskCompletion } from './voiceTaskCompletion';
import { deliverInteractivePrompt, deliverVoiceAnnouncement } from './voiceWakeDelivery';
import { redactVoiceDiagnostic } from './voiceDiagnostics';
import {
  authorizeVoiceIpc,
  isSessionInWorkspace,
  type VoiceConversationIdentity,
  type VoiceIpcCaller,
  type VoiceIpcClaim,
  type VoiceIpcVerdict,
} from './voiceIpcAuthorization';
import { getWindowIdForWindow, resolveActiveWorkspacePathForWindowId } from '../../window/windowState';
import { createVoiceSessionHandoff } from './voiceSessionHandoff';
import { getAgentWorkflowService } from '../AgentWorkflowService';
import { loadFreshVoiceCommandContext } from './voiceCommandContext';
import { ensureVoiceMicrophoneAccess } from './microphoneAccess';
import {
  captureActiveVoiceWindow,
  sanitizeVoiceUiContext,
  type RawVoiceUiContext,
  type VoiceUiContext,
} from './voiceUiContext';

/** Which speech transport a session is running on. */
type VoiceEngineId = 'realtime' | 'live';

// Store active voice session info
interface VoiceSession {
  presentationClaims?: DesktopVoiceClaim[];
  presentationRenewal?: ReturnType<typeof setInterval>;
  poc: VoiceEngineRegistrar;
  /** Which transport `poc` actually is. Stamped onto every usage report. */
  engineId: VoiceEngineId;
  /**
   * Barge-in decision for engines that publish no interruption event (Live).
   * Null on Realtime, where the engine owns that decision and emits
   * `interrupted` itself.
   */
  bargeIn: LiveBargeInCoordinator | null;
  window: BrowserWindow;
  workspacePath: string | null;
  sessionId: string;
  /**
   * Fresh on every activation. Authorized callers quote it back, so a message
   * written against a conversation that has since ended cannot land in the one
   * that replaced it. See voiceIpcAuthorization.ts.
   */
  generation: number;
  cleanupCompletionListener: () => void;
  startTime: number; // For duration tracking
  hasExistingSession: boolean; // Whether AI session had prior messages
}

/**
 * Get duration category for analytics (privacy-preserving)
 */
function getDurationCategory(durationMs: number): 'short' | 'medium' | 'long' {
  if (durationMs < 60000) return 'short'; // < 1 minute
  if (durationMs < 300000) return 'medium'; // 1-5 minutes
  return 'long'; // > 5 minutes
}

/**
 * Send voice session ended analytics event
 */
function sendSessionEndedEvent(reason: string, startTime: number): void {
  const durationMs = Date.now() - startTime;
  AnalyticsService.getInstance().sendEvent('voice_session_ended', {
    reason,
    durationCategory: getDurationCategory(durationMs),
  });
}

let activeVoiceSession: VoiceSession | null = null;
registerDesktopVoicePresence(() => activeVoiceSession?.engineId === 'realtime');

/** Monotonic across activations; never reused, so a stale claim can never match. */
let voiceConversationGeneration = 0;

/**
 * Cap on the repository-local voice project summary folded into session
 * context. Generous for a curated summary, and a bound rather than a hope.
 */
const MAX_VOICE_PROJECT_SUMMARY_CHARS = 8000;

/** The same bound for the concatenated extension-contributed voice context. */
const MAX_VOICE_EXTENSION_CONTEXT_CHARS = 8000;

/**
 * The facts an authorization decision needs about the caller, resolved from
 * window state rather than from anything the renderer asserted.
 */
function resolveVoiceCaller(event: { sender: WebContents }): VoiceIpcCaller {
  return {
    webContentsId: event.sender.id,
    resolvedWorkspacePath:
      resolveActiveWorkspacePathForWindowId(
        getWindowIdForWindow(BrowserWindow.fromWebContents(event.sender)),
      ) ?? null,
  };
}

function voiceConversationIdentity(): VoiceConversationIdentity | null {
  if (!activeVoiceSession) return null;
  return {
    generation: activeVoiceSession.generation,
    ownerWebContentsId: activeVoiceSession.window.webContents.id,
    workspacePath: activeVoiceSession.workspacePath,
  };
}

/**
 * Authorize one `voice-mode:*` message. Returns null when the message is not
 * allowed, having already said why: every rejection here is either a stale
 * renderer or an attempt to drive a conversation the caller has no relationship
 * to, and both are worth seeing in the log.
 */
function authorizeVoiceMessage(
  channel: string,
  event: { sender: WebContents },
  claim: VoiceIpcClaim,
  require?: { sessionId?: boolean; promptId?: boolean; revision?: boolean },
): Extract<VoiceIpcVerdict, { allowed: true }> | null {
  const verdict = authorizeVoiceIpc({
    caller: resolveVoiceCaller(event),
    conversation: voiceConversationIdentity(),
    claim,
    require,
  });
  if (verdict.allowed) return verdict;
  if (verdict.reason !== 'no active voice conversation') {
    console.warn(`[VoiceModeService] Rejected ${channel}: ${verdict.reason}`);
  }
  return null;
}

/**
 * Sessions whose workspace membership has been established, keyed by
 * `generation:workspace:session`. Completions and revisions arrive repeatedly
 * for the same handful of sessions, and re-querying per message would put a
 * database round-trip on every one of them.
 */
const verifiedVoiceSessions = new Map<string, boolean>();

/**
 * ...and that the coding session it names is one this conversation may speak
 * for. Separate from the synchronous checks because membership is a lookup.
 */
async function authorizedSessionBelongs(
  channel: string,
  sessionId: string,
  workspacePath: string,
  generation: number,
): Promise<boolean> {
  const key = `${generation}:${workspacePath}:${sessionId}`;
  const cached = verifiedVoiceSessions.get(key);
  if (cached !== undefined) return cached;
  try {
    const session = await AISessionsRepository.get(sessionId);
    const belongs = isSessionInWorkspace(session, workspacePath);
    verifiedVoiceSessions.set(key, belongs);
    if (!belongs) {
      console.warn(
        `[VoiceModeService] Rejected ${channel}: session ${sessionId} is not in ${workspacePath}`,
      );
    }
    return belongs;
  } catch (error) {
    // Fail closed: an unverifiable session is not an authorized one. Not
    // cached -- a transient database failure must not permanently deny a
    // session the user legitimately owns.
    console.warn(`[VoiceModeService] Rejected ${channel}: could not verify session ${sessionId}`, error);
    return false;
  }
}

/**
 * Work that needs the membership lookup, run strictly in the order the
 * messages arrived.
 *
 * Ordering is the point. A task revision supersedes outstanding work and a
 * completion is attributed against exactly that state, so letting two lookups
 * race would let a completion be credited to the task the next revision was
 * about to replace -- reintroducing, through the authorization layer, the
 * misattribution durable task identity exists to prevent.
 */
let voiceAuthorizedWork: Promise<void> = Promise.resolve();

function runAuthorizedSessionWork(
  channel: string,
  input: { sessionId: string; workspacePath: string; generation: number },
  work: () => void,
): void {
  voiceAuthorizedWork = voiceAuthorizedWork
    .then(async () => {
      const belongs = await authorizedSessionBelongs(
        channel,
        input.sessionId,
        input.workspacePath,
        input.generation,
      );
      if (!belongs) return;
      // The lookup was awaited, so the conversation may have ended or been
      // replaced. Authorization is only good for the generation it was granted
      // against.
      if (!activeVoiceSession || activeVoiceSession.generation !== input.generation) return;
      work();
    })
    .catch((error) => {
      console.error(`[VoiceModeService] Authorized ${channel} work failed:`, error);
    });
}

/**
 * The session's usage, stamped with the engine that measured it.
 *
 * Engine fields are passed through exactly as reported -- an engine that does
 * not measure something leaves it undefined, and substituting 0 there would
 * claim a measurement we never made. The stamp is the only thing added, so the
 * display never has to infer the engine from which fields happen to be set.
 */
function usageWithEngine(session: VoiceSession): VoiceEngineUsage & { engine: VoiceEngineId } {
  return { ...session.poc.getUsage(), engine: session.engineId };
}

/**
 * Request the concatenated voice session context contributed by extensions
 * (Core hook 2). Extension providers run in the renderer, so we send a request
 * with a one-shot result channel and await the reply (capped timeout). Returns
 * an empty string if no providers contribute or on timeout/error.
 */
function requestExtensionVoiceContext(
  window: BrowserWindow,
  input: { workspacePath?: string; activeFilePath?: string; voiceSessionId?: string; codingSessionId?: string },
  timing?: VoiceStartupTiming,
): Promise<string> {
  return new Promise((resolve) => {
    if (!window || window.isDestroyed()) {
      resolve('');
      return;
    }
    // randomUUID, not a timestamp plus Math.random: this channel's reply is
    // folded into the text sent to the provider, so it is worth being
    // unguessable, and the sender is checked besides -- the other one-shot
    // voice channels already do both.
    const resultChannel = `voice-mode:extension-context-result-${randomUUID()}`;
    const timeout = setTimeout(() => {
      timing?.mark('extension-context-timeout');
      ipcMain.removeAllListeners(resultChannel);
      resolve('');
    }, 5000);
    ipcMain.on(resultChannel, (event, data: { context?: string }) => {
      if (event.sender.id !== window.webContents.id) return;
      ipcMain.removeAllListeners(resultChannel);
      clearTimeout(timeout);
      const context = typeof data?.context === 'string' ? data.context : '';
      // Extension-provided text has no size contract of its own, and all of it
      // goes to the provider on every voice session start.
      if (context.length > MAX_VOICE_EXTENSION_CONTEXT_CHARS) {
        console.warn(
          `[VoiceModeService] Extension voice context truncated from ${context.length} to ${MAX_VOICE_EXTENSION_CONTEXT_CHARS} characters`,
        );
        resolve(`${context.slice(0, MAX_VOICE_EXTENSION_CONTEXT_CHARS)}\n[truncated]`);
        return;
      }
      resolve(context);
    });
    window.webContents.send('voice-mode:collect-extension-context', { input, resultChannel });
  });
}

const UI_CONTEXT_TIMEOUT_MS = 2000;

/** How long ask_coding_agent waits for an answer before giving up (Realtime). */
const REALTIME_ASK_TIMEOUT_MS = 60000;
/**
 * The same wait on Live, cut short because the open tool result holds the
 * delegation lane and blocks the paid-session closure that stops billing. Past
 * this the call returns still-working and the real answer arrives through the
 * completion path, which does not need the call to stay open.
 */
const LIVE_ASK_TIMEOUT_MS = 20000;

interface RendererUiContextResponse {
  workspacePath?: string;
  context?: RawVoiceUiContext;
  error?: string;
}

/**
 * Ask the voice-owning renderer for a fresh Jotai snapshot. The dynamic result
 * channel is accepted only from the expected webContents and must echo the
 * workspace path, preventing another workspace window from supplying context.
 */
function requestVoiceUiContext(
  window: BrowserWindow,
  workspacePath: string,
): Promise<{ success: true; context: VoiceUiContext } | { success: false; error: string }> {
  return new Promise((resolve) => {
    if (!window || window.isDestroyed()) {
      resolve({ success: false, error: 'The Nimbalyst window is not available.' });
      return;
    }
    if (!workspacePath) {
      resolve({ success: false, error: 'The active workspace is not available.' });
      return;
    }

    const resultChannel = `voice-mode:ui-context-result-${randomUUID()}`;
    let settled = false;
    const finish = (
      result: { success: true; context: VoiceUiContext } | { success: false; error: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ipcMain.removeListener(resultChannel, handleResult);
      resolve(result);
    };
    const handleResult = (
      event: Electron.IpcMainEvent,
      data: RendererUiContextResponse,
    ) => {
      if (event.sender.id !== window.webContents.id) return;
      if (data?.workspacePath !== workspacePath) {
        finish({ success: false, error: 'The UI context response was for a different workspace.' });
        return;
      }
      if (data?.error) {
        finish({ success: false, error: data.error });
        return;
      }
      try {
        finish({
          success: true,
          context: sanitizeVoiceUiContext(data?.context || {}, workspacePath),
        });
      } catch (error) {
        finish({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const timeout = setTimeout(() => {
      finish({ success: false, error: 'Timed out while reading the current UI context.' });
    }, UI_CONTEXT_TIMEOUT_MS);

    ipcMain.on(resultChannel, handleResult);
    window.webContents.send('voice-mode:request-ui-context', {
      workspacePath,
      resultChannel,
    });
  });
}

/** How long a coding-prompt submission may take to be confirmed queued. */
const SUBMIT_ACK_TIMEOUT_MS = 5000;

/**
 * Hand the renderer a prompt to queue, and wait for it to say it did.
 *
 * The send used to be fire-and-forget, so the tool answered "accepted" (and on
 * Live minted a durable task id) before anything had been queued -- including
 * when the renderer deduplicated the prompt or the queue call failed. Accepted
 * is a claim about application state, so it has to be the application that
 * makes it.
 */
function requestVoicePromptSubmission(
  window: BrowserWindow,
  payload: {
    sessionId: string;
    workspacePath: string | null;
    prompt: string;
    /**
     * This submission's identity, minted here so the renderer can report which
     * submission a later agent run came from. Without it a run has to be
     * matched to a task by recency, which binds the wrong one whenever two
     * submissions are queued before the first starts.
     */
    submissionId: string;
    codingAgentPrompt?: Record<string, unknown>;
  },
): Promise<{ queued: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!window || window.isDestroyed()) {
      resolve({ queued: false, error: 'The Nimbalyst window is not available.' });
      return;
    }
    const resultChannel = `voice-mode:submit-prompt-result-${randomUUID()}`;
    let settled = false;
    const finish = (result: { queued: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ipcMain.removeListener(resultChannel, handleResult);
      resolve(result);
    };
    const handleResult = (
      event: Electron.IpcMainEvent,
      data: { queued?: boolean; error?: string },
    ): void => {
      if (event.sender.id !== window.webContents.id) return;
      finish({ queued: data?.queued === true, error: data?.error });
    };
    const timeout = setTimeout(() => {
      finish({ queued: false, error: 'Timed out while queueing the task.' });
    }, SUBMIT_ACK_TIMEOUT_MS);

    ipcMain.on(resultChannel, handleResult);
    window.webContents.send('voice-mode:submit-prompt', { ...payload, resultChannel });
  });
}

/**
 * Speak an agent's question, restoring the voice session first if it is asleep.
 * The decision lives in ./voiceWakeDelivery.ts; this binds it to the session.
 */
async function deliverInteractivePromptTo(
  session: VoiceSession,
  data: { promptId: string; promptType: string; description: string; sourceSessionId: string },
): Promise<boolean> {
  if (!await claimDesktopAnnouncement(session, data.sourceSessionId, data.promptId)) return false;
  return deliverInteractivePrompt(session.poc, data, {
    isCurrent: () => activeVoiceSession === session,
  });
}

function armPresentationDeadline(session: VoiceSession, claim: DesktopVoiceClaim): void {
  const deadline = claim.expiresAt;
  setTimeout(() => {
    if (activeVoiceSession !== session || claim.expiresAt !== deadline) return;
    // Clear audio already enqueued, independently of whether another delta arrives.
    session.window.webContents.send('voice-mode:interrupt', { sessionId: session.sessionId });
    stopVoiceSession();
  }, Math.max(0, deadline - Date.now() - 1000));
}

async function claimDesktopAnnouncement(session: VoiceSession, sessionId: string, promptId?: string): Promise<boolean> {
  if (session.engineId !== 'live') return true;
  const host = getLocalHostDeviceId();
  if (!host || !session.workspacePath) return false;
  try {
    const claim = await claimDesktopVoiceEvent(host, session.workspacePath, sessionId, promptId);
    if (activeVoiceSession !== session || claim === null) return false;
    if (claim) {
      (session.presentationClaims ??= []).push(claim);
      armPresentationDeadline(session, claim);
      if (!session.presentationRenewal) session.presentationRenewal = setInterval(() => {
        if (activeVoiceSession !== session || !session.presentationClaims?.length) {
          clearInterval(session.presentationRenewal);
          session.presentationRenewal = undefined;
          return;
        }
        for (const current of session.presentationClaims) {
          if (!voicePresentationAuthority.valid(current.key, current.deviceId, current.token)) {
            session.window?.webContents.send('voice-mode:interrupt', { sessionId: session.sessionId });
            stopVoiceSession();
            break;
          }
          const renewed = voicePresentationAuthority.claim(current.key, current.deviceId);
          if (renewed) { current.expiresAt = renewed.expiresAt; armPresentationDeadline(session, current); }
        }
      }, 10_000);
    }
    return true;
  } catch {
    // No authority means no permission to announce on both devices.
    return false;
  }
}

/**
 * Check if voice mode is active for a given session
 */
export function isVoiceModeActive(sessionId: string): boolean {
  return activeVoiceSession !== null && activeVoiceSession.sessionId === sessionId;
}

/**
 * Get the active voice session ID if one exists
 * Returns null if no voice session is active
 */
export function getActiveVoiceSessionId(): string | null {
  return activeVoiceSession?.sessionId ?? null;
}

/**
 * Send a message to the active voice agent to be spoken aloud
 * Returns true if the message was sent successfully, false if:
 * - No active voice session for this sessionId
 * - Voice agent WebSocket is not connected
 * - Message sending failed
 */
export function sendToVoiceAgent(sessionId: string, message: string): boolean {
  if (!activeVoiceSession || activeVoiceSession.sessionId !== sessionId) {
    console.error('[VoiceModeService] No active voice session for sessionId:', sessionId);
    return false;
  }

  // Check if the voice agent is still connected
  if (!activeVoiceSession.poc.isConnected()) {
    console.error('[VoiceModeService] Voice agent WebSocket is not connected');
    return false;
  }

  // Attempt to send the message
  const success = activeVoiceSession.poc.sendHostAnnouncement(message);

  if (!success) {
    console.error('[VoiceModeService] Failed to send message to voice agent');
  }

  return success;
}

/**
 * Stop the active voice session programmatically
 * Called by the AI assistant via MCP tool to end voice mode
 * Returns true if a session was stopped, false if no session was active
 */
export function stopVoiceSession(): boolean {
  if (!activeVoiceSession) {
    console.log('[VoiceModeService] No active voice session to stop');
    return false;
  }

  const sessionId = activeVoiceSession.sessionId;
  console.log('[VoiceModeService] Stopping voice session programmatically:', sessionId);

  // Track session ended (reason: assistant_stopped)
  sendSessionEndedEvent('assistant_stopped', activeVoiceSession.startTime);

  // Get final usage before disconnecting
  const finalTokenUsage = usageWithEngine(activeVoiceSession);

  // Disconnect from OpenAI
  activeVoiceSession.poc.disconnect('user_stopped');
  activeVoiceSession.bargeIn?.reset();

  // Clean up the completion listener
  activeVoiceSession.cleanupCompletionListener();

  // Notify the renderer that voice mode was stopped, include final token usage for persistence
  if (activeVoiceSession.window && !activeVoiceSession.window.isDestroyed()) {
    activeVoiceSession.window.webContents.send('voice-mode:stopped', {
      sessionId,
      tokenUsage: finalTokenUsage,
    });
  }

  activeVoiceSession = null;

  return true;
}

/**
 * Get a summary of the current AI session
 * Returns session metadata, message counts, and recent activity
 */
export async function getSessionSummary(): Promise<{
  success: boolean;
  summary?: string;
  details?: {
    sessionId: string;
    sessionName: string;
    messageCount: number;
    userMessageCount: number;
    assistantMessageCount: number;
    sessionDurationMinutes: number;
    recentTopics: string[];
  };
  error?: string;
}> {
  if (!activeVoiceSession) {
    return { success: false, error: 'No active voice session' };
  }
  const { sessionId, window, workspacePath } = activeVoiceSession;
  if (!workspacePath) {
    return { success: false, error: 'No workspace path available' };
  }
  // Shared with the mobile voice-tool proxy (mobileVoiceToolHandler) so the iOS
  // agent gets identical summaries -- including for sessions surfaced by the
  // desktop-backed semantic list_sessions that aren't in the phone's local DB.
  return getSessionSummaryForVoice(workspacePath, sessionId, window);
}

export function initVoiceModeService() {
  // Create settings store instance (MUST match AIService store name!)
  const settingsStore = new Store<Record<string, unknown>>({
    name: 'ai-settings',  // Same as AIService!
    watch: true,
  });

  /**
   * Extension SDK: report the status of the agent task the voice agent is
   * currently driving (the session it targets with submit_agent_prompt). Lets an
   * extension voice tool (e.g. the memory extension's get_task_status) answer
   * "is it still running?" verbally. Resolves the active voice-linked session,
   * then reads its live status from ai_sessions (same source as list_sessions).
   */
  safeHandle('extensions:ai-get-task-status', async (_event, _options: { workspacePath?: string }) => {
    const targetId = getActiveVoiceSessionId();
    if (!targetId) return null;
    try {
      const db = getDatabase();
      const { rows } = await db.query<{ id: string; title: string | null; status: string | null }>(
        `SELECT id, title, status FROM ai_sessions WHERE id = $1`,
        [targetId],
      );
      const row = rows[0];
      if (!row) return null;
      return mapAiSessionStatusToTaskStatus(row);
    } catch (error) {
      console.error('[VoiceModeService] get-task-status query failed:', error);
      return null;
    }
  });

  // Voice mode settings store (for voice mode specific settings including custom prompts)
  const voiceModeSettingsStore = new Store<Record<string, unknown>>({
    name: 'nimbalyst-settings',
    watch: true,
  });

  /**
   * Test OpenAI Realtime API connection
   */
  safeHandle('voice-mode:test-connection', async (event, workspacePath: string | null, sessionId: string, startupId?: string) => {
    const timing = new VoiceStartupTiming('main', startupId);
    try {
      if (!sessionId) {
        throw new Error('Session ID is required for voice mode');
      }

      await ensureVoiceMicrophoneAccess(process.platform, systemPreferences);
      timing.mark('permission');

      // If there's an active session, disconnect it first
      if (activeVoiceSession) {
        activeVoiceSession.poc.disconnect();
        activeVoiceSession = null;
      }

      // Get OpenAI API key from settings store
      const apiKey = getProviderCredentials().get('openai');

      if (!apiKey) {
        throw new Error('OpenAI API key not configured. Please add it in Settings.');
      }

      // Store window reference for sending events
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) {
        throw new Error('Could not find window for session');
      }

      // Load session to get context by calling the renderer to fetch it
      let sessionContext = 'New session with no prior messages.';
      let hasExistingSession = false; // For analytics
      let linkedSessionProvider = 'claude-code';
      try {
        // Request session data from the renderer
        const session = await window.webContents.executeJavaScript(`
          window.electronAPI.invoke('ai:loadSession', ${JSON.stringify(sessionId)}, ${JSON.stringify(workspacePath)}, false)
        `);

        if (session) {
          if (typeof session.provider === 'string' && session.provider.trim()) {
            linkedSessionProvider = session.provider;
          }
          // session.messages is TranscriptViewMessage[] from the canonical
          // ai_transcript_events table -- discriminated by `type`, not `role`.
          const allEvents = (session.messages || []) as Array<any>;
          const userEvents = allEvents.filter(m => m.type === 'user_message');
          const assistantEvents = allEvents.filter(m => m.type === 'assistant_message');
          const toolEvents = allEvents.filter(m => m.type === 'tool_call');
          const conversationEvents = allEvents.filter(
            m => m.type === 'user_message' || m.type === 'assistant_message'
          );

          const messageCount = conversationEvents.length;
          hasExistingSession = messageCount > 0;
          // Session name is stored in the 'title' field, not 'name'
          const sessionName = session.title || session.name || 'Untitled';
          const userMessageCount = userEvents.length;
          const sessionMode = session.mode || 'agent'; // 'agent' or 'planning'

          // Build context parts
          const contextParts: string[] = [];
          contextParts.push(`Session: "${sessionName}"`);
          contextParts.push(`Mode: ${sessionMode === 'planning' ? 'Planning mode (read-only exploration)' : 'Agent mode (can make changes)'}`);

          if (messageCount === 0) {
            contextParts.push('Status: New session with no messages yet.');
          } else {
            contextParts.push(`Activity: ${userMessageCount} user ${userMessageCount === 1 ? 'prompt' : 'prompts'}, ${assistantEvents.length} assistant responses.`);

            // Extract recent activity (last few tool calls)
            const recentToolCalls = toolEvents.slice(-5).map(m => m.toolCall).filter(Boolean);

            if (recentToolCalls.length > 0) {
              const toolSummary = recentToolCalls.map((tc: any) => {
                const name = tc.toolName;
                if (name === 'Edit' || name === 'Write') {
                  const filePath = tc.arguments?.file_path || tc.arguments?.filePath || tc.targetFilePath;
                  return filePath ? `edited ${String(filePath).split('/').pop()}` : 'edited a file';
                } else if (name === 'Read') {
                  const filePath = tc.arguments?.file_path || tc.arguments?.filePath || tc.targetFilePath;
                  return filePath ? `read ${String(filePath).split('/').pop()}` : 'read a file';
                } else if (name === 'Bash') {
                  return 'ran a command';
                } else if (name === 'Grep' || name === 'Glob') {
                  return 'searched files';
                }
                return name?.toLowerCase?.() || 'used a tool';
              }).join(', ');
              contextParts.push(`Recent tools: ${toolSummary}`);
            }

            // Include the tail of the actual conversation so the voice agent
            // knows what has been discussed. Extract the last few user prompts
            // and assistant text responses (skip tool/system events).
            const conversationTail = conversationEvents
              .slice(-6)
              .map(m => {
                const role = m.type === 'user_message' ? 'Already submitted user prompt' : 'Coding agent response';
                const text = typeof m.text === 'string' ? m.text : '';
                if (!text.trim()) return null;
                // Truncate each message to keep total size manageable
                const truncated = text.length > 500
                  ? text.substring(0, 500) + '...'
                  : text;
                return `${role}: ${truncated}`;
              })
              .filter(Boolean);

            if (conversationTail.length > 0) {
              contextParts.push(`\nRecent conversation:\n${conversationTail.join('\n')}`);
            }
          }

          sessionContext = contextParts.join('\n');
        }
      } catch (error) {
        console.error('[VoiceModeService] Failed to load session context:', error);
      }

      timing.mark('session-context');

      // Get files that have been read or edited during this session
      try {
        const { SessionFilesRepository } = await import('@nimbalyst/runtime/storage/repositories/SessionFilesRepository');
        const [editedFiles, readFiles] = await Promise.all([
          SessionFilesRepository.getFilesBySession(sessionId, 'edited'),
          SessionFilesRepository.getFilesBySession(sessionId, 'read'),
        ]);

        // Combine and dedupe, prioritizing edited files
        const allFiles = [...editedFiles];
        for (const file of readFiles) {
          if (!allFiles.some(f => f.filePath === file.filePath)) {
            allFiles.push(file);
          }
        }

        if (allFiles.length > 0) {
          // Show up to 8 files, with edited files first
          const fileList = allFiles.slice(0, 8).map(f => {
            const fileName = f.filePath.split('/').pop();
            const isEdited = editedFiles.some(e => e.filePath === f.filePath);
            return isEdited ? `${fileName} (edited)` : fileName;
          }).join(', ');
          sessionContext += `\nSession files: ${fileList}`;
        }
      } catch (error) {
        // Ignore - session files are optional context
        console.error('[VoiceModeService] Failed to load session files:', error);
      }

      timing.mark('session-files');

      // Load AI-generated project summary for voice mode context
      // This is stored in nimbalyst-local/voice-project-summary.md and generated on demand
      if (workspacePath) {
        try {
          const fs = await import('fs/promises');
          const path = await import('path');

          const summaryPath = path.join(workspacePath, 'nimbalyst-local', 'voice-project-summary.md');
          const summaryContent = await fs.readFile(summaryPath, 'utf-8').catch(() => null);

          if (summaryContent) {
            // Bounded. The file is expected to be a short curated summary, but
            // it is a repository file: nothing stops it being megabytes, and
            // the whole of it is sent to the provider on every voice session
            // start. "It is already curated" is an expectation about content,
            // not a limit on size.
            const trimmed = summaryContent.trim();
            const summary =
              trimmed.length > MAX_VOICE_PROJECT_SUMMARY_CHARS
                ? `${trimmed.slice(0, MAX_VOICE_PROJECT_SUMMARY_CHARS)}\n[truncated]`
                : trimmed;
            if (trimmed.length !== summary.length) {
              console.warn(
                `[VoiceModeService] Project summary truncated from ${trimmed.length} to ${MAX_VOICE_PROJECT_SUMMARY_CHARS} characters`,
              );
            }
            sessionContext += `\n\nProject Summary:\n${summary}`;
          }
        } catch (error) {
          // Ignore - summary file is optional
        }
      }

      timing.mark('project-summary');

      // Enumerate the same provider-aware command catalog used by the composer.
      // Force a fresh registry snapshot for every voice-session start so command
      // changes inside the normal catalog TTL are reflected immediately. The
      // formatter admits command names only; it never forwards command bodies,
      // descriptions, source paths, or tool metadata into the voice prompt.
      if (workspacePath) {
        try {
          const workflowRequest = JSON.stringify({
            workspacePath,
            sessionId,
            provider: linkedSessionProvider,
          });
          const commandContext = await loadFreshVoiceCommandContext(
            () => getAgentWorkflowService(workspacePath).clearCache(),
            () => window.webContents.executeJavaScript(`
              window.electronAPI.invoke('ai:getAgentWorkflows', ${workflowRequest})
            `),
          );
          sessionContext += `\n\n${commandContext}`;
        } catch (error) {
          console.error('[VoiceModeService] Failed to load workspace commands for voice context:', error);
        }
      }

      timing.mark('command-catalog');

      // NOTE: Initial active file context is sent by the renderer via
      // voice-mode:editor-context-changed IPC after voiceActiveSessionIdAtom is set.
      // The voiceModeListeners subscription fires checkAndReportFileChange automatically.

      // Load custom voice agent prompt, turn detection settings, and voice
      const voiceModeSettings = voiceModeSettingsStore.get('voiceMode') as {
        voice?: 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';
        engine?: VoiceEngineId;
        model?: RealtimeModel;
        reasoningEffort?: RealtimeReasoningEffort;
        voiceAgentPrompt?: { prepend?: string; append?: string };
        codingAgentPrompt?: { prepend?: string; append?: string };
        turnDetection?: {
          mode: 'server_vad' | 'push_to_talk';
          detection?: 'semantic_vad' | 'server_vad';
          vadThreshold?: number;
          silenceDuration?: number;
          interruptible?: boolean;
        };
        noiseReduction?: 'near_field' | 'far_field' | 'off';
      } | undefined;
      const customPrompt = voiceModeSettings?.voiceAgentPrompt || {};
      const turnDetection = {
        ...(voiceModeSettings?.turnDetection || {
          mode: 'server_vad' as const,
          silenceDuration: 500,
          interruptible: true,
        }),
        // Echo round 2 defaults: model-judged semantic_vad (echo-robust; the
        // old amplitude server_vad tripped on residual echo at 0.5) and
        // far_field noise reduction (loud open speakers are the echo case).
        // Persisted settings can override both.
        detection: voiceModeSettings?.turnDetection?.detection ?? ('semantic_vad' as const),
        noiseReduction: voiceModeSettings?.noiseReduction ?? ('far_field' as const),
        // A persisted 0.5 is indistinguishable from the old default and lets
        // echo trip amplitude VAD -- treat it as unset so the raised builder
        // default applies (matches the iOS NIM-1314 migration).
        ...(voiceModeSettings?.turnDetection?.vadThreshold === 0.5 ? { vadThreshold: undefined } : {}),
      };
      const selectedVoice = voiceModeSettings?.voice || 'alloy';
      // Old persisted settings predate these fields -- fall back to the defaults.
      const selectedModel: RealtimeModel = voiceModeSettings?.model ?? 'gpt-realtime-2';
      const reasoningEffort: RealtimeReasoningEffort = voiceModeSettings?.reasoningEffort ?? 'low';
      // Pin the voice agent's spoken language to the desktop's configured default
      // (undefined -> RealtimeAPIClient falls back to English).
      const preferredLanguage = getPreferredAgentLanguage();

      // Core hook 2: let extensions contribute to the voice session context at
      // start (e.g. top-N grounding facts). Appended before the client is built
      // so it ships in the initial session instructions.
      try {
        const extensionContext = await requestExtensionVoiceContext(window, {
          workspacePath: workspacePath ?? undefined,
          voiceSessionId: sessionId,
          codingSessionId: sessionId,
        }, timing);
        if (extensionContext && extensionContext.trim().length > 0) {
          sessionContext += `\n\n${extensionContext.trim()}`;
          console.log(`[VoiceModeService] Appended ${extensionContext.length} chars of extension voice context`);
        }
      } catch (error) {
        console.error('[VoiceModeService] Failed to collect extension voice context:', error);
      }

      timing.mark('extension-context');

      // Core hook 1: extension-contributed voice tools. Loaded before the
      // engine is built so the tool list ships in the initial session config
      // on either transport. Dispatch reuses the existing extension-tool
      // execution path (the same route MCP uses via handleExtensionTool).
      let extensionTools: { schemas: ReturnType<typeof buildVoiceToolSet>['schemas']; nameMap: Map<string, string> } | undefined;
      try {
        // Voice tools come from two sources: renderer-declared extension tools
        // (dispatched to the renderer) and backend-module-registered tools
        // (dispatched main->backend, no renderer hop — protects the voice
        // latency budget). Merge both into the advertised tool list.
        const [extVoiceTools, backendVoiceTools] = await Promise.all([
          getVoiceEnabledExtensionTools(workspacePath ?? undefined),
          getVoiceEnabledBackendToolsForWorkspace(workspacePath ?? undefined),
        ]);
        const voiceTools = [...extVoiceTools, ...backendVoiceTools];
        if (voiceTools.length > 0) {
          const { schemas, nameMap } = buildVoiceToolSet(voiceTools, {
            reservedNames: new Set(BUILTIN_VOICE_TOOL_NAMES),
          });
          extensionTools = { schemas, nameMap };
          console.log(
            `[VoiceModeService] Exposed ${schemas.length} voice tool(s) (${extVoiceTools.length} extension, ${backendVoiceTools.length} backend): ${Array.from(nameMap.values()).join(', ')}`
          );
        }
      } catch (error) {
        console.error('[VoiceModeService] Failed to load voice tools:', error);
      }

      timing.mark('tool-discovery');

      // Helper: get the current linked session ID (may change if user switches sessions)
      const currentSessionId = () => activeVoiceSession?.sessionId ?? sessionId;
      const sessionHandoff = createVoiceSessionHandoff();

      // Load coding agent prompt settings for inclusion in submit-prompt events
      const codingAgentPromptSettings = voiceModeSettings?.codingAgentPrompt || {};

      // Track whether an ask_coding_agent call is in-flight so the completion
      // path doesn't also announce the same response (which would make the
      // voice agent say "I finished that task" instead of relaying the answer).
      let askCodingAgentInFlight = false;
      let askCodingAgentTarget: string | null = null;
      /**
       * The agent session the last submission actually went to. The handoff
       * target is consumed at submit time, so this is what a task accepted a
       * moment later must be correlated with.
       */
      let lastSubmitTarget: string | null = null;

      const send = (channel: string, payload: Record<string, unknown>): void => {
        if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
      };

      /**
       * Every tool the voice agent can call. One implementation per tool,
       * independent of which transport is carrying the conversation.
       */
      const buildToolHandlers = (engineId: VoiceEngineId): VoiceToolHandlers => ({
        onSubmitPrompt: async (prompt) => {
          const targetSessionId = sessionHandoff.takePromptTarget(currentSessionId());
          lastSubmitTarget = targetSessionId;
          const submissionId = `voice-submission-${randomUUID()}`;
          const ack = await requestVoicePromptSubmission(window, {
            sessionId: targetSessionId,
            workspacePath,
            prompt,
            submissionId,
            codingAgentPrompt: codingAgentPromptSettings,
          });
          if (!ack.queued) {
            return { success: false, error: ack.error || 'The task could not be queued.' };
          }
          return { success: true, sessionId: targetSessionId, submissionId };
        },

        onStopSession: () => stopVoiceSession(),

        onPauseListening: () => {
          send('voice-mode:pause-listening', { sessionId: currentSessionId() });
        },

        onGetSessionSummary: async () => {
          const result = await getSessionSummary();
          return { success: result.success, summary: result.summary, error: result.error };
        },

        onGetUiContext: async () => {
          const wp = activeVoiceSession?.workspacePath ?? workspacePath;
          if (!wp) return { success: false, error: 'The active workspace is not available.' };
          return requestVoiceUiContext(window, wp);
        },

        onCaptureUiScreenshot: async () => {
          const wp = activeVoiceSession?.workspacePath ?? workspacePath;
          if (!wp) return { success: false, error: 'The active workspace is not available.' };
          const uiContextResult = await requestVoiceUiContext(window, wp);
          const context = uiContextResult.success ? uiContextResult.context : undefined;
          try {
            return await captureActiveVoiceWindow(window, context);
          } catch (error) {
            console.error('[VoiceModeService] Failed to capture active UI:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },

        // Respond to interactive prompts (AskUserQuestion, ExitPlanMode, etc.).
        // The renderer resolves the answer's real target from the queued event
        // that announced it, so a tab switch after the question cannot
        // redirect the answer.
        onRespondToPrompt: async (params) => {
          try {
            console.log('[VoiceModeService] respond_to_interactive_prompt:', {
              promptId: params.promptId,
              promptType: params.promptType,
              answer: params.answer,
            });

            let response: any;
            if (params.promptType === 'ask_user_question_request') {
              // AskUserQuestion expects { answers: { questionText: answerText } }.
              // The renderer rebuilds the real question key.
              response = { answers: { _voice: params.answer } };
            } else if (
              params.promptType === 'exit_plan_mode_request' ||
              params.promptType === 'git_commit_proposal_request'
            ) {
              response = { approved: params.answer.toLowerCase() === 'approve' };
            } else {
              response = { answer: params.answer };
            }

            send('voice-mode:respond-to-prompt', {
              sessionId: currentSessionId(),
              promptId: params.promptId,
              promptType: params.promptType,
              response,
            });
            return { success: true };
          } catch (error) {
            console.error('[VoiceModeService] Failed to respond to prompt:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },

        // List sessions in this workspace. With a topic query and the memory
        // engine running, this matches session *content* semantically, then
        // falls back to title/transcript search. Shared with the mobile
        // voice-tool proxy so the iOS agent gets the identical lookup.
        onListSessions: async (query?: string) => {
          const wp = activeVoiceSession?.workspacePath;
          if (!wp) return { success: false, error: 'No workspace path available' };
          return searchSessionsForVoice(wp, query);
        },

        onCreateSession: (title?: string) => sessionHandoff.createSessionOnce(async () => {
          try {
            const wp = activeVoiceSession?.workspacePath ?? workspacePath;
            if (!wp) return { success: false, error: 'No workspace path available' };

            const newSessionId = randomUUID();
            const { provider, model } = resolveSessionModelSelection(
              'claude-code',
              getDefaultAIModel() || 'claude-code:opus-1m',
            );
            const newTitle = title?.trim() || 'New Session';

            await AISessionsRepository.create({
              id: newSessionId,
              provider,
              model,
              title: newTitle,
              workspaceId: wp,
            });

            // Navigation is only visual; sessionHandoff pins the next coding
            // prompt to this ID even if renderer selection lags or changes.
            if (window && !window.isDestroyed()) {
              window.show();
              window.focus();
              window.webContents.send('sessions:refresh-list', { workspacePath: wp, sessionId: newSessionId });
              window.webContents.send('tray:navigate-to-session', { sessionId: newSessionId, workspacePath: wp });
            }

            return { success: true, sessionId: newSessionId, title: newTitle };
          } catch (error) {
            console.error('[VoiceModeService] Failed to create session:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        }),

        // Propose a commit via the "Commit with AI" path: the renderer runs the
        // SAME logic as the Smart Commit button, so the transcript widget and
        // the git_commit_proposal_request prompt flow through the existing
        // forwarding pipeline.
        onProposeCommit: async () => {
          try {
            if (!window || window.isDestroyed()) return { success: false, error: 'Window not available' };
            window.webContents.send('voice-mode:propose-commit', {
              sessionId: currentSessionId(),
              workspacePath,
            });
            return { success: true };
          } catch (error) {
            console.error('[VoiceModeService] Failed to propose commit:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },

        onNavigateToSession: async (targetSessionId: string) => {
          try {
            const session = await AISessionsRepository.get(targetSessionId);
            if (!session) return { success: false, error: `Session not found: ${targetSessionId}` };

            const wp = activeVoiceSession?.workspacePath;
            if (!wp) return { success: false, error: 'No workspace path available' };

            if (window && !window.isDestroyed()) {
              window.show();
              window.focus();
              window.webContents.send('tray:navigate-to-session', { sessionId: targetSessionId, workspacePath: wp });
            }
            return { success: true, title: session.title || targetSessionId };
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },

        /**
         * Relay a message to the coding agent and wait for its answer.
         *
         * The wait is bounded per engine. On Live the tool result also holds
         * the delegation lane open and blocks the paid-session closure that
         * stops billing, so waiting a full minute there would trade money for
         * an answer we can deliver later anyway: past the bound it returns
         * accepted-and-still-working, and the real answer arrives through the
         * normal completion path.
         */
        onAskCodingAgent: async (question: string) => {
          // Read-only, and said so explicitly, because this tool reaches an
          // editing-capable agent. A spoken design question ("do we need a
          // Bloom filter here, or are these indexes too small?") is a question,
          // and the plan is clear that it must not turn into an edit
          // instruction -- `submit_agent_prompt` is the tool for that, and it
          // goes through the on-screen queue and countdown the user controls.
          //
          // The framing is the enforcement available at this layer: there is no
          // per-submission permission mode to set from here, so a determined
          // model could still phrase an edit as a question. That gap is
          // narrowed, not closed, and the actions that matter are gated
          // elsewhere on application-owned intent rather than on the agent
          // being obedient.
          const questionPrompt =
            `[VOICE QUESTION -- DISCUSSION ONLY] ${question}\n\n` +
            'Answer this question. Do not edit, create, move or delete any file, do not run any ' +
            'command that changes state, and do not commit. If answering needs a change, describe ' +
            'the change instead of making it. Reading files and searching the project is fine.';
          const targetSessionId = sessionHandoff.takePromptTarget(currentSessionId());
          lastSubmitTarget = targetSessionId;
          const timeoutMs = engineId === 'live' ? LIVE_ASK_TIMEOUT_MS : REALTIME_ASK_TIMEOUT_MS;

          console.log('[VoiceModeService] ask_coding_agent called with question:', question, 'target:', targetSessionId);
          askCodingAgentInFlight = true;
          askCodingAgentTarget = targetSessionId;

          try {
            if (!window || window.isDestroyed()) {
              askCodingAgentInFlight = false;
              return { success: false, error: 'Window not available' };
            }
            return await new Promise((resolve) => {
              let timeoutId: NodeJS.Timeout | null = null;

              const responseHandler = (
                event: Electron.IpcMainEvent,
                data: { sessionId: string; summary?: string; error?: string },
              ) => {
                // This resolves a tool call the controller is waiting on, so an
                // unauthorized caller could hand it an answer of its choosing.
                // The session is not looked up: it has to equal the session we
                // ourselves submitted to, which is a tighter bind than
                // membership.
                if (!authorizeVoiceMessage('voice-mode:agent-task-complete', event, data ?? {}, {
                  sessionId: true,
                })) return;
                if (data.sessionId !== targetSessionId) return;
                ipcMain.removeListener('voice-mode:agent-task-complete', responseHandler);
                if (timeoutId) clearTimeout(timeoutId);
                askCodingAgentInFlight = false;
                askCodingAgentTarget = null;

                console.log('[VoiceModeService] ask_coding_agent received response:', {
                  summaryLength: data.summary?.length,
                  summaryPreview: data.summary?.substring(0, 500),
                });

                if (data.error) {
                  resolve({ success: false, error: data.error });
                  return;
                }

                // Truncate for the voice context window: very long function
                // results degrade the speech model's relay.
                const answer = data.summary || 'I was unable to find an answer.';
                resolve({
                  success: true,
                  answer: answer.length > 2000 ? answer.substring(0, 2000) + '... (truncated)' : answer,
                });
              };

              ipcMain.on('voice-mode:agent-task-complete', responseHandler);

              window.webContents.send('voice-mode:submit-prompt', {
                sessionId: targetSessionId,
                workspacePath,
                prompt: questionPrompt,
              });

              timeoutId = setTimeout(() => {
                ipcMain.removeListener('voice-mode:agent-task-complete', responseHandler);
                // Released so the still-running work announces itself when it
                // finishes instead of being swallowed as this call's answer.
                askCodingAgentInFlight = false;
                askCodingAgentTarget = null;
                resolve(
                  engineId === 'live'
                    ? {
                        success: true,
                        answer:
                          'The coding agent is still working on that. I will tell you as soon as it answers.',
                      }
                    : { success: false, error: 'Question timed out waiting for response' },
                );
              }, timeoutMs);
            });
          } catch (error) {
            askCodingAgentInFlight = false;
            askCodingAgentTarget = null;
            console.error('[VoiceModeService] Failed to ask coding agent:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
          }
        },

        onExtensionVoiceTool: extensionTools
          ? async (namespacedName, args) => {
              const targetWorkspace = activeVoiceSession?.workspacePath ?? workspacePath ?? undefined;
              const targetSessionId = activeVoiceSession?.sessionId ?? sessionId;
              try {
                // Route backend tools to the module; everything else to the
                // renderer extension path. Resolve worktree paths so registry
                // and module lookups hit the project the module started for.
                let result;
                const resolvedWs = targetWorkspace
                  ? await resolveBackendWorkspacePath(targetWorkspace)
                  : undefined;
                if (resolvedWs && isBackendTool(namespacedName, resolvedWs)) {
                  result = await handleBackendTool(namespacedName, namespacedName, args, resolvedWs);
                } else {
                  result = await handleExtensionTool(
                    namespacedName, // toolName -- matches the registered (dotted) name
                    namespacedName, // originalName (for error messages)
                    args,
                    targetSessionId,
                    targetWorkspace,
                  );
                }
                const text = (result.content || [])
                  .map((c) => (typeof c?.text === 'string' ? c.text : ''))
                  .filter(Boolean)
                  .join('\n');
                return { success: !result.isError, message: text };
              } catch (error) {
                console.error('[VoiceModeService] Extension voice tool dispatch failed:', namespacedName, error);
                return { success: false, error: error instanceof Error ? error.message : String(error) };
              }
            }
          : undefined,
      });

      const sessionStartTime = Date.now();

      /**
       * Install the application on an engine. ONE registration call site for
       * both transports: the events are named for what the user experiences,
       * the handlers are the tool implementations, and neither mentions a wire
       * protocol. The only engine-shaped branch is barge-in, which exists
       * precisely because the two engines report interruption differently.
       */
      const prepareEngine = (
        engine: VoiceEngineRegistrar,
        engineId: VoiceEngineId,
      ): LiveBargeInCoordinator | null => {
        const bargeIn =
          engineId === 'live'
            ? new LiveBargeInCoordinator({
                isPlaybackActive: () => (engine as LiveAPIClient).isSpeaking(),
                // Flushing the renderer's queue is the whole point: Live stops
                // generating on its own, but our buffered audio would keep
                // playing at the user after they interrupted.
                flushPlayback: () => send('voice-mode:interrupt', { sessionId: currentSessionId() }),
              })
            : null;

        registerVoiceEngine(engine, {
          events: {
            audio: (audioBase64) => {
              if (!activeVoiceSession || activeVoiceSession.poc !== engine) return;
              const claims = activeVoiceSession.presentationClaims ?? [];
              if (claims.some(claim => !voicePresentationAuthority.valid(claim.key, claim.deviceId, claim.token))) return;
              send('voice-mode:audio-received', { sessionId: currentSessionId(), audioBase64 });
            },
            assistantText: (text) => {
              // What the assistant just said is what an echo of it will look
              // like; the barge-in decision is a content comparison.
              bargeIn?.noteAssistantText(text);
              send('voice-mode:text-received', { sessionId: currentSessionId(), text });
            },
            userTranscript: (transcript) =>
              send('voice-mode:transcript-complete', { sessionId: currentSessionId(), transcript }),
            userTranscriptDelta: (delta, itemId) => {
              // On Live this is the only evidence about what the user is
              // saying, which is what separates a barge-in from our own echo.
              bargeIn?.onUserTranscriptDelta(itemId, delta);
              send('voice-mode:transcript-delta', { sessionId: currentSessionId(), delta, itemId });
            },
            // Live has no end-of-turn signal; this is that engine reporting
            // that an utterance's transcript stopped growing. It closes the
            // renderer's listen window and persists the utterance -- nothing
            // is told to the model, and no VAD event is synthesized.
            userSpeechWindowClosed: (transcript, itemId) =>
              send('voice-mode:speech-window-closed', {
                sessionId: currentSessionId(),
                transcript,
                itemId,
              }),
            usage: (usage) =>
              send('voice-mode:token-usage', { sessionId: currentSessionId(), usage, engine: engineId }),
            toolCall: (event) => send('voice-mode:tool-call', { sessionId: currentSessionId(), event }),
            // Unconditional speech-start signal (unlike voice-mode:interrupt,
            // which the barge-in policy can defer or suppress). The renderer
            // uses it to hold the listen window open for the whole utterance.
            userSpeechStarted: () => {
              bargeIn?.onUserSpeechStarted();
              send('voice-mode:speech-started', { sessionId: currentSessionId() });
            },
            userSpeechStopped: () => send('voice-mode:speech-stopped', { sessionId: currentSessionId() }),
            // Realtime decides interruption itself and says so. Live publishes
            // no such event, and none is synthesized for it -- its flush comes
            // from the barge-in coordinator above.
            interrupted: () => send('voice-mode:interrupt', { sessionId: currentSessionId() }),
            error: (error) => {
              console.error('[VoiceModeService] Error from engine:', error.type, error.message);
              send('voice-mode:error', { sessionId: currentSessionId(), error });
            },
            // Transient reconnect state, so a dropped socket surfaces as
            // "reconnecting…" instead of silently dying. A hard error is only
            // emitted once retries are exhausted.
            reconnecting: (attempt) => send('voice-mode:reconnecting', { sessionId: currentSessionId(), attempt }),
            reconnected: () => send('voice-mode:reconnected', { sessionId: currentSessionId() }),
            disconnected: (reason) => {
              if (activeVoiceSession?.sessionId !== sessionId || reason === 'user_stopped') return;
              sendSessionEndedEvent(reason, sessionStartTime);
              activeVoiceSession.cleanupCompletionListener();
              activeVoiceSession.bargeIn?.reset();
              activeVoiceSession = null;
            },
          },
          handlers: buildToolHandlers(engineId),
          extensionTools,
        });

        if (engine instanceof LiveAPIClient) {
          // Live returns accepted-and-queued for long work; correlating the
          // task to the session it was submitted to is what lets the real
          // outcome find it later, after the paid session has been closed.
          engine.setTaskCorrelator(() => ({ sessionId: lastSubmitTarget ?? currentSessionId() }));
        }
        return bargeIn;
      };

      // --- Engine selection ---------------------------------------------------
      // GPT-Live is the default; preserve an explicit Realtime selection.
      const requestedEngine: VoiceEngineId = resolveVoiceEngine(voiceModeSettings?.engine, true).engine;

      const createRealtime = (): RealtimeAPIClient =>
        new RealtimeAPIClient(
          apiKey,
          sessionId,
          workspacePath,
          window,
          sessionContext,
          customPrompt,
          turnDetection,
          selectedVoice,
          // Realtime's model setting, and only on the Realtime engine: this
          // helper is what keeps a Realtime model string from ever reaching
          // the Live endpoint, where it would fail as a confusing startup
          // error instead of a clean fallback.
          realtimeModelForEngine('realtime', selectedModel),
          reasoningEffort,
          preferredLanguage,
          timing,
        );

      // Note what is NOT passed here: `selectedModel`. The Live session config
      // carries its own model default; the two engines' model settings are
      // independent so a Live failure falls back with Realtime's config intact.
      const createLive = (): LiveAPIClient =>
        new LiveAPIClient({
          apiKey,
          voice: selectedVoice,
          language: preferredLanguage,
          sessionContext,
          customPrompt,
          startupTiming: timing,
        });

      let engineId: VoiceEngineId = requestedEngine;
      let engineFallback: { from: VoiceEngineId; reason: string } | null = null;
      let poc: VoiceEngineRegistrar;
      let bargeIn: LiveBargeInCoordinator | null = null;

      const startRealtime = async (): Promise<RealtimeAPIClient> => {
        const realtime = createRealtime();
        bargeIn = prepareEngine(realtime, 'realtime');
        await realtime.connect();
        return realtime;
      };

      timing.mark('engine-preparation');
      if (requestedEngine === 'live') {
        const live = createLive();
        bargeIn = prepareEngine(live, 'live');
        try {
          await live.connect();
          poc = live;
        } catch (error) {
          // An account or build that cannot run Live must not silently become
          // Realtime: resolveVoiceEngine owns both the fallback decision and
          // the wording the user is told, so the evaluation is not attributing
          // Realtime's behavior to Live.
          timing.mark('live-fallback');
          const resolution = resolveVoiceEngine('live', false);
          console.warn(
            `[VoiceModeService] GPT-Live startup failed; falling back to ${resolution.engine}: ${error instanceof Error ? error.message : String(error)}`,
          );
          live.disconnect('error');
          engineId = resolution.engine;
          engineFallback = { from: 'live', reason: resolution.reason };
          poc = await startRealtime();
        }
      } else {
        poc = await startRealtime();
      }

      voiceConversationGeneration += 1;
      const generation = voiceConversationGeneration;
      // Keyed by generation, so the previous conversation's entries can never
      // authorize anything again; drop them rather than accumulate them.
      verifiedVoiceSessions.clear();

      send('voice-mode:engine-selected', {
        sessionId,
        engine: engineId,
        fallbackFrom: engineFallback?.from ?? null,
        reason: engineFallback?.reason ?? '',
        // The renderer quotes this back on every message it sends about this
        // conversation; see voiceIpcAuthorization.ts.
        generation,
        workspacePath,
      });

      // Coding-agent completions reach the voice conversation through the
      // renderer's event queue, not from here: the queue is what knows whether
      // a completion is still current, whether the user is mid-conversation,
      // and which session an answer must go back to. This listener only keeps
      // ask_coding_agent's own answer out of that path.
      const completionListener = (
        event: Electron.IpcMainEvent,
        data: { sessionId: string; summary?: string; error?: string; workspacePath?: string; generation?: number },
      ) => {
        console.log('[VoiceModeService] agent-task-complete received:', {
          sessionId: data?.sessionId,
          summaryLength: data?.summary?.length ?? 0,
          error: data?.error,
          askCodingAgentInFlight,
        });
        // A completion carries another session's content into this
        // conversation, so the caller has to own the conversation and the
        // session has to be one this workspace can speak for. Without that,
        // any renderer could announce a foreign workspace's result.
        const verdict = authorizeVoiceMessage('voice-mode:agent-task-complete', event, data ?? {}, {
          sessionId: true,
        });
        if (!verdict?.sessionId) return;
        if (askCodingAgentInFlight && verdict.sessionId === askCodingAgentTarget) return;
        const completedSessionId = verdict.sessionId;
        runAuthorizedSessionWork(
          'voice-mode:agent-task-complete',
          { sessionId: completedSessionId, workspacePath: verdict.workspacePath, generation },
          () => {
            send('voice-mode:task-completed', {
              sessionId: completedSessionId,
              summary: data.summary,
              error: data.error,
              workspacePath: verdict.workspacePath,
            });
          },
        );
      };
      ipcMain.on('voice-mode:agent-task-complete', completionListener);

      // Store cleanup function for this listener
      const cleanupCompletionListener = () => {
        ipcMain.removeListener('voice-mode:agent-task-complete', completionListener);
      };

      // Store active session info
      activeVoiceSession = {
        poc,
        engineId,
        bargeIn,
        window,
        workspacePath,
        sessionId,
        generation,
        cleanupCompletionListener,
        startTime: Date.now(),
        hasExistingSession,
      };

      // Track session started
      AnalyticsService.getInstance().sendEvent('voice_session_started');

      console.log(`[VoiceModeService] Voice mode activated for sessionId: ${sessionId} engine=${engineId}`);

      timing.finish('ready');
      return {
        success: true,
        message: engineFallback
          ? engineFallback.reason
          : `Connected to the ${engineId === 'live' ? 'GPT-Live' : 'Realtime'} voice engine`,
        engine: engineId,
        fallbackFrom: engineFallback?.from,
        sessionId: poc.isConnected() ? 'connected' : null,
        generation,
      };
    } catch (error) {
      timing.finish('failed');
      return {
        success: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  /**
   * Disconnect from OpenAI
   */
  safeHandle('voice-mode:test-disconnect', async (_event, workspacePath: string | null, sessionId: string) => {
    try {
      if (!sessionId) {
        throw new Error('Session ID is required for voice mode');
      }

      let tokenUsage: (VoiceEngineUsage & { engine: VoiceEngineId }) | undefined;

      // Only disconnect if this is the active session
      if (activeVoiceSession && activeVoiceSession.sessionId === sessionId) {
        // Track session ended before cleanup
        sendSessionEndedEvent('user_stopped', activeVoiceSession.startTime);

        // Get final token usage before disconnect
        tokenUsage = usageWithEngine(activeVoiceSession);

        activeVoiceSession.poc.disconnect();
        activeVoiceSession.bargeIn?.reset();
        // Clean up the completion listener
        activeVoiceSession.cleanupCompletionListener();
        activeVoiceSession = null;
      }

      return {
        success: true,
        message: 'Disconnected',
        tokenUsage,
      };
    } catch (error) {
      return {
        success: false,
        message: `Disconnect failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  /**
   * Check connection status
   */
  safeHandle('voice-mode:test-status', async (_event, workspacePath: string | null, sessionId: string) => {
    const isActiveSession = activeVoiceSession?.sessionId === sessionId;
    const connected = isActiveSession && activeVoiceSession?.poc.isConnected() || false;
    return {
      success: true,
      connected,
      message: connected ? 'Connected' : 'Disconnected',
    };
  });

  /**
   * Send audio chunk to OpenAI
   */
  safeHandle('voice-mode:send-audio', async (_event, workspacePath: string | null, sessionId: string, audioBase64: string) => {
    try {
      if (!sessionId) {
        throw new Error('Session ID is required for voice mode');
      }

      if (!activeVoiceSession || activeVoiceSession.sessionId !== sessionId) {
        throw new Error('No active voice session for this session ID');
      }

      if (!activeVoiceSession.poc.isConnected()) {
        throw new Error('Not connected to OpenAI');
      }

      activeVoiceSession.poc.appendAudio(audioBase64);

      return {
        success: true,
      };
    } catch (error) {
      return {
        success: false,
        message: `Send audio failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  /**
   * Commit audio buffer (tell OpenAI to process it)
   */
  safeHandle('voice-mode:commit-audio', async (_event, workspacePath: string | null, sessionId: string) => {
    try {
      if (!sessionId) {
        throw new Error('Session ID is required for voice mode');
      }

      if (!activeVoiceSession || activeVoiceSession.sessionId !== sessionId) {
        throw new Error('No active voice session for this session ID');
      }

      if (!activeVoiceSession.poc.isConnected()) {
        throw new Error('Not connected to OpenAI');
      }

      // Push-to-talk end of turn. Realtime commits the input buffer; Live has
      // no commit event and closes the utterance its own way.
      activeVoiceSession.poc.endUserTurn();

      return {
        success: true,
      };
    } catch (error) {
      return {
        success: false,
        message: `Commit audio failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  /**
   * Preview a voice using OpenAI's TTS API
   */
  safeHandle('voice-mode:preview-voice', async (event, voiceId: string) => {
    try {
      // Get OpenAI API key
      const apiKey = getProviderCredentials().get('openai');

      if (!apiKey) {
        return {
          success: false,
          message: 'OpenAI API key not configured',
        };
      }

      // TTS API supports: alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer
      // Realtime API adds: ballad, marin, cedar, verse
      // Map unsupported voices to similar TTS voices for preview
      const ttsVoiceMap: Record<string, string> = {
        'ballad': 'nova',    // Warm and melodic -> Nova
        'marin': 'alloy',    // Natural conversational -> Alloy
        'cedar': 'onyx',     // Deep and resonant -> Onyx
        'verse': 'fable',    // Dynamic and engaging -> Fable
      };

      const ttsVoice = ttsVoiceMap[voiceId] || voiceId;
      const isApproximation = ttsVoiceMap[voiceId] !== undefined;

      // Use OpenAI's TTS API to generate a preview
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: isApproximation
            ? `Hello! I'm ${voiceId}. This preview uses a similar voice. The actual voice in conversation will sound slightly different.`
            : `Hello! I'm ${voiceId}. This is how I sound when speaking to you.`,
          voice: ttsVoice,
          response_format: 'mp3',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`TTS API error: ${response.status} - ${redactVoiceDiagnostic(errorText, apiKey)}`);
      }

      // Get the audio data
      const audioBuffer = await response.arrayBuffer();
      const audioBase64 = Buffer.from(audioBuffer).toString('base64');

      // Get the window that made the request
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window) {
        // Send audio to renderer for playback
        window.webContents.send('voice-mode:preview-audio', {
          voiceId,
          audioBase64,
          format: 'mp3',
        });
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: `Voice preview failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  // Voice-friendly project summary generation lives in the renderer now: the
  // Voice Mode settings panel launches an agent session that writes
  // nimbalyst-local/voice-project-summary.md using its Write tool. See
  // packages/electron/src/renderer/components/Settings/VoiceModePanel.tsx and
  // voiceModeSummaryPrompt.ts. Voice mode loads the resulting file in
  // loadSessionContext above.

  /**
   * Find the most recent voice session for a workspace, if it was updated
   * within the timeout window. Used to resume an existing voice session
   * rather than creating a new one every time the button is pressed.
   */
  safeHandle('voice-mode:findRecentSession', async (_event, data: {
    workspacePath: string;
    timeoutMs: number;
  }) => {
    try {
      const { database } = await import('../../database/PGLiteDatabaseWorker');
      const cutoff = new Date(Date.now() - data.timeoutMs);
      const result = await database.query(
        `SELECT id, updated_at FROM ai_sessions
         WHERE workspace_id = $1
           AND session_type = 'voice'
           AND updated_at > $2
         ORDER BY updated_at DESC
         LIMIT 1`,
        [data.workspacePath, cutoff]
      );
      if (result.rows.length > 0) {
        return { found: true, sessionId: result.rows[0].id };
      }
      return { found: false };
    } catch (error) {
      console.error('[VoiceModeService] Failed to find recent voice session:', error);
      return { found: false };
    }
  });

  /**
   * Create a voice session row in ai_sessions.
   * Called immediately when voice activates so the session is visible right away.
   */
  safeHandle('voice-mode:createSession', async (_event, data: {
    id: string;
    workspacePath: string;
    linkedSessionId: string;
  }) => {
    try {
      const { database } = await import('../../database/PGLiteDatabaseWorker');
      await database.query(
        `INSERT INTO ai_sessions (id, workspace_id, provider, title, session_type, metadata, created_at, updated_at)
         VALUES ($1, $2, 'openai-realtime', 'Voice Session', 'voice', $3, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [
          data.id,
          data.workspacePath,
          JSON.stringify({ linkedSessionId: data.linkedSessionId }),
        ]
      );
      return { success: true };
    } catch (error) {
      console.error('[VoiceModeService] Failed to create voice session:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Resume an existing voice session by touching its updated_at and
   * updating the linked coding session ID in metadata.
   */
  safeHandle('voice-mode:resumeSession', async (_event, data: {
    sessionId: string;
    linkedSessionId: string;
  }) => {
    try {
      const { database } = await import('../../database/PGLiteDatabaseWorker');
      await database.query(
        `UPDATE ai_sessions
         SET updated_at = NOW(),
             metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
         WHERE id = $1`,
        [
          data.sessionId,
          JSON.stringify({ linkedSessionId: data.linkedSessionId }),
        ]
      );
      return { success: true };
    } catch (error) {
      console.error('[VoiceModeService] Failed to resume voice session:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Append a single transcript message to a voice session.
   * Called incrementally as user speaks and assistant responds.
   */
  safeHandle('voice-mode:appendMessage', async (_event, data: {
    sessionId: string;
    direction: 'input' | 'output';
    content: string;
    entryId: string;
    timestamp: number;
  }) => {
    try {
      const { database } = await import('../../database/PGLiteDatabaseWorker');
      await database.query(
        `INSERT INTO ai_agent_messages (session_id, source, direction, content, metadata, created_at)
         VALUES ($1, 'voice', $2, $3, $4, $5)`,
        [
          data.sessionId,
          data.direction,
          data.content,
          JSON.stringify({ voiceEntryId: data.entryId }),
          new Date(data.timestamp).toISOString(),
        ]
      );
      // Touch updated_at on the session
      await database.query(
        `UPDATE ai_sessions SET updated_at = NOW() WHERE id = $1`,
        [data.sessionId]
      );
      return { success: true };
    } catch (error) {
      console.error('[VoiceModeService] Failed to append voice message:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Update voice session metadata (token usage, duration) on stop.
   */
  safeHandle('voice-mode:updateSessionMetadata', async (_event, data: {
    sessionId: string;
    tokenUsage: unknown;
    durationMs: number;
  }) => {
    try {
      const { database } = await import('../../database/PGLiteDatabaseWorker');
      // Merge token usage and duration into existing metadata
      await database.query(
        `UPDATE ai_sessions
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          data.sessionId,
          JSON.stringify({
            tokenUsage: data.tokenUsage,
            durationMs: data.durationMs,
          }),
        ]
      );
      return { success: true };
    } catch (error) {
      console.error('[VoiceModeService] Failed to update voice session metadata:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Update the linked AI session for the active voice session.
   * Called when the user switches to a different coding session while voice is active.
   * This ensures voice agent commands (submit-prompt, ask_coding_agent) target the correct session.
   */
  ipcMain.on('voice-mode:update-linked-session', (event, data: {
    newSessionId: string;
    sessionName?: string;
    workspacePath?: string;
    generation?: number;
  }) => {
    // Repointing the conversation decides where every later submission,
    // question and commit lands, so it is the last handler that should take a
    // session id on trust.
    const verdict = authorizeVoiceMessage('voice-mode:update-linked-session', event, {
      ...data,
      sessionId: data?.newSessionId,
    }, { sessionId: true });
    if (!verdict?.sessionId) return;
    const newSessionId = verdict.sessionId;
    if (activeVoiceSession?.sessionId === newSessionId) return;
    const generation = activeVoiceSession!.generation;

    runAuthorizedSessionWork(
      'voice-mode:update-linked-session',
      { sessionId: newSessionId, workspacePath: verdict.workspacePath, generation },
      () => {
        if (!activeVoiceSession || activeVoiceSession.sessionId === newSessionId) return;

        activeVoiceSession.sessionId = newSessionId;
        const name = data.sessionName || 'Untitled';
        console.log(`[VoiceModeService] Updated linked session -> "${name}"`);

        // Notify the voice agent so it knows commands now target a different session
        if (activeVoiceSession.poc.isConnected()) {
          activeVoiceSession.poc.injectContext(
            `[INTERNAL: User switched to a different coding session called "${name}". Your commands now target this session.]`
          );
        }
      },
    );
  });

  /**
   * Listen state changed -- renderer notifies when voice goes to sleep or wakes up.
   *
   * On Realtime this suspends the inactivity disconnect timer. On Live it
   * closes the paid transport outright, because closing the socket is the only
   * thing that stops billed duration; the conversation text and the identity of
   * any accepted-but-unfinished task are retained locally and seeded back when
   * the next activity restores it.
   */
  ipcMain.on('voice-mode:listen-state-changed', (event, data: {
    sleeping: boolean;
    workspacePath?: string;
    generation?: number;
  }) => {
    if (!authorizeVoiceMessage('voice-mode:listen-state-changed', event, data ?? {})) return;
    activeVoiceSession?.poc.setListeningPaused(data.sleeping === true);
  });

  /**
   * An agent run started for a session, at the application's submission
   * revision. Passed straight through to an engine that tracks durable tasks:
   * it binds the task the voice agent submitted to the run it became, and
   * supersedes anything older that is still outstanding for that session.
   */
  ipcMain.on('voice-mode:task-revision', (event, data: {
    sessionId: string;
    revision: number;
    /** The submission this run came from, when this conversation made it. */
    submissionId?: string | null;
    workspacePath?: string;
    generation?: number;
  }) => {
    // A revision supersedes outstanding work, so an unauthorized or
    // non-finite one silences every task for the rest of the conversation.
    const verdict = authorizeVoiceMessage('voice-mode:task-revision', event, data ?? {}, {
      sessionId: true,
      revision: true,
    });
    if (!verdict?.sessionId || verdict.revision === null) return;
    const { sessionId, revision, workspacePath: wp } = verdict;
    const generation = activeVoiceSession!.generation;
    runAuthorizedSessionWork(
      'voice-mode:task-revision',
      { sessionId, workspacePath: wp, generation },
      () => {
        asDurableTaskEngine(activeVoiceSession!.poc)?.noteTaskRevision(
          sessionId,
          revision,
          typeof data.submissionId === 'string' ? data.submissionId : null,
        );
      },
    );
  });

  /**
   * Speak the outcome of a coding task. The renderer's event queue decides
   * *whether* this is worth saying and *when*; this decides how to deliver it
   * on the engine that is actually connected.
   */
  ipcMain.on('voice-mode:announce-completion', (event, data: {
    sessionId: string;
    taskId?: string | null;
    summary?: string;
    error?: string;
    workspacePath?: string;
    generation?: number;
  }) => {
    // This one speaks: whatever text it carries is read to the user and sent
    // to the provider. Skipping the queue with a victim session id and text of
    // the caller's choosing is the exploit it has to be closed against.
    const verdict = authorizeVoiceMessage('voice-mode:announce-completion', event, data ?? {}, {
      sessionId: true,
    });
    if (!verdict?.sessionId) return;
    const session = activeVoiceSession!;
    runAuthorizedSessionWork(
      'voice-mode:announce-completion',
      { sessionId: verdict.sessionId, workspacePath: verdict.workspacePath, generation: session.generation },
      () => announceAuthorizedCompletion(session, { ...data, sessionId: verdict.sessionId!, taskId: verdict.taskId }),
    );
  });

  async function announceAuthorizedCompletion(session: VoiceSession, data: {
    sessionId: string;
    taskId?: string | null;
    summary?: string;
    error?: string;
  }): Promise<void> {
    const completion = buildVoiceTaskCompletion(data);

    // Realtime can keep the submit_agent_prompt call open; resolving it hands
    // the agent the real summary as that tool's return value. Only the session
    // the call was submitted to may resolve it -- a completion from another
    // session is another request's outcome, not this call's return value.
    const deferred = asDeferredCallEngine(session.poc);
    if (
      data.sessionId &&
      deferred?.hasDeferredCallFor(data.sessionId) &&
      deferred.resolveDeferredCallFor(data.sessionId, completion.deferredResult)
    ) {
      console.log(`[VoiceModeService] Resolved deferred submit_agent_prompt for ${data.sessionId}`);
      return;
    }

    // An engine that cannot hold a call open accepted the work with a durable
    // task id instead. Delivering through the task is what rejects a duplicate
    // or superseded outcome -- and what survives the paid session having been
    // closed in the meantime.
    const tasks = asDurableTaskEngine(session.poc);
    if (tasks) {
      // A supplied task id has to be one of *this* session's tasks. Accepting
      // it on its own let a caller pair a victim session id with another
      // session's task and have that task's outcome spoken as this one's.
      if (data.taskId && !tasks.getOpenTasksFor(data.sessionId).some((task) => task.taskId === data.taskId)) {
        console.warn(
          `[VoiceModeService] Rejected completion: taskId=${data.taskId} is not open for session=${data.sessionId}`,
        );
        return;
      }
      const taskId = data.taskId ?? tasks.findOpenTaskFor(data.sessionId)?.taskId ?? null;
      const spoken = completion.deferredResult.success
        ? completion.deferredResult.summary
        : `failed: ${completion.deferredResult.error}`;
      if (taskId && !await claimDesktopAnnouncement(session, data.sessionId)) return;
      if (activeVoiceSession !== session) return;
      if (taskId && tasks.announceTaskCompletion(taskId, spoken)) return;
      if (taskId) {
        // Refused: duplicate, unknown, or superseded. Never reworded into a
        // plain message -- that would smuggle it back into the conversation.
        console.warn(`[VoiceModeService] Completion not announced for taskId=${taskId}`);
        return;
      }
      if (tasks.getOpenTasksFor(data.sessionId).length > 0) {
        // This session has work outstanding but the completion could not be
        // attributed to one of them. Speaking it anyway would report an
        // unidentified task's outcome as if it were the one being waited on.
        console.warn(
          `[VoiceModeService] Completion for session=${data.sessionId} matched no task; not announcing`,
        );
        return;
      }
    }

    if (!await claimDesktopAnnouncement(session, data.sessionId)) return;
    void deliverVoiceAnnouncement(session.poc, completion.fallbackMessage, {
      isCurrent: () => activeVoiceSession === session,
    }).then(delivered => {
      console.info('[VoiceQueue]', JSON.stringify({ action: 'completion-delivery', delivered }));
    }).catch(() => {
      console.warn('[VoiceQueue] Completion delivery failed');
    });
  }

  /**
   * Audible playback state from the renderer (the renderer owns the playback
   * buffer, so only it knows when the assistant is actually audible -- audio
   * keeps playing after response.done because it streams faster than
   * realtime). Drives echo-vs-genuine barge-in classification and server VAD
   * response gating (echo cancellation round 2).
   */
  ipcMain.on('voice-mode:playback-active', (event, data: {
    active: boolean;
    workspacePath?: string;
    generation?: number;
  }) => {
    if (!authorizeVoiceMessage('voice-mode:playback-active', event, data ?? {})) return;
    // A session-wide drain cannot prove which notification was spoken. Keep
    // claims renewable; only an explicit source receipt finalizes presentation.
    activeVoiceSession!.poc.setPlaybackActive(data.active);
    // The barge-in coordinator needs the same fact: whether there is currently
    // audio worth flushing is the difference between a real interruption and
    // cutting the assistant off over an echo.
    activeVoiceSession!.bargeIn?.setPlaybackActive(data.active);
  });

  /**
   * Editor context changed -- user switched to a different file.
   * Notify the active voice agent so it knows what document the user is viewing.
   */
  ipcMain.on('voice-mode:editor-context-changed', (event, data: {
    sessionId: string;
    filePath: string | null;
    workspacePath?: string;
    generation?: number;
  }) => {
    if (!authorizeVoiceMessage('voice-mode:editor-context-changed', event, data ?? {}, {
      sessionId: true,
    })) return;
    if (activeVoiceSession!.sessionId !== data.sessionId) return;
    if (!activeVoiceSession!.poc.isConnected()) return;

    if (data.filePath) {
      // Extract just the filename for the voice agent (full paths are noisy for speech)
      const fileName = data.filePath.split('/').pop() || data.filePath;
      activeVoiceSession!.poc.injectContext(
        `[INTERNAL: User is now viewing ${fileName}]`
      );
    }
  });

  /**
   * Interactive prompt notification from the renderer.
   * When a pending prompt appears (AskUserQuestion, ExitPlanMode, etc.),
   * the renderer forwards it here so we can inject it into the voice agent's
   * conversation and let the user respond verbally.
   */
  ipcMain.on('voice-mode:interactive-prompt', (event, data: {
    sessionId: string;
    promptId: string;
    promptType: string;
    description: string;
    workspacePath?: string;
    generation?: number;
  }) => {
    console.log('[VoiceModeService] interactive-prompt IPC received:', {
      promptId: data?.promptId,
      promptType: data?.promptType,
      hasActiveSession: !!activeVoiceSession,
      isConnected: activeVoiceSession?.poc?.isConnected() ?? false,
      descriptionLength: data?.description?.length ?? 0,
    });

    // This wakes the singleton conversation and speaks `description`, so an
    // unauthorized caller reaches the user's ears with text of its choosing
    // and leaves a promptId the controller will later try to answer.
    const verdict = authorizeVoiceMessage('voice-mode:interactive-prompt', event, data ?? {}, {
      sessionId: true,
      promptId: true,
    });
    if (!verdict?.sessionId) return;
    const session = activeVoiceSession!;
    runAuthorizedSessionWork(
      'voice-mode:interactive-prompt',
      { sessionId: verdict.sessionId, workspacePath: verdict.workspacePath, generation: session.generation },
      () => {
        void deliverInteractivePromptTo(session, {
          promptId: data.promptId,
          promptType: data.promptType,
          description: data.description,
          sourceSessionId: verdict.sessionId!,
        });
      },
    );
  });

  console.log('[VoiceModeService] Test handlers initialized');
}
