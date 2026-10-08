// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getAgentGitContext } from '../gitAgentContext';
import { createScratchRepo, type ScratchRepo } from '../../services/testSupport/gitTestSandbox';

/**
 * #1177 — this snapshot replaces the CLI's suppressed git-status block. The part
 * worth testing is the main-branch resolution, which falls back through
 * origin/HEAD -> main -> master and is not visible from the call site. Sandboxed
 * under os.tmpdir so nothing can be committed onto the branch under test.
 */
describe('getAgentGitContext', () => {
  let scratch: ScratchRepo;
  let repo: string;

  beforeAll(() => {
    scratch = createScratchRepo({ initialBranch: 'master' });
    repo = scratch.path;
    writeFileSync(path.join(repo, 'a.txt'), 'a');
    scratch.git('add', 'a.txt');
    scratch.git('commit', '-m', 'initial commit');
    scratch.git('checkout', '-b', 'feature/x');
  });

  afterAll(() => {
    scratch.cleanup();
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
