// @vitest-environment jsdom
/**
 * A host-driven loadSession (the PR pane pointing the chat at the selected PR's
 * session) must survive mount-time auto-init, which resolves ~100ms later and
 * would otherwise snap back to the most recent chat session.
 */
import React, { createRef } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSidebar, type ChatSidebarRef } from '../ChatSidebar';

vi.mock('../../../store', async () => {
  const { atom } = await import('jotai');
  return {
    sessionListChatAtom: atom([]),
    refreshSessionListAtom: atom(null, () => {}),
    initSessionList: vi.fn(),
  };
});

vi.mock('../../../store/atoms/appSettings', async () => {
  const { atom } = await import('jotai');
  return {
    defaultAgentModelAtom: atom('claude-code:sonnet'),
  };
});

vi.mock('../../UnifiedAI/SessionTranscript', () => ({
  SessionTranscript: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="session-transcript" data-session-id={sessionId} />
  ),
}));

vi.mock('../../AIChat/SessionDropdown', () => ({
  SessionDropdown: () => null,
}));

describe('ChatSidebar loadSession vs auto-init', () => {
  beforeEach(() => {
    (window as any).electronAPI = {
      invoke: vi.fn().mockImplementation(async (channel: string) => {
        if (channel === 'sessions:list') {
          return {
            success: true,
            sessions: [{ id: 'most-recent-chat', worktreeId: null, childCount: 0 }],
          };
        }
        return { success: true };
      }),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps a host-loaded session instead of the auto-selected most recent one', async () => {
    const ref = createRef<ChatSidebarRef>();
    const view = render(<ChatSidebar ref={ref} workspacePath="/workspace" />);

    // Load before auto-init's 100ms wait resolves — the PR pane's selection.
    act(() => {
      ref.current?.loadSession('pr-linked-session');
    });

    await waitFor(() => {
      expect(view.getByTestId('chat-sidebar-panel')).toBeTruthy();
    });
    expect(view.getByTestId('session-transcript').getAttribute('data-session-id')).toBe(
      'pr-linked-session',
    );
  });

  it('still auto-selects the most recent session when the host loads nothing', async () => {
    const view = render(<ChatSidebar workspacePath="/workspace" />);

    await waitFor(() => {
      expect(view.getByTestId('session-transcript').getAttribute('data-session-id')).toBe(
        'most-recent-chat',
      );
    });
  });
});
