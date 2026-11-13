// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseWorktreeListPorcelain } from '../gitWorktreeList';

describe('parseWorktreeListPorcelain', () => {
  it('marks only the first entry as main and reads branch, detached, bare, locked and prunable', () => {
    const output = [
      'worktree /repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /wt/feature',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature/x',
      'locked busy',
      '',
      'worktree /wt/detached',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');

    expect(parseWorktreeListPorcelain(output)).toEqual([
      { path: '/repo', head: '1'.repeat(40), branch: 'main', detached: false, bare: false, locked: false, prunable: false, isMain: true },
      { path: '/wt/feature', head: '2'.repeat(40), branch: 'feature/x', detached: false, bare: false, locked: true, prunable: false, isMain: false },
      { path: '/wt/detached', head: '3'.repeat(40), branch: null, detached: true, bare: false, locked: false, prunable: true, isMain: false },
    ]);
  });

  it('parses a bare main entry and keeps later entries non-main', () => {
    const output = 'worktree /srv/repo.git\nbare\n\nworktree /srv/checkout\nHEAD 4444444444444444444444444444444444444444\nbranch refs/heads/dev\n';
    const entries = parseWorktreeListPorcelain(output);
    expect(entries.map(e => [e.path, e.bare, e.isMain, e.branch, e.head])).toEqual([
      ['/srv/repo.git', true, true, null, null],
      ['/srv/checkout', false, false, 'dev', '4'.repeat(40)],
    ]);
  });

  it('treats an all-zero HEAD (unborn branch) as no commit and keeps paths with spaces', () => {
    const output = `worktree /tmp/my repo\nHEAD ${'0'.repeat(40)}\nbranch refs/heads/main\n`;
    expect(parseWorktreeListPorcelain(output)[0]).toMatchObject({ path: '/tmp/my repo', head: null, branch: 'main' });
  });
});

describe('parseWorktreeListPorcelain with -z', () => {
  it('reads raw paths containing tabs and newlines from NUL-terminated records', () => {
    const output = [
      'worktree /repo', 'HEAD ' + '1'.repeat(40), 'branch refs/heads/main', '',
      'worktree /wt/odd\tname\nline', 'HEAD ' + '2'.repeat(40), 'branch refs/heads/feature/x', 'locked', '',
      'worktree /wt/plain', 'HEAD ' + '3'.repeat(40), 'detached', '',
    ].join('\0');

    expect(parseWorktreeListPorcelain(output, { nulTerminated: true }).map(e => [e.path, e.branch, e.isMain, e.locked, e.detached])).toEqual([
      ['/repo', 'main', true, false, false],
      ['/wt/odd\tname\nline', 'feature/x', false, true, false],
      ['/wt/plain', null, false, false, true],
    ]);
  });
});
