import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// GitLogPanel and ChangesTab both read `window.electronAPI` at module scope, so
// the stub has to exist before the imports are evaluated.
const invoke = vi.hoisted(() => {
  const fn = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = { invoke: fn };
  return fn;
});

import { GitLogPanel } from '../components/GitLogPanel';

const WORKSPACE = '/repo';

function makeHost() {
  const storage = new Map<string, unknown>();
  return {
    workspacePath: WORKSPACE,
    close: vi.fn(),
    onWorkspaceEvent: vi.fn(() => () => {}),
    storage: {
      get: <T,>(key: string) => storage.get(`w:${key}`) as T | undefined,
      set: (key: string, value: unknown) => { storage.set(`w:${key}`, value); },
      getGlobal: <T,>(key: string) => storage.get(`g:${key}`) as T | undefined,
      setGlobal: (key: string, value: unknown) => { storage.set(`g:${key}`, value); },
    },
  } as unknown as Parameters<typeof GitLogPanel>[0]['host'];
}

function workingChangesCalls() {
  return invoke.mock.calls.filter(([channel]) => channel === 'git:working-changes').length;
}

describe('GitLogPanel refresh', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((channel: string) => {
      switch (channel) {
        case 'git:working-changes':
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: 'src/picked.ts', status: 'M' }],
            untracked: [],
            conflicted: [],
          });
        case 'git:status':
          return Promise.resolve({ branch: 'main', ahead: 0, behind: 0, hasUncommitted: true });
        case 'git:branches':
          return Promise.resolve({ branches: ['main'], current: 'main' });
        case 'git:log':
          return Promise.resolve([]);
        case 'git:list-workspace-repos':
          return Promise.resolve({ success: true, repos: [WORKSPACE] });
        default:
          return Promise.resolve(null);
      }
    });
  });

  // The Refresh button lives in the shared header, so it used to reload only the
  // commit log and branch pill -- pressing it on the Changes tab left the file
  // list untouched, and a path that had just been gitignored kept showing.
  it('reloads the working-tree file list when the Changes tab is open', async () => {
    const { container } = render(<GitLogPanel host={makeHost()} />);

    fireEvent.click(await screen.findByRole('button', { name: /changes/i }));
    await screen.findByText('picked.ts');

    const beforeRefresh = workingChangesCalls();
    expect(beforeRefresh).toBeGreaterThan(0);

    const refreshButton = container.querySelector('.git-log-action-btn--refresh');
    if (!refreshButton) throw new Error('Refresh button not rendered');
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(workingChangesCalls()).toBeGreaterThan(beforeRefresh);
    });
  });

  // Multi-root: every git call in the panel has to target the picked repo, not
  // the workspace. Getting this wrong shows the primary repo's branch and log
  // under the attached repo's name.
  it('hides the repo picker and targets the workspace when there is one repo', async () => {
    render(<GitLogPanel host={makeHost()} />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git:branches', WORKSPACE));
    expect(screen.queryByRole('button', { name: /^Repository:/ })).toBeNull();
  });

  it('runs git against the selected repo once the workspace spans two', async () => {
    const ATTACHED = '/other/collab';
    invoke.mockImplementation((channel: string) => {
      switch (channel) {
        case 'git:list-workspace-repos':
          return Promise.resolve({ success: true, repos: [WORKSPACE, ATTACHED] });
        case 'git:status':
          return Promise.resolve({ branch: 'main', ahead: 0, behind: 0, hasUncommitted: false });
        case 'git:branches':
          return Promise.resolve({ branches: ['main'], current: 'main' });
        case 'git:log':
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<GitLogPanel host={makeHost()} />);

    const picker = await screen.findByRole('button', { name: `Repository: repo` });
    fireEvent.click(picker);
    fireEvent.click(await screen.findByTitle(ATTACHED));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git:branches', ATTACHED));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git:log', ATTACHED, 100, expect.anything()));
  });

  it('keeps the active tab when switching repositories', async () => {
    const ATTACHED = '/other/tab-state';
    invoke.mockImplementation((channel: string) => {
      switch (channel) {
        case 'git:list-workspace-repos':
          return Promise.resolve({ success: true, repos: [WORKSPACE, ATTACHED] });
        case 'git:working-changes':
          return Promise.resolve({ staged: [], unstaged: [], untracked: [], conflicted: [] });
        case 'git:status':
          return Promise.resolve({ branch: 'main', ahead: 0, behind: 0, hasUncommitted: false });
        case 'git:branches':
          return Promise.resolve({ branches: ['main'], current: 'main' });
        case 'git:log':
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<GitLogPanel host={makeHost()} />);

    fireEvent.click(await screen.findByRole('button', { name: /changes/i }));
    expect(screen.getByRole('button', { name: /changes/i }).classList.contains('git-tab-btn--active')).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: `Repository: repo` }));
    fireEvent.click(await screen.findByTitle(ATTACHED));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /changes/i }).classList.contains('git-tab-btn--active')).toBe(true);
    });
  });
});
