// @vitest-environment node
import { execFileSync } from 'child_process';
import * as os from 'os';
import { describe, expect, it } from 'vitest';
import {
  buildWorktreeBranchName,
  findBranchConflict,
  stripWorktreeBranchPrefix,
  validateWorktreeBranchSuffix,
  worktreeBranchLabel,
  worktreeDirectoryNameFor,
} from '../worktreeBranchNaming';
import { gitSandboxEnv } from '../../main/services/testSupport/gitTestSandbox';

/** Whether git accepts `worktree/<suffix>` as a branch name; read-only, so no repository is needed */
function gitAcceptsBranch(suffix: string): boolean {
  try {
    execFileSync('git', ['check-ref-format', '--branch', buildWorktreeBranchName(suffix)], {
      cwd: os.tmpdir(),
      env: gitSandboxEnv(),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

describe('worktree branch naming', () => {
  it('adds and strips the branch prefix', () => {
    expect(buildWorktreeBranchName('feat/x')).toBe('worktree/feat/x');
    expect(stripWorktreeBranchPrefix('worktree/feat/x')).toBe('feat/x');
    expect(stripWorktreeBranchPrefix('worktree-feat')).toBe('worktree-feat');
    expect(stripWorktreeBranchPrefix('main')).toBe('main');
  });

  // `git`: git itself rejects `worktree/<suffix>`. `policy`: Nimbalyst's own
  // limit on a name git would accept, among them names Windows cannot hold.
  it.each([
    ['feat/x', 'ok'],
    ['swift-falcon', 'ok'],
    ['@', 'ok'],
    ['HEAD', 'ok'],
    ['é/ü', 'ok'],
    ['console/aux-x', 'ok'],
    ['x'.repeat(64), 'ok'],
    ['', 'git'],
    ['feat..x', 'git'],
    ['.x', 'git'],
    ['a/.b', 'git'],
    ['x.', 'git'],
    ['x.lock', 'git'],
    ['a.lock/b', 'git'],
    ['/a', 'git'],
    ['a/', 'git'],
    ['a//b', 'git'],
    ['a@{b', 'git'],
    ['a b', 'git'],
    ['a\tb', 'git'],
    ['a\x7fb', 'git'],
    ['a~b', 'git'],
    ['a^b', 'git'],
    ['a:b', 'git'],
    ['a?b', 'git'],
    ['a*b', 'git'],
    ['a[b', 'git'],
    ['a\\b', 'git'],
    ['-x', 'policy'],
    ['x'.repeat(65), 'policy'],
    // Git for Windows cannot store these as loose refs, and a branch travels
    // between machines
    ['a<b', 'policy'],
    ['a>b', 'policy'],
    ['a"b', 'policy'],
    ['a|b', 'policy'],
    ['a./b', 'policy'],
    ['con', 'policy'],
    ['feat/NUL.txt', 'policy'],
    ['aux/x', 'policy'],
    ['conin$', 'policy'],
    ['lpt\u00b9', 'policy'],
  ] as const)('validates %j as %s, as git check-ref-format --branch does', (suffix, verdict) => {
    const problem = validateWorktreeBranchSuffix(suffix);
    if (verdict === 'ok') {
      expect(problem).toBeNull();
    } else {
      expect(problem).toMatchObject({ message: expect.stringMatching(/^Name /), policy: verdict === 'policy' });
    }
    // Every name the validator accepts is a branch git accepts; only the
    // policy rows reject what git would allow.
    expect(gitAcceptsBranch(suffix)).toBe(verdict !== 'git');
  });

  it.each([
    ['feat/x', 'feat-x'],
    ['feat/sub/x', 'feat-sub-x'],
    ['a<b>"c|d', 'abcd'],
    ['a--b//c', 'a-b-c'],
    ['-x.', 'x'],
    ['é/ü', 'é-ü'],
    ['con', 'con_'],
    ['CONOUT$', 'CONOUT$_'],
    ['LPT1.notes', 'LPT1_.notes'],
    ['console', 'console'],
    ['<>', 'worktree'],
  ])('names the folder for %j as %j', (suffix, folder) => {
    expect(worktreeDirectoryNameFor(suffix)).toBe(folder);
  });

  it.each([
    ['worktree/feat/x', ['main', 'worktree/feat/x'], {}, { ref: 'worktree/feat/x', kind: 'exact' }],
    ['worktree/feat/x', ['worktree/feat'], {}, { ref: 'worktree/feat', kind: 'ancestor' }],
    ['worktree/x', ['worktree'], {}, { ref: 'worktree', kind: 'ancestor' }],
    ['worktree/feat', ['worktree/feat/x/y'], {}, { ref: 'worktree/feat/x/y', kind: 'descendant' }],
    ['worktree/a', ['worktree/a/b', 'worktree/a'], {}, { ref: 'worktree/a', kind: 'exact' }],
    ['worktree/feat', ['worktree/feature', 'worktree/feat-1', 'feat'], {}, null],
    ['worktree/Feat/x', ['worktree/feat'], {}, null],
    ['worktree/Feat/x', ['worktree/feat'], { caseInsensitive: true }, { ref: 'worktree/feat', kind: 'ancestor' }],
  ] as const)('finds the conflict of %s with %j (%j)', (branch, refs, options, conflict) => {
    expect(findBranchConflict(branch, refs, options)).toEqual(conflict);
  });

  it('labels a worktree by the branch its row records, not one rebuilt from its folder', () => {
    const recorded = { worktreePath: '/repo_worktrees/feat-x', branch: 'worktree/feat/x' };
    expect(worktreeBranchLabel(recorded, '/repo_worktrees/feat-x', 'feat-x')).toBe('worktree/feat/x');
    // Until the row of this worktree loads, the branch a worktree without a
    // typed name has, and never the branch of the worktree shown before
    expect(worktreeBranchLabel(recorded, '/repo_worktrees/swift-falcon', 'swift-falcon')).toBe('worktree/swift-falcon');
    expect(worktreeBranchLabel(null, '/repo_worktrees/swift-falcon', 'swift-falcon')).toBe('worktree/swift-falcon');
  });
});
