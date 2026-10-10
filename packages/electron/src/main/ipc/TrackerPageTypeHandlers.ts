/**
 * IPC for Pages mode's "Set type": the read-back that must succeed before the
 * renderer trashes the page whose text the new item now holds.
 */

import { safeHandle } from '../utils/ipcRegistry';
import { checkTrackerItemBody, defaultItemBodyReaders } from '../services/tracker/pageTypeBodyCheck';

export function registerTrackerPageTypeHandlers(): void {
  safeHandle('tracker-page-type:check-body', async (_event, payload: {
    workspacePath?: unknown;
    itemId?: unknown;
    expected?: unknown;
    lane?: unknown;
  }) => {
    if (typeof payload?.workspacePath !== 'string' || !payload.workspacePath) throw new Error('workspacePath is required');
    if (typeof payload.itemId !== 'string' || !payload.itemId) throw new Error('itemId is required');
    if (typeof payload.expected !== 'string') throw new Error('expected must be a string');
    if (payload.lane !== 'team' && payload.lane !== 'personal') throw new Error('lane must be team or personal');
    return checkTrackerItemBody({
      workspacePath: payload.workspacePath,
      itemId: payload.itemId,
      expected: payload.expected,
      lane: payload.lane,
    }, defaultItemBodyReaders);
  });
}
