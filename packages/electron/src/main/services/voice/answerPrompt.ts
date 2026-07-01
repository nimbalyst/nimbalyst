/**
 * Answer a session's pending interactive prompt by voice.
 *
 * Used by BOTH the local desktop voice agent and the mobile voice-tool proxy
 * (mobileVoiceToolHandler). The voice model hears the pending question (surfaced
 * by the session summary) and speaks an answer; this maps that natural-language
 * answer onto the structured prompt response and resolves it through the EXACT
 * same path mobile uses for an in-app answer (`resolveVoicePromptResponse`).
 *
 * Supported prompt types (the canonical `interactive_prompt` shapes):
 *  - ask_user_question  -> match the answer to an option label, or free text
 *  - permission_request -> yes/no -> allow/deny (once)
 *  - git_commit_proposal -> yes/no -> commit/cancel
 */

import type { BrowserWindow } from 'electron';
import { loadVoiceSession } from './voiceSessionLoader';
import {
  resolveVoicePromptResponse,
  type PromptResponsePayload,
} from '../ai/MobileSessionControlHandler';

export interface VoiceAnswerResult {
  success: boolean;
  /** Agent-facing confirmation of what was answered. */
  message?: string;
  error?: string;
}

/** Interpret a spoken yes/no-ish answer. Returns true/false, or null if unclear. */
function interpretAffirmative(text: string): boolean | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (/\b(yes|yeah|yep|yup|sure|ok|okay|approve|approved|allow|accept|confirm|go ahead|do it|proceed|sounds good|please do)\b/.test(t)) {
    return true;
  }
  if (/\b(no|nope|deny|denied|don'?t|do not|reject|decline|cancel|stop|never mind|nevermind)\b/.test(t)) {
    return false;
  }
  return null;
}

/** Pick the option label that best matches the spoken answer, or null. */
function matchOption(options: Array<{ label?: string }> | undefined, answer: string): string | null {
  if (!Array.isArray(options) || options.length === 0) return null;
  const labels = options.map((o) => o?.label).filter((l): l is string => typeof l === 'string' && l.length > 0);
  const a = answer.trim().toLowerCase();
  if (!a) return null;
  // Exact (case-insensitive) first, then containment either direction.
  const exact = labels.find((l) => l.toLowerCase() === a);
  if (exact) return exact;
  const contains = labels.find((l) => a.includes(l.toLowerCase()) || l.toLowerCase().includes(a));
  return contains ?? null;
}

/**
 * Map a pending canonical prompt + a spoken answer into a response payload.
 * Returns an `{ error }` for shapes we can't safely answer by voice.
 */
function buildResponsePayload(
  prompt: any,
  answer: string,
): { payload: PromptResponsePayload; describe: string } | { error: string } {
  const promptId: string = prompt?.requestId;
  if (!promptId) return { error: 'This prompt is missing an id and cannot be answered by voice.' };

  switch (prompt.promptType) {
    case 'ask_user_question': {
      const questions = Array.isArray(prompt.questions) ? prompt.questions : [];
      if (questions.length === 0) return { error: 'There is no question to answer.' };
      if (questions.length > 1) {
        // A single spoken answer can't be reliably split across multiple
        // distinct questions; ask the user to answer this one in the app.
        return {
          error: 'This prompt has multiple questions; please answer it in the Nimbalyst app.',
        };
      }
      const q = questions[0];
      const header = typeof q?.header === 'string' && q.header ? q.header : 'answer';
      const matched = matchOption(q?.options, answer);
      const value = matched ?? answer.trim();
      return {
        payload: {
          promptType: 'ask_user_question',
          promptId,
          response: { answers: { [header]: value } },
        },
        describe: `Answered "${header}" with "${value}".`,
      };
    }

    case 'permission_request': {
      const decision = interpretAffirmative(answer);
      if (decision === null) {
        return { error: 'Could not tell whether to allow or deny. Please say yes or no.' };
      }
      const tool = typeof prompt.toolName === 'string' ? prompt.toolName : 'the tool';
      return {
        payload: {
          promptType: 'tool_permission',
          promptId,
          response: { decision: decision ? 'allow' : 'deny', scope: 'once' },
        },
        describe: decision ? `Allowed ${tool} to run once.` : `Denied permission to run ${tool}.`,
      };
    }

    case 'git_commit_proposal': {
      const decision = interpretAffirmative(answer);
      if (decision === null) {
        return { error: 'Could not tell whether to commit. Please say yes or no.' };
      }
      return {
        payload: {
          promptType: 'git_commit',
          promptId,
          response: decision ? { action: 'committed' } : { action: 'cancelled' },
        },
        describe: decision ? 'Approved the commit.' : 'Cancelled the commit.',
      };
    }

    default:
      return { error: `This prompt type (${prompt.promptType}) can't be answered by voice yet.` };
  }
}

/**
 * Answer the most recent pending interactive prompt for a session.
 * @param workspacePath The workspace the session belongs to.
 * @param sessionId     The session (id or title) to answer a prompt in.
 * @param answer        The user's spoken answer.
 * @param preferredWindow Optional window to use directly (the active voice window).
 */
export async function answerSessionPromptForVoice(
  workspacePath: string,
  sessionId: string,
  answer: string,
  preferredWindow?: BrowserWindow,
): Promise<VoiceAnswerResult> {
  if (!answer || !answer.trim()) {
    return { success: false, error: 'No answer was provided.' };
  }

  const loaded = await loadVoiceSession(workspacePath, sessionId, preferredWindow);
  if ('error' in loaded) {
    return { success: false, error: loaded.error };
  }

  const messages = (loaded.session.messages || []) as Array<any>;
  const pending = messages.filter(
    (m) => m.type === 'interactive_prompt' && m.interactivePrompt?.status === 'pending',
  );
  if (pending.length === 0) {
    return { success: false, error: 'This session is not waiting on any question right now.' };
  }

  // The most recent pending prompt is the one the user is responding to.
  const prompt = pending[pending.length - 1].interactivePrompt;
  const built = buildResponsePayload(prompt, answer);
  if ('error' in built) {
    return { success: false, error: built.error };
  }

  resolveVoicePromptResponse(loaded.sessionId, built.payload);
  return { success: true, message: built.describe };
}
