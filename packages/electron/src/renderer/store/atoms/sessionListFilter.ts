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

/**
 * Title the automations extension gives every session it starts
 * (`packages/extensions/automations/src/index.tsx`). It sets the title with
 * `force` and `markAsNamed`, so the prefix survives auto-naming.
 */
export const AUTOMATION_SESSION_TITLE_PREFIX = 'Automation: ';

/** Sessions started by a scheduled automation run, not by the user. */
export function isAutomationSession(session: Pick<SessionMeta, 'title'>): boolean {
  return (session.title ?? '').startsWith(AUTOMATION_SESSION_TITLE_PREFIX);
}

export const AUTOMATIONS_GROUP_KEY = 'Automations';

/**
 * List groups that start collapsed. Scheduled runs pile up fast, so their
 * group stays out of the way until the user opens it. For these keys the
 * persisted `collapsedGroups` list records the opposite state: an
 * `<key>:expanded` entry means the user opened it.
 */
const COLLAPSED_BY_DEFAULT_GROUPS = new Set([AUTOMATIONS_GROUP_KEY]);

export function isSessionListGroupCollapsed(collapsedGroups: readonly string[], groupKey: string): boolean {
  if (COLLAPSED_BY_DEFAULT_GROUPS.has(groupKey)) {
    return !collapsedGroups.includes(`${groupKey}:expanded`);
  }
  return collapsedGroups.includes(groupKey);
}

export function toggleSessionListGroup(collapsedGroups: readonly string[], groupKey: string): string[] {
  const stored = COLLAPSED_BY_DEFAULT_GROUPS.has(groupKey) ? `${groupKey}:expanded` : groupKey;
  return collapsedGroups.includes(stored)
    ? collapsedGroups.filter(g => g !== stored)
    : [...collapsedGroups, stored];
}

export interface SessionListFilter {
  tags: string[];
}

export const sessionListTagFilterAtom = atom<SessionListFilter>({ tags: [] });
