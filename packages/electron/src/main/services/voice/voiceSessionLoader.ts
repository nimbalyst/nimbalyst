/**
 * Shared loader for the canonical transcript of a session, for voice tools.
 *
 * Both the session summary and the answer-a-prompt tool need the same thing: the
 * loaded session (TranscriptViewMessage[]) for a session that the voice model
 * may have referenced by id OR by title. This centralizes the window lookup, the
 * `ai:loadSession` call, and the title fallback so both paths behave identically.
 */

import type { BrowserWindow } from 'electron';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { findWindowByWorkspace } from '../../window/WindowManager';

export interface LoadedVoiceSession {
  /** The resolved session id (may differ from the input when a title was passed). */
  sessionId: string;
  /** The loaded session object with `messages` (TranscriptViewMessage[]). */
  session: any;
}

/**
 * Load a session's canonical transcript through the renderer that owns the
 * workspace. Resolves a value that may be an id OR a title.
 * @returns the loaded session, or an `{ error }` describing why it couldn't load.
 */
export async function loadVoiceSession(
  workspacePath: string,
  idOrTitle: string,
  preferredWindow?: BrowserWindow,
): Promise<LoadedVoiceSession | { error: string }> {
  const window = preferredWindow ?? findWindowByWorkspace(workspacePath);
  if (!window || window.isDestroyed()) {
    return { error: 'The desktop workspace for this session is not open.' };
  }

  const loadSession = async (id: string): Promise<any> =>
    window.webContents.executeJavaScript(`
      window.electronAPI.invoke('ai:loadSession', ${JSON.stringify(id)}, ${JSON.stringify(workspacePath)}, false)
    `);

  try {
    let resolvedId = idOrTitle;
    let session = await loadSession(idOrTitle);

    // The voice model sometimes hands us a session TITLE instead of its id (it
    // surfaces both via list_sessions and occasionally passes the wrong field).
    // Fall back to resolving the value as a title before giving up.
    if (!session) {
      const resolved = await resolveSessionIdFromTitle(workspacePath, idOrTitle);
      if (resolved && resolved !== idOrTitle) {
        resolvedId = resolved;
        session = await loadSession(resolved);
      }
    }

    if (!session) {
      return { error: 'Session not found' };
    }
    return { sessionId: resolvedId, session };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolve a session id from a value that may actually be a session title.
 * Returns the id of the exact (case-insensitive) title match, or undefined.
 */
async function resolveSessionIdFromTitle(
  workspacePath: string,
  value: string,
): Promise<string | undefined> {
  const needle = value.trim().toLowerCase();
  if (!needle) return undefined;
  try {
    const all = await AISessionsRepository.list(workspacePath);
    const exact = all.find((s) => (s.title || '').trim().toLowerCase() === needle);
    if (exact) return exact.id;
  } catch {
    // Best-effort fallback only.
  }
  return undefined;
}
