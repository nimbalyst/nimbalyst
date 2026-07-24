/** Main-owned IPC and personal-sync bridge for tracker personal state. */

import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import type { SyncedTrackerPersonalStateChange } from '@nimbalyst/runtime/sync';
import { getDatabase } from '../database/initialize';
import { createTrackerPersonalStateStore, type TrackerPersonalStateRow, type TrackerPersonalStateStore } from '../services/TrackerPersonalStateStore';
import { getCurrentIdentity } from '../services/TrackerIdentityService';
import { getSyncProvider } from '../services/SyncManager';
import { resolveTrackerProjectScope } from '../services/TrackerProjectScope';
import { safeHandle } from '../utils/ipcRegistry';

const logger = log.scope('TrackerPersonalStateHandlers');

interface IPCResponse<T> { success: boolean; data?: T; error?: string }

let cachedStore: TrackerPersonalStateStore | null = null;

function getStore(): TrackerPersonalStateStore {
  if (cachedStore) return cachedStore;
  const db = getDatabase();
  if (!db) throw new Error('Database not initialized');
  cachedStore = createTrackerPersonalStateStore(db);
  return cachedStore;
}

function resolveUserEmail(workspacePath?: string): string {
  try { return getCurrentIdentity(workspacePath).email ?? ''; }
  catch { return ''; }
}

function fail(error: unknown): IPCResponse<never> {
  return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
}

function pushPersonalState(change: SyncedTrackerPersonalStateChange): void {
  const provider = getSyncProvider();
  if (!provider?.syncTrackerPersonalState) return;
  provider.syncTrackerPersonalState(change).catch((error) => {
    logger.debug('tracker personal-state sync push failed', { error });
  });
}

function notifyRenderers(row: TrackerPersonalStateRow): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('tracker-personal-state:remote-updated', row);
  }
}

export async function applyRemoteTrackerPersonalState(change: SyncedTrackerPersonalStateChange): Promise<void> {
  try {
    const userEmail = resolveUserEmail();
    const row = change.kind === 'favorite'
      ? await getStore().setFavorite({
          userEmail,
          scope: change.scope,
          itemId: change.itemId,
          isFavorite: change.isFavorite,
          favoriteUpdatedAt: change.favoriteUpdatedAt,
        })
      : await getStore().recordOpened({
          userEmail,
          scope: change.scope,
          itemId: change.itemId,
          lastOpenedAt: change.lastOpenedAt,
        });
    if (row) notifyRenderers(row);
  } catch (error) {
    logger.error('applyRemoteTrackerPersonalState failed', { error });
  }
}

export function registerTrackerPersonalStateHandlers(): void {
  safeHandle('tracker-personal-state:get-for-scope', async (_event, workspacePath?: string): Promise<IPCResponse<{
    scope: string;
    rows: TrackerPersonalStateRow[];
  }>> => {
    if (!workspacePath) return { success: false, error: 'workspacePath required' };
    try {
      const { scope } = await resolveTrackerProjectScope(workspacePath);
      return {
        success: true,
        data: { scope, rows: await getStore().getForScope(resolveUserEmail(workspacePath), scope) },
      };
    } catch (error) { return fail(error); }
  });

  safeHandle('tracker-personal-state:set-favorite', async (_event, input: {
    itemId: string; isFavorite: boolean; favoriteUpdatedAt: number;
  }, workspacePath?: string): Promise<IPCResponse<TrackerPersonalStateRow | null>> => {
    if (!workspacePath || !input?.itemId || !Number.isFinite(input.favoriteUpdatedAt)) {
      return { success: false, error: 'workspacePath, itemId and favoriteUpdatedAt required' };
    }
    try {
      const projectScope = await resolveTrackerProjectScope(workspacePath);
      const row = await getStore().setFavorite({
        ...input,
        scope: projectScope.scope,
        userEmail: resolveUserEmail(workspacePath),
      });
      if (row && projectScope.syncable) pushPersonalState({
        kind: 'favorite', scope: row.scope, itemId: row.itemId,
        isFavorite: row.isFavorite, favoriteUpdatedAt: row.favoriteUpdatedAt, updatedAt: row.updatedAt,
      });
      return { success: true, data: row };
    } catch (error) { return fail(error); }
  });

  safeHandle('tracker-personal-state:record-opened', async (_event, input: {
    itemId: string; lastOpenedAt: number;
  }, workspacePath?: string): Promise<IPCResponse<TrackerPersonalStateRow | null>> => {
    if (!workspacePath || !input?.itemId || !Number.isFinite(input.lastOpenedAt)) {
      return { success: false, error: 'workspacePath, itemId and lastOpenedAt required' };
    }
    try {
      const projectScope = await resolveTrackerProjectScope(workspacePath);
      const row = await getStore().recordOpened({
        ...input,
        scope: projectScope.scope,
        userEmail: resolveUserEmail(workspacePath),
      });
      if (row && projectScope.syncable) pushPersonalState({
        kind: 'opened', scope: row.scope, itemId: row.itemId,
        lastOpenedAt: row.lastOpenedAt!, updatedAt: row.updatedAt,
      });
      return { success: true, data: row };
    } catch (error) { return fail(error); }
  });

  // Snooze is deliberately local-only: it is a transient triage deferral, and
  // pushing it would mean a new kind on the personal-sync wire protocol that the
  // mobile client would have to understand. Revisit if inbox triage moves to
  // mobile.
  safeHandle('tracker-personal-state:set-snooze', async (_event, input: {
    itemId: string; snoozedUntil: number | null;
  }, workspacePath?: string): Promise<IPCResponse<TrackerPersonalStateRow | null>> => {
    if (!workspacePath || !input?.itemId) {
      return { success: false, error: 'workspacePath and itemId required' };
    }
    if (input.snoozedUntil !== null && !Number.isFinite(input.snoozedUntil)) {
      return { success: false, error: 'snoozedUntil must be a timestamp or null' };
    }
    try {
      const projectScope = await resolveTrackerProjectScope(workspacePath);
      const row = await getStore().setSnooze({
        itemId: input.itemId,
        snoozedUntil: input.snoozedUntil,
        scope: projectScope.scope,
        userEmail: resolveUserEmail(workspacePath),
        updatedAt: Date.now(),
      });
      return { success: true, data: row };
    } catch (error) { return fail(error); }
  });

  logger.info('Tracker personal-state IPC handlers registered');
}
