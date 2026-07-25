/**
 * Shared voice session summary (by session id).
 *
 * Used by BOTH the local desktop voice agent (VoiceModeService.getSessionSummary)
 * and the mobile voice-tool proxy (mobileVoiceToolHandler), so the iOS agent can
 * summarize ANY session the desktop knows about -- including ones surfaced by the
 * desktop-backed semantic list_sessions that don't exist in the phone's local DB.
 *
 * The canonical transcript lives in ai_transcript_events and is assembled by the
 * renderer; we load it via the existing `ai:loadSession` IPC (the same path the
 * desktop summary already used) for whichever window owns the workspace.
 */

import type { BrowserWindow } from 'electron';
import { loadVoiceSession } from './voiceSessionLoader';
import {
  appendPendingPromptSection,
  collectPendingPromptDescriptionsFromTranscript,
} from '../sessionSummaryPrompt';

export interface VoiceSessionSummary {
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
    /** The most recent agent message with text (full final notes/instructions). */
    lastAgentMessage?: string;
    /** Human-readable descriptions of prompts the session is waiting on the user to answer. */
    pendingPrompts?: string[];
  };
  error?: string;
}

/** Build the human-readable summary + details from a loaded session object. */
function buildSummary(sessionId: string, session: any): VoiceSessionSummary {
  // session.messages is TranscriptViewMessage[] from the canonical
  // ai_transcript_events table -- discriminated by `type`, not `role`.
  const messages = (session.messages || []) as Array<any>;
  const userMessages = messages.filter((m) => m.type === 'user_message');
  const assistantMessages = messages.filter((m) => m.type === 'assistant_message');
  const sessionName = session.title || session.name || 'Untitled';

  const createdAt = session.createdAt || Date.now();
  const sessionDurationMinutes = Math.round((Date.now() - createdAt) / 60000);

  const recentTopics = userMessages
    .slice(-5)
    .map((m) => {
      const text = typeof m.text === 'string' ? m.text : '';
      return text.length > 80 ? text.substring(0, 80) + '...' : text;
    })
    .filter((t: string) => t.trim().length > 0);

  // Prompts the session is blocked on, awaiting the user. These are the most
  // actionable thing in a summary -- the user may have started the voice agent
  // specifically to deal with an existing session that's stuck on a question.
  const pendingPrompts = collectPendingPromptDescriptionsFromTranscript(messages);

  const conversationEvents = messages.filter(
    (m) => m.type === 'user_message' || m.type === 'assistant_message',
  );

  // The most recent agent message is the single most important thing to surface
  // -- it's where the coding agent leaves its final notes, results, or
  // instructions. It must NOT be lost to the conversation-tail's per-line
  // truncation, nor dropped when the final turn ended on tool calls (an
  // assistant_message with empty text). So pick the last assistant_message that
  // actually has text, and include it in full (generously bounded) and up front.
  const lastAgentMessageRaw = [...assistantMessages]
    .reverse()
    .map((m) => (typeof m.text === 'string' ? m.text.trim() : ''))
    .find((t) => t.length > 0);
  const lastAgentMessage = lastAgentMessageRaw
    ? lastAgentMessageRaw.length > 1500
      ? lastAgentMessageRaw.substring(0, 1500) + '...'
      : lastAgentMessageRaw
    : undefined;

  const conversationTail = conversationEvents
    .slice(-8)
    .map((m) => {
      const role = m.type === 'user_message' ? 'User' : 'Agent';
      const text = typeof m.text === 'string' ? m.text : '';
      if (!text.trim()) return null;
      const truncated = text.length > 400 ? text.substring(0, 400) + '...' : text;
      return `${role}: ${truncated}`;
    })
    .filter(Boolean) as string[];

  const summaryParts: string[] = [];
  summaryParts.push(
    `Session "${sessionName}" has ${userMessages.length} user messages and ${assistantMessages.length} assistant responses over ${sessionDurationMinutes} minutes.`,
  );
  if (recentTopics.length > 0) {
    summaryParts.push(`Recent topics: ${recentTopics.join('; ')}`);
  } else if (conversationEvents.length === 0) {
    summaryParts.push('No messages yet.');
  }
  if (lastAgentMessage) {
    summaryParts.push(`Most recent agent message:\n${lastAgentMessage}`);
  }
  if (conversationTail.length > 0) {
    summaryParts.push(`Recent conversation:\n${conversationTail.join('\n')}`);
  }

  return {
    success: true,
    summary: appendPendingPromptSection(summaryParts.join('\n\n'), pendingPrompts),
    details: {
      sessionId,
      sessionName,
      messageCount: conversationEvents.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      sessionDurationMinutes,
      recentTopics,
      lastAgentMessage,
      pendingPrompts: pendingPrompts.length > 0 ? pendingPrompts : undefined,
    },
  };
}

/**
 * Summarize a session by id within a workspace, loading its canonical transcript
 * through the renderer that owns the workspace.
 * @param workspacePath The workspace the session belongs to.
 * @param sessionId The session to summarize.
 * @param preferredWindow Optional window to use directly (the active voice window).
 */
export async function getSessionSummaryForVoice(
  workspacePath: string,
  sessionId: string,
  preferredWindow?: BrowserWindow,
): Promise<VoiceSessionSummary> {
  const loaded = await loadVoiceSession(workspacePath, sessionId, preferredWindow);
  if ('error' in loaded) {
    return { success: false, error: loaded.error };
  }
  return buildSummary(loaded.sessionId, loaded.session);
}
