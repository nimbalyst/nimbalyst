/**
 * ReadReceiptHandlers - IPC handlers for unread-indicator read receipts.
 *
 * Channels:
 *   * `read-receipts:get-for-scope` — every receipt for the current user in one
 *     (entityKind, scope), so the renderer can compute unread for all visible
 *     tracker items / docs at once.
 *   * `read-receipts:mark-viewed` — advance-only upsert when the user opens an
 *     item; returns the resulting row (or null when it was a no-op).
 *
 * The receipt OWNER is always the current human identity's email (the stable
 * cross-org key), resolved here in main — never trusted from the renderer. An
 * empty string means single-user / no-identity.
 *
 * Read receipts are PERSONAL data; the personal-channel sync push is wired in
 * Phase 2 (see plan). This handler is the local persistence surface.
 */

import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { getDatabase } from '../database/initialize';
import { getCurrentIdentity } from '../services/TrackerIdentityService';
import { getSyncProvider } from '../services/SyncManager';
import {
  createReadReceiptsStore,
  type ReadReceiptsStore,
  type ReadReceiptRow,
} from '../services/ReadReceiptsStore';
import type {
  ReadReceiptEntityKind,
  SyncedReadReceipt,
} from '@nimbalyst/runtime/readReceipts/readReceipts';
import { resolveTrackerProjectScope } from '../services/TrackerProjectScope';

const logger = log.scope('ReadReceiptHandlers');

interface IPCResponse<T> {
  success: boolean;
  error?: string;
  data?: T;
}

function errorResponse(error: unknown): IPCResponse<never> {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return { success: false, error: message };
}

let cachedStore: ReadReceiptsStore | null = null;

function getStore(): ReadReceiptsStore {
  if (cachedStore) return cachedStore;
  const db = getDatabase();
  if (!db) throw new Error('Database not initialized');
  cachedStore = createReadReceiptsStore(db);
  return cachedStore;
}

/** Resolve the receipt-owner key. '' when there is no identity. */
function resolveUserEmail(workspacePath?: string): string {
  try {
    return getCurrentIdentity(workspacePath).email ?? '';
  } catch {
    return '';
  }
}

/** Push a locally-written receipt to the user's other devices (personal channel). */
function pushReceiptToPersonalSync(row: ReadReceiptRow): void {
  const provider = getSyncProvider();
  if (!provider?.syncReadReceipt) return;
  provider
    .syncReadReceipt({
      entityKind: row.entityKind,
      entityId: row.entityId,
      scope: row.scope,
      lastViewedAt: row.lastViewedAt,
      lastSeenVersion: row.lastSeenVersion,
    })
    .catch((err) => logger.debug('read receipt personal-sync push failed', { err }));
}

async function resolveReceiptScope(
  entityKind: ReadReceiptEntityKind,
  requestedScope: string,
  workspacePath?: string,
): Promise<{ scope: string; syncable: boolean }> {
  if (entityKind !== 'tracker') return { scope: requestedScope, syncable: true };
  if (!workspacePath) throw new Error('workspacePath required for tracker read receipts');
  return resolveTrackerProjectScope(workspacePath);
}

/**
 * Apply a read receipt that arrived from another device (personal-sync inbound
 * or server replay). Advance-only persist, then notify all renderer windows so
 * the unread atoms recompute. No-op when the receipt does not advance.
 */
export async function applyRemoteReadReceipt(receipt: SyncedReadReceipt): Promise<void> {
  try {
    const userEmail = resolveUserEmail();
    const row = await getStore().markViewed({
      userEmail,
      entityKind: receipt.entityKind,
      entityId: receipt.entityId,
      scope: receipt.scope,
      lastViewedAt: receipt.lastViewedAt,
      lastSeenVersion: receipt.lastSeenVersion ?? null,
    });
    if (!row) return; // stale / no advance
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('read-receipts:remote-updated', receipt);
      }
    }
  } catch (error) {
    logger.error('applyRemoteReadReceipt failed', { error });
  }
}

export function registerReadReceiptHandlers(): void {
  safeHandle(
    'read-receipts:get-for-scope',
    async (
      _event,
      entityKind: ReadReceiptEntityKind,
      scope: string,
      workspacePath?: string,
    ): Promise<IPCResponse<ReadReceiptRow[]>> => {
      if (!entityKind || !scope) {
        return { success: false, error: 'entityKind and scope required' };
      }
      try {
        const userEmail = resolveUserEmail(workspacePath);
        const resolved = await resolveReceiptScope(entityKind, scope, workspacePath);
        const rows = await getStore().getForScope(userEmail, entityKind, resolved.scope);
        return { success: true, data: rows };
      } catch (error: unknown) {
        logger.error('read-receipts:get-for-scope failed', { entityKind, scope, error });
        return errorResponse(error);
      }
    },
  );

  safeHandle(
    'read-receipts:mark-viewed',
    async (
      _event,
      input: {
        entityKind: ReadReceiptEntityKind;
        entityId: string;
        scope: string;
        lastViewedAt: number;
        lastSeenVersion: number | null;
      },
      workspacePath?: string,
    ): Promise<IPCResponse<ReadReceiptRow | null>> => {
      if (!input?.entityKind || !input?.entityId || !input?.scope) {
        return { success: false, error: 'entityKind, entityId and scope required' };
      }
      try {
        const userEmail = resolveUserEmail(workspacePath);
        const resolved = await resolveReceiptScope(input.entityKind, input.scope, workspacePath);
        const row = await getStore().markViewed({
          userEmail,
          entityKind: input.entityKind,
          entityId: input.entityId,
          scope: resolved.scope,
          lastViewedAt: input.lastViewedAt,
          lastSeenVersion: input.lastSeenVersion ?? null,
        });
        // Push through the personal sync provider so read state follows the
        // user cross-device (skipped when row === null, i.e. no advance).
        if (row && resolved.syncable) pushReceiptToPersonalSync(row);
        return { success: true, data: row };
      } catch (error: unknown) {
        logger.error('read-receipts:mark-viewed failed', {
          entityKind: input?.entityKind,
          entityId: input?.entityId,
          error,
        });
        return errorResponse(error);
      }
    },
  );

  logger.info('Read receipt IPC handlers registered');
}
