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

function renderPicker(props: Partial<React.ComponentProps<typeof WorktreeBaseBranchPicker>> = {}) {
  return render(
    <WorktreeBaseBranchPicker
      isOpen
      repoPath="/workspace"
      onCreate={vi.fn().mockResolvedValue(undefined)}
      onCancel={vi.fn()}
      {...props}
    />,
  );
}

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

function typeQuery(value: string) {
  fireEvent.change(screen.getByTestId('worktree-base-branch-search'), { target: { value } });
}

describe('WorktreeBaseBranchPicker branch search', () => {
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

describe('WorktreeBaseBranchPicker worktree name', () => {
  function typeName(value: string) {
    fireEvent.change(screen.getByTestId('worktree-name-input'), { target: { value } });
  }

  it('previews the exact branch of a typed name, and the folder it gets', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-main');

    typeName('feat/x');

    const preview = screen.getByTestId('worktree-branch-preview').textContent;
    expect(preview).toContain('worktree/feat/x');
    expect(preview).toContain('folder feat-x');
  });

  it('shows the rule a typed name breaks and keeps it from being created', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-main');

    typeName('feat..x');

    expect(screen.getByTestId('worktree-name-error').textContent).toContain('..');
    expect((screen.getByTestId('worktree-base-branch-create') as HTMLButtonElement).disabled).toBe(true);
  });

  // An unedited name from a tracker item keeps the -N renaming on a
  // conflict; a name the user typed or edited becomes the branch exactly.
  it.each([
    ['an unedited suggested name', undefined, { name: 'nim-12-fix-login', nameSource: 'suggested' }],
    ['an edited suggested name', 'nim-12-fix/login', { name: 'nim-12-fix/login', nameSource: 'user' }],
  ])('reports %s with its source', async (_label, typed, expected) => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    renderPicker({ initialName: 'nim-12-fix-login', onCreate });
    await screen.findByTestId('worktree-base-branch-item-main');
    if (typed) typeName(typed);

    fireEvent.click(screen.getByTestId('worktree-base-branch-create'));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ baseBranch: 'main', ...expected }));
  });
});
