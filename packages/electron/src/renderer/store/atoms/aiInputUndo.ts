/**
 * AIInput Undo/Redo Stack
 *
 * Per-session in-memory history of the AI chat input's full state
 * (text + attachments + cursor). Lets the user Cmd+Z / Cmd+Shift+Z back
 * through typing, image pastes, large-text-as-attachment pastes, file/session
 * drag-drops, typeahead mention insertions, attachment removals,
 * "convert attachment to text", and history-recall navigation.
 *
 * Pattern: callers push a snapshot of the *previous* state BEFORE applying a
 * mutation. Undo pops the latest from `past` and applies it to the live
 * draft atoms; the (now-displaced) state is moved into `future`.
 *
 * Coalescing (typing only): the first keystroke of a burst records its
 * pre-edit snapshot; subsequent keystrokes within COALESCE_WINDOW_MS drop
 * (their pre-state is already captured by the burst's first entry). Boundary
 * events (paste, drop, typeahead, etc.) always record and end any active
 * typing burst.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';

export interface AIInputSnapshot {
  value: string;
  attachments: ChatAttachment[];
  cursorStart: number;
  cursorEnd: number;
}

export interface AIInputHistory {
  past: AIInputSnapshot[];
  future: AIInputSnapshot[];
  /**
   * Wall-clock ms of the start of the current typing burst. 0 means no
   * active burst (any next typing push will record). Boundary pushes always
   * reset this to 0 so post-boundary typing records cleanly.
   */
  burstStartedAt: number;
  /**
   * Monotonic counter incremented on every undo() call. AIInput captures
   * this at the start of an attachment paste. When the (long-running)
   * attachment:save IPC resolves, if undoCount has advanced past the
   * captured value, the user undid past the paste -- drop the result
   * instead of silently re-adding the attachment.
   */
  undoCount: number;
}

const EMPTY_HISTORY: AIInputHistory = {
  past: [],
  future: [],
  burstStartedAt: 0,
  undoCount: 0,
};

export const aiInputHistoryAtom = atomFamily((_sessionId: string) =>
  atom<AIInputHistory>(EMPTY_HISTORY)
);

export const MAX_HISTORY = 100;
export const COALESCE_WINDOW_MS = 600;

export interface PushOptions {
  boundary?: boolean;
  now?: number;
}

function recordSnapshot(
  history: AIInputHistory,
  snapshot: AIInputSnapshot,
  burstStartedAt: number
): AIInputHistory {
  const past = [...history.past, snapshot];
  if (past.length > MAX_HISTORY) {
    past.splice(0, past.length - MAX_HISTORY);
  }
  return {
    past,
    future: [],
    burstStartedAt,
    undoCount: history.undoCount,
  };
}

export function applyPush(
  history: AIInputHistory,
  snapshot: AIInputSnapshot,
  opts: PushOptions = {}
): AIInputHistory {
  const now = opts.now ?? Date.now();
  const boundary = opts.boundary ?? false;

  if (boundary) {
    // Always record; end any active typing burst so the next typing push
    // starts a fresh undo entry.
    return recordSnapshot(history, snapshot, 0);
  }

  // Typing push: coalesce if a burst is active and we're still inside the
  // window. Drop the snapshot but slide the burst window forward so the burst
  // stays alive as long as the user keeps typing.
  if (
    history.burstStartedAt > 0 &&
    now - history.burstStartedAt < COALESCE_WINDOW_MS
  ) {
    return { ...history, burstStartedAt: now };
  }

  // First keystroke of a new burst: record the pre-edit snapshot and start
  // the burst window.
  return recordSnapshot(history, snapshot, now);
}

export function applyUndo(
  history: AIInputHistory,
  current: AIInputSnapshot
): { history: AIInputHistory; restored: AIInputSnapshot | null } {
  if (history.past.length === 0) {
    return { history, restored: null };
  }
  const restored = history.past[history.past.length - 1];
  const past = history.past.slice(0, -1);
  const future = [current, ...history.future];
  return {
    history: {
      past,
      future,
      burstStartedAt: 0,
      undoCount: history.undoCount + 1,
    },
    restored,
  };
}

export function applyRedo(
  history: AIInputHistory,
  current: AIInputSnapshot
): { history: AIInputHistory; restored: AIInputSnapshot | null } {
  if (history.future.length === 0) {
    return { history, restored: null };
  }
  const restored = history.future[0];
  const future = history.future.slice(1);
  const past = [...history.past, current];
  if (past.length > MAX_HISTORY) {
    past.splice(0, past.length - MAX_HISTORY);
  }
  return {
    history: {
      past,
      future,
      burstStartedAt: 0,
      undoCount: history.undoCount,
    },
    restored,
  };
}

export function applyClear(history: AIInputHistory): AIInputHistory {
  if (history.past.length === 0 && history.future.length === 0) return history;
  return {
    past: [],
    future: [],
    burstStartedAt: 0,
    undoCount: history.undoCount,
  };
}

/**
 * Action atom: clear the undo history for a specific session. Used by
 * submit/queue/clear paths in SessionTranscript so a sent message becomes a
 * hard boundary -- Cmd+Z after Send is a no-op (users have ArrowUp prompt
 * history for recall).
 */
export const clearAIInputHistoryAtom = atom(
  null,
  (get, set, sessionId: string) => {
    set(aiInputHistoryAtom(sessionId), (prev) => applyClear(prev));
  }
);
