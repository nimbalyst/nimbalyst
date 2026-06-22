/**
 * Pure transition logic for full-document (frontmatter-backed) tracker items.
 *
 * When a plan/decision/etc. document's frontmatter is edited directly on disk
 * (the normal way work "moves through the system"), the change does NOT pass
 * through the tracker UI/MCP update path -- so no status-change history was ever
 * recorded. This module computes the activity[] transitions for such a direct
 * edit so the item's own self-contained timeline captures them, regardless of
 * whether the edit came from the UI or from hand-editing the markdown.
 *
 * It is intentionally free of any DB / Electron / fs dependency so it can be
 * unit-tested in isolation. The caller (ElectronDocumentService) loads the prior
 * persisted `data`, passes the freshly-parsed frontmatter fields, and persists
 * the returned `data` whole -- no SQL JSONB merge operator, which keeps it safe
 * across the PGLite / better-sqlite3 backend divergence.
 */

/** Scalar fields whose changes are recorded as activity transitions. */
export const TRACKED_TRANSITION_FIELDS = [
  'status',
  'priority',
  'owner',
  'progress',
  'title',
  'planType',
  'dueDate',
] as const;

export interface TrackerActivityEntry {
  id: string;
  authorIdentity: unknown;
  action: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  timestamp: number;
}

export interface FrontmatterTransitionResult {
  /** The full `data` payload to persist (existing system metadata preserved). */
  data: Record<string, any>;
  /** Per-field changes detected (empty on first projection / no change). */
  changes: Array<{ field: string; from?: string; to?: string }>;
  /** True when there was no prior row (first time this file is materialized). */
  isNew: boolean;
}

/** Keep the in-item activity log bounded, matching the tracker update path. */
const MAX_ACTIVITY_ENTRIES = 100;

function toComparable(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

/**
 * Compute the next `data` payload and the activity transitions for a direct
 * frontmatter edit.
 *
 * @param existingData prior persisted `data` (null when no row exists yet)
 * @param newFields    fresh tracked field values parsed from frontmatter
 * @param authorIdentity identity to attribute transitions to (may be null)
 * @param now          millisecond timestamp (injected for determinism)
 */
export function computeFrontmatterTrackerTransition(
  existingData: Record<string, any> | null,
  newFields: Record<string, any>,
  authorIdentity: unknown,
  now: number,
): FrontmatterTransitionResult {
  const isNew = !existingData;
  const base: Record<string, any> = { ...(existingData ?? {}) };

  // Apply the freshly-parsed frontmatter values over the existing data. Only
  // keys present in newFields are written, so system metadata (authorIdentity,
  // activity, comments, linkedSessions, ...) on the existing row is preserved.
  for (const [key, value] of Object.entries(newFields)) {
    if (value !== undefined) base[key] = value;
  }

  const activity: TrackerActivityEntry[] = Array.isArray(existingData?.activity)
    ? [...existingData!.activity]
    : [];
  const changes: Array<{ field: string; from?: string; to?: string }> = [];

  const pushEntry = (action: string, field?: string, oldValue?: unknown, newValue?: unknown) => {
    activity.push({
      id: `activity_${now}_${activity.length}`,
      authorIdentity,
      action,
      field,
      oldValue: oldValue !== undefined && oldValue !== null ? String(oldValue) : undefined,
      newValue: newValue !== undefined && newValue !== null ? String(newValue) : undefined,
      timestamp: now,
    });
  };

  if (isNew) {
    // First materialization: anchor the timeline with a single 'created' entry
    // capturing the starting status, instead of emitting one entry per field.
    pushEntry('created', undefined, undefined, newFields.status);
  } else {
    for (const field of TRACKED_TRANSITION_FIELDS) {
      const newValue = newFields[field];
      if (newValue === undefined) continue; // absent in frontmatter -> not a clear
      const oldValue = existingData![field];
      if (toComparable(oldValue) === toComparable(newValue)) continue;
      changes.push({ field, from: oldValue, to: newValue });
      pushEntry(field === 'status' ? 'status_changed' : 'updated', field, oldValue, newValue);
    }
  }

  // Bound the log (matches the MCP/UI update path's rolling window).
  const bounded = activity.length > MAX_ACTIVITY_ENTRIES
    ? activity.slice(-MAX_ACTIVITY_ENTRIES)
    : activity;
  base.activity = bounded;

  return { data: base, changes, isNew };
}
