/**
 * Shared linked-sessions resolution for a tracker item.
 *
 * The tracker↔session link is bidirectional and the durable direction varies
 * (tracker-side linkedSessions is dropped for synced items), so every surface
 * showing "sessions for this item" must merge BOTH directions the same way:
 *
 *   1. Forward — item.system.linkedSessions[] (session ids on the item)
 *   2. Reverse — sessions whose linkedTrackerItemIds contains the item id or
 *      a `file:<documentPath>` ref
 *
 * Used by TrackerItemDetail and the PR view (via prLinkedSessions). Deleted
 * sessions are silently filtered; results sort most recently updated first.
 */

import type { SessionMeta } from '../store/atoms/sessions';

export interface LinkedSessionSource {
  id: string;
  system?: {
    linkedSessions?: string[];
    documentPath?: string;
  };
}

export function resolveLinkedSessions(
  item: LinkedSessionSource | null | undefined,
  sessionRegistry: Map<string, SessionMeta>,
): SessionMeta[] {
  if (!item) return [];
  const sessionSet = new Set<string>();

  for (const id of item.system?.linkedSessions || []) sessionSet.add(id);

  const filePath = item.system?.documentPath;
  const fileRef = filePath ? `file:${filePath}` : null;

  sessionRegistry.forEach((session, sessionId) => {
    const linked = session.linkedTrackerItemIds;
    if (!linked) return;
    if (linked.includes(item.id)) sessionSet.add(sessionId);
    if (fileRef && linked.includes(fileRef)) sessionSet.add(sessionId);
  });

  if (sessionSet.size === 0) return [];
  return Array.from(sessionSet)
    .map((id) => sessionRegistry.get(id))
    .filter((s): s is SessionMeta => s != null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
