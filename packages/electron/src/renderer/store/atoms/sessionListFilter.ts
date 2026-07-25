/**
 * Session List Filter Atoms
 *
 * Renderer-only filter state for the sessions list panel. Mirrors the tag
 * picker behavior the kanban view already provides (see sessionKanban.ts), but
 * scoped to the list and without phase/showComplete since the list has its
 * own time grouping and archive toggle.
 *
 * Session-only state -- clears on reload, like the kanban filter.
 */

import { atom } from 'jotai';
import type { SessionMeta } from '@nimbalyst/runtime';

// Virtual tags are renderer-only predicates. They are never persisted in a
// session's metadata.tags array.
export const VIRTUAL_TAG_WORKTREE = 'worktree';
export const VIRTUAL_TAG_WORKSTREAMS = 'workstreams';

export const SESSION_LIST_VIRTUAL_TAGS = new Set([
  VIRTUAL_TAG_WORKTREE,
  VIRTUAL_TAG_WORKSTREAMS,
]);

/** Match the same root shapes that SessionHistory renders as workstream groups. */
export function isWorkstreamParentSession(session: SessionMeta): boolean {
  return !session.worktreeId
    && session.sessionType !== 'blitz'
    && (session.sessionType === 'workstream' || session.childCount > 0);
}

/**
 * Match one list tag, including virtual structural tags. Workstream children
 * inherit the virtual #workstreams match from their parent so the predicate
 * stays correct if it is reused with the full registry rather than root rows.
 */
export function matchesSessionListTag(
  session: SessionMeta,
  tag: string,
  registry: ReadonlyMap<string, SessionMeta>,
): boolean {
  if (tag === VIRTUAL_TAG_WORKTREE) {
    return !!session.worktreeId;
  }

  if (tag === VIRTUAL_TAG_WORKSTREAMS) {
    if (isWorkstreamParentSession(session)) return true;
    if (!session.parentSessionId) return false;

    const parent = registry.get(session.parentSessionId);
    return parent ? isWorkstreamParentSession(parent) : false;
  }

  return (session.tags ?? []).includes(tag);
}

export interface SessionListFilter {
  tags: string[];
}

export const sessionListTagFilterAtom = atom<SessionListFilter>({ tags: [] });
