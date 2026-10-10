/** Derivations behind the desk header, chapter timeline and delegated tab. */
import type {
  CrewChapterSummary,
  CrewDelegatedSession,
  CrewMemberSnapshot,
  CrewMemberStatus,
  CrewRosterSnapshot,
  CrewShiftTrigger,
} from '../shared/types';

export type CrewShiftAction =
  | { kind: 'end' }
  | { kind: 'start'; blockedReason?: string };

/**
 * What the desk's shift button does. A member on shift can always be released.
 * Otherwise starting is blocked by pause, budget, or a definition file that
 * does not validate; the reason is shown on the button.
 */
export function deriveShiftAction(member: CrewMemberSnapshot): CrewShiftAction {
  const { definition, runtime } = member;
  if (runtime.onShift || runtime.status === 'on-shift') return { kind: 'end' };
  if (definition.paused === true || runtime.status === 'paused') {
    return { kind: 'start', blockedReason: `Unpause ${definition.name} to start a shift` };
  }
  if (runtime.status === 'error') {
    return { kind: 'start', blockedReason: 'Fix the definition file first' };
  }
  if (runtime.status === 'over-budget' || runtime.usage.overBudget) {
    return { kind: 'start', blockedReason: runtime.usage.overBudgetReason ?? 'Over budget' };
  }
  return { kind: 'start' };
}

export interface CrewChapterSplit {
  /** The chapter the desk's transcript shows, or null before the first shift. */
  current: CrewChapterSummary | null;
  /** Every other chapter, oldest first, as collapsed cards above the transcript. */
  earlier: CrewChapterSummary[];
}

/**
 * Split the chapter list. The roster's `currentChapter` wins over the list's
 * own `isCurrent` flag: the roster is polled more often, so right after a
 * chapter rolls it is the one that already names the new session.
 */
export function splitChapters(
  chapters: readonly CrewChapterSummary[],
  currentSessionId: string | undefined,
): CrewChapterSplit {
  const currentId = currentSessionId ?? chapters.find((c) => c.isCurrent)?.sessionId;
  const current = chapters.find((c) => c.sessionId === currentId) ?? null;
  const earlier = chapters
    .filter((c) => c.sessionId !== currentId)
    .sort((a, b) => a.chapterIndex - b.chapterIndex);
  return { current, earlier };
}

/** Host session statuses that mean the delegated work is still going. */
const ACTIVE_SESSION_STATUSES = new Set(['running', 'waiting', 'waiting_for_input', 'processing']);

/** Delegated sessions that are still running or need the user, for the tab count. */
export function countLiveDelegated(sessions: readonly CrewDelegatedSession[]): number {
  return sessions.filter((s) => s.hasPendingPrompt || ACTIVE_SESSION_STATUSES.has(s.status)).length;
}

export function describeTrigger(trigger: CrewShiftTrigger): string {
  switch (trigger) {
    case 'user': return 'You started this shift';
    case 'schedule': return 'Scheduled run';
    case 'self': return 'Its own wake-up';
    case 'child-session': return 'A delegated session reported back';
    case 'launch-catchup': return 'Missed run while Nimbalyst was closed';
  }
}

/**
 * The gutter badge: the number of things waiting on the user, in the warning
 * tone when the crew or any member is over budget. Over budget with nothing
 * waiting still shows (as a dot), so a stalled crew is visible from anywhere.
 */
export function crewGutterBadge(roster: CrewRosterSnapshot): { value: number | null; tone: 'default' | 'warning' } {
  const waiting = roster.members.reduce((sum, m) => sum + m.runtime.unreadCount, 0);
  const overBudget = roster.crewUsage.overBudget || roster.members.some((m) => m.runtime.usage.overBudget);
  const tone = overBudget ? 'warning' : 'default';
  if (waiting > 0) return { value: waiting, tone };
  return { value: overBudget ? 0 : null, tone };
}

/** What the user is looking at: a member's desk (slug) or the crew feed (null). */
export interface CrewSeenState {
  view: string | null;
  unread: number;
}

/**
 * Whether to tell the backend the user has seen the current view. Once when
 * the view changes, then again only when its unread count rises while it is
 * on screen (a new flag arrived). Unread also counts prompts waiting on an
 * answer, which marking seen cannot clear, so "above zero" would re-mark on
 * every poll; "rose since last look" does not.
 */
export function nextSeenState(
  previous: CrewSeenState | null,
  view: string | null,
  unread: number,
): { markSeen: boolean; state: CrewSeenState } {
  const changedView = previous === null || previous.view !== view;
  return { markSeen: changedView || unread > previous.unread, state: { view, unread } };
}

export const STATUS_LABEL: Record<CrewMemberStatus, string> = {
  idle: 'Idle',
  'on-shift': 'On shift',
  sleeping: 'Sleeping',
  'waiting-on-user': 'Waiting on you',
  'over-budget': 'Over budget',
  paused: 'Paused',
  error: 'Definition error',
};
