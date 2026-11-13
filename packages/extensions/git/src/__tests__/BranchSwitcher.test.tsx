import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// BranchSwitcher reads `window.electronAPI` at module scope.
const invoke = vi.hoisted(() => {
  const fn = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = { invoke: fn };
  return fn;
});

import { BranchSwitcher, OPEN_WORKTREE_SESSION_EVENT } from '../components/BranchSwitcher';

const REPO = '/repo';

const LIST = {
  current: { branch: 'main', detached: false, headSha: 'a'.repeat(40), headReachable: true },
  local: [
    { name: 'main', upstream: 'origin/main', ahead: 0, behind: 0, upstreamGone: false, lastCommitDate: null, isCurrent: true, occupiedBy: null },
    { name: 'feature/x', upstream: 'origin/feature/x', ahead: 0, behind: 0, upstreamGone: false, lastCommitDate: null, isCurrent: false, occupiedBy: null },
    {
      name: 'worktree/quick-falcon', upstream: null, ahead: 0, behind: 0, upstreamGone: false, lastCommitDate: null, isCurrent: false,
      occupiedBy: { path: '/wt/quick-falcon', worktreeId: 'wt-1', sessionTitle: 'quick-falcon' },
    },
  ],
  remoteOnly: [],
  lastFetchedAt: null,
  managedWorktree: null,
  worktreeLookupFailed: false,
};

const CLEAN = {
  blocked: null, targetBranch: 'feature/x', dirtyFiles: [], dirtyCount: 0, runningSessions: [],
  unreachableHead: null, localExists: false, needsConfirm: false, confirmToken: 'clean-token',
};

function calls(channel: string) {
  return invoke.mock.calls.filter(([c]) => c === channel);
}

function renderSwitcher(overrides: Partial<Parameters<typeof BranchSwitcher>[0]> = {}) {
  const props = {
    repoPath: REPO,
    currentBranch: 'main',
    onSwitched: vi.fn(),
    onOpenChanges: vi.fn(),
    ...overrides,
  };
  const view = render(<BranchSwitcher {...props} />);
  return Object.assign(props, { rerender: (next: Partial<typeof props>) => view.rerender(<BranchSwitcher {...props} {...next} />) });
}

async function openSwitcher() {
  fireEvent.click(screen.getByRole('button', { name: /switch branch/i }));
  return screen.findByRole('listbox', { name: 'Branches' });
}

describe('BranchSwitcher', () => {
  let preflight: unknown;
  let switchResult: unknown;

  beforeEach(() => {
    invoke.mockReset();
    preflight = CLEAN;
    switchResult = { success: true, branch: 'feature/x' };
    invoke.mockImplementation((channel: string) => {
      switch (channel) {
        case 'git:list-branches-detailed': return Promise.resolve(LIST);
        case 'git:switch-preflight': return Promise.resolve(preflight);
        case 'git:switch-branch': return Promise.resolve(switchResult);
        default: return Promise.resolve(null);
      }
    });
  });

  it('opens the owning session for a branch in a Nimbalyst worktree and runs no git switch', async () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_WORKTREE_SESSION_EVENT, opened);
    renderSwitcher();
    const listbox = await openSwitcher();

    const row = (await within(listbox).findByText('worktree/quick-falcon')).closest('[role="option"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Open session' }));

    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ worktreeId: 'wt-1' });
    expect(calls('git:switch-preflight')).toHaveLength(0);
    expect(calls('git:switch-branch')).toHaveLength(0);
    window.removeEventListener(OPEN_WORKTREE_SESSION_EVENT, opened);
  });

  it('switches with uncommitted changes only after the confirm', async () => {
    preflight = { ...CLEAN, dirtyFiles: ['src/a.ts', 'new.txt'], dirtyCount: 2, needsConfirm: true, confirmToken: 'dirty-token' };
    const props = renderSwitcher();
    const listbox = await openSwitcher();

    fireEvent.click(await within(listbox).findByText('feature/x'));
    const confirm = await screen.findByRole('button', { name: 'Switch and keep changes' });
    expect(calls('git:switch-preflight')).toEqual([['git:switch-preflight', REPO, { kind: 'local', branch: 'feature/x' }]]);
    expect(calls('git:switch-branch')).toHaveLength(0);

    fireEvent.click(confirm);
    await waitFor(() => expect(props.onSwitched).toHaveBeenCalledWith('feature/x'));
    expect(calls('git:switch-branch')).toEqual([['git:switch-branch', REPO, { kind: 'local', branch: 'feature/x' }, 'dirty-token']]);
  });

  it('offers only Open Changes and Close when git refuses the switch', async () => {
    switchResult = { success: false, error: 'Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts' };
    const props = renderSwitcher();
    const listbox = await openSwitcher();

    fireEvent.click(await within(listbox).findByText('feature/x'));
    const openChanges = await screen.findByRole('button', { name: 'Open Changes' });
    const card = openChanges.closest('.git-branch-switcher') as HTMLElement;
    expect(within(card).getAllByRole('button').map(b => b.textContent)).toEqual(['Open Changes', 'Close']);
    expect(props.onSwitched).not.toHaveBeenCalled();

    fireEvent.click(openChanges);
    expect(props.onOpenChanges).toHaveBeenCalledTimes(1);
    expect(calls('git:switch-branch')).toHaveLength(1);
  });

  it('requires a confirm naming the running session even on a clean tree', async () => {
    preflight = { ...CLEAN, runningSessions: [{ id: 's1', title: 'Fix sync retry' }], needsConfirm: true };
    const props = renderSwitcher();
    const listbox = await openSwitcher();

    fireEvent.click(await within(listbox).findByText('feature/x'));
    const confirm = await screen.findByRole('button', { name: 'Switch' });
    const card = confirm.closest('.git-branch-switcher') as HTMLElement;
    within(card).getByText('Fix sync retry');
    expect(calls('git:switch-branch')).toHaveLength(0);

    fireEvent.click(confirm);
    await waitFor(() => expect(props.onSwitched).toHaveBeenCalledWith('feature/x'));
  });

  it('creates a branch at a commit from the context-menu request through the same flow', async () => {
    switchResult = { success: true, branch: 'topic/from-log' };
    const props = renderSwitcher({ createRequest: { startPoint: 'abc1234def', startLabel: 'abc1234', nonce: 1 } });

    fireEvent.change(await screen.findByRole('textbox', { name: 'New branch name' }), { target: { value: 'topic/from-log' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and switch' }));

    await waitFor(() => expect(props.onSwitched).toHaveBeenCalledWith('topic/from-log'));
    const request = { kind: 'create', name: 'topic/from-log', startPoint: 'abc1234def' };
    expect(calls('git:switch-preflight')).toEqual([['git:switch-preflight', REPO, request]]);
    expect(calls('git:switch-branch')).toEqual([['git:switch-branch', REPO, request, 'clean-token']]);
  });

  // ---- Review round 1 ----

  it('drops a preflight that resolves after the popover closed', async () => {
    let resolvePreflight: (value: unknown) => void = () => {};
    invoke.mockImplementation((channel: string) => {
      if (channel === 'git:list-branches-detailed') return Promise.resolve(LIST);
      if (channel === 'git:switch-preflight') return new Promise(r => { resolvePreflight = r; });
      if (channel === 'git:switch-branch') return Promise.resolve(switchResult);
      return Promise.resolve(null);
    });
    const props = renderSwitcher();
    const listbox = await openSwitcher();

    fireEvent.click(await within(listbox).findByText('feature/x'));
    await waitFor(() => expect(calls('git:switch-preflight')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /switch branch/i }));
    resolvePreflight(CLEAN);
    await new Promise(r => setTimeout(r, 20));

    expect(calls('git:switch-branch')).toHaveLength(0);
    expect(props.onSwitched).not.toHaveBeenCalled();
  });

  it('does not carry a confirm from one repository to another', async () => {
    preflight = { ...CLEAN, dirtyFiles: ['src/a.ts'], dirtyCount: 1, needsConfirm: true, confirmToken: 'repo-a' };
    const props = renderSwitcher();
    const listbox = await openSwitcher();
    fireEvent.click(await within(listbox).findByText('feature/x'));
    await screen.findByRole('button', { name: 'Switch and keep changes' });

    props.rerender({ repoPath: '/other-repo' });

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Switch and keep changes' })).toBeNull());
    expect(calls('git:switch-branch')).toHaveLength(0);
  });

  it('shows the fresh confirm when main reports the state changed since preflight', async () => {
    const fresh = { ...CLEAN, runningSessions: [{ id: 's9', title: 'Started meanwhile' }], needsConfirm: true, confirmToken: 'fresh-token' };
    invoke.mockImplementation((channel: string, _repo: string, _request: unknown, token?: string) => {
      if (channel === 'git:list-branches-detailed') return Promise.resolve(LIST);
      if (channel === 'git:switch-preflight') return Promise.resolve(CLEAN);
      if (channel === 'git:switch-branch') {
        return Promise.resolve(token === 'fresh-token'
          ? { success: true, branch: 'feature/x' }
          : { success: false, error: 'Confirmation required', needsConfirm: fresh });
      }
      return Promise.resolve(null);
    });
    const props = renderSwitcher();
    const listbox = await openSwitcher();

    fireEvent.click(await within(listbox).findByText('feature/x'));
    const confirm = await screen.findByRole('button', { name: 'Switch' });
    within(confirm.closest('.git-branch-switcher') as HTMLElement).getByText('Started meanwhile');
    expect(props.onSwitched).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    await waitFor(() => expect(props.onSwitched).toHaveBeenCalledWith('feature/x'));
    expect(calls('git:switch-branch').map(call => call[3])).toEqual(['clean-token', 'fresh-token']);
  });

  it('moves the selection with ArrowDown and closes on Escape', async () => {
    renderSwitcher();
    const listbox = await openSwitcher();
    await within(listbox).findByText('feature/x');
    const selected = () => within(listbox).getAllByRole('option').find(o => o.getAttribute('aria-selected') === 'true')?.textContent;
    expect(selected()).toContain('main');

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search branches' }), { key: 'ArrowDown' });
    expect(selected()).toContain('feature/x');

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search branches' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Branches' })).toBeNull());
  });

  // ---- Review round 2 ----

  it('drops a pending preflight when a create request replaces the target', async () => {
    let resolvePreflight: (value: unknown) => void = () => {};
    invoke.mockImplementation((channel: string) => {
      if (channel === 'git:list-branches-detailed') return Promise.resolve(LIST);
      if (channel === 'git:switch-preflight') return new Promise(r => { resolvePreflight = r; });
      if (channel === 'git:switch-branch') return Promise.resolve(switchResult);
      return Promise.resolve(null);
    });
    const props = renderSwitcher();
    const listbox = await openSwitcher();

    fireEvent.click(await within(listbox).findByText('feature/x'));
    await waitFor(() => expect(calls('git:switch-preflight')).toHaveLength(1));
    props.rerender({ createRequest: { startPoint: 'abc1234def', startLabel: 'abc1234', nonce: 2 } });
    await screen.findByRole('textbox', { name: 'New branch name' });

    resolvePreflight(CLEAN);
    await new Promise(r => setTimeout(r, 20));
    expect(calls('git:switch-branch')).toHaveLength(0);
    expect(props.onSwitched).not.toHaveBeenCalled();
    screen.getByRole('textbox', { name: 'New branch name' });
  });
});

