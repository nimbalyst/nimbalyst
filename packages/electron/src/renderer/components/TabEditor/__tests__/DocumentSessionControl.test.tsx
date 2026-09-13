import {workspaceFileLinksRevisionAtom} from '../../../store/atoms/sessionFiles';
// @vitest-environment jsdom
/**
 * The header-bar session control: a chip for the last session that touched the
 * file (caret opens the menu, the chip itself opens the session), degrading to
 * the sparkle icon when no session has.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { sessionRefMapAtom } from '@nimbalyst/runtime/ui/AgentTranscript/session/sessionRefAtoms';
import {
  DocumentSessionControl,
  type DocumentSessionActions,
  type FileSession,
} from '../DocumentSessionControl';

const WORKSPACE = '/Users/dev/proj';
const DOC = `${WORKSPACE}/docs/foo.md`;

const invoke = vi.fn().mockResolvedValue([]);

function fileSession(overrides: Partial<FileSession> & Pick<FileSession, 'id'>): FileSession {
  return {
    title: overrides.id,
    provider: 'claude-code',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    isCurrentWorkspace: true,
    ...overrides,
  };
}

function renderControl(options: { actions?: DocumentSessionActions; registryTitle?: string; store?: ReturnType<typeof createStore> } = {}) {
  const store = options.store ?? createStore();
  if (options.registryTitle) {
    store.set(
      sessionRefMapAtom,
      new Map([['newest', { id: 'newest', title: options.registryTitle, provider: 'claude-code' }]]),
    );
  }
  return render(
    <JotaiProvider store={store}>
      <DocumentSessionControl filePath={DOC} workspaceId={WORKSPACE} actions={options.actions} />
    </JotaiProvider>,
  );
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = { invoke };
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  invoke.mockResolvedValue([]);
});

describe('DocumentSessionControl', () => {
  it('shows the sparkle icon, not a chip, when no session has touched the file', async () => {
    renderControl();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:get-by-file', WORKSPACE, DOC));
    screen.getByTestId('ai-sessions-button');
    expect(screen.queryByTestId('document-session-chip')).toBeNull();
  });

  it('chips the most recent session even when the handler sorts another first', async () => {
    // The handler puts current-workspace sessions first, which is not the same
    // as most-recent: here the newest session lives in another worktree.
    invoke.mockResolvedValue([
      fileSession({ id: 'local-older', title: 'Older local pass', updatedAt: 10 }),
      fileSession({ id: 'newest', title: 'Newest worktree pass', updatedAt: 30, isCurrentWorkspace: false }),
    ]);
    const openInChat = vi.fn();
    renderControl({ actions: { openInChat } });

    const chip = await screen.findByTestId('document-session-chip');
    expect(chip.getAttribute('data-session-id')).toBe('newest');
    expect(screen.queryByTestId('ai-sessions-button')).toBeNull();

    // Title comes from the query, not the registry — a worktree session isn't in it.
    fireEvent.click(screen.getByText('Newest worktree pass'));
    expect(openInChat).toHaveBeenCalledWith('newest');
    expect(screen.queryByTestId('document-session-menu')).toBeNull();
  });

  it('prefers live registry data over the queried title', async () => {
    invoke.mockResolvedValue([fileSession({ id: 'newest', title: 'Stale title', updatedAt: 30 })]);
    renderControl({ registryTitle: 'Renamed since' });

    await screen.findByTestId('document-session-chip');
    screen.getByText('Renamed since');
    expect(screen.queryByText('Stale title')).toBeNull();
  });

  it('opens the grouped session list and the new-session action from the caret', async () => {
    invoke.mockResolvedValue([
      fileSession({ id: 'newest', title: 'This project pass', updatedAt: 30 }),
      fileSession({ id: 'elsewhere', title: 'Other worktree pass', updatedAt: 5, isCurrentWorkspace: false }),
    ]);
    const startNew = vi.fn();
    renderControl({ actions: { openInChat: vi.fn(), startNew } });

    fireEvent.click(await screen.findByTestId('document-session-caret'));

    const menu = await screen.findByTestId('document-session-menu');
    expect(
      Array.from(menu.querySelectorAll('.document-session-group-header')).map(e => e.textContent),
    ).toEqual(['This project', 'Other sessions']);
    expect(
      screen.getAllByTestId('document-session-row').map(r => r.getAttribute('data-session-id')),
    ).toEqual(['newest', 'elsewhere']);

    fireEvent.click(screen.getByTestId('document-session-new'));
    expect(startNew).toHaveBeenCalled();
  });
});

it('refreshes an already-open file after link notifications and orders by file edit time',async()=>{
  const store=createStore();renderControl({store});
  await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1));
  invoke.mockResolvedValue([fileSession({id:'older-edit',updatedAt:999,lastFileEditAt:20}),fileSession({id:'new-edit',updatedAt:1,lastFileEditAt:30,fileAttribution:'inferred'})]);
  act(()=>store.set(workspaceFileLinksRevisionAtom(WORKSPACE),1));
  expect((await screen.findByTestId('document-session-chip')).getAttribute('data-session-id')).toBe('new-edit');
  fireEvent.click(screen.getByTestId('document-session-caret'));
  expect(await screen.findByText('Inferred edit')).toBeTruthy();
});
