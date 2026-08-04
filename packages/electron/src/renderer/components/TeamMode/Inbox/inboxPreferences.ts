/**
 * Per-user Inbox UI state (active filter, scope selection).
 *
 * Goes through the app-settings store over IPC, never `localStorage` — same
 * path `defaultOrg.ts` uses for the org window's last selection. Reads and
 * writes are best-effort: failing to remember a filter must never block the
 * surface from rendering.
 */

import type { InboxFilterId, InboxScope, InboxSourceKind } from './inboxTypes';
import { EMPTY_INBOX_SCOPE } from './inboxTypes';

export const INBOX_PREFERENCES_SETTING_KEY = 'inboxViewPreferences';

export interface InboxPreferences {
  filter: InboxFilterId;
  unreadOnly: boolean;
  scope: InboxScope;
}

export const DEFAULT_INBOX_PREFERENCES: InboxPreferences = {
  filter: 'all',
  unreadOnly: false,
  scope: EMPTY_INBOX_SCOPE,
};

const FILTERS: InboxFilterId[] = ['all', 'mentions', 'assigned', 'follows'];
const SOURCE_KINDS: InboxSourceKind[] = [
  'roomMessage',
  'documentDiscussion',
  'dmMessage',
  'trackerComment',
  'documentInlineComment',
];

function stringArrayOrNull(value: unknown, allowed?: readonly string[]): string[] | null {
  if (!Array.isArray(value)) return null;
  const cleaned = value.filter((entry): entry is string => typeof entry === 'string' && (!allowed || allowed.includes(entry)));
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Persisted state predates any field added later, so every field is defaulted
 * rather than trusted (STATE_PERSISTENCE.md). That also covers the source kinds
 * moving to the protocol's camelCase spelling: an unrecognized stored value is
 * dropped, and an axis left with nothing collapses to unrestricted rather than
 * to an empty list the user cannot explain.
 */
export function normalizeInboxPreferences(raw: unknown): InboxPreferences {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // Unread used to be a reason filter. Anyone whose last session ended on it
  // gets what they were actually looking at — every reason, unread only — not
  // silently reset to All, which would hide nothing and show everything.
  const storedUnreadFilter = record.filter === 'unread';
  const filter = storedUnreadFilter
    ? 'all'
    : FILTERS.includes(record.filter as InboxFilterId)
      ? (record.filter as InboxFilterId)
      : DEFAULT_INBOX_PREFERENCES.filter;
  const unreadOnly = storedUnreadFilter || record.unreadOnly === true;
  const scopeRecord = (record.scope && typeof record.scope === 'object' ? record.scope : {}) as Record<string, unknown>;

  return {
    filter,
    unreadOnly,
    scope: {
      orgIds: stringArrayOrNull(scopeRecord.orgIds),
      sourceKinds: stringArrayOrNull(scopeRecord.sourceKinds, SOURCE_KINDS) as InboxSourceKind[] | null,
      projectIds: stringArrayOrNull(scopeRecord.projectIds),
    },
  };
}

export async function readInboxPreferences(): Promise<InboxPreferences> {
  try {
    const stored = await window.electronAPI?.invoke?.('app-settings:get', INBOX_PREFERENCES_SETTING_KEY);
    return normalizeInboxPreferences(stored);
  } catch {
    return DEFAULT_INBOX_PREFERENCES;
  }
}

export async function persistInboxPreferences(preferences: InboxPreferences): Promise<void> {
  try {
    await window.electronAPI?.invoke?.('app-settings:set', INBOX_PREFERENCES_SETTING_KEY, preferences);
  } catch {
    // Best effort.
  }
}
