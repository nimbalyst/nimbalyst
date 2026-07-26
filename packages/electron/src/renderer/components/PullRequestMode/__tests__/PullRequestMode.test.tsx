// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import type { PullRequestRow } from '../../../services/RendererPullRequestService';
import {
  initPrModeLayout,
  prListAtom,
  prRemoteAtom,
  setPrModeLayoutAtom,
} from '../../../store/atoms/pullRequests';
import { windowModeAtom } from '../../../store/atoms/windowMode';
import { PullRequestMode } from '../PullRequestMode';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  loadSession: vi.fn(),
  createChatSession: vi.fn(),
  startPolling: vi.fn(),
  stopPolling: vi.fn(),
  setFocus: vi.fn(),
  pollNow: vi.fn(),
  emptyTrackerContext: { items: [], primary: null, sessions: [] as Array<{ id: string }> },
  trackerContextByPr: new Map<
    number,
    { items: unknown[]; primary: unknown; sessions: Array<{ id: string }> }
  >(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));

vi.mock('../../../store/actions/sessionHistoryActions', () => ({
  dispatchCreateNewSession: mocks.createSession,
  dispatchOpenWorktreeSession: vi.fn(),
}));

vi.mock('../../../services/RendererPullRequestService', () => ({
  getPullRequestService: () => ({
    startPolling: mocks.startPolling,
    stopPolling: mocks.stopPolling,
    setFocus: mocks.setFocus,
    pollNow: mocks.pollNow,
  }),
}));

vi.mock('../usePrTrackerContext', () => ({
  usePrTrackerReferences: () => new Map([[1408, [{ id: 'tracker-1' }]]]),
  usePrTrackerContext: (_workspacePath: string, _remote: string | null, prNumber: number) =>
    mocks.trackerContextByPr.get(prNumber) ?? mocks.emptyTrackerContext,
}));

vi.mock('../../ChatSidebar', async () => {
  const ReactModule = await import('react');
  return {
    ChatSidebar: ReactModule.forwardRef(function MockChatSidebar(
      props: { isCollapsed?: boolean },
      ref: React.ForwardedRef<unknown>,
    ) {
      ReactModule.useImperativeHandle(ref, () => ({
        focusInput: vi.fn(),
        insertPrompt: vi.fn(),
        loadSession: mocks.loadSession,
        createNewSession: mocks.createChatSession,
      }));
      return (
        <div
          data-testid="mock-chat-sidebar"
          data-collapsed={String(props.isCollapsed)}
        />
      );
    }),
  };
});

vi.mock('../../AgenticCoding/ResizablePanel', () => ({
  ResizablePanel: ({
    leftPanel,
    rightPanel,
  }: {
    leftPanel: React.ReactNode;
    rightPanel: React.ReactNode;
  }) => (
    <div>
      {leftPanel}
      {rightPanel}
    </div>
  ),
}));

vi.mock('../GhOnboardingBanner', () => ({ GhOnboardingBanner: () => null }));
vi.mock('../PullRequestSidebar', () => ({ PullRequestSidebar: () => null }));
vi.mock('../PullRequestListView', () => ({ PullRequestListView: () => null }));
vi.mock('../PullRequestDetail', () => ({
  PullRequestDetail: ({
    onStartReviewSession,
    onOpenSession,
  }: {
    onStartReviewSession: () => void;
    onOpenSession?: (sessionId: string) => void;
  }) => (
    <>
      <button data-testid="start-review" onClick={onStartReviewSession}>
        Review
      </button>
      <button data-testid="open-linked-session" onClick={() => onOpenSession?.('session-linked')}>
        Open linked
      </button>
    </>
  ),
}));

const pr: PullRequestRow = {
  id: 'pr-1408',
  workspaceId: '/workspace',
  remote: 'nimbalyst/nimbalyst',
  number: 1408,
  title: 'Add PR chat context',
  body: null,
  state: 'open',
  isDraft: false,
  authorLogin: 'octocat',
  authorAvatarUrl: null,
  headRef: 'feature/pr-chat',
  headSha: 'abc123',
  baseRef: 'main',
  mergeable: 'mergeable',
  commentsCount: 3,
  reviewCommentsCount: 2,
  additions: 42,
  deletions: 7,
  changedFiles: 5,
  ciStatus: 'success',
  reviewers: [],
  labels: [],
  raw: { html_url: 'https://github.com/nimbalyst/nimbalyst/pull/1408' },
  etag: null,
  createdAt: 1,
  updatedAt: 2,
  fetchedAt: 3,
};

const otherPr: PullRequestRow = { ...pr, id: 'pr-1409', number: 1409, title: 'Another PR' };

describe('PullRequestMode review session action', () => {
  const invoke = vi.fn();

  beforeEach(async () => {
    mocks.trackerContextByPr.clear();
    mocks.createSession.mockReset().mockResolvedValue('session-review');
    mocks.loadSession.mockReset();
    mocks.createChatSession.mockReset();
    mocks.startPolling.mockReset().mockResolvedValue(undefined);
    mocks.stopPolling.mockReset().mockResolvedValue(undefined);
    mocks.setFocus.mockReset();
    mocks.pollNow.mockReset().mockResolvedValue(undefined);
    invoke.mockReset().mockImplementation(async (channel: string) => {
      if (channel === 'workspace:get-state') {
        return {
          prModeLayout: {
            selectedItemId: 'pr-1408',
            chatCollapsed: true,
          },
        };
      }
      return { success: true };
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { invoke },
    });

    await initPrModeLayout('/workspace');
    store.set(prRemoteAtom, {
      workspacePath: '/workspace',
      remote: 'nimbalyst/nimbalyst',
      host: 'github.com',
    });
    store.set(prListAtom, [pr]);
    store.set(windowModeAtom, 'pr-review');
  });

  afterEach(() => {
    cleanup();
    store.set(prRemoteAtom, null);
    store.set(prListAtom, []);
  });

  it('creates and links a review session, opens it in the pane, and stays in PR mode', async () => {
    render(
      <JotaiProvider store={store}>
        <PullRequestMode
          workspacePath="/workspace"
          workspaceName="workspace"
          isActive
        />
      </JotaiProvider>,
    );

    fireEvent.click(screen.getByTestId('start-review'));

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith(
        '/review-contribution https://github.com/nimbalyst/nimbalyst/pull/1408',
      );
      expect(invoke).toHaveBeenCalledWith('tracker:link-session', {
        trackerId: 'tracker-1',
        sessionId: 'session-review',
      });
      expect(mocks.loadSession).toHaveBeenCalledWith('session-review');
    });
    expect(store.get(windowModeAtom)).toBe('pr-review');
    expect(
      screen.getByTestId('mock-chat-sidebar').getAttribute('data-collapsed'),
    ).toBe('false');
  });

  it('opens an already-linked session in the chat pane without leaving PR mode', async () => {
    render(
      <JotaiProvider store={store}>
        <PullRequestMode
          workspacePath="/workspace"
          workspaceName="workspace"
          isActive
        />
      </JotaiProvider>,
    );
    // Let mount effects (layout hydration, poll start) settle first — they
    // would otherwise land after the click and clobber the uncollapse.
    await act(async () => {});

    fireEvent.click(screen.getByTestId('open-linked-session'));

    await waitFor(() => {
      expect(mocks.loadSession).toHaveBeenCalledWith('session-linked');
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(store.get(windowModeAtom)).toBe('pr-review');
    expect(
      screen.getByTestId('mock-chat-sidebar').getAttribute('data-collapsed'),
    ).toBe('false');
  });
});

describe('PullRequestMode session follows PR selection', () => {
  const invoke = vi.fn();

  beforeEach(async () => {
    mocks.trackerContextByPr.clear();
    mocks.loadSession.mockReset();
    mocks.createSession.mockReset().mockResolvedValue('session-review');
    mocks.createChatSession.mockReset();
    mocks.startPolling.mockReset().mockResolvedValue(undefined);
    mocks.stopPolling.mockReset().mockResolvedValue(undefined);
    mocks.setFocus.mockReset();
    mocks.pollNow.mockReset().mockResolvedValue(undefined);
    invoke.mockReset().mockImplementation(async (channel: string) => {
      if (channel === 'workspace:get-state') {
        return { prModeLayout: { selectedItemId: 'pr-1408', chatCollapsed: false } };
      }
      return { success: true };
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { invoke },
    });

    await initPrModeLayout('/workspace');
    store.set(prRemoteAtom, {
      workspacePath: '/workspace',
      remote: 'nimbalyst/nimbalyst',
      host: 'github.com',
    });
    store.set(prListAtom, [pr, otherPr]);
    store.set(windowModeAtom, 'pr-review');
  });

  afterEach(() => {
    cleanup();
    store.set(prRemoteAtom, null);
    store.set(prListAtom, []);
  });

  function renderMode() {
    return render(
      <JotaiProvider store={store}>
        <PullRequestMode workspacePath="/workspace" workspaceName="workspace" isActive />
      </JotaiProvider>,
    );
  }

  it('loads the selected PR’s most recent linked session into the chat pane', async () => {
    mocks.trackerContextByPr.set(1408, {
      items: [],
      primary: null,
      sessions: [{ id: 'session-1408-newest' }, { id: 'session-1408-older' }],
    });

    renderMode();

    await waitFor(() => {
      expect(mocks.loadSession).toHaveBeenCalledWith('session-1408-newest');
    });
  });

  it('leaves the chat pane alone when the selected PR has no linked session', async () => {
    renderMode();
    await act(async () => {});

    expect(mocks.loadSession).not.toHaveBeenCalled();
  });

  it('follows the selection to another PR’s session', async () => {
    mocks.trackerContextByPr.set(1408, {
      items: [],
      primary: null,
      sessions: [{ id: 'session-1408' }],
    });
    mocks.trackerContextByPr.set(1409, {
      items: [],
      primary: null,
      sessions: [{ id: 'session-1409' }],
    });

    renderMode();
    await waitFor(() => {
      expect(mocks.loadSession).toHaveBeenCalledWith('session-1408');
    });

    await act(async () => {
      store.set(setPrModeLayoutAtom, { selectedItemId: 'pr-1409' });
    });

    await waitFor(() => {
      expect(mocks.loadSession).toHaveBeenCalledWith('session-1409');
    });
  });
});
