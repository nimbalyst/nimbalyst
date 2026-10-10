import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitOperationLogWireEntry } from '@nimbalyst/extension-sdk/git-operation-log';
import { useGitActivity } from '../useGitActivity';

type Listener = (data: unknown) => void;

let listeners: Listener[];
let invoke: ReturnType<typeof vi.fn>;

function entry(overrides: Partial<GitOperationLogWireEntry> & { id: string }): GitOperationLogWireEntry {
  return {
    timestamp: 1000,
    updatedAt: 1000,
    command: 'git push',
    executable: 'git',
    args: ['push'],
    cwd: '/repo',
    status: 'running',
    output: '',
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

function emit(data: unknown) {
  act(() => {
    for (const listener of listeners) listener(data);
  });
}

beforeEach(() => {
  listeners = [];
  invoke = vi.fn().mockResolvedValue([]);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    invoke,
    on: (_channel: string, callback: Listener) => {
      listeners.push(callback);
      return () => {
        listeners = listeners.filter((entry) => entry !== callback);
      };
    },
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('useGitActivity', () => {
  it('follows every repository of a multi-repo workspace, and clears one without the others', async () => {
    // The journal is kept per repository; a pull in a repository cloned inside
    // the project is recorded under that repository, not the root.
    invoke.mockImplementation(async (_channel: string, repoPath: string) =>
      repoPath === '/repo/api' ? [entry({ id: 'fetch', cwd: '/repo/api', command: 'git fetch' })] : []);
    const { result } = renderHook(() => useGitActivity(['/repo', '/repo/api', '/repo']));
    await waitFor(() => expect(result.current.runningEntries.map((e) => e.id)).toEqual(['fetch']));
    expect(invoke.mock.calls.map(([, repoPath]) => repoPath)).toEqual(['/repo', '/repo/api']);

    emit({ workspacePath: '/repo/api', type: 'upsert', entry: entry({ id: 'pull', cwd: '/repo/api', command: 'git pull', timestamp: 3000, updatedAt: 3000 }) });
    emit({ workspacePath: '/repo', type: 'upsert', entry: entry({ id: 'push', timestamp: 2000, updatedAt: 2000 }) });
    expect(result.current.latestRunningEntry).toMatchObject({ id: 'pull', repoPath: '/repo/api' });

    emit({ workspacePath: '/repo', type: 'clear' });
    expect(result.current.runningEntries.map((e) => e.id).sort()).toEqual(['fetch', 'pull']);
  });

  it('ignores journal events belonging to another workspace', async () => {
    const { result } = renderHook(() => useGitActivity('/repo'));
    await waitFor(() => expect(invoke).toHaveBeenCalled());

    emit({ workspacePath: '/other', type: 'upsert', entry: entry({ id: 'a' }) });

    expect(result.current.runningEntries).toHaveLength(0);
  });

  it('does not let a slow hydration response resurrect a finished command', async () => {
    let resolveHydration: (value: GitOperationLogWireEntry[]) => void = () => {};
    invoke.mockReturnValue(
      new Promise<GitOperationLogWireEntry[]>((resolve) => {
        resolveHydration = resolve;
      }),
    );
    const { result } = renderHook(() => useGitActivity('/repo'));

    emit({
      workspacePath: '/repo',
      type: 'upsert',
      entry: entry({ id: 'a', status: 'success', updatedAt: 5000 }),
    });
    await act(async () => {
      resolveHydration([entry({ id: 'a', status: 'running', updatedAt: 1000 })]);
    });

    expect(result.current.runningEntries).toHaveLength(0);
    expect(result.current.latestTerminalEntry?.id).toBe('a');
  });

  it('clears the previous workspace activity before the new one hydrates', async () => {
    invoke.mockResolvedValue([entry({ id: 'a' })]);
    const { result, rerender } = renderHook(({ path }) => useGitActivity(path), {
      initialProps: { path: '/repo' },
    });
    await waitFor(() => expect(result.current.latestRunningEntry?.id).toBe('a'));

    // Hold the second workspace's hydration open: the stale entry must be gone
    // already, not linger for the length of the round-trip.
    invoke.mockReturnValue(new Promise(() => {}));
    rerender({ path: '/other-repo' });

    expect(result.current.latestRunningEntry).toBeUndefined();
  });

  it('defaults metadata absent from a pre-agent journal to app-owned', async () => {
    const legacy = entry({ id: 'a' });
    delete (legacy as Partial<GitOperationLogWireEntry>).source;
    invoke.mockResolvedValue([legacy]);
    const { result } = renderHook(() => useGitActivity('/repo'));

    await waitFor(() => expect(result.current.latestRunningEntry?.source).toBe('nimbalyst'));
  });
});
