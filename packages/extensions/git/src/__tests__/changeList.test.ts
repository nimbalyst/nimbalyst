// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildChangeRows, mergeWorkingChanges, visibleFilePaths } from '../changeList';

describe('mergeWorkingChanges', () => {
  it('collapses a path that is both staged and modified in the worktree into one row', () => {
    const merged = mergeWorkingChanges({
      staged: [
        { path: 'src/a.ts', status: 'M' },
        { path: 'src/new.ts', status: 'A' },
        { path: 'src/recreated.ts', status: 'D' },
      ],
      unstaged: [{ path: 'src/a.ts', status: 'M' }, { path: 'src/new.ts', status: 'M' }],
      untracked: [{ path: 'src/scratch.ts' }, { path: 'src/recreated.ts' }],
      conflicted: [],
    });

    expect(merged).toEqual([
      // staged M + further worktree edits is still one modified file
      { path: 'src/a.ts', status: 'M' },
      // added to the index then edited again is still an addition
      { path: 'src/new.ts', status: 'A' },
      // staged deletion + a worktree recreation is modified relative to HEAD
      { path: 'src/recreated.ts', status: 'M' },
      { path: 'src/scratch.ts', status: '?' },
    ]);
  });

  it('reports a file deleted in the worktree as deleted even when the index has it modified', () => {
    const merged = mergeWorkingChanges({
      staged: [{ path: 'src/gone.ts', status: 'M' }],
      unstaged: [{ path: 'src/gone.ts', status: 'D' }],
      untracked: [],
      conflicted: [],
    });

    expect(merged).toEqual([{ path: 'src/gone.ts', status: 'D' }]);
  });

  it('keeps conflicted paths out of the selectable list', () => {
    const merged = mergeWorkingChanges({
      staged: [],
      unstaged: [{ path: 'src/clash.ts', status: 'M' }],
      untracked: [],
      conflicted: [{ path: 'src/clash.ts' }],
    });

    expect(merged).toEqual([]);
  });
});

describe('buildChangeRows', () => {
  const files = [
    { path: 'packages/app/src/one.ts', status: 'M' },
    { path: 'packages/app/src/two.ts', status: 'M' },
    { path: 'docs/only.md', status: 'M' },
  ];

  it('omits files inside a collapsed directory so keyboard navigation cannot reach them', () => {
    const expanded = buildChangeRows(files, new Set());
    expect(visibleFilePaths(expanded)).toEqual([
      'docs/only.md',
      'packages/app/src/one.ts',
      'packages/app/src/two.ts',
    ]);

    const collapsed = buildChangeRows(files, new Set(['packages/app/src']));
    expect(visibleFilePaths(collapsed)).toEqual(['docs/only.md']);
  });
});
