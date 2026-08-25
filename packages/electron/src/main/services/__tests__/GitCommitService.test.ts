import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseUnifiedDiffToHunks, type HunkRef } from '@nimbalyst/runtime/ui/git/unifiedDiffModel';
import {
  createGitCommitProposalResponse,
  executeGitCommit,
} from '../GitCommitService';
import { assertGitSandbox, gitSandboxEnv } from '../testSupport/gitTestSandbox';

const execFileAsync = promisify(execFile);

let tmpRoot: string;
// os.tmpdir(), never the working checkout. This suite used to scratch inside
// `<cwd>/nimbalyst-local/test-tmp`; if `git init` was ever skipped or hijacked,
// every subsequent commit walked up into the real stravu-editor repo and was
// authored from the developer's ~/.gitconfig. See testSupport/gitTestSandbox.ts.
const testTempRoot = process.env.NIMBALYST_TEST_TEMP_DIR ?? os.tmpdir();

beforeEach(async () => {
  await fs.mkdir(testTempRoot, { recursive: true });
  tmpRoot = await fs.mkdtemp(path.join(testTempRoot, 'nim-git-commit-service-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd, env: gitSandboxEnv(testTempRoot) });
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: gitSandboxEnv(testTempRoot) });
  return stdout;
}

async function gitBytes(args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'buffer', env: gitSandboxEnv(testTempRoot) }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/** `git init` + a sandbox assertion, so no test can commit outside tmpRoot. */
async function initScratchRepo(cwd: string): Promise<void> {
  await git(['init', '-q'], cwd);
  await git(['config', 'user.email', 'test@example.com'], cwd);
  await git(['config', 'user.name', 'Test User'], cwd);
  await git(['config', 'commit.gpgsign', 'false'], cwd);
  assertGitSandbox(cwd, testTempRoot);
}

describe('GitCommitService', () => {
  it('rejects an empty proposal without committing the current index', async () => {
    await initScratchRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'already-staged.txt'), 'keep\n', 'utf8');
    await git(['add', 'already-staged.txt'], tmpRoot);

    const result = await executeGitCommit(tmpRoot, 'must not commit an empty selection', []);

    expect(result.success).toBe(false);
    expect(await gitOutput(['diff', '--cached', '--name-only'], tmpRoot)).toBe('already-staged.txt\n');
  });

  it('commits a selected absolute file path relative to its repository', async () => {
    await initScratchRepo(tmpRoot);

    const absoluteFilePath = path.join(tmpRoot, 'a.txt');
    await fs.writeFile(absoluteFilePath, 'hello\n', 'utf8');

    const result = await executeGitCommit(tmpRoot, 'commit absolute path', [absoluteFilePath]);

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeTruthy();
  });

  it('ignores inherited repository-selection env and commits only in the requested workspace', async () => {
    await initScratchRepo(tmpRoot);
    const selectedPath = path.join(tmpRoot, 'a.txt');
    await fs.writeFile(selectedPath, 'scratch\n', 'utf8');

    const decoyRoot = await fs.mkdtemp(path.join(testTempRoot, 'nim-git-commit-decoy-'));
    await initScratchRepo(decoyRoot);
    await fs.writeFile(path.join(decoyRoot, 'seed.txt'), 'seed\n', 'utf8');
    await git(['add', 'seed.txt'], decoyRoot);
    await git(['commit', '-q', '-m', 'decoy baseline'], decoyRoot);
    const decoyHeadBefore = (await gitOutput(['rev-parse', 'HEAD'], decoyRoot)).trim();
    await fs.writeFile(path.join(decoyRoot, 'a.txt'), 'must stay uncommitted\n', 'utf8');

    const inheritedKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;
    const previousValues = new Map(
      inheritedKeys.map((key) => [key, process.env[key]])
    );
    process.env.GIT_DIR = path.join(decoyRoot, '.git');
    process.env.GIT_WORK_TREE = decoyRoot;
    process.env.GIT_INDEX_FILE = path.join(decoyRoot, '.git', 'index');

    try {
      const result = await executeGitCommit(tmpRoot, 'commit requested workspace', [selectedPath]);

      expect(result.success).toBe(true);
      expect((await gitOutput(['rev-parse', 'HEAD'], decoyRoot)).trim()).toBe(decoyHeadBefore);
      expect(await gitOutput(['status', '--porcelain', '--', 'a.txt'], decoyRoot)).toBe('?? a.txt\n');
      expect(await gitOutput(['log', '-1', '--format=%s'], tmpRoot)).toBe('commit requested workspace\n');
    } finally {
      for (const key of inheritedKeys) {
        const previousValue = previousValues.get(key);
        if (previousValue === undefined) delete process.env[key];
        else process.env[key] = previousValue;
      }
      await fs.rm(decoyRoot, { recursive: true, force: true });
    }
  });

  it('commits only the selected file while preserving unrelated staged and unstaged hunks', async () => {
    await initScratchRepo(tmpRoot);

    const unrelatedPath = path.join(tmpRoot, 'unrelated.txt');
    const selectedPath = path.join(tmpRoot, 'selected.txt');
    await fs.writeFile(unrelatedPath, 'first\nsecond\n', 'utf8');
    await fs.writeFile(selectedPath, 'before\n', 'utf8');
    await git(['add', 'unrelated.txt', 'selected.txt'], tmpRoot);
    await git(['commit', '-q', '-m', 'baseline'], tmpRoot);
    const baselineHead = (await gitOutput(['rev-parse', 'HEAD'], tmpRoot)).trim();

    await fs.writeFile(unrelatedPath, 'first staged\nsecond\n', 'utf8');
    await git(['add', 'unrelated.txt'], tmpRoot);
    await fs.writeFile(unrelatedPath, 'first staged\nsecond unstaged-only\n', 'utf8');
    const cachedDiffBefore = await gitBytes(['diff', '--cached', '--binary', '--', 'unrelated.txt'], tmpRoot);

    await fs.writeFile(selectedPath, 'after\n', 'utf8');

    const result = await executeGitCommit(tmpRoot, 'commit selected file', ['selected.txt']);

    expect(result.success).toBe(true);
    expect(result.commitHash).toBe((await gitOutput(['rev-parse', 'HEAD'], tmpRoot)).trim());
    expect(await gitOutput(['rev-list', '--count', `${baselineHead}..HEAD`], tmpRoot)).toBe('1\n');
    expect(await gitOutput(['log', '-1', '--format=%s'], tmpRoot)).toBe('commit selected file\n');
    expect(await gitOutput(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], tmpRoot)).toBe('selected.txt\n');
    expect(await gitBytes(['diff', '--cached', '--binary', '--', 'unrelated.txt'], tmpRoot)).toEqual(cachedDiffBefore);

    const cachedUnrelatedDiff = await gitOutput(['diff', '--cached', '--unified=0', '--', 'unrelated.txt'], tmpRoot);
    const workingUnrelatedDiff = await gitOutput(['diff', '--unified=0', '--', 'unrelated.txt'], tmpRoot);
    expect(cachedUnrelatedDiff).toContain('first staged');
    expect(cachedUnrelatedDiff).not.toContain('unstaged-only');
    expect(workingUnrelatedDiff).toContain('second unstaged-only');
  });

  it('commits an absolute path in the selected linked worktree, not its parent checkout', async () => {
    await initScratchRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'seed.txt'), 'seed\n', 'utf8');
    await git(['add', 'seed.txt'], tmpRoot);
    await git(['commit', '-q', '-m', 'seed'], tmpRoot);

    const worktreePath = path.join(tmpRoot, 'linked-worktree');
    await git(['worktree', 'add', '-b', 'feature/worktree-commit', worktreePath], tmpRoot);
    try {
      const filePath = path.join(worktreePath, 'worktree-only.txt');
      await fs.writeFile(filePath, 'worktree\n', 'utf8');

      const result = await executeGitCommit(worktreePath, 'commit in linked worktree', [filePath]);

      expect(result.success).toBe(true);
      expect(await gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)).toBe('feature/worktree-commit\n');
      expect(await gitOutput(['log', '-1', '--format=%s'], tmpRoot)).toBe('seed\n');
    } finally {
      await git(['worktree', 'remove', '--force', worktreePath], tmpRoot);
    }
  });

  it('rejects a selected path outside the repository', async () => {
    await initScratchRepo(tmpRoot);

    const outsidePath = path.join(path.dirname(tmpRoot), 'outside.txt');
    await fs.writeFile(outsidePath, 'outside\n', 'utf8');

    try {
      const result = await executeGitCommit(tmpRoot, 'must not commit outside path', [outsidePath]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('outside the repository');
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('preserves existing staging when rejecting an outside path', async () => {
    await initScratchRepo(tmpRoot);

    await fs.writeFile(path.join(tmpRoot, 'already-staged.txt'), 'keep\n', 'utf8');
    await git(['add', 'already-staged.txt'], tmpRoot);
    const outsidePath = path.join(path.dirname(tmpRoot), 'outside.txt');
    await fs.writeFile(outsidePath, 'outside\n', 'utf8');

    try {
      const result = await executeGitCommit(tmpRoot, 'must not change the index', [outsidePath]);

      expect(result.success).toBe(false);
      expect(await gitOutput(['diff', '--cached', '--name-only'], tmpRoot)).toBe('already-staged.txt\n');
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('rejects Git pathspec magic in a proposal', async () => {
    await initScratchRepo(tmpRoot);

    const result = await executeGitCommit(tmpRoot, 'must not expand a pathspec', [':(glob)**/*']);

    expect(result.success).toBe(false);
    expect(result.error).toContain('literal path');
  });

  it('returns a failure result with hook output when pre-commit rejects the commit', async () => {
    await initScratchRepo(tmpRoot);

    const hooksDir = path.join(tmpRoot, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-commit'),
      '#!/bin/sh\n' +
      'echo "PRECOMMIT_STDOUT" 1>&2\n' +
      'echo "HOOK_DETAIL: lint failed" 1>&2\n' +
      'exit 1\n',
      { mode: 0o755 }
    );

    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'hello\n', 'utf8');

    const streamed: string[] = [];
    const result = await executeGitCommit(tmpRoot, 'test commit', ['a.txt'], {
      logContext: '[test:git-commit]',
      onOutput: (stream, chunk) => streamed.push(`${stream}:${chunk}`),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('PRECOMMIT_STDOUT');
    expect(result.error).toContain('HOOK_DETAIL: lint failed');
    expect(streamed.join('')).toContain('stderr:PRECOMMIT_STDOUT');
    expect(streamed.join('')).toContain('HOOK_DETAIL: lint failed');
  });

  it('restores the exact existing index when a hook rejects the proposed commit', async () => {
    await initScratchRepo(tmpRoot);

    await fs.writeFile(path.join(tmpRoot, 'already-staged.txt'), 'keep\n', 'utf8');
    await git(['add', 'already-staged.txt'], tmpRoot);
    const before = await gitOutput(['diff', '--cached', '--binary'], tmpRoot);

    const hooksDir = path.join(tmpRoot, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await fs.writeFile(path.join(tmpRoot, 'proposed.txt'), 'proposal\n', 'utf8');

    const result = await executeGitCommit(tmpRoot, 'hook must reject', ['proposed.txt']);

    expect(result.success).toBe(false);
    expect(await gitOutput(['diff', '--cached', '--binary'], tmpRoot)).toBe(before);
  });

  it('runs hooks with the injected subprocess env so PATH-dependent hooks resolve', async () => {
    await initScratchRepo(tmpRoot);

    // A binary that lives ONLY in a directory absent from the test process PATH,
    // standing in for an nvm-managed `yarn` that husky hooks invoke.
    const fakeBinDir = path.join(tmpRoot, 'fakebin');
    await fs.mkdir(fakeBinDir, { recursive: true });
    await fs.writeFile(
      path.join(fakeBinDir, 'nimbalyst_hook_marker'),
      '#!/bin/sh\nexit 0\n',
      { mode: 0o755 }
    );

    const hooksDir = path.join(tmpRoot, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-commit'),
      '#!/bin/sh\nnimbalyst_hook_marker\n',
      { mode: 0o755 }
    );

    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'hello\n', 'utf8');

    const result = await executeGitCommit(tmpRoot, 'commit with hook', ['a.txt'], {
      logContext: '[test:git-commit]',
      env: {
        ...process.env,
        // simple-git's .env() scans the supplied environment and blocks these
        // unless its unsafe flags are enabled; they are ubiquitous in real
        // shells, so a working fix must tolerate them.
        GIT_EDITOR: 'vim',
        GIT_PAGER: 'less',
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      },
    });

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeTruthy();
  });

  it('retries past a briefly-held .git/index.lock and commits successfully', async () => {
    await initScratchRepo(tmpRoot);

    // Seed commit so executeGitCommit's reset-HEAD path (which writes the index) runs.
    await fs.writeFile(path.join(tmpRoot, 'seed.txt'), 'seed\n', 'utf8');
    await git(['add', 'seed.txt'], tmpRoot);
    await git(['commit', '-q', '-m', 'seed'], tmpRoot);

    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'hello\n', 'utf8');

    // Simulate another git process holding index.lock, releasing it shortly after.
    const lockPath = path.join(tmpRoot, '.git', 'index.lock');
    await fs.writeFile(lockPath, '', 'utf8');
    const releaseTimer = setTimeout(() => {
      void fs.rm(lockPath, { force: true });
    }, 250);

    try {
      const result = await executeGitCommit(tmpRoot, 'commit under lock', ['a.txt'], {
        logContext: '[test:git-commit]',
        lockRetry: { maxRetries: 8, baseDelayMs: 50 },
      });
      expect(result.success).toBe(true);
      expect(result.commitHash).toBeTruthy();
    } finally {
      clearTimeout(releaseTimer);
      await fs.rm(lockPath, { force: true });
    }
  });

  /**
   * Staging and committing happen in a private index, so a held `.git/index.lock`
   * no longer blocks a commit — it only stops the post-commit refresh. That is a
   * deliberate improvement over aborting: the commit itself never needed the real
   * index. Concurrent writers of that index are unaffected, and two competing
   * commits still serialize on the ref lock rather than the index lock.
   */
  it('still commits when .git/index.lock is held persistently, reporting the unrefreshed index', async () => {
    await initScratchRepo(tmpRoot);

    await fs.writeFile(path.join(tmpRoot, 'seed.txt'), 'seed\n', 'utf8');
    await git(['add', 'seed.txt'], tmpRoot);
    await git(['commit', '-q', '-m', 'seed'], tmpRoot);

    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'hello\n', 'utf8');

    const lockPath = path.join(tmpRoot, '.git', 'index.lock');
    await fs.writeFile(lockPath, '', 'utf8');

    try {
      const result = await executeGitCommit(tmpRoot, 'commit under lock', ['a.txt'], {
        logContext: '[test:git-commit]',
        lockRetry: { maxRetries: 3, baseDelayMs: 20 },
      });
      expect(result.success).toBe(true);
      expect(await gitOutput(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], tmpRoot)).toBe('a.txt\n');
      // The one cost of the held lock, reported rather than hidden.
      expect(result.indexRefreshFailed).toBe(true);
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  });

  /**
   * NIM-2284. A commit must leave the index agreeing with HEAD for every path it
   * committed. These three drive the failure from real Git mechanics rather than
   * from wall-clock timing:
   *
   *   - a `post-commit` hook takes `.git/index.lock` at exactly the moment the
   *     post-commit index refresh runs, and releases it shortly after;
   *   - a `pre-commit` hook running `env -u GIT_INDEX_FILE git add` stands in for
   *     a terminal or second Nimbalyst process staging into the REAL index while
   *     a proposal is mid-flight.
   */
  describe('index consistency under concurrent git processes', () => {
    async function seedRepo(): Promise<void> {
      await initScratchRepo(tmpRoot);
      await fs.writeFile(path.join(tmpRoot, 'tracked.txt'), 'v1\n', 'utf8');
      await git(['add', 'tracked.txt'], tmpRoot);
      await git(['commit', '-q', '-m', 'seed'], tmpRoot);
    }

    async function writeHook(name: string, body: string): Promise<void> {
      const hooksDir = path.join(tmpRoot, '.git', 'hooks');
      await fs.mkdir(hooksDir, { recursive: true });
      await fs.writeFile(path.join(hooksDir, name), body, { mode: 0o755 });
    }

    it('leaves the index agreeing with HEAD when index.lock is held across the post-commit refresh', async () => {
      await seedRepo();

      // The committed set spans both shapes the incident produced: a modified
      // tracked file (reported `MM`) and a brand-new file (reported `D `).
      await fs.writeFile(path.join(tmpRoot, 'tracked.txt'), 'v2\n', 'utf8');
      await fs.writeFile(path.join(tmpRoot, 'added.txt'), 'brand new\n', 'utf8');

      // Held from post-commit — after Git has released its own lock, and exactly
      // when the service reaches its post-commit index bookkeeping. The detached
      // subshell outlives the hook so the lock is still held when that runs.
      const lockPath = path.join(tmpRoot, '.git', 'index.lock');
      await writeHook(
        'post-commit',
        '#!/bin/sh\n' +
        `: > '${lockPath}'\n` +
        `( sleep 0.3; rm -f '${lockPath}' ) </dev/null >/dev/null 2>&1 &\n` +
        'exit 0\n'
      );

      try {
        const result = await executeGitCommit(tmpRoot, 'commit under post-commit lock', ['tracked.txt', 'added.txt'], {
          logContext: '[test:git-commit]',
          lockRetry: { maxRetries: 8, baseDelayMs: 40 },
        });

        expect(result.success).toBe(true);
        expect(await gitOutput(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], tmpRoot))
          .toBe('added.txt\ntracked.txt\n');

        // The defect: the index still holds the PRE-commit blobs for exactly the
        // files just committed, so the cached diff is the inverse of the commit.
        expect(await gitOutput(['diff', '--cached', '--name-only'], tmpRoot)).toBe('');
        expect(await gitOutput(['status', '--porcelain', '--', 'tracked.txt', 'added.txt'], tmpRoot)).toBe('');
      } finally {
        await fs.rm(lockPath, { force: true });
      }
    });

    it('preserves a concurrent external git add made while a proposal is mid-flight', async () => {
      await seedRepo();

      await fs.writeFile(path.join(tmpRoot, 'proposed.txt'), 'mine\n', 'utf8');
      await fs.writeFile(path.join(tmpRoot, 'theirs.txt'), 'theirs\n', 'utf8');

      // `env -u GIT_INDEX_FILE` makes this behave like a terminal or a second
      // Nimbalyst process: it always targets the repository's REAL index, never
      // whatever private index the service may be committing from.
      await writeHook(
        'pre-commit',
        '#!/bin/sh\n' +
        'env -u GIT_INDEX_FILE git add theirs.txt\n' +
        'exit 0\n'
      );

      const result = await executeGitCommit(tmpRoot, 'commit only the proposal', ['proposed.txt'], {
        logContext: '[test:git-commit]',
      });

      expect(result.success).toBe(true);
      // `--name-status`, not `--name-only`: today the byte-for-byte index restore
      // erases this staging with no error, and because the file also rode along
      // into the commit it reappears as a staged DELETE under the same name.
      expect(await gitOutput(['diff', '--cached', '--name-status'], tmpRoot)).toBe('A\ttheirs.txt\n');
    });

    it('commits exactly the verified file set when another process stages into the real index', async () => {
      await seedRepo();

      await fs.writeFile(path.join(tmpRoot, 'proposed.txt'), 'mine\n', 'utf8');
      await fs.writeFile(path.join(tmpRoot, 'theirs.txt'), 'theirs\n', 'utf8');

      await writeHook(
        'pre-commit',
        '#!/bin/sh\n' +
        'env -u GIT_INDEX_FILE git add theirs.txt\n' +
        'exit 0\n'
      );

      const result = await executeGitCommit(tmpRoot, 'commit only the proposal', ['proposed.txt'], {
        logContext: '[test:git-commit]',
      });

      expect(result.success).toBe(true);
      // The staged-set verification runs before `git commit` with no lock held
      // in between, so today an unapproved file rides along into the commit.
      expect(await gitOutput(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], tmpRoot))
        .toBe('proposed.txt\n');
    });

    it('never writes the real index before the commit is durable', async () => {
      await seedRepo();

      await fs.writeFile(path.join(tmpRoot, 'tracked.txt'), 'v2\n', 'utf8');
      const snapshotPath = path.join(tmpRoot, 'index-during-commit.bin');
      const realIndexPath = path.join(tmpRoot, '.git', 'index');

      // Capture the real index at the one moment staging is complete and the
      // commit is about to be written.
      await writeHook(
        'pre-commit',
        '#!/bin/sh\n' +
        `cp '${realIndexPath}' '${snapshotPath}'\n` +
        'exit 0\n'
      );

      const before = await fs.readFile(realIndexPath);
      const result = await executeGitCommit(tmpRoot, 'commit without touching the real index', ['tracked.txt']);

      expect(result.success).toBe(true);
      expect(await fs.readFile(snapshotPath)).toEqual(before);
    });

    it('leaves no temporary index behind on success or on hook rejection', async () => {
      await seedRepo();
      const gitDir = path.join(tmpRoot, '.git');
      const tempIndexes = async () =>
        (await fs.readdir(gitDir)).filter((entry) => entry.startsWith('nimbalyst-commit-'));

      await fs.writeFile(path.join(tmpRoot, 'tracked.txt'), 'v2\n', 'utf8');
      expect((await executeGitCommit(tmpRoot, 'succeeds', ['tracked.txt'])).success).toBe(true);
      expect(await tempIndexes()).toEqual([]);

      await writeHook('pre-commit', '#!/bin/sh\nexit 1\n');
      await fs.writeFile(path.join(tmpRoot, 'tracked.txt'), 'v3\n', 'utf8');
      expect((await executeGitCommit(tmpRoot, 'is rejected', ['tracked.txt'])).success).toBe(false);
      expect(await tempIndexes()).toEqual([]);
    });

    /**
     * `GIT_INDEX_FILE` is deliberately left visible to hooks, matching what Git
     * itself does when the variable is set. Scrubbing it would be worse than the
     * status quo: a hook running `git add` would write the real index while the
     * commit came from the private one, recreating the divergence NIM-2284 fixed.
     */
    it('lets a pre-commit hook stage into the index being committed', async () => {
      await seedRepo();

      await fs.writeFile(path.join(tmpRoot, 'proposed.txt'), 'mine\n', 'utf8');
      await fs.writeFile(path.join(tmpRoot, 'generated.txt'), 'from the hook\n', 'utf8');
      await writeHook('pre-commit', '#!/bin/sh\ngit add generated.txt\nexit 0\n');

      const result = await executeGitCommit(tmpRoot, 'hook adds a generated file', ['proposed.txt']);

      expect(result.success).toBe(true);
      expect(await gitOutput(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], tmpRoot))
        .toBe('generated.txt\nproposed.txt\n');
    });
  });

  describe('hunk-level staging', () => {
    /**
     * The scenario this feature exists for: two sessions working in the repo
     * root have both edited one file, far enough apart to be separate hunks.
     */
    async function seedTwoSessionEdits(): Promise<{ file: string; refs: HunkRef[] }> {
      await initScratchRepo(tmpRoot);
      const file = path.join(tmpRoot, 'shared.txt');
      const base = `${Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n')}\n`;
      await fs.writeFile(file, base, 'utf8');
      await git(['add', 'shared.txt'], tmpRoot);
      await git(['commit', '-q', '-m', 'base'], tmpRoot);

      const edited = base.split('\n');
      edited[4] = 'SESSION-A-EDIT';
      edited[24] = 'SESSION-B-EDIT';
      await fs.writeFile(file, edited.join('\n'), 'utf8');

      const parsed = parseUnifiedDiffToHunks(
        await gitOutput(['diff', 'HEAD', '--', 'shared.txt'], tmpRoot)
      );
      expect(parsed.hunks).toHaveLength(2);
      return {
        file,
        refs: parsed.hunks.map((h) => ({
          oldStart: h.oldStart,
          oldLines: h.oldLines,
          newStart: h.newStart,
          newLines: h.newLines,
        })),
      };
    }

    it('commits one session\'s hunk and leaves the other session\'s edit in the working tree', async () => {
      const { file, refs } = await seedTwoSessionEdits();

      const result = await executeGitCommit(tmpRoot, 'commit only session A', [file], {
        hunkSelections: [{ path: file, hunks: [refs[0]] }],
      });

      expect(result.success).toBe(true);

      // The commit carries session A's line and not session B's.
      const committed = await gitOutput(['show', 'HEAD:shared.txt'], tmpRoot);
      expect(committed).toContain('SESSION-A-EDIT');
      expect(committed).not.toContain('SESSION-B-EDIT');
      expect(committed).toContain('line25');

      // The working tree is untouched: both edits are still on disk.
      const onDisk = await fs.readFile(file, 'utf8');
      expect(onDisk).toContain('SESSION-A-EDIT');
      expect(onDisk).toContain('SESSION-B-EDIT');

      // And the leftover hunk is still pending, not silently swallowed.
      expect(await gitOutput(['status', '--porcelain', '--', 'shared.txt'], tmpRoot)).toBe(
        ' M shared.txt\n'
      );
    });

    it('aborts without committing when a hunk ref no longer matches the file', async () => {
      const { file, refs } = await seedTwoSessionEdits();
      const headBefore = (await gitOutput(['rev-parse', 'HEAD'], tmpRoot)).trim();

      const stale: HunkRef = { ...refs[0], oldStart: refs[0].oldStart + 7 };
      const result = await executeGitCommit(tmpRoot, 'should not land', [file], {
        hunkSelections: [{ path: file, hunks: [stale] }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/out of date/i);
      expect((await gitOutput(['rev-parse', 'HEAD'], tmpRoot)).trim()).toBe(headBefore);
      // The real index must be untouched by a rejected proposal.
      expect(await gitOutput(['diff', '--cached', '--name-only'], tmpRoot)).toBe('');
    });

    it('stages a partial file and a whole file in the same commit', async () => {
      const { file, refs } = await seedTwoSessionEdits();
      const wholeFile = path.join(tmpRoot, 'whole.txt');
      await fs.writeFile(wholeFile, 'entirely new\n', 'utf8');

      const result = await executeGitCommit(tmpRoot, 'mixed staging', [file, wholeFile], {
        hunkSelections: [{ path: file, hunks: [refs[1]] }],
      });

      expect(result.success).toBe(true);
      expect(await gitOutput(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], tmpRoot))
        .toBe('shared.txt\nwhole.txt\n');

      const committed = await gitOutput(['show', 'HEAD:shared.txt'], tmpRoot);
      expect(committed).toContain('SESSION-B-EDIT');
      expect(committed).not.toContain('SESSION-A-EDIT');
    });

    it('refuses a hunk selection for a file outside the commit', async () => {
      const { file, refs } = await seedTwoSessionEdits();
      const other = path.join(tmpRoot, 'other.txt');
      await fs.writeFile(other, 'x\n', 'utf8');

      const result = await executeGitCommit(tmpRoot, 'mismatched selection', [other], {
        hunkSelections: [{ path: file, hunks: [refs[0]] }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not in the commit's file list/);
    });

    it('leaves whole-file staging untouched when no hunk selection is passed', async () => {
      const { file } = await seedTwoSessionEdits();

      const result = await executeGitCommit(tmpRoot, 'whole file', [file]);

      expect(result.success).toBe(true);
      const committed = await gitOutput(['show', 'HEAD:shared.txt'], tmpRoot);
      expect(committed).toContain('SESSION-A-EDIT');
      expect(committed).toContain('SESSION-B-EDIT');
    });
  });

  it('maps failed commit execution to an error proposal response', () => {
    expect(
      createGitCommitProposalResponse(
        { success: false, error: 'HOOK_DETAIL: lint failed' },
        ['a.txt'],
        'test commit'
      )
    ).toEqual({
      action: 'error',
      error: 'HOOK_DETAIL: lint failed',
    });
  });

  it('commits files at the repo root when the workspace is a subfolder (#124)', async () => {
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);

    const sub = path.join(tmpRoot, 'home');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'inner.txt'), 'inner\n', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'root.txt'), 'root\n', 'utf8');

    const result = await executeGitCommit(
      sub, // workspace is the SUBFOLDER, not the repo root
      'subfolder commit',
      [path.join(sub, 'inner.txt'), path.join(tmpRoot, 'root.txt')],
      { logContext: '[test:git-commit]' }
    );

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeTruthy();

    const { stdout } = await execFileAsync(
      'git',
      ['show', '--name-only', '--format='],
      { cwd: tmpRoot }
    );
    const committed = stdout.trim().split('\n');
    expect(committed).toContain('home/inner.txt');
    expect(committed).toContain('root.txt');
  });

  it('commits a staged deletion from a subfolder workspace', async () => {
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);

    const sub = path.join(tmpRoot, 'home');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'del.txt'), 'bye\n', 'utf8');
    await git(['add', '.'], tmpRoot);
    await git(['commit', '-q', '-m', 'init'], tmpRoot);
    await fs.rm(path.join(sub, 'del.txt'));

    const result = await executeGitCommit(
      sub,
      'delete file',
      [path.join(sub, 'del.txt')],
      { logContext: '[test:git-commit]' }
    );

    expect(result.success).toBe(true);

    const { stdout } = await execFileAsync(
      'git',
      ['show', '--name-only', '--format='],
      { cwd: tmpRoot }
    );
    expect(stdout.trim().split('\n')).toContain('home/del.txt');
  });
});
