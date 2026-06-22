/**
 * Pure transition logic for AI session workflow-phase history.
 *
 * A session moves through workflow phases (backlog -> planning -> implementing
 * -> validating -> complete) over its life -- driven by the agent (the
 * `update_session_meta` MCP tool) or by a user dragging it between kanban
 * columns. Only the *current* phase was ever persisted, so the session's history
 * could not be reconstructed.
 *
 * This module records each phase change as a self-contained activity entry on
 * the session's `metadata.activity[]` array -- the exact same shape the tracker
 * items use (`action: 'status_changed'`, `field`, `oldValue`, `newValue`,
 * `timestamp`, `authorIdentity`). That lets the project-graph timeline render a
 * session's phase segments with no extra wiring: it already reconstructs colored
 * bars from any node whose `fields.data.activity` carries `status_changed`
 * entries.
 *
 * It is intentionally free of any DB / Electron / fs dependency so it can be
 * unit-tested in isolation. The caller (the session store) loads the prior
 * persisted `metadata`, passes the new phase, and persists the returned blob
 * whole -- no SQL JSONB merge operator, which keeps it safe across the
 * PGLite / better-sqlite3 backend divergence.
 *
 * Note: we deliberately track only the workflow `phase`, NOT the operational
 * `status` (idle/running/waiting_for_input), which flips many times per turn and
 * would saturate the bounded log with noise.
 */

export interface SessionActivityEntry {
  id: string;
  authorIdentity: unknown;
  action: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  timestamp: number;
}

export interface SessionPhaseTransitionResult {
  /** The full `metadata` payload to persist (existing keys preserved). */
  metadata: Record<string, any>;
  /** True when a phase change was recorded. */
  changed: boolean;
}

/** Keep the in-session activity log bounded, matching the tracker update path. */
const MAX_ACTIVITY_ENTRIES = 100;

/**
 * Compute the next `metadata` payload and append a phase transition entry when
 * the phase actually changes.
 *
 * @param existingMetadata prior persisted metadata blob (null when none exists)
 * @param newPhase         the phase being set (undefined when this update isn't a phase change)
 * @param authorIdentity   identity to attribute the transition to (may be null)
 * @param now              millisecond timestamp (injected for determinism)
 */
export function computeSessionPhaseTransition(
  existingMetadata: Record<string, any> | null,
  newPhase: string | undefined,
  authorIdentity: unknown,
  now: number,
): SessionPhaseTransitionResult {
  const base: Record<string, any> = { ...(existingMetadata ?? {}) };
  const oldPhase = base.phase;

  // No phase supplied, or it didn't change -> nothing to record.
  if (newPhase === undefined || String(oldPhase ?? '') === String(newPhase)) {
    return { metadata: base, changed: false };
  }

  const activity: SessionActivityEntry[] = Array.isArray(base.activity)
    ? [...base.activity]
    : [];

  activity.push({
    id: `activity_${now}_${activity.length}`,
    authorIdentity,
    action: 'status_changed', // same action string the timeline filters on
    field: 'phase',
    oldValue: oldPhase !== undefined && oldPhase !== null ? String(oldPhase) : undefined,
    newValue: String(newPhase),
    timestamp: now,
  });

  base.phase = newPhase;
  base.activity = activity.length > MAX_ACTIVITY_ENTRIES
    ? activity.slice(-MAX_ACTIVITY_ENTRIES)
    : activity;

  return { metadata: base, changed: true };
}
