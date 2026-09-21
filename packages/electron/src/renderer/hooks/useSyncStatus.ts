/**
 * Sync status for the account popover and the gutter avatar.
 *
 * Fetches the snapshot once per workspace over `sync:get-status` and merges the
 * live connection bits broadcast on `sync:status-changed`. The IPC subscription
 * itself lives in store/listeners/syncListeners.ts, which owns the single
 * listener and writes `syncStatusUpdateAtom`; this hook only asks the main
 * process to start broadcasting.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';

import { syncStatusUpdateAtom } from '../store/atoms/syncStatus';
import type { SyncStatusSnapshot } from '../components/Accounts/syncStatusSummary';

/** Shape returned by the `sync:get-status` IPC handler. */
interface SyncStatusResult {
  appConfigured: boolean;
  projectEnabled: boolean;
  connected: boolean;
  syncing: boolean;
  error: string | null;
  skippedRowCount?: number;
  stats?: { sessionCount: number; lastSyncedAt: number | null };
}

const INITIAL: SyncStatusSnapshot = {
  appConfigured: false,
  projectEnabled: false,
  connected: false,
  syncing: false,
  error: null,
  lastSyncedAt: null,
};

export function useSyncStatus(workspacePath?: string): SyncStatusSnapshot {
  const [status, setStatus] = useState<SyncStatusSnapshot>(INITIAL);

  const fetchStatus = useCallback(async () => {
    try {
      // Optional: the gutter also mounts where the sync IPC surface isn't
      // present, and a missing status is "nothing to report", not a failure.
      const result: SyncStatusResult | null | undefined = await window.electronAPI?.invoke(
        'sync:get-status',
        workspacePath,
      );
      if (!result) return;
      setStatus({
        appConfigured: result.appConfigured,
        projectEnabled: result.projectEnabled,
        connected: result.connected,
        syncing: result.syncing,
        error: result.error,
        skippedRowCount: result.skippedRowCount,
        lastSyncedAt: result.stats?.lastSyncedAt ?? null,
      });
    } catch (error) {
      console.error('[useSyncStatus] Failed to fetch sync status:', error);
    }
  }, [workspacePath]);

  useEffect(() => {
    void fetchStatus();
    void window.electronAPI?.invoke('sync:subscribe-status');
  }, [fetchStatus]);

  const update = useAtomValue(syncStatusUpdateAtom);
  useEffect(() => {
    if (!update) return;
    setStatus((prev) => ({
      ...prev,
      connected: update.connected,
      syncing: update.syncing,
      error: update.error,
      skippedRowCount: update.skippedRowCount,
    }));
  }, [update]);

  return status;
}
