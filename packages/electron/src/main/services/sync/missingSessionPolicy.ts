import { isRetainedSession, SESSION_INDEX_TTL_MS, SESSION_TRANSCRIPT_TTL_MS } from '@nimbalyst/collab-protocol';

// Kept as an alias for callers compiled against the original helper.
export const LEGACY_SERVER_SESSION_TTL_MS = SESSION_INDEX_TTL_MS;

export interface MissingSessionDecision {
  publishIndex: boolean;
  syncMessages: boolean;
  reason: 'tombstoned' | 'publish' | 'ttl-expired';
}

/** Remote expiry never deletes local history or authorizes uploading it again. */
export function decideMissingSession(args: {
  sessionId: string;
  updatedAt: number | undefined;
  isArchived: boolean | undefined;
  tombstonedSessionIds: ReadonlySet<string>;
  indexProtocolVersion: 1 | 2 | undefined;
  now: number;
}): MissingSessionDecision {
  if (args.tombstonedSessionIds.has(args.sessionId)) {
    return { publishIndex: false, syncMessages: false, reason: 'tombstoned' };
  }
  if (!isRetainedSession(args.updatedAt, args.now)) {
    return { publishIndex: false, syncMessages: false, reason: 'ttl-expired' };
  }
  return { publishIndex: true, syncMessages: isRetainedSession(args.updatedAt, args.now, SESSION_TRANSCRIPT_TTL_MS), reason: 'publish' };
}
