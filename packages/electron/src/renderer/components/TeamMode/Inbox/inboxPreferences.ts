/**
 * Per-user Inbox UI state (active filter, scope selection, context-pane width).
 *
 * Goes through the app-settings store over IPC, never `localStorage` — same
 * path `defaultOrg.ts` uses for the org window's last selection. Reads and
 * writes are best-effort: failing to remember a filter must never block the
 * surface from rendering.
 */

import type { InboxFilterId, InboxScope, InboxSourceKind } from './inboxTypes';
import { EMPTY_INBOX_SCOPE } from './inboxTypes';
import { SOURCE_KIND_LABELS } from './inboxViewModel';

export const INBOX_PREFERENCES_SETTING_KEY = 'inboxViewPreferences';

/**
 * Bounds on the context pane. The minimum is what the feedback-request card and
 * the conversation composer need before they start wrapping into uselessness.
 * The maximum only guards against a stored width captured on a much wider
 * display — what actually stops a drag on any given window is the list's own
 * minimum below, so this is deliberately generous.
 */
export const INBOX_CONTEXT_PANE_MIN_WIDTH = 280;
export const INBOX_CONTEXT_PANE_MAX_WIDTH = 1600;
/** Width the list needs to stay readable, which caps the pane while dragging. */
export const INBOX_LIST_PANE_MIN_WIDTH = 320;

export interface InboxPreferences {
  filter: InboxFilterId;
  unreadOnly: boolean;
  scope: InboxScope;
  /** Width of the right-hand context pane, in CSS pixels. */
  contextPaneWidth: number;
}

export const DEFAULT_INBOX_PREFERENCES: InboxPreferences = {
  filter: 'all',
  unreadOnly: false,
  scope: EMPTY_INBOX_SCOPE,
  contextPaneWidth: 340,
};

export function clampInboxContextPaneWidth(width: number, available?: number): number {
  // `available` is the surface width at drag time: the pane may not grow past
  // what leaves the list its minimum, or a drag to the far edge would hide the
  // very thing the pane is describing.
  const max = available !== undefined && available > 0
    ? Math.max(INBOX_CONTEXT_PANE_MIN_WIDTH, Math.min(INBOX_CONTEXT_PANE_MAX_WIDTH, available - INBOX_LIST_PANE_MIN_WIDTH))
    : INBOX_CONTEXT_PANE_MAX_WIDTH;
  return Math.round(Math.max(INBOX_CONTEXT_PANE_MIN_WIDTH, Math.min(max, width)));
}

const FILTERS: InboxFilterId[] = ['all', 'mentions', 'assigned', 'follows'];
// Derived from the label map rather than restated, so a source kind added to
// the protocol cannot be silently dropped from a restored scope: the map is a
// `Record<InboxSourceKind, string>` and stops compiling until it is covered.
const SOURCE_KINDS = Object.keys(SOURCE_KIND_LABELS) as InboxSourceKind[];

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
    contextPaneWidth: typeof record.contextPaneWidth === 'number' && Number.isFinite(record.contextPaneWidth)
      ? clampInboxContextPaneWidth(record.contextPaneWidth)
      : DEFAULT_INBOX_PREFERENCES.contextPaneWidth,
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
