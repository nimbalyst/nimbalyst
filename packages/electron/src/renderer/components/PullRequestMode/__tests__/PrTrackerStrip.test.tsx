// @vitest-environment jsdom
/**
 * PrTrackerStrip linked-session presentation: session chips (live title +
 * provider glyph), not a generic "Session" button.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { sessionRefMapAtom } from '@nimbalyst/runtime';
import type { SessionMeta } from '../../../store/atoms/sessions';

const openSessionInTab = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../store/actions/sessionHistoryActions', () => ({
  dispatchOpenSessionInTab: openSessionInTab,
}));

const { PrTrackerStrip } = await import('../PrTrackerStrip');

function session(id: string, title: string, provider: string): SessionMeta {
  return { id, title, provider } as SessionMeta;
}

const onOpenSession = vi.fn();

function renderStrip(sessions: SessionMeta[], hostHandler?: (id: string) => void) {
  const store = createStore();
  store.set(
    sessionRefMapAtom,
    new Map(sessions.map((s) => [s.id, { id: s.id, title: s.title, provider: s.provider }])),
  );
  return render(
    <JotaiProvider store={store}>
      <PrTrackerStrip
        remote="nimbalyst/nimbalyst"
        prNumber={978}
        context={{ items: [], primary: null, sessions }}
        onOpenSession={hostHandler}
      />
    </JotaiProvider>,
  );
}

afterEach(() => {
  cleanup();
  openSessionInTab.mockClear();
  onOpenSession.mockClear();
});

describe('PrTrackerStrip linked sessions', () => {
  it('renders a linked session as a titled chip with its provider glyph', () => {
    renderStrip([session('s-1', 'PR 978 contribution review', 'claude-code')], onOpenSession);

    expect(screen.getByText('PR 978 contribution review')).toBeTruthy();
    expect(screen.queryByText('Session')).toBeNull();
    const chip = document.querySelector('.session-reference-chip');
    expect(chip?.getAttribute('data-session-id')).toBe('s-1');
    expect(
      chip?.querySelector('.session-reference-chip-icon')?.getAttribute('data-provider'),
    ).toBe('claude-code');
  });

  it('hands the click to the host so the session opens in the PR chat pane', () => {
    renderStrip([session('s-1', 'PR 978 contribution review', 'claude-code')], onOpenSession);

    fireEvent.click(screen.getByText('PR 978 contribution review'));

    expect(onOpenSession).toHaveBeenCalledWith('s-1');
    // Staying in PR mode is the point — no agent-mode tab handoff.
    expect(openSessionInTab).not.toHaveBeenCalled();
  });

  it('falls back to opening the session in an agent tab without a host handler', () => {
    renderStrip([session('s-1', 'PR 978 contribution review', 'claude-code')]);

    fireEvent.click(screen.getByText('PR 978 contribution review'));

    expect(openSessionInTab).toHaveBeenCalledWith('s-1');
  });

  it('collapses sessions past the inline limit into a +N overflow', () => {
    renderStrip(
      [
        session('s-1', 'First review', 'claude-code'),
        session('s-2', 'Second review', 'openai-codex'),
        session('s-3', 'Third review', 'claude-code'),
      ],
      onOpenSession,
    );

    expect(screen.getByText('First review')).toBeTruthy();
    expect(screen.getByText('Second review')).toBeTruthy();
    expect(screen.queryByText('Third review')).toBeNull();

    fireEvent.click(screen.getByTestId('pr-open-session'));

    expect(screen.getByText('Third review')).toBeTruthy();
  });
});
