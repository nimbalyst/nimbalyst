// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionDropdown } from '../SessionDropdown';
import { requestConfirmation } from '../../../dialogs/requestConfirmation';

vi.mock('../../../dialogs/requestConfirmation', () => ({ requestConfirmation: vi.fn() }));

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
  ProviderIcon: () => null,
  formatDate: (v: unknown) => String(v),
}));

vi.mock('../../../utils/modelUtils', () => ({
  parseModelInfo: () => null,
  getProviderLabel: (p: string) => p,
}));

vi.mock('../../../store', async () => {
  const { atom } = await import('jotai');
  const off = atom(false);
  return {
    sessionProcessingAtom: () => off,
    sessionUnreadAtom: () => off,
  };
});

// Controllable, jsdom-friendly stand-in for the floating menu hook.
vi.mock('../../../hooks/useFloatingMenu', async () => {
  const React = await import('react');
  return {
    FloatingPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useFloatingMenu: () => {
      const [isOpen, setIsOpen] = React.useState(false);
      return {
        isOpen,
        setIsOpen,
        refs: { setReference: () => {}, setFloating: () => {} },
        floatingStyles: {},
        getReferenceProps: () => ({}),
        getFloatingProps: () => ({}),
      };
    },
  };
});

const baseProps = {
  currentSessionId: 's1',
  sessions: [
    { id: 's1', createdAt: 1, title: 'Agent trust popup review', provider: 'claude-code' },
    { id: 's2', createdAt: 2, title: 'Draft release notes', provider: 'claude-code' },
  ],
  onSessionSelect: vi.fn(),
  onDeleteSession: vi.fn(),
};

afterEach(cleanup);

describe('SessionDropdown new-session affordance', () => {
  it('shows the current session name in the trigger', () => {
    render(<SessionDropdown {...baseProps} onNewSession={vi.fn()} />);
    screen.getByText('Agent trust popup review');
  });

  it('creates a new session from the menu row and closes the menu', () => {
    const onNewSession = vi.fn();
    render(<SessionDropdown {...baseProps} onNewSession={onNewSession} />);

    // Open the dropdown.
    fireEvent.click(screen.getByTitle('Session History'));

    const newRow = screen.getByText('New session');
    fireEvent.click(newRow);

    expect(onNewSession).toHaveBeenCalledTimes(1);
    // Menu closed → row is gone.
    expect(screen.queryByText('New session')).toBeNull();
  });
});

describe('SessionDropdown delete', () => {
  it('deletes only after the in-app confirmation is accepted', async () => {
    const onDeleteSession = vi.fn();
    const confirmMock = vi.mocked(requestConfirmation);
    render(<SessionDropdown {...baseProps} onNewSession={vi.fn()} onDeleteSession={onDeleteSession} />);
    fireEvent.click(screen.getByTitle('Session History'));

    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(screen.getAllByTitle('Delete')[0]);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(onDeleteSession).not.toHaveBeenCalled();

    confirmMock.mockResolvedValueOnce(true);
    fireEvent.click(screen.getAllByTitle('Delete')[0]);
    await waitFor(() => expect(onDeleteSession).toHaveBeenCalledTimes(1));
  });
});
