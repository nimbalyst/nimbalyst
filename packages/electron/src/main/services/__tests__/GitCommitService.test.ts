import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGitCommitProposalResponse,
  executeGitCommit,
} from '../GitCommitService';

const execFileAsync = promisify(execFile);

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-git-commit-service-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

describe('GitCommitService', () => {
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
});
