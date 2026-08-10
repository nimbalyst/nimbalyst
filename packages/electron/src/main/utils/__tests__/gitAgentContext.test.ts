// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getAgentGitContext } from '../gitAgentContext';

/**
 * #1177 — this snapshot replaces the CLI's suppressed git-status block. The part
 * worth testing is the main-branch resolution, which falls back through
 * origin/HEAD -> main -> master and is not visible from the call site. Sandboxed
 * under os.tmpdir so nothing can be committed onto the branch under test.
 */
describe('getAgentGitContext', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'nim-gitctx-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '--initial-branch', 'master');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(repo, 'a.txt'), 'a');
    git('add', 'a.txt');
    git('commit', '-m', 'initial commit');
    git('checkout', '-b', 'feature/x');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('states the current branch, the resolved main branch, and recent commits', async () => {
    const context = await getAgentGitContext(repo);

    expect(context).toContain('Current branch: feature/x');
    // No origin/HEAD and no `main`, so it falls back to the `master` that exists.
    expect(context).toContain('Main branch (usually the base for PRs): master');
    expect(context).toContain('initial commit');
  });

  it('omits the working-tree file list, which is the volatile part we removed', async () => {
    writeFileSync(path.join(repo, 'untracked.txt'), 'dirty');

    expect(await getAgentGitContext(repo)).not.toContain('untracked.txt');
  });

  it('returns null for a directory that is not a git repository', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'nim-gitctx-plain-'));
    try {
      expect(await getAgentGitContext(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
