// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionDropdown } from '../SessionDropdown';

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
    expect(screen.getByText('Agent trust popup review')).toBeTruthy();
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
