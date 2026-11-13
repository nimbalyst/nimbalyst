// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorktreeBaseBranchPicker } from '../WorktreeBaseBranchPicker';

const BRANCHES = [
  'main',
  'feature/login',
  'feature/logout',
  'hotfix/crash',
  'remotes/origin/feature/login',
  'remotes/origin/release',
];

function renderPicker() {
  return render(
    <WorktreeBaseBranchPicker
      isOpen
      repoPath="/workspace"
      workspacePath="/workspace"
      onCreate={vi.fn().mockResolvedValue(undefined)}
      onCancel={vi.fn()}
    />,
  );
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByTestId('worktree-base-branch-search'), { target: { value } });
}

describe('WorktreeBaseBranchPicker branch search', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'git:branches') return { branches: BRANCHES, current: 'main' };
          return undefined;
        }),
      },
    });
  });

  afterEach(cleanup);

  it('filters local and remote branches in the same pass', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-main');

    typeQuery('feature');

    await waitFor(() => {
      expect(screen.queryByTestId('worktree-base-branch-item-main')).toBeNull();
    });
    screen.getByTestId('worktree-base-branch-item-feature/login');
    screen.getByTestId('worktree-base-branch-item-feature/logout');
    screen.getByTestId('worktree-base-branch-item-origin/feature/login');
    expect(screen.queryByTestId('worktree-base-branch-item-hotfix/crash')).toBeNull();
    expect(screen.queryByTestId('worktree-base-branch-item-origin/release')).toBeNull();
  });

  it('matches case-insensitively', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-main');

    typeQuery('FEATURE');

    await waitFor(() => {
      screen.getByTestId('worktree-base-branch-item-feature/login');
    });
    screen.getByTestId('worktree-base-branch-item-origin/feature/login');
  });

  it('shows an empty state naming the query when nothing matches', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-main');

    typeQuery('nothing-matches-this');

    const empty = await screen.findByTestId('worktree-base-branch-no-matches');
    expect(empty.textContent).toContain('nothing-matches-this');
  });

  it('restores the full list when the query is cleared', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-main');

    typeQuery('hotfix');
    await waitFor(() => {
      expect(screen.queryByTestId('worktree-base-branch-item-main')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('worktree-base-branch-search-clear'));

    await waitFor(() => {
      screen.getByTestId('worktree-base-branch-item-main');
    });
    screen.getByTestId('worktree-base-branch-item-origin/release');
  });

  it('keeps the selected base branch visible in the preview while it is filtered out', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-main');

    typeQuery('hotfix');

    await waitFor(() => {
      expect(screen.queryByTestId('worktree-base-branch-item-main')).toBeNull();
    });
    expect(screen.getByTestId('worktree-branch-preview').textContent).toContain('from main');
  });
});

describe('WorktreeBaseBranchPicker project default', () => {
  let finishFetch: (result: { success: boolean; error?: string }) => void;
  let defaultRef: string;
  let branches: string[];

  beforeEach(() => {
    defaultRef = 'origin/main';
    branches = ['main', 'feature/login', 'remotes/origin/main'];
    const fetchDone = new Promise<{ success: boolean; error?: string }>((resolve) => {
      finishFetch = resolve;
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'git:branches') return { branches, current: 'feature/login' };
          if (channel === 'worktree:resolve-default-base') {
            return { success: true, resolved: { ref: defaultRef, displayRef: defaultRef, source: 'remote-default' } };
          }
          if (channel === 'git:fetch') return fetchDone;
          return undefined;
        }),
      },
    });
  });

  afterEach(cleanup);

  const selected = () => screen.getByTestId('worktree-branch-preview').textContent ?? '';

  it('pre-selects the resolved default instead of the checkout branch', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-origin/main');

    await waitFor(() => expect(selected()).toContain('from origin/main'));
    expect(
      screen.getByTestId('worktree-base-branch-item-origin/main').querySelector('[data-testid="worktree-base-branch-project-default"]'),
    ).not.toBeNull();
  });

  it('re-selects a default that only appears after the fetch when the user has not chosen', async () => {
    defaultRef = 'main';
    renderPicker();
    await waitFor(() => expect(selected()).toContain('from main'));

    defaultRef = 'origin/develop';
    branches = [...branches, 'remotes/origin/develop'];
    finishFetch({ success: true });

    await waitFor(() => expect(selected()).toContain('from origin/develop'));
  });

  it('keeps the user selection when the default changes after the fetch', async () => {
    renderPicker();
    await waitFor(() => expect(selected()).toContain('from origin/main'));

    fireEvent.click(screen.getByTestId('worktree-base-branch-item-feature/login'));
    defaultRef = 'origin/develop';
    branches = [...branches, 'remotes/origin/develop'];
    finishFetch({ success: true });

    await screen.findByTestId('worktree-base-branch-item-origin/develop');
    expect(selected()).toContain('from feature/login');
  });

  it('shows a note when the fetch fails instead of ignoring it', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-origin/main');

    finishFetch({ success: false, error: 'Could not resolve host: github.com' });

    const note = await screen.findByTestId('worktree-base-branch-fetch-note');
    expect(note.textContent).toContain('Could not resolve host');
  });

  it('keeps a resolved default that is not in the branch lists selectable', async () => {
    defaultRef = '3f2a9c1';
    renderPicker();

    const item = await screen.findByTestId('worktree-base-branch-item-3f2a9c1');
    await waitFor(() => expect(selected()).toContain('from 3f2a9c1'));
    expect(item.getAttribute('aria-checked')).toBe('true');
  });
});

describe('WorktreeBaseBranchPicker load ordering and project', () => {
  afterEach(cleanup);

  it('reads the default from the owning workspace, not the source repo', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'git:branches') return { branches: ['main'], current: 'main' };
      if (channel === 'worktree:resolve-default-base') {
        return { success: true, resolved: { ref: 'refs/heads/main', displayRef: 'main', source: 'fallback' } };
      }
      return { success: true };
    });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });

    render(
      <WorktreeBaseBranchPicker
        isOpen
        repoPath="/workspace/attached-repo"
        workspacePath="/workspace"
        onCreate={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByTestId('worktree-base-branch-item-main');
    expect(invoke).toHaveBeenCalledWith('worktree:resolve-default-base', '/workspace', '/workspace/attached-repo');
  });

  it('does not let a slow initial load overwrite the post-fetch default', async () => {
    let releaseInitialBranches!: () => void;
    const initialBranches = new Promise<void>((resolve) => {
      releaseInitialBranches = resolve;
    });
    let branchCalls = 0;
    let resolveCalls = 0;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'git:branches') {
            branchCalls += 1;
            if (branchCalls === 1) {
              await initialBranches;
              return { branches: ['main'], current: 'main' };
            }
            return { branches: ['main', 'remotes/origin/develop'], current: 'main' };
          }
          if (channel === 'worktree:resolve-default-base') {
            resolveCalls += 1;
            const ref = resolveCalls === 1 ? 'main' : 'origin/develop';
            return { success: true, resolved: { ref, displayRef: ref, source: 'project-setting' } };
          }
          if (channel === 'git:fetch') return { success: true };
          return undefined;
        }),
      },
    });

    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-origin/develop');
    releaseInitialBranches();
    await waitFor(() => expect(branchCalls).toBe(2));
    // Let the stale initial response settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByTestId('worktree-branch-preview').textContent).toContain('from origin/develop');
    screen.getByTestId('worktree-base-branch-item-origin/develop');
  });
});
