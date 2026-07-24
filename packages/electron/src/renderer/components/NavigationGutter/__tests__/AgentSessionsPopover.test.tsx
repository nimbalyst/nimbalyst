// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import type { SessionMeta } from '@nimbalyst/runtime';
import {
  sessionHasPendingInteractivePromptAtom,
  sessionListWorkspaceAtom,
  sessionProcessingAtom,
  sessionRegistryAtom,
  sessionUnreadAtom,
} from '../../../store/atoms/sessions';
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

afterEach(() => cleanup());

describe('AgentSessionsPopover', () => {
  it('uses a separate bubble click target and opens the grouped attention list', () => {
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
    expect(screen.getByTestId('agent-sessions-popover')).toBeTruthy();
    expect(screen.getByText('Awaiting input')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Unread')).toBeTruthy();
    expect(screen.getByTestId('agent-sessions-row-awaiting')).toBeTruthy();
    expect(screen.getByTestId('agent-sessions-row-running')).toBeTruthy();
    expect(screen.getByTestId('agent-sessions-row-unread')).toBeTruthy();

    fireEvent.click(screen.getByTestId('agent-sessions-mark-all-read'));
    expect(store.get(sessionUnreadAtom(unread.id))).toBe(false);
    expect(screen.queryByTestId('agent-sessions-row-unread')).toBeNull();
  });
});
