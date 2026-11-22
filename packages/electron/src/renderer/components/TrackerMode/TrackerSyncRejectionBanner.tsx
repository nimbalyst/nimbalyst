/**
 * TrackerSyncRejectionBanner
 *
 * Surfaces tracker-sync mutation rejections that would otherwise silently
 * roll back a user edit. The banner sits above `TrackerMainView` and
 * subscribes to `trackerSyncRejectionAtom`, which is populated by
 * `trackerSyncListeners` on `tracker-sync:mutation-rejected` events.
 *
 * States, distinct affordances:
 * - `custodyUnavailable`: the server could not load the team DEK -- the
 *   organization's encryption was never migrated to server-managed
 *   custody, so writes are refused. Persistent until dismissed.
 * - `recoveryConflict`: an edit queued before organization recovery was
 *   refused so it cannot overwrite restored content. It stays in local
 *   transaction history, not in the item. Persistent until dismissed.
 * - `rotationLocked` (legacy, old servers only): team is mid-rotation;
 *   writes will resume in a moment. Auto-clears 30s after the last event.
 * - `staleKeyEpoch` (legacy, old servers only) with `refreshKey -> null`:
 *   the user's admin hasn't shared the new envelope yet. Persistent until
 *   cleared; "Retry" triggers `tracker-sync:connect` which re-fetches the
 *   org key.
 *
 * It also surfaces a `drainHold` (`trackerSyncDrainHoldAtom`), which is not a
 * rejection: nothing was refused and no edit rolled back. The socket is
 * `connected` and the CLIENT declined to push, because it could not resolve the
 * tracker's sharing policy and would otherwise have deleted previously shared
 * items from the room on a guess (NIM-2968). It shares this banner because the
 * user-visible consequence is identical -- your changes are not reaching your
 * team -- and it self-clears on the next drain that completes.
 *
 * No button-gating: the mutation surface stays available so the user
 * can keep trying. The banner itself is the explanation for any
 * subsequent silent rollback.
 */

import React, { useCallback, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { trackerSyncDrainHoldAtom, trackerSyncRejectionAtom } from '../../store/atoms/trackerSync';

interface TrackerSyncRejectionBannerProps {
  workspacePath?: string;
}

export const TrackerSyncRejectionBanner: React.FC<TrackerSyncRejectionBannerProps> = ({ workspacePath }) => {
  const state = useAtomValue(trackerSyncRejectionAtom);
  const setRejection = useSetAtom(trackerSyncRejectionAtom);
  const drainHoldState = useAtomValue(trackerSyncDrainHoldAtom);

  const drainHold = drainHoldState
    && (!workspacePath || drainHoldState.workspacePath === workspacePath)
    ? drainHoldState
    : null;

  // Filter to this workspace -- the listener stores rejections globally
  // (mutation-rejected is broadcast to all windows). A user with multiple
  // workspaces open shouldn't see a peer workspace's banner.
  const active = useMemo(() => {
    const candidates = [state.custodyUnavailable, state.recoveryConflict, state.staleKeyEpoch, state.rotationLocked].filter(
      (r): r is NonNullable<typeof r> => r != null && (!workspacePath || r.workspacePath === workspacePath),
    );
    if (candidates.length === 0) return null;
    // Priority: custodyUnavailable and staleKeyEpoch need explicit user
    // action and won't disappear on their own; rotationLocked auto-clears.
    const custody = candidates.find((r) => r.code === 'custodyUnavailable');
    if (custody) return custody;
    const recovery = candidates.find((r) => r.code === 'recoveryConflict');
    if (recovery) return recovery;
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

  // A hold means nothing is syncing at all, which outranks a per-item
  // rejection. Not dismissible: it is a live state, not a past event, and it
  // clears itself as soon as a drain completes.
  if (drainHold) {
    return (
      <div
        className="tracker-sync-rejection-banner flex items-center gap-2 px-3 py-2 border-b border-nim bg-nim-tertiary text-xs text-nim shrink-0"
        role="status"
        data-testid="tracker-sync-drain-hold-banner"
        data-drain-hold-reason={drainHold.reason}
      >
        <MaterialSymbol icon="cloud_off" size={16} className="text-nim-warning" />
        <span className="flex-1">
          {drainHold.rowsHeldBack === 1
            ? "1 tracker item isn't syncing to your team yet."
            : `${drainHold.rowsHeldBack} tracker items aren't syncing to your team yet.`}
          {' '}
          Nimbalyst couldn't confirm which of your trackers are shared, so it left them alone rather than risk removing your team's copies. Reopening the project usually resolves it.
        </span>
        <button
          type="button"
          className="px-2 py-0.5 rounded border border-nim text-nim-muted hover:bg-nim hover:text-nim transition-colors"
          onClick={handleRetry}
          data-testid="tracker-sync-drain-hold-retry"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!active) return null;

  const isRotation = active.code === 'rotationLocked';
  const isCustodyUnavailable = active.code === 'custodyUnavailable';
  const isRecoveryConflict = active.code === 'recoveryConflict';

  return (
    <div
      className="tracker-sync-rejection-banner flex items-center gap-2 px-3 py-2 border-b border-nim bg-nim-tertiary text-xs text-nim shrink-0"
      role="status"
      data-testid="tracker-sync-rejection-banner"
      data-rejection-code={active.code}
    >
      {isCustodyUnavailable ? (
        <>
          <MaterialSymbol icon="key_off" size={16} className="text-nim-warning" />
          <span className="flex-1">
            This organization's encryption isn't migrated, so your changes can't sync. Ask an organization admin to finish setting up the organization.
          </span>
        </>
      ) : isRecoveryConflict ? (
        <>
          <MaterialSymbol icon="history" size={16} className="text-nim-warning" />
          <span className="flex-1">
            An edit made before this organization was recovered wasn't applied. Reopen the item and make the change again.
          </span>
        </>
      ) : isRotation ? (
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
