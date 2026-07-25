/**
 * Live data + navigation seam for session reference chips.
 *
 * A transcript may reference another AI session by its id — inside a
 * cross-session tool call (`send_prompt`, `spawn_session`, …) or as a bare
 * UUID in prose. `SessionReferenceChip` resolves the session's live title +
 * phase from this cross-platform atom and opens it on click.
 *
 * The atom is populated by the platform host (the Electron renderer mirrors its
 * `sessionRegistryAtom` here; mobile can populate it later). Because the chip
 * reads the atom reactively, renaming a session or advancing its phase updates
 * every chip with no transcript edit. This mirrors the tracker-reference chip
 * architecture (`trackerReferenceData.ts`).
 *
 * Navigation is dispatched via a window CustomEvent the host already listens
 * for (`open-ai-session`), so the chip depends only on runtime state, not on
 * renderer/IPC code.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

/** The minimal live data a session chip needs to render. */
export interface SessionRefMeta {
  id: string;
  /** Human-readable session title. */
  title: string;
  /** Kanban phase (planning/implementing/validating/complete). */
  phase?: string;
  /** Provider id (claude-code, openai-codex, …) for an optional glyph. */
  provider?: string;
  /** True while the session is actively producing output. */
  isProcessing?: boolean;
  /** True when the session is blocked on an interactive prompt. */
  isAwaitingInput?: boolean;
}

/**
 * All known sessions keyed by id. Host adapters populate this atom; session
 * chips read from it.
 */
export const sessionRefMapAtom = atom<Map<string, SessionRefMeta>>(new Map());

/**
 * A single session's live meta by id, or null when unknown (not yet loaded /
 * different workspace). Reactive: only re-renders when that id changes.
 */
export const sessionRefByIdAtom = atomFamily((id: string) =>
  atom((get) => get(sessionRefMapAtom).get(id) ?? null),
);

/**
 * Ask the host to open a session by id. The Electron renderer listens for this
 * event in `App.tsx` (`handleOpenAiSession`). `workspacePath` is only needed to
 * seed a draft input, so opening an existing session works without it.
 */
export function openSessionReference(sessionId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('open-ai-session', { detail: { sessionId } }),
  );
}
