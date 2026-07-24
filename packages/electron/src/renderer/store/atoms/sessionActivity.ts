/**
 * Cross-workspace session activity tracking
 *
 * Tracks which sessions are streaming and which carry unread output across
 * every open project — including projects warm in the rail but not the
 * currently visible one. Lives in its own atom so the existing
 * `sessionRegistryAtom` (which `initSessionList(workspacePath)` repopulates
 * with only the active project's sessions) stays unchanged. This atom is
 * the source of truth for:
 *
 * - Rail badges in `projectActivitySummaryAtom`
 * - Close-confirm streaming detection in `ProjectRail.handleClose`
 *
 * Maintained imperatively by `sessionStateListeners.ts` from the events
 * already fanning out across the multi-project rail subscription
 * (`session:started/streaming/waiting/completed/error/interrupted` and
 * `ai:message-logged` with `workspacePath`).
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';

export interface WorkspaceActivity {
  /** Session IDs currently streaming for this workspace. */
  streaming: Set<string>;
  /** Session IDs with unread output (last message after lastReadAt). */
  unread: Set<string>;
}

/**
 * Map<workspacePath, WorkspaceActivity>. Mutations always replace the
 * top-level map and the affected entry so Jotai re-renders subscribers.
 */
export const globalSessionActivityAtom = atom<Map<string, WorkspaceActivity>>(new Map());

/**
 * Index sessionId -> workspacePath. Populated as we observe events; used
 * by `clearActivity` callers (e.g. `session:completed`) that don't know
 * the path because the session payload may have stripped it.
 */
export const sessionActivityIndexAtom = atom<Map<string, string>>(new Map());
const EMPTY_TURN_ACTIVITY = new Map<string, number>();

/**
 * Map<workspacePath, Map<sessionId, timestamp>> of the latest turn-boundary
 * activity observed in the renderer. This is intentionally separate from the
 * persisted session `updatedAt`: agent-mode session history can sort from
 * turn lifecycle boundaries (start / waiting / complete) without reshuffling
 * on every streamed message or metadata patch.
 */
export const globalSessionTurnActivityAtom = atom<Map<string, Map<string, number>>>(new Map());

/**
 * Per-workspace view of the latest turn-boundary activity timestamps.
 * SessionHistory subscribes to this instead of the global map so unrelated
 * workspace updates do not cause the current sidebar to recompute.
 */
export const workspaceSessionTurnActivityAtom = atomFamily((workspacePath: string) =>
  atom((get) => get(globalSessionTurnActivityAtom).get(workspacePath) ?? EMPTY_TURN_ACTIVITY)
);

function emptyActivity(): WorkspaceActivity {
  return { streaming: new Set(), unread: new Set() };
}

/**
 * Mark a session as streaming for a workspace. Idempotent.
 */
export const markSessionStreamingAtom = atom(
  null,
  (get, set, payload: { sessionId: string; workspacePath: string }) => {
    const { sessionId, workspacePath } = payload;
    const map = new Map(get(globalSessionActivityAtom));
    const entry = { ...(map.get(workspacePath) ?? emptyActivity()) };
    entry.streaming = new Set(entry.streaming).add(sessionId);
    map.set(workspacePath, entry);
    set(globalSessionActivityAtom, map);

    const index = new Map(get(sessionActivityIndexAtom));
    index.set(sessionId, workspacePath);
    set(sessionActivityIndexAtom, index);
  }
);

/**
 * Defense-in-depth for the May 28 perf fix (commit 3d613ecfc) and its Jun 2
 * regression (commit 3d78447dd). `markSessionTurnActivityAtom` drives the
 * agent-mode SessionHistory sort via `workspaceSessionTurnActivityAtom`; any
 * caller that writes it per chunk re-fires the sort cascade and the downstream
 * `session-files:get-by-session` storm. The expected cadence is one write per
 * turn-boundary lifecycle event (started / streaming / waiting / completed /
 * error / interrupted), so >5 writes per second for the same session is
 * structurally impossible and indicates a misuse — log a loud warning in dev.
 */
const TURN_ACTIVITY_RATE_WINDOW_MS = 1_000;
const TURN_ACTIVITY_RATE_LIMIT = 5;
const turnActivityWriteTimes = new Map<string, number[]>();
const TURN_ACTIVITY_DEV_GUARD =
  typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

function recordTurnActivityWrite(workspacePath: string, sessionId: string): void {
  if (!TURN_ACTIVITY_DEV_GUARD) return;
  const key = `${workspacePath}\0${sessionId}`;
  const now = Date.now();
  const recent = (turnActivityWriteTimes.get(key) ?? []).filter(
    (ts) => now - ts < TURN_ACTIVITY_RATE_WINDOW_MS
  );
  recent.push(now);
  turnActivityWriteTimes.set(key, recent);
  if (recent.length > TURN_ACTIVITY_RATE_LIMIT) {
    console.warn(
      `[sessionActivity] markSessionTurnActivityAtom fired ${recent.length}x in ` +
        `${TURN_ACTIVITY_RATE_WINDOW_MS}ms for session ${sessionId}. ` +
        'This atom drives the agent-mode session-list sort; per-chunk writes ' +
        'reopen the SessionHistory sort cascade and the session-files:get-by-session ' +
        'storm fixed in commit 3d613ecfc on 2026-05-28. Only call this from ' +
        'turn-boundary events (session:started/streaming/waiting/completed/error/' +
        'interrupted), never from ai:message-logged or other per-message paths.',
      new Error('markSessionTurnActivityAtom rate-limit stack')
    );
    // Reset the window so we get one warning per burst, not one per write.
    turnActivityWriteTimes.set(key, []);
  }
}

/**
 * Record that a session crossed a turn boundary in the agent lifecycle.
 * This feeds throttled sidebar ordering in agent mode.
 */
export const markSessionTurnActivityAtom = atom(
  null,
  (get, set, payload: { sessionId: string; workspacePath: string; timestamp?: number }) => {
    const { sessionId, workspacePath } = payload;
    const timestamp = payload.timestamp ?? Date.now();

    recordTurnActivityWrite(workspacePath, sessionId);

    const workspaceMap = new Map(get(globalSessionTurnActivityAtom));
    const turnsForWorkspace = new Map(workspaceMap.get(workspacePath) ?? new Map<string, number>());
    turnsForWorkspace.set(sessionId, timestamp);
    workspaceMap.set(workspacePath, turnsForWorkspace);
    set(globalSessionTurnActivityAtom, workspaceMap);

    const index = new Map(get(sessionActivityIndexAtom));
    index.set(sessionId, workspacePath);
    set(sessionActivityIndexAtom, index);
  }
);

/**
 * Clear streaming flag for a session. Looks up the workspacePath from the
 * activity index when not provided.
 */
export const clearSessionStreamingAtom = atom(
  null,
  (get, set, payload: { sessionId: string; workspacePath?: string }) => {
    const { sessionId } = payload;
    const path = payload.workspacePath ?? get(sessionActivityIndexAtom).get(sessionId);
    if (!path) return;

    const map = new Map(get(globalSessionActivityAtom));
    const existing = map.get(path);
    if (!existing || !existing.streaming.has(sessionId)) return;

    const nextStreaming = new Set(existing.streaming);
    nextStreaming.delete(sessionId);
    const next = { ...existing, streaming: nextStreaming };
    if (next.streaming.size === 0 && next.unread.size === 0) {
      map.delete(path);
    } else {
      map.set(path, next);
    }
    set(globalSessionActivityAtom, map);
  }
);

/**
 * Mark a session as unread for its workspace.
 */
export const markSessionUnreadAtom = atom(
  null,
  (get, set, payload: { sessionId: string; workspacePath: string }) => {
    const { sessionId, workspacePath } = payload;
    const map = new Map(get(globalSessionActivityAtom));
    const entry = { ...(map.get(workspacePath) ?? emptyActivity()) };
    if (entry.unread.has(sessionId)) return;
    entry.unread = new Set(entry.unread).add(sessionId);
    map.set(workspacePath, entry);
    set(globalSessionActivityAtom, map);

    const index = new Map(get(sessionActivityIndexAtom));
    index.set(sessionId, workspacePath);
    set(sessionActivityIndexAtom, index);
  }
);

/**
 * Clear unread flag for a session.
 */
export const clearSessionUnreadAtom = atom(
  null,
  (get, set, payload: { sessionId: string; workspacePath?: string }) => {
    const { sessionId } = payload;
    const path = payload.workspacePath ?? get(sessionActivityIndexAtom).get(sessionId);
    if (!path) return;

    const map = new Map(get(globalSessionActivityAtom));
    const existing = map.get(path);
    if (!existing || !existing.unread.has(sessionId)) return;

    const nextUnread = new Set(existing.unread);
    nextUnread.delete(sessionId);
    const next = { ...existing, unread: nextUnread };
    if (next.streaming.size === 0 && next.unread.size === 0) {
      map.delete(path);
    } else {
      map.set(path, next);
    }
    set(globalSessionActivityAtom, map);
  }
);

/**
 * Drop every reference to `workspacePath` from the activity tracker. Use
 * when a project is closed from the rail — keeps the map bounded.
 */
export const clearWorkspaceActivityAtom = atom(
  null,
  (get, set, workspacePath: string) => {
    const map = new Map(get(globalSessionActivityAtom));
    const hadActivity = map.delete(workspacePath);
    if (hadActivity) {
      set(globalSessionActivityAtom, map);
    }

    const turnMap = new Map(get(globalSessionTurnActivityAtom));
    const hadTurnActivity = turnMap.delete(workspacePath);
    if (hadTurnActivity) {
      set(globalSessionTurnActivityAtom, turnMap);
    }

    if (!hadActivity && !hadTurnActivity) return;

    const index = new Map(get(sessionActivityIndexAtom));
    let mutated = false;
    for (const [sid, path] of index) {
      if (path === workspacePath) {
        index.delete(sid);
        mutated = true;
      }
    }
    if (mutated) set(sessionActivityIndexAtom, index);
  }
);

export interface ProjectActivitySummary {
  processing: number;
  unread: number;
}

/**
 * Per-project rollup of streaming + unread counts. Drives rail badges.
 *
 * Replaces the earlier `projectActivitySummaryAtom` in `openProjects.ts`
 * which iterated `sessionRegistryAtom` and missed inactive workspaces.
 */
export const projectActivitySummaryAtom = atom<Map<string, ProjectActivitySummary>>((get) => {
  const activity = get(globalSessionActivityAtom);
  const out = new Map<string, ProjectActivitySummary>();
  for (const [path, entry] of activity) {
    if (entry.streaming.size === 0 && entry.unread.size === 0) continue;
    out.set(path, { processing: entry.streaming.size, unread: entry.unread.size });
  }
  return out;
});
