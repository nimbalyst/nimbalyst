// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SessionWakeupView } from '../../atoms/sessions';
import { applyWakeupChange, groupActiveWakeups } from '../wakeupList';

function wakeup(id: string, fireAt: number, overrides: Partial<SessionWakeupView> = {}): SessionWakeupView {
  return {
    id,
    sessionId: 's1',
    workspaceId: '/w',
    prompt: id,
    reason: null,
    fireAt,
    status: 'pending',
    createdAt: 0,
    firedAt: null,
    error: null,
    ...overrides,
  };
}

describe('applyWakeupChange', () => {
  it('drops a cancelled row and keeps the session\'s other schedules', () => {
    const list = [wakeup('a', 1), wakeup('b', 2), wakeup('c', 3)];
    const next = applyWakeupChange(list, wakeup('b', 2, { status: 'cancelled' }));
    expect(next.map((w) => w.id)).toEqual(['a', 'c']);
  });

  it('updates a row in place and keeps the list soonest first', () => {
    const list = [wakeup('a', 1), wakeup('b', 5)];
    const next = applyWakeupChange(list, wakeup('b', 0, { status: 'firing' }));
    expect(next.map((w) => [w.id, w.status])).toEqual([['b', 'firing'], ['a', 'pending']]);
  });
});

describe('groupActiveWakeups', () => {
  it('keeps every active wakeup per session, sorted, and skips inactive rows', () => {
    const grouped = groupActiveWakeups([
      wakeup('late', 9),
      wakeup('other', 1, { sessionId: 's2' }),
      wakeup('early', 2),
      wakeup('done', 0, { status: 'fired' }),
    ]);
    expect(grouped.get('s1')?.map((w) => w.id)).toEqual(['early', 'late']);
    expect(grouped.get('s2')?.map((w) => w.id)).toEqual(['other']);
  });
});
