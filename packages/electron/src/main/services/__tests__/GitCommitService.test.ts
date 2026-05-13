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

    const result = await executeGitCommit(tmpRoot, 'test commit', ['a.txt'], {
      logContext: '[test:git-commit]',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('PRECOMMIT_STDOUT');
    expect(result.error).toContain('HOOK_DETAIL: lint failed');
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
