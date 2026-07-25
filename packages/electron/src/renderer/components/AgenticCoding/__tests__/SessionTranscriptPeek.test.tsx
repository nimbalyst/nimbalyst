// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime';
import { sessionRegistryAtom } from '../../../store/atoms/sessions';
import { transcriptEventSignalAtom } from '../../../store/atoms/sessionTranscript';
import { SessionTranscriptPeek } from '../SessionTranscriptPeek';

vi.mock('@floating-ui/react', () => ({
  autoUpdate: vi.fn(),
  flip: vi.fn(() => ({ name: 'flip' })),
  FloatingPortal: ({ children }: { children: React.ReactNode }) => children,
  offset: vi.fn(() => ({ name: 'offset' })),
  shift: vi.fn(() => ({ name: 'shift' })),
  useDismiss: vi.fn(() => ({})),
  useFloating: vi.fn(() => ({
    refs: {
      setReference: vi.fn(),
      setFloating: vi.fn(),
    },
    floatingStyles: {},
    context: {},
  })),
  useInteractions: vi.fn(() => ({
    getFloatingProps: () => ({}),
  })),
  useRole: vi.fn(() => ({})),
}));

vi.mock('@nimbalyst/runtime/ui/AgentTranscript/components/RichTranscriptView', () => ({
  RichTranscriptView: ({
    sessionId,
    messages,
    persistScrollState,
  }: {
    sessionId: string;
    messages: Array<{ content?: string }>;
    persistScrollState: boolean;
  }) => (
    <div
      data-testid="mock-rich-transcript"
      data-session-id={sessionId}
      data-persist-scroll-state={String(persistScrollState)}
    >
      {messages.map((message) => message.content).join('|')}
    </div>
  ),
}));

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    sessionType: 'session',
    workspaceId: '/workspace',
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
    ...overrides,
  };
}

describe('SessionTranscriptPeek', () => {
  let anchor: HTMLButtonElement;
  let getTailMessages: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    anchor = document.createElement('button');
    document.body.appendChild(anchor);
    getTailMessages = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ai: {
          getTailMessages,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    anchor.remove();
    vi.useRealTimers();
  });

  it('fetches the transcript tail and refreshes after live transcript activity', async () => {
    vi.useFakeTimers();
    const store = createStore();
    const meta = session('live-session');
    store.set(sessionRegistryAtom, new Map([[meta.id, meta]]));
    getTailMessages
      .mockResolvedValueOnce([{ content: 'initial response' }])
      .mockResolvedValueOnce([{ content: 'updated response' }]);

    render(
      <JotaiProvider store={store}>
        <SessionTranscriptPeek
          sessionId={meta.id}
          reference={anchor}
          onClose={vi.fn()}
        />
      </JotaiProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(getTailMessages).toHaveBeenCalledWith(meta.id, 100);
    expect(screen.getByTestId('mock-rich-transcript').textContent).toBe('initial response');
    expect(screen.getByTestId('mock-rich-transcript').getAttribute('data-persist-scroll-state')).toBe('false');

    act(() => {
      store.set(transcriptEventSignalAtom(meta.id), 1);
    });
    expect(getTailMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
    });
    expect(getTailMessages).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('mock-rich-transcript').textContent).toBe('updated response');
  });

  it('previews the most recently updated child for a workstream card', async () => {
    const store = createStore();
    const parent = session('workstream', {
      sessionType: 'workstream',
      childCount: 2,
    });
    const olderChild = session('older-child', {
      parentSessionId: parent.id,
      updatedAt: 10,
    });
    const newerChild = session('newer-child', {
      parentSessionId: parent.id,
      updatedAt: 20,
    });
    store.set(sessionRegistryAtom, new Map([
      [parent.id, parent],
      [olderChild.id, olderChild],
      [newerChild.id, newerChild],
    ]));
    getTailMessages.mockResolvedValue([{ content: 'newest child transcript' }]);

    render(
      <JotaiProvider store={store}>
        <SessionTranscriptPeek
          sessionId={parent.id}
          reference={anchor}
          placement="right-start"
          onClose={vi.fn()}
        />
      </JotaiProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(getTailMessages).toHaveBeenCalledWith(newerChild.id, 100);
    expect(screen.getByTestId('session-transcript-peek').getAttribute('data-session-id')).toBe(newerChild.id);
    expect(screen.getByTestId('mock-rich-transcript').textContent).toBe('newest child transcript');
  });
});
