/**
 * useAIInputUndo
 *
 * React hook around aiInputHistoryAtom that exposes a small reducer-style API
 * for AIInput to push snapshots and walk undo/redo.
 *
 * The hook is purely a state container -- it does NOT touch the textarea or
 * the draft atoms. Callers are responsible for:
 *   - Capturing a snapshot of the *previous* state before mutating draft atoms
 *   - Calling pushSnapshot with that snapshot
 *   - Applying the restored snapshot returned by undo()/redo() to the
 *     draft atoms and textarea cursor.
 */

import { useAtom } from 'jotai';
import { useCallback, useRef, useEffect } from 'react';
import {
  aiInputHistoryAtom,
  applyClear,
  applyPush,
  applyRedo,
  applyUndo,
  type AIInputHistory,
  type AIInputSnapshot,
  type PushOptions,
} from '../store/atoms/aiInputUndo';

export interface UseAIInputUndo {
  pushSnapshot: (snapshot: AIInputSnapshot, opts?: PushOptions) => void;
  undo: (current: AIInputSnapshot) => AIInputSnapshot | null;
  redo: (current: AIInputSnapshot) => AIInputSnapshot | null;
  clear: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Read the current undo counter without subscribing to it. AIInput captures
   * this when starting a paste's attachment-processing IPC. If undo() has
   * advanced the counter by the time the IPC resolves, the user undid past
   * the paste -- drop the result instead of silently re-adding the
   * attachment.
   */
  getUndoCount: () => number;
}

export function useAIInputUndo(sessionId: string | undefined): UseAIInputUndo {
  // sessionId can be undefined briefly during session bootstrap; key on a
  // sentinel string so the atom family still returns something usable.
  const key = sessionId || '__pending__';
  const [history, setHistory] = useAtom(aiInputHistoryAtom(key));

  // Mirror of history kept in a ref so callbacks can read current undoCount
  // without re-subscribing or going stale.
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const pushSnapshot = useCallback(
    (snapshot: AIInputSnapshot, opts?: PushOptions): void => {
      setHistory((prev: AIInputHistory) => applyPush(prev, snapshot, opts));
    },
    [setHistory]
  );

  const undo = useCallback(
    (current: AIInputSnapshot): AIInputSnapshot | null => {
      let restored: AIInputSnapshot | null = null;
      setHistory((prev: AIInputHistory) => {
        const result = applyUndo(prev, current);
        restored = result.restored;
        return result.history;
      });
      return restored;
    },
    [setHistory]
  );

  const redo = useCallback(
    (current: AIInputSnapshot): AIInputSnapshot | null => {
      let restored: AIInputSnapshot | null = null;
      setHistory((prev: AIInputHistory) => {
        const result = applyRedo(prev, current);
        restored = result.restored;
        return result.history;
      });
      return restored;
    },
    [setHistory]
  );

  const clear = useCallback(() => {
    setHistory((prev: AIInputHistory) => applyClear(prev));
  }, [setHistory]);

  const getUndoCount = useCallback(() => historyRef.current.undoCount, []);

  return {
    pushSnapshot,
    undo,
    redo,
    clear,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    getUndoCount,
  };
}
