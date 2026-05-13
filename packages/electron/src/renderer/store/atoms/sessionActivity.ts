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
    if (!map.has(workspacePath)) return;
    map.delete(workspacePath);
    set(globalSessionActivityAtom, map);

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
