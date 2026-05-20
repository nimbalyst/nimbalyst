/**
 * TrackerSyncRejectionBanner
 *
 * Surfaces tracker-sync mutation rejections that would otherwise silently
 * roll back a user edit. The banner sits above `TrackerMainView` and
 * subscribes to `trackerSyncRejectionAtom`, which is populated by
 * `trackerSyncListeners` on `tracker-sync:mutation-rejected` events.
 *
 * Two states, distinct affordances:
 * - `rotationLocked`: team is mid-rotation; writes will resume in a
 *   moment. Auto-clears 30s after the last event.
 * - `staleKeyEpoch` with `refreshKey -> null`: the user's admin hasn't
 *   shared the new envelope yet. Persistent until cleared; "Retry"
 *   triggers `tracker-sync:connect` which re-fetches the org key.
 *
 * No button-gating: the mutation surface stays available so the user
 * can keep trying. The banner itself is the explanation for any
 * subsequent silent rollback.
 */

import React, { useCallback, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { trackerSyncRejectionAtom } from '../../store/atoms/trackerSync';

interface TrackerSyncRejectionBannerProps {
  workspacePath?: string;
}

export const TrackerSyncRejectionBanner: React.FC<TrackerSyncRejectionBannerProps> = ({ workspacePath }) => {
  const state = useAtomValue(trackerSyncRejectionAtom);
  const setRejection = useSetAtom(trackerSyncRejectionAtom);

  // Filter to this workspace -- the listener stores rejections globally
  // (mutation-rejected is broadcast to all windows). A user with multiple
  // workspaces open shouldn't see a peer workspace's banner.
  const active = useMemo(() => {
    const candidates = [state.staleKeyEpoch, state.rotationLocked].filter(
      (r): r is NonNullable<typeof r> => r != null && (!workspacePath || r.workspacePath === workspacePath),
    );
    if (candidates.length === 0) return null;
    // Show the most recent. staleKeyEpoch needs explicit user action,
    // rotationLocked auto-clears -- if both are present at once,
    // staleKeyEpoch wins because it's the one that won't disappear.
    const stale = candidates.find((r) => r.code === 'staleKeyEpoch');
    if (stale) return stale;
    return candidates[0];
  }, [state, workspacePath]);

  const handleRetry = useCallback(async () => {
    if (!workspacePath) return;
    try {
      // Use generic invoke -- the typed `trackerSync` namespace is wired in
      // preload but not declared in electron.d.ts; other call sites use
      // the same pattern.
      await (window as any).electronAPI.invoke('tracker-sync:connect', { workspacePath });
    } catch (err) {
      console.error('[TrackerSyncRejectionBanner] retry failed:', err);
    }
  }, [workspacePath]);

  const handleDismiss = useCallback(() => {
    if (!active) return;
    setRejection((prev) => ({ ...prev, [active.code]: null }));
  }, [active, setRejection]);

  if (!active) return null;

  const isRotation = active.code === 'rotationLocked';

  return (
    <div
      className="tracker-sync-rejection-banner flex items-center gap-2 px-3 py-2 border-b border-nim bg-nim-tertiary text-xs text-nim shrink-0"
      role="status"
      data-testid="tracker-sync-rejection-banner"
      data-rejection-code={active.code}
    >
      {isRotation ? (
        <>
          <MaterialSymbol icon="sync" size={16} className="text-nim-faint animate-spin" />
          <span className="flex-1">
            Team key rotation in progress. Your changes will resume in a moment.
          </span>
        </>
      ) : (
        <>
          <MaterialSymbol icon="key_off" size={16} className="text-nim-warning" />
          <span className="flex-1">
            Your team's encryption key changed. Ask your team admin to share the new key envelope with you.
          </span>
          <button
            type="button"
            className="px-2 py-0.5 rounded border border-nim text-nim-muted hover:bg-nim hover:text-nim transition-colors"
            onClick={handleRetry}
            data-testid="tracker-sync-rejection-retry"
          >
            Check again
          </button>
        </>
      )}
      <button
        type="button"
        className="text-nim-faint hover:text-nim p-0.5"
        onClick={handleDismiss}
        aria-label="Dismiss"
        data-testid="tracker-sync-rejection-dismiss"
      >
        <MaterialSymbol icon="close" size={14} />
      </button>
    </div>
  );
};
