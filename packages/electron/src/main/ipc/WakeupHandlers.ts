/**
 * WakeupHandlers - IPC handlers for session wakeups (scheduled re-invocations).
 *
 * Channels:
 * - wakeup:create        ({ sessionId, workspacePath, prompt, fireAt, reason? }) -> created row.
 *                                            User-facing "Run later" creation path. Creates a
 *                                            'user' wakeup, which never replaces another one.
 * - wakeup:list-active   (workspacePath?) -> active wakeups (pending/overdue/waiting_for_workspace),
 *                                            scoped to workspace if provided.
 * - wakeup:cancel        (id) -> updated row or null.
 * - wakeup:run-now       (id) -> updated row or null. Sets fire_at to now and re-arms.
 *
 * Outbound (broadcast from scheduler / MCP tool):
 * - wakeup:changed       (row) -> sent to all renderer windows.
 * - wakeup:focus-session ({ sessionId }) -> sent when user clicks the OS notification.
 */

import { ipcMain } from 'electron';
import log from 'electron-log/main';
import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { MIN_WAKEUP_LEAD_MS } from '../../shared/sessionWakeups';
import { getSessionWakeupsStore } from '../services/RepositoryManager';
import { SessionWakeupScheduler } from '../services/SessionWakeupScheduler';
import { scheduleSessionWakeup } from '../services/sessionWakeupScheduling';

const logger = log.scope('WakeupHandlers');

export function registerWakeupHandlers(): void {
  ipcMain.handle('wakeup:create', async (_event, args: {
    sessionId?: string;
    workspacePath?: string;
    prompt?: string;
    fireAt?: number;
    reason?: string;
    attachments?: ChatAttachment[];
  }) => {
    const { sessionId, workspacePath, prompt, fireAt, reason, attachments } = args ?? {};
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('sessionId is required');
    }
    if (!workspacePath || typeof workspacePath !== 'string') {
      throw new Error('workspacePath is required');
    }
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('prompt is required and must be a non-empty string');
    }
    if (typeof fireAt !== 'number' || !Number.isFinite(fireAt)) {
      throw new Error('fireAt is required and must be a number (epoch ms)');
    }
    if (fireAt < Date.now() + MIN_WAKEUP_LEAD_MS) {
      throw new Error(`fireAt must be at least ${MIN_WAKEUP_LEAD_MS / 1000}s in the future`);
    }

    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    try {
      return await scheduleSessionWakeup({
        sessionId,
        workspaceId: workspacePath,
        prompt: prompt.trim(),
        reason: reason?.trim() || undefined,
        fireAt,
        attachments: Array.isArray(attachments) ? attachments : undefined,
        origin: 'user',
      });
    } catch (error) {
      logger.error('wakeup:create failed', error);
      throw error;
    }
  });


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

  logger.info('Wakeup IPC handlers registered');
}
