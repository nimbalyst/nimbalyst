/**
 * Pure list maintenance for `sessionWakeupsAtom` (#1497). Kept free of the
 * store and IPC so the merge rules can be tested directly.
 */

import type { SessionWakeupView } from '../atoms/sessions';

const ACTIVE_STATUSES: ReadonlyArray<SessionWakeupView['status']> = [
  'pending',
  'firing',
  'waiting_for_workspace',
  'overdue',
];

export function isActiveWakeup(row: SessionWakeupView): boolean {
  return ACTIVE_STATUSES.includes(row.status);
}

/** Soonest first, so the banner and the session-list icon agree on order. */
function byFireAt(a: SessionWakeupView, b: SessionWakeupView): number {
  return a.fireAt - b.fireAt || a.id.localeCompare(b.id);
}

/**
 * Upsert one changed row by id. A broadcast describes one row, so the others
 * in the list must survive it -- replacing the whole list would drop a
 * session's other schedules every time one of them changed status.
 */
export function applyWakeupChange(current: SessionWakeupView[], row: SessionWakeupView): SessionWakeupView[] {
  const without = current.filter((w) => w.id !== row.id);
  return isActiveWakeup(row) ? [...without, row].sort(byFireAt) : without;
}

/**
 * Group a workspace's active rows by session. Written once per session:
 * setting per row would leave each session holding only its last wakeup.
 */
export function groupActiveWakeups(rows: SessionWakeupView[]): Map<string, SessionWakeupView[]> {
  const bySession = new Map<string, SessionWakeupView[]>();
  for (const row of rows) {
    if (!row?.sessionId || !isActiveWakeup(row)) continue;
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }
  for (const list of bySession.values()) list.sort(byFireAt);
  return bySession;
}
