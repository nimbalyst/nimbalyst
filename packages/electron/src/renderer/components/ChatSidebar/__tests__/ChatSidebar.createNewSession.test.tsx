// @vitest-environment jsdom
import React, { createRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
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

describe('ChatSidebar createNewSession ref action', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: vi.fn(() => 'new-chat-session'),
    });
    (window as any).electronAPI = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('creates a chat session while the panel is hidden', async () => {
    const ref = createRef<ChatSidebarRef>();
    render(
      <ChatSidebar
        ref={ref}
        workspacePath="/workspace"
        isActive={false}
      />,
    );

    await act(async () => {
      await ref.current?.createNewSession();
    });

    expect(window.electronAPI.invoke).toHaveBeenCalledWith(
      'sessions:create',
      {
        session: {
          id: 'new-chat-session',
          provider: 'claude-code',
          model: 'claude-code:sonnet',
          title: 'Chat',
        },
        workspaceId: '/workspace',
      },
    );
  });

  it('uses a controlled session without auto-selecting or creating another session', () => {
    const view = render(
      <ChatSidebar
        workspacePath="/workspace"
        sessionId="paired-chat"
        autoInitializeSession={false}
        linkedSession={{ id: 'source-session', title: 'Source session' }}
      />,
    );

    expect(view.getByTestId('chat-sidebar-panel').getAttribute('data-session-id')).toBe(
      'paired-chat',
    );
    expect(view.getByTestId('session-transcript').getAttribute('data-session-id')).toBe(
      'paired-chat',
    );
    expect(
      view.getByTestId('chat-sidebar-linked-session').getAttribute('data-linked-session-id'),
    ).toBe('source-session');
    expect(window.electronAPI.invoke).not.toHaveBeenCalled();
  });

  it('creates a normal linked chat and reports its controlled session id', async () => {
    const ref = createRef<ChatSidebarRef>();
    const onSessionIdChange = vi.fn();
    render(
      <ChatSidebar
        ref={ref}
        workspacePath="/workspace"
        sessionId={null}
        onSessionIdChange={onSessionIdChange}
        autoInitializeSession={false}
        newSessionTitle="Chat with Source"
        newSessionDraft="Regarding @@[Source](source-session): "
      />,
    );

    await act(async () => {
      await ref.current?.createNewSession();
    });

    expect(window.electronAPI.invoke).toHaveBeenNthCalledWith(
      1,
      'sessions:create',
      {
        session: {
          id: 'new-chat-session',
          provider: 'claude-code',
          model: 'claude-code:sonnet',
          title: 'Chat with Source',
        },
        workspaceId: '/workspace',
      },
    );
    expect(window.electronAPI.invoke).toHaveBeenNthCalledWith(
      2,
      'sessions:update-draft-input',
      'new-chat-session',
      'Regarding @@[Source](source-session): ',
    );
    expect(onSessionIdChange).toHaveBeenCalledWith('new-chat-session');
  });
});
