// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// Keep the component isolated, same setup as the sibling SessionListItem tests:
// jotai atom reads return defaults, the store atom families are callable stubs,
// and heavy children are stubbed so importing them has no side effects.
vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jotai')>()),
  useAtomValue: () => undefined,
  useSetAtom: () => () => {},
}));
vi.mock('@nimbalyst/runtime', () => ({ MaterialSymbol: () => null, ProviderIcon: () => null }));
vi.mock('../../../store', () => ({
  sessionOrChildProcessingAtom: () => ({}),
  sessionUnreadAtom: () => ({}),
  sessionPendingPromptAtom: () => ({}),
  sessionHasPendingInteractivePromptAtom: () => ({}),
  reparentSessionAtom: () => ({}),
  refreshSessionListAtom: () => ({}),
  sessionShareAtom: () => ({}),
  sessionWakeupAtom: () => ({}),
  sessionLastActivityAtom: () => ({}),
}));
vi.mock('../../../store/atoms/sessions', () => ({ convertToWorkstreamAtom: () => ({}) }));
vi.mock('../../../store/atoms/teamInbox', () => ({ sessionAgentWakePendingAtom: () => ({}) }));
vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));

import { SessionListItem } from '../SessionListItem';

const baseProps = {
  id: 's1',
  isActive: false,
  onClick: () => {},
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SessionListItem - relative time keeps ticking on an idle session (#1200)', () => {
  it('advances the "X ago" label as time passes without new activity', () => {
    vi.useFakeTimers();
    const base = 1_700_000_000_000;
    vi.setSystemTime(base);

    // Session last touched 30s ago -> "Just now" at first paint.
    const { container } = render(
      <SessionListItem {...baseProps} title="Idle session" createdAt={base - 30_000} />,
    );
    const label = () => container.querySelector('.session-list-item-datetime')?.textContent;
    expect(label()).toBe('Just now');

    // One minute passes with no new activity. The per-minute tick must re-render
    // so the label reflects real elapsed time (now 90s old -> "1 min ago").
    // Before the fix there is no interval, so the label stays frozen at "Just now".
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(label()).toBe('1 min ago');
  });
});
