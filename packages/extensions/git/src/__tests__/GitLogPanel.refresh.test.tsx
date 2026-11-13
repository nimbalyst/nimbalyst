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

// #1959: the Log follows the checked-out branch unless the "Showing:" filter
// pins another one; a pinned filter survives a checkout.
describe('GitLogPanel log branch filter', () => {
  it('follows checkouts until the user pins a branch', async () => {
    let branch = 'main';
    invoke.mockReset();
    invoke.mockImplementation((channel: string) => {
      switch (channel) {
        case 'git:status':
          return Promise.resolve({ branch, ahead: 0, behind: 0, hasUncommitted: false });
        case 'git:branches':
          return Promise.resolve({ branches: ['main', 'feature/x', 'release'], current: branch });
        case 'git:log':
          return Promise.resolve([]);
        case 'git:list-workspace-repos':
          return Promise.resolve({ success: true, repos: [WORKSPACE] });
        default:
          return Promise.resolve(null);
      }
    });
    const host = makeHost();
    const statusHandlers: Array<(data: unknown) => void> = [];
    (host.onWorkspaceEvent as ReturnType<typeof vi.fn>).mockImplementation((event: string, handler: (data: unknown) => void) => {
      if (event === 'git:status-changed') statusHandlers.push(handler);
      return () => {};
    });
    const lastLogBranch = () => {
      const logCalls = invoke.mock.calls.filter(([channel]) => channel === 'git:log');
      return (logCalls[logCalls.length - 1]?.[3] as { branch?: string } | undefined)?.branch;
    };
    const checkout = (next: string) => {
      branch = next;
      statusHandlers[statusHandlers.length - 1]({ workspacePath: WORKSPACE, status: { branch: next, ahead: 0, behind: 0, hasUncommitted: false } });
    };

    render(<GitLogPanel host={host} />);
    fireEvent.click(await screen.findByRole('button', { name: /^log$/i }));
    await waitFor(() => expect(lastLogBranch()).toBe('main'));

    checkout('feature/x');
    await waitFor(() => expect(lastLogBranch()).toBe('feature/x'));

    fireEvent.click(screen.getByRole('button', { name: /^Log branch filter/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'release' }));
    await waitFor(() => expect(lastLogBranch()).toBe('release'));

    const logCallsBefore = invoke.mock.calls.filter(([c]) => c === 'git:log').length;
    checkout('main');
    await waitFor(() => expect(invoke.mock.calls.filter(([c]) => c === 'git:log').length).toBeGreaterThan(logCallsBefore));
    await new Promise(resolve => setTimeout(resolve, 50));
    const afterCheckout = invoke.mock.calls.filter(([c]) => c === 'git:log').slice(logCallsBefore);
    expect(afterCheckout.map(call => (call[3] as { branch?: string }).branch)).toEqual(afterCheckout.map(() => 'release'));
  });
});

describe('GitLogPanel stale log responses', () => {
  // A slow `git:log` for the branch the Log used to follow must not repaint
  // over the newer branch's commits when it finally lands.
  it('keeps the newest branch filter\'s commits when an older request resolves late', async () => {
    let branch = 'main';
    let resolveMainLog: (commits: unknown[]) => void = () => {};
    invoke.mockReset();
    invoke.mockImplementation((channel: string, _repo: string, _limit: number, opts?: { branch?: string }) => {
      switch (channel) {
        case 'git:status':
          return Promise.resolve({ branch, ahead: 0, behind: 0, hasUncommitted: false });
        case 'git:branches':
          return Promise.resolve({ branches: ['main', 'feature/x'], current: branch });
        case 'git:log':
          if (opts?.branch === 'main') return new Promise(r => { resolveMainLog = r; });
          if (opts?.branch === 'feature/x') {
            return Promise.resolve([{ hash: 'f'.repeat(40), message: 'Feature commit', author: 'Dev', date: '2026-10-01T12:00:00Z' }]);
          }
          return Promise.resolve([]);
        case 'git:list-workspace-repos':
          return Promise.resolve({ success: true, repos: [WORKSPACE] });
        default:
          return Promise.resolve(null);
      }
    });
    const host = makeHost();
    const statusHandlers: Array<(data: unknown) => void> = [];
    (host.onWorkspaceEvent as ReturnType<typeof vi.fn>).mockImplementation((event: string, handler: (data: unknown) => void) => {
      if (event === 'git:status-changed') statusHandlers.push(handler);
      return () => {};
    });

    render(<GitLogPanel host={host} />);
    fireEvent.click(await screen.findByRole('button', { name: /^log$/i }));
    await waitFor(() => expect(invoke.mock.calls.some(([c, , , o]) => c === 'git:log' && (o as { branch?: string })?.branch === 'main')).toBe(true));

    branch = 'feature/x';
    statusHandlers[statusHandlers.length - 1]({ workspacePath: WORKSPACE, status: { branch: 'feature/x', ahead: 0, behind: 0, hasUncommitted: false } });
    await screen.findByText('Feature commit');

    resolveMainLog([{ hash: 'm'.repeat(40), message: 'Main commit', author: 'Dev', date: '2026-10-01T12:00:00Z' }]);
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByText('Main commit')).toBeNull();
    screen.getByText('Feature commit');
  });
});

describe('GitLogPanel commit hover card', () => {
  const COMMIT = { hash: 'abc1234def', message: 'Fix the thing', author: 'Dev', date: '2026-10-01T12:00:00Z' };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((channel: string) => {
      switch (channel) {
        case 'git:status':
          return Promise.resolve({ branch: 'main', ahead: 0, behind: 0, hasUncommitted: false });
        case 'git:branches':
          return Promise.resolve({ branches: ['main'], current: 'main' });
        case 'git:log':
          return Promise.resolve([COMMIT]);
        case 'git:list-workspace-repos':
          return Promise.resolve({ success: true, repos: [WORKSPACE] });
        case 'git:commit-detail':
          return Promise.resolve({
            body: 'Fix the thing',
            files: [{ status: 'M', path: 'src/thing.ts', added: 1, deleted: 1 }],
            summary: { filesChanged: 1, insertions: 1, deletions: 1 },
          });
        default:
          return Promise.resolve(null);
      }
    });
  });

  // When the detail loads, the card grows from its loading height and, for a
  // frame, overlaps the row under the cursor; the cursor then lands back on the
  // row. Treating that as a new hover reset the card to Loading and refetched,
  // which re-triggered the overlap: the card blinked as long as the mouse sat
  // still.
  it('does not reload the card when the cursor returns to the row it belongs to', async () => {
    render(<GitLogPanel host={makeHost()} />);
    // Panel state is per workspace and module-scoped, so an earlier test can
    // leave the Changes tab active.
    fireEvent.click(await screen.findByRole('button', { name: /^log$/i }));
    const row = (await screen.findByText('Fix the thing')).closest('tr');
    if (!row) throw new Error('Commit row not rendered');

    fireEvent.mouseEnter(row);
    await wait(400);
    const card = await screen.findByText('thing.ts').then(el => el.closest('.git-hover-card'));
    if (!card) throw new Error('Hover card not rendered');

    fireEvent.mouseLeave(row);
    fireEvent.mouseEnter(card);
    fireEvent.mouseLeave(card);
    fireEvent.mouseEnter(row);
    await wait(400);

    expect(invoke.mock.calls.filter(([channel]) => channel === 'git:commit-detail')).toHaveLength(1);
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(screen.getByText('thing.ts')).toBeDefined();
  });
});
