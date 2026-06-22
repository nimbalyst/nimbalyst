import {
  globalRegistry,
  type TrackerSyncMode,
  type TrackerSyncPolicy,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import { getWorkspaceState } from '../utils/store';

export type StoredTrackerSyncPolicy =
  | TrackerSyncMode
  | Partial<TrackerSyncPolicy>
  | undefined;

function normalizeTrackerSyncMode(mode: unknown, fallback: TrackerSyncMode): TrackerSyncMode {
  return mode === 'local' || mode === 'shared' || mode === 'hybrid' ? mode : fallback;
}

function normalizeTrackerSyncScope(scope: unknown, fallback: TrackerSyncPolicy['scope']): TrackerSyncPolicy['scope'] {
  return scope === 'workspace' || scope === 'project' ? scope : fallback;
}

/**
 * Determine the effective sync policy for a tracker type.
 *
 * Priority chain:
 * 1. Workspace-level override (stored in workspace state)
 * 2. Model registry (if loaded -- renderer always has it, main process may not)
 * 3. Caller-provided syncMode (from the renderer, which always has the model)
 * 4. Default: 'local'
 */
export function getEffectiveTrackerSyncPolicy(
  workspacePath: string,
  trackerType: string,
  callerSyncMode?: string,
): TrackerSyncPolicy {
  const modelPolicy = globalRegistry.get(trackerType)?.sync;
  const fallback: TrackerSyncPolicy = {
    mode: normalizeTrackerSyncMode(modelPolicy?.mode ?? callerSyncMode, 'local'),
    scope: modelPolicy?.scope ?? 'project',
  };

  const workspaceState = getWorkspaceState(workspacePath) as {
    trackerSyncPolicies?: Record<string, StoredTrackerSyncPolicy>;
  };
  const storedPolicy = workspaceState?.trackerSyncPolicies?.[trackerType];

  if (typeof storedPolicy === 'string') {
    return {
      mode: normalizeTrackerSyncMode(storedPolicy, fallback.mode),
      scope: fallback.scope,
    };
  }

  if (storedPolicy && typeof storedPolicy === 'object') {
    return {
      mode: normalizeTrackerSyncMode(storedPolicy.mode, fallback.mode),
      scope: normalizeTrackerSyncScope(storedPolicy.scope, fallback.scope),
    };
  }

  return fallback;
}

/**
 * Coarse, type-wide check: could ANY item of this type ever sync?
 * `shared` and `hybrid` types can; `local` cannot. This is intentionally
 * NOT the per-item decision -- use `shouldSyncTrackerItem` once an item (or its
 * data) is in hand, because `hybrid` is per-item (see below).
 */
export function shouldSyncTrackerPolicy(policy: TrackerSyncPolicy): boolean {
  return policy.mode === 'shared' || policy.mode === 'hybrid';
}

/**
 * Is this individual item flagged for team sharing?
 *
 * Accepts either a raw `data` blob (the parsed JSONB column, share/shared at top
 * level) or a `TrackerItem` (where extra fields are nested under `customFields`),
 * so a single predicate works at every call site regardless of which shape is in
 * hand. The canonical flags (per NIM-876):
 *   - `shared === true`  (generic boolean, for non-frontmatter hybrid types)
 *   - `share.status === 'team'` (frontmatter `planStatus.share.status:team` flattens here)
 *   - `share.body === 'team'`   (body-share; a tracker item always carries its
 *     own body via the `tracker-content/<id>` room, so sharing the body also
 *     shares the item)
 */
export function isTrackerItemShared(
  source: Record<string, any> | null | undefined,
): boolean {
  if (!source) return false;
  const carriesFlag = (o: any): boolean =>
    !!o &&
    (o.shared === true ||
      (o.share &&
        typeof o.share === 'object' &&
        (o.share.status === 'team' || o.share.body === 'team')));
  return carriesFlag(source) || carriesFlag(source.customFields);
}

/**
 * Per-item sync decision. This is what gate sites must use whenever an item is
 * available. `hybrid` means "sync ONLY items individually flagged for sharing":
 *   - `shared` -> always sync
 *   - `local`  -> never sync
 *   - `hybrid` -> sync iff the item carries the share flag
 */
export function shouldSyncTrackerItem(
  policy: TrackerSyncPolicy,
  source: Record<string, any> | null | undefined,
): boolean {
  if (policy.mode === 'shared') return true;
  if (policy.mode === 'local') return false;
  // hybrid: per-item
  return isTrackerItemShared(source);
}

export type BackfillAction = 'upsert' | 'delete' | 'skip';

/**
 * Decide what the reconnect backfill should do with a candidate row (NIM-880).
 *
 *   - should-sync (shared, or flagged hybrid)         -> 'upsert' (push state)
 *   - unflagged but previously shared (sync_id set)   -> 'delete' (propagate the
 *       unshare as a room tombstone -- the user removed the flag while offline)
 *   - unflagged and never shared                      -> 'skip' (local-only)
 *
 * The `delete` case is the fix for offline unshare: previously the backfill
 * either re-uploaded the unflagged-but-previously-shared item (re-sharing it) or
 * skipped it (leaving the stale copy in the room). Neither propagated the
 * unshare.
 */
export function decideBackfillAction(
  policy: TrackerSyncPolicy,
  source: Record<string, any> | null | undefined,
  previouslyShared: boolean,
): BackfillAction {
  if (shouldSyncTrackerItem(policy, source)) return 'upsert';
  return previouslyShared ? 'delete' : 'skip';
}

/**
 * Initial `sync_status` for a freshly-created item. For `hybrid` types this is
 * item-aware: an unflagged hybrid item starts `local` (no leak), a flagged one
 * starts `pending`. Callers should pass the item's `data` when creating a hybrid
 * item; omitting it treats hybrid as unflagged (local).
 */
export function getInitialTrackerSyncStatus(
  policy: TrackerSyncPolicy,
  source?: Record<string, any> | null,
): 'local' | 'pending' {
  return shouldSyncTrackerItem(policy, source ?? null) ? 'pending' : 'local';
}
