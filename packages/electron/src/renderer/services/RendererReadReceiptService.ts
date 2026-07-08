/**
 * RendererReadReceiptService - renderer facade over the read-receipt IPC.
 *
 * Thin wrapper over the generic `window.electronAPI.invoke` channels
 * (`read-receipts:get-for-scope`, `read-receipts:mark-viewed`), unwrapping the
 * IPCResponse envelope so callers just await/try-catch. Mirrors the pattern of
 * RendererPullRequestService.
 *
 * The receipt owner (user email) is resolved in the main process; the renderer
 * never supplies it.
 */

import type { ReadReceiptEntityKind } from '@nimbalyst/runtime';

export interface ReadReceiptDto {
  userEmail: string;
  entityKind: ReadReceiptEntityKind;
  entityId: string;
  scope: string;
  lastViewedAt: number;
  lastSeenVersion: number | null;
  updatedAt: number;
}

interface IPCResponse<T> {
  success: boolean;
  error?: string;
  data?: T;
}

function requireApi(): NonNullable<typeof window.electronAPI> {
  if (!window.electronAPI) throw new Error('electronAPI not available');
  return window.electronAPI;
}

function unwrap<T>(res: IPCResponse<T>, label: string): T {
  if (!res?.success || res.data === undefined) {
    throw new Error(res?.error || `${label} failed`);
  }
  return res.data;
}

export const readReceiptService = {
  /** All receipts for the current user in one (entityKind, scope). */
  async getForScope(
    entityKind: ReadReceiptEntityKind,
    scope: string,
    workspacePath?: string,
  ): Promise<ReadReceiptDto[]> {
    const res = (await requireApi().invoke(
      'read-receipts:get-for-scope',
      entityKind,
      scope,
      workspacePath,
    )) as IPCResponse<ReadReceiptDto[]>;
    return unwrap(res, 'read-receipts:get-for-scope');
  },

  /**
   * Mark an entity viewed (advance-only). Returns the resulting receipt, or
   * null when the write was a no-op (receipt did not advance).
   */
  async markViewed(input: {
    entityKind: ReadReceiptEntityKind;
    entityId: string;
    scope: string;
    lastViewedAt: number;
    lastSeenVersion: number | null;
    workspacePath?: string;
  }): Promise<ReadReceiptDto | null> {
    const { workspacePath, ...payload } = input;
    const res = (await requireApi().invoke(
      'read-receipts:mark-viewed',
      payload,
      workspacePath,
    )) as IPCResponse<ReadReceiptDto | null>;
    return unwrap(res, 'read-receipts:mark-viewed');
  },
};

export type RendererReadReceiptService = typeof readReceiptService;
