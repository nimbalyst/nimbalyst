import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGitCommitProposalResponse,
  executeGitCommit,
} from '../GitCommitService';

const execFileAsync = promisify(execFile);

let tmpRoot: string;
const testTempRoot = process.env.NIMBALYST_TEST_TEMP_DIR
  ?? path.join(process.cwd(), 'nimbalyst-local', 'test-tmp');

beforeEach(async () => {
  await fs.mkdir(testTempRoot, { recursive: true });
  tmpRoot = await fs.mkdtemp(path.join(testTempRoot, 'nim-git-commit-service-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function gitBytes(args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'buffer' }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

describe('GitCommitService', () => {
  it('rejects an empty proposal without committing the current index', async () => {
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'already-staged.txt'), 'keep\n', 'utf8');
    await git(['add', 'already-staged.txt'], tmpRoot);

    const result = await executeGitCommit(tmpRoot, 'must not commit an empty selection', []);

    expect(result.success).toBe(false);
    expect(await gitOutput(['diff', '--cached', '--name-only'], tmpRoot)).toBe('already-staged.txt\n');
  });

  it('commits a selected absolute file path relative to its repository', async () => {
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);

    const absoluteFilePath = path.join(tmpRoot, 'a.txt');
    await fs.writeFile(absoluteFilePath, 'hello\n', 'utf8');

    const result = await executeGitCommit(tmpRoot, 'commit absolute path', [absoluteFilePath]);

    expect(result.success).toBe(true);
    expect(result.commitHash).toBeTruthy();
  });

  it('commits only the selected file while preserving unrelated staged and unstaged hunks', async () => {
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);

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
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);
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
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);

    const outsidePath = path.join(path.dirname(tmpRoot), 'outside.txt');
    await fs.writeFile(outsidePath, 'outside\n', 'utf8');

    try {
      const result = await executeGitCommit(tmpRoot, 'must not commit outside path', [outsidePath]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('outside the session workspace');
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('preserves existing staging when rejecting an outside path', async () => {
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);

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
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);

    const result = await executeGitCommit(tmpRoot, 'must not expand a pathspec', [':(glob)**/*']);

    expect(result.success).toBe(false);
    expect(result.error).toContain('literal path');
  });

  it('returns a failure result with hook output when pre-commit rejects the commit', async () => {
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);

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
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);

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
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);

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
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);

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

  it('surfaces a clear lock error when .git/index.lock is held persistently', async () => {
    await git(['init', '-q'], tmpRoot);
    await git(['config', 'user.email', 'test@example.com'], tmpRoot);
    await git(['config', 'user.name', 'Test User'], tmpRoot);

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
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/locked by another git process/i);
    } finally {
      await fs.rm(lockPath, { force: true });
    }
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
});
