// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CrewFeedEntry, CrewMemberSnapshot } from '../../shared/types';
import { buildCrewFeed, mergeFeedEntries } from '../crewFeedModel';
import { crewGutterBadge, deriveShiftAction, nextSeenState, splitChapters } from '../crewDeskModel';
import { formatScheduleTiming } from '../crewFormat';
import { DESK_PANEL_WIDTH, readCrewPaneLayout, ROSTER_WIDTH } from '../crewPaneLayout';

function entry(id: string, at: string, kind: CrewFeedEntry['kind'], level?: CrewFeedEntry['level']): CrewFeedEntry {
  return { id, memberSlug: 'ada', at, kind, title: id, body: '', level };
}

function member(slug: string, name: string, overrides: Partial<CrewMemberSnapshot['runtime']> = {}, paused?: boolean): CrewMemberSnapshot {
  return {
    definition: {
      slug, name, role: 'Architect', color: '#777', provider: 'claude-code', model: 'opus',
      personality: '', directive: '', schedule: [], notify: { maxLevel: 'flag' },
      budget: { tokensPerWeek: 1000, shiftsPerDay: 3 }, paused, sourcePath: `/crew/${slug}.md`,
    },
    runtime: {
      status: 'idle', statusDetail: '', errors: [], onShift: false, unreadCount: 0, pendingInboxCount: 0,
      definitionChangedSinceChapter: false,
      usage: {
        source: 'ledger', tokensThisWeek: 0, tokensToday: 0, tokensPerWeekLimit: 1000, dailyCeiling: 333,
        shiftsToday: 0, shiftsPerDayLimit: 3, overBudget: false,
      },
      ...overrides,
    },
  };
}

describe('buildCrewFeed', () => {
  it('pins members waiting on the user, and partitions journal entries into exactly one segment', () => {
    const entries = [
      entry('page', '2026-09-28T03:00:00Z', 'flag', 'page'),
      entry('standup', '2026-09-28T04:00:00Z', 'flag', 'note'),
      entry('shift', '2026-09-28T05:00:00Z', 'shift'),
      entry('journal', '2026-09-28T06:00:00Z', 'journal'),
      entry('budget', '2026-09-28T01:00:00Z', 'budget'),
    ];
    const members = [
      member('zed', 'Zed', { status: 'waiting-on-user' }),
      member('bo', 'Bo'),
      member('ada', 'Ada', { status: 'waiting-on-user' }),
    ];

    const all = buildCrewFeed(entries, members, 'all');
    expect(all.waiting.map((m) => m.definition.slug)).toEqual(['ada', 'zed']);
    expect(all.stream.map((e) => e.id)).toEqual(['journal', 'shift', 'standup', 'page', 'budget']);

    const ids = (filter: 'flags' | 'summaries' | 'activity') => buildCrewFeed(entries, members, filter).stream.map((e) => e.id).sort();
    const segments = [ids('flags'), ids('summaries'), ids('activity')];
    // A note-level flag is a standup: it reads with summaries, not with flags.
    expect(segments).toEqual([['page'], ['shift', 'standup'], ['budget', 'journal']]);
    expect(segments.flat().sort()).toEqual(all.stream.map((e) => e.id).sort());
    // Open questions are not reporting.
    expect(buildCrewFeed(entries, members, 'summaries').waiting).toEqual([]);
  });

  it('keeps older pages across a refresh that only returns the newest page', () => {
    const older = [entry('a', '2026-09-20T00:00:00Z', 'journal'), entry('b', '2026-09-21T00:00:00Z', 'journal')];
    let held = mergeFeedEntries([], [entry('c', '2026-09-28T00:00:00Z', 'journal')]);
    held = mergeFeedEntries(held, older);
    const corrected = { ...entry('c', '2026-09-28T00:00:00Z', 'journal'), title: 'corrected' };
    held = mergeFeedEntries(held, [entry('d', '2026-09-28T09:00:00Z', 'shift'), corrected]);

    expect(held.map((e) => e.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(held.find((e) => e.id === 'c')?.title).toBe('corrected');
  });
});

describe('desk derivations', () => {
  it('always lets a member on shift be released, and names what blocks a start', () => {
    // On shift wins even over pause: pausing mid-shift must not strand the shift.
    expect(deriveShiftAction(member('ada', 'Ada', { onShift: true, status: 'on-shift' }, true))).toEqual({ kind: 'end' });
    expect(deriveShiftAction(member('ada', 'Ada', {}, true)))
      .toMatchObject({ kind: 'start', blockedReason: expect.stringContaining('Unpause') });
    const overBudget = member('ada', 'Ada', {
      usage: { ...member('x', 'X').runtime.usage, overBudget: true, overBudgetReason: "today's shift limit reached" },
    });
    expect(deriveShiftAction(overBudget)).toEqual({ kind: 'start', blockedReason: "today's shift limit reached" });
    expect(deriveShiftAction(member('ada', 'Ada'))).toEqual({ kind: 'start' });
  });

  it('prefers the roster current chapter over a stale isCurrent flag, earlier chapters oldest first', () => {
    const chapter = (sessionId: string, chapterIndex: number, isCurrent = false) =>
      ({ sessionId, chapterIndex, startedAt: '2026-09-01T00:00:00Z', isCurrent });
    // The chapter list still marks chapter 2 current; the roster already rolled to 3.
    const split = splitChapters([chapter('s2', 2, true), chapter('s3', 3), chapter('s1', 1)], 's3');
    expect(split.current?.sessionId).toBe('s3');
    expect(split.earlier.map((c) => c.chapterIndex)).toEqual([1, 2]);
    expect(splitChapters([chapter('s1', 1, true)], undefined).current?.sessionId).toBe('s1');
  });

  it('badges the gutter with waiting items, and still shows an over-budget crew with nothing waiting', () => {
    const roster = (members: CrewMemberSnapshot[], overBudget = false) => ({
      members, allPaused: false, revision: 1, generatedAt: '',
      crewUsage: { source: 'ledger' as const, tokensThisWeek: 0, tokensPerWeekLimit: 0, overBudget },
    });
    const broke = member('bo', 'Bo', { usage: { ...member('x', 'X').runtime.usage, overBudget: true } });
    expect(crewGutterBadge(roster([member('ada', 'Ada', { unreadCount: 2 }), member('zed', 'Zed', { unreadCount: 1 })])))
      .toEqual({ value: 3, tone: 'default' });
    expect(crewGutterBadge(roster([member('ada', 'Ada')]))).toEqual({ value: null, tone: 'default' });
    expect(crewGutterBadge(roster([broke]))).toEqual({ value: 0, tone: 'warning' });
    expect(crewGutterBadge(roster([member('ada', 'Ada')], true))).toEqual({ value: 0, tone: 'warning' });
  });

  it('marks a view seen on open and on new unread, not on every poll while a prompt stays unanswered', () => {
    let step = nextSeenState(null, 'ada', 3);
    expect(step.markSeen).toBe(true);
    // Flags cleared; one question is still open, so unread settles at 1 and stays there.
    step = nextSeenState(step.state, 'ada', 1);
    expect(step.markSeen).toBe(false);
    step = nextSeenState(step.state, 'ada', 1);
    expect(step.markSeen).toBe(false);
    // A new flag while the desk is on screen.
    step = nextSeenState(step.state, 'ada', 2);
    expect(step.markSeen).toBe(true);
    // Switching to the feed is a new look even with the same count.
    expect(nextSeenState(step.state, null, 2).markSeen).toBe(true);
  });

  it('formats weekly schedules in week order and collapses Monday-Friday', () => {
    expect(formatScheduleTiming({ prompt: '', weekly: { days: ['friday', 'monday', 'wednesday', 'thursday', 'tuesday'], time: '09:00' } }))
      .toBe('Weekdays 09:00');
    expect(formatScheduleTiming({ prompt: '', weekly: { days: ['sunday', 'monday'], time: '16:00' } })).toBe('Mon, Sun 16:00');
  });
});

describe('readCrewPaneLayout', () => {
  it('restores a stored layout, clamping widths and defaulting anything missing or malformed', () => {
    expect(readCrewPaneLayout(undefined)).toEqual({
      rosterWidth: ROSTER_WIDTH.initial, rosterCollapsed: false,
      deskPanelWidth: DESK_PANEL_WIDTH.initial, deskPanelCollapsed: false,
    });
    expect(readCrewPaneLayout({ rosterWidth: 9999, rosterCollapsed: true, deskPanelWidth: 'wide', deskPanelCollapsed: 'yes' })).toEqual({
      rosterWidth: ROSTER_WIDTH.max, rosterCollapsed: true,
      deskPanelWidth: DESK_PANEL_WIDTH.initial, deskPanelCollapsed: false,
    });
  });
});
