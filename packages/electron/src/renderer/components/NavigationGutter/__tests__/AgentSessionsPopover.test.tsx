// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import type { SessionMeta } from '@nimbalyst/runtime';
import {
  sessionHasPendingInteractivePromptAtom,
  sessionListWorkspaceAtom,
  sessionProcessingAtom,
  sessionRegistryAtom,
  sessionUnreadAtom,
} from '../../../store/atoms/sessions';
import { settingAtom } from '../../../store/atoms/settingAtomFamily';
import { AgentSessionsPopover } from '../AgentSessionsPopover';

vi.mock('@nimbalyst/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nimbalyst/runtime')>();
  return {
    ...actual,
    MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
    ProviderIcon: ({ provider }: { provider: string }) => <span>{provider}</span>,
  };
});

vi.mock('../../AgenticCoding/SessionListItem', () => ({
  SessionStatusIndicator: ({ sessionId }: { sessionId: string }) => <span data-testid={`status-${sessionId}`} />,
}));

vi.mock('../../AgenticCoding/SessionTranscriptPeek', () => ({
  SessionTranscriptPeek: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="mock-session-transcript-peek" data-session-id={sessionId} />
  ),
}));

vi.mock('../../../help', () => ({
  HelpTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../../hooks/useFloatingMenu', async () => {
  const ReactModule = await import('react');
  return {
    FloatingPortal: ({ children }: { children: React.ReactNode }) => children,
    useFloatingMenu: () => {
      const [isOpen, setIsOpen] = ReactModule.useState(false);
      return {
        isOpen,
        setIsOpen,
        refs: { setReference: () => undefined, setFloating: () => undefined },
        floatingStyles: {},
        getReferenceProps: () => ({}),
        getFloatingProps: () => ({}),
      };
    },
  };
});

const WORKSPACE = '/workspace/current';

function session(id: string): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    sessionType: 'session',
    workspaceId: WORKSPACE,
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    isArchived: false,
    isPinned: false,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AgentSessionsPopover', () => {
  it('uses a separate bubble click target and opens the grouped attention list', () => {
    vi.useFakeTimers();
    const store = createStore();
    const awaiting = session('awaiting');
    const running = session('running');
    const unread = session('unread');
    store.set(sessionListWorkspaceAtom, WORKSPACE);
    store.set(sessionRegistryAtom, new Map([
      [awaiting.id, awaiting],
      [running.id, running],
      [unread.id, unread],
    ]));
    store.set(sessionHasPendingInteractivePromptAtom(awaiting.id), true);
    store.set(sessionProcessingAtom(running.id), true);
    store.set(sessionUnreadAtom(unread.id), true);
    const onOpenAgentMode = vi.fn();

    render(
      <JotaiProvider store={store}>
        <div className="relative">
          <AgentSessionsPopover onOpenAgentMode={onOpenAgentMode} />
        </div>
      </JotaiProvider>,
    );

    const bubble = screen.getByTestId('agent-sessions-bubble');
    expect(bubble.getAttribute('data-state')).toBe('orange');
    expect(bubble.textContent).toBe('1');

    fireEvent.click(bubble);

    expect(onOpenAgentMode).not.toHaveBeenCalled();
    screen.getByTestId('agent-sessions-popover');
    screen.getByText('Awaiting input');
    screen.getByText('Running');
    screen.getByText('Unread');
    screen.getByTestId('agent-sessions-row-awaiting');
    screen.getByTestId('agent-sessions-row-running');
    screen.getByTestId('agent-sessions-row-unread');

    const awaitingPeek = screen.getByTestId('agent-sessions-peek-awaiting');
    fireEvent.click(awaitingPeek);
    expect(onOpenAgentMode).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-session-transcript-peek').getAttribute('data-session-id')).toBe('awaiting');

    fireEvent.click(awaitingPeek);
    expect(screen.queryByTestId('mock-session-transcript-peek')).toBeNull();

    fireEvent.mouseEnter(awaitingPeek);
    act(() => vi.advanceTimersByTime(299));
    expect(screen.queryByTestId('mock-session-transcript-peek')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId('mock-session-transcript-peek').getAttribute('data-session-id')).toBe('awaiting');

    fireEvent.click(screen.getByTestId('agent-sessions-mark-all-read'));
    expect(store.get(sessionUnreadAtom(unread.id))).toBe(false);
    expect(screen.queryByTestId('agent-sessions-row-unread')).toBeNull();
  });

  it('persists the popover width after a resize drag', () => {
    const store = createStore();
    const running = session('running');
    store.set(sessionListWorkspaceAtom, WORKSPACE);
    store.set(sessionRegistryAtom, new Map([[running.id, running]]));
    store.set(sessionProcessingAtom(running.id), true);
    store.set(settingAtom('agent.sessionsPopoverWidth'), 420);

    render(
      <JotaiProvider store={store}>
        <AgentSessionsPopover onOpenAgentMode={vi.fn()} />
      </JotaiProvider>,
    );

    fireEvent.click(screen.getByTestId('agent-sessions-bubble'));
    const popover = screen.getByTestId('agent-sessions-popover');
    expect(popover.style.width).toBe('420px');

    // jsdom has no PointerEvent, so drive the drag with MouseEvents of the
    // pointer types — React and the window listeners both accept them.
    const pointer = (type: string, clientX: number) =>
      new MouseEvent(type, { clientX, bubbles: true });

    const handle = screen.getByTestId('agent-sessions-popover-resize');
    act(() => { handle.dispatchEvent(pointer('pointerdown', 420)); });
    act(() => { window.dispatchEvent(pointer('pointermove', 560)); });
    expect(popover.style.width).toBe('560px');

    act(() => { window.dispatchEvent(pointer('pointerup', 560)); });
    expect(store.get(settingAtom('agent.sessionsPopoverWidth'))).toBe(560);

    // Dragging below the floor clamps instead of collapsing the popover.
    act(() => { handle.dispatchEvent(pointer('pointerdown', 560)); });
    act(() => { window.dispatchEvent(pointer('pointermove', 100)); });
    act(() => { window.dispatchEvent(pointer('pointerup', 100)); });
    expect(store.get(settingAtom('agent.sessionsPopoverWidth'))).toBe(280);
  });
});
