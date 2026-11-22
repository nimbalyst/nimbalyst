/**
 * WakeupHandlers - IPC handlers for session wakeups (scheduled re-invocations).
 *
 * Channels:
 * - wakeup:list-active   (workspacePath?) -> active wakeups (pending/overdue/waiting_for_workspace),
 *                                            scoped to workspace if provided.
 * - wakeup:cancel        (id) -> updated row or null.
 * - wakeup:run-now       (id) -> updated row or null. Sets fire_at to now and re-arms.
 * - wakeup:set-usage-limit-auto-resume (enabled, current?) -> the resume plan, or null.
 *
 * Outbound (broadcast from scheduler / MCP tool):
 * - wakeup:changed       (row) -> sent to all renderer windows.
 */

import { ipcMain, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { getSessionWakeupsStore } from '../services/RepositoryManager';
import { SessionWakeupScheduler } from '../services/SessionWakeupScheduler';
import { setUsageLimitAutoResume } from '../services/ai/usageLimitAutoResume';

const logger = log.scope('WakeupHandlers');

export function registerWakeupHandlers(): void {
  ipcMain.handle('wakeup:list-active', async (_event, workspacePath?: string) => {
    try {
      const store = getSessionWakeupsStore();
      if (workspacePath) {
        return await store.listActiveForWorkspace(workspacePath);
      }
      // No workspace filter: return all pending + waiting_for_workspace + overdue.
      // We don't have a direct "all active" method; iterate via listPending() and
      // listWaitingForWorkspace per workspace would require knowing all workspaces.
      // For the renderer use case, callers always pass workspacePath, so this branch
      // exists only for completeness.
      return await store.listPending();
    } catch (error) {
      logger.error('wakeup:list-active failed', error);
      throw error;
    }
  });

  ipcMain.handle('wakeup:cancel', async (_event, id: string) => {
    try {
      if (!id || typeof id !== 'string') {
        throw new Error('id is required');
      }
      const updated = await SessionWakeupScheduler.getInstance().cancel(id);
      return updated;
    } catch (error) {
      logger.error('wakeup:cancel failed', error);
      throw error;
    }
  });

  ipcMain.handle('wakeup:run-now', async (_event, id: string) => {
    try {
      if (!id || typeof id !== 'string') {
        throw new Error('id is required');
      }
      const updated = await SessionWakeupScheduler.getInstance().runNow(id);
      return updated;
    } catch (error) {
      logger.error('wakeup:run-now failed', error);
      throw error;
    }
  });

  // The usage-limit card's auto-resume switch. `current` is the card's session,
  // scheduled on enable because its turn ended before the setting was on.
  ipcMain.handle('wakeup:set-usage-limit-auto-resume', async (
    _event,
    enabled: boolean,
    current?: { sessionId: string; workspacePath: string; resetsAtMs: number },
  ) => {
    try {
      if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
      return await setUsageLimitAutoResume(enabled, current);
    } catch (error) {
      logger.error('wakeup:set-usage-limit-auto-resume failed', error);
      throw error;
    }
  });

  logger.info('Wakeup IPC handlers registered');
}

/** Broadcast a wakeup change to all renderer windows. Used from main-side code paths. */
export function broadcastWakeupChanged(row: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      try {
        window.webContents.send('wakeup:changed', row);
      } catch {
        // ignore -- destroyed window
      }
    }
  }
}
