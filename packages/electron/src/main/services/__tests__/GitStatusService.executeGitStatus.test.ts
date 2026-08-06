import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: execFileMock };
});

vi.mock('../../utils/gitUtils', async () => {
  const actual = await vi.importActual<typeof import('../../utils/gitUtils')>('../../utils/gitUtils');
  return { ...actual, isGitAvailable: () => true };
});

import { GitStatusService } from '../GitStatusService';

type GitStatusServiceInternals = {
  executeGitStatus(workspacePath: string): Promise<string>;
};

function executeGitStatus(service: GitStatusService, workspacePath: string): Promise<string> {
  return (service as unknown as GitStatusServiceInternals).executeGitStatus(workspacePath);
}

let workspacePath: string;

beforeEach(async () => {
  execFileMock.mockReset();
  workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-git-status-cache-'));
  // A real repo, not just a `.git` directory: the repository gate asks git for
  // the toplevel (#124), and git rejects an empty `.git` as "not a repository".
  // execFileSync is the real one -- only execFile is mocked above.
  execFileSync('git', ['init', '-q'], { cwd: workspacePath, stdio: 'pipe' });
});

afterEach(async () => {
  await fs.rm(workspacePath, { recursive: true, force: true });
});

describe('GitStatusService executeGitStatus', () => {
  it('coalesces concurrent status requests for one repository into one asynchronous child process', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, ' M changed.ts\n', ''));
    });
    const service = new GitStatusService();

    await expect(Promise.all([
      executeGitStatus(service, '/workspace'),
      executeGitStatus(service, '/workspace'),
    ])).resolves.toEqual([' M changed.ts\n', ' M changed.ts\n']);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      // `--no-optional-locks` keeps this read-only call off `.git/index` (NIM-2285).
      ['--no-optional-locks', 'status', '--porcelain'],
      expect.objectContaining({ cwd: '/workspace', encoding: 'utf8', timeout: 5000 }),
      expect.any(Function),
    );
  });

  it('clears a failed in-flight request so a later request preserves retry behavior', async () => {
    execFileMock
      .mockImplementationOnce((_file, _args, _options, callback) => {
        queueMicrotask(() => callback(new Error('git status failed'), '', 'fatal'));
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        queueMicrotask(() => callback(null, '', ''));
      });
    const service = new GitStatusService();

    await expect(executeGitStatus(service, '/workspace')).rejects.toThrow('git status failed');
    await expect(executeGitStatus(service, '/workspace')).resolves.toBe('');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('does not repopulate a cleared status cache when a pending command completes', async () => {
    let completeStatus: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      completeStatus = callback;
    });
    const service = new GitStatusService();

    const staleRequest = service.getAllFileStatuses(workspacePath);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    service.clearCache(workspacePath);
    completeStatus!(null, ' M stale.ts\n', '');
    await expect(staleRequest).resolves.toEqual({
      [path.join(workspacePath, 'stale.ts')]: expect.objectContaining({ status: 'modified' }),
    });

    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      callback(null, ' M fresh.ts\n', '');
    });
    await expect(service.getAllFileStatuses(workspacePath)).resolves.toEqual({
      [path.join(workspacePath, 'fresh.ts')]: expect.objectContaining({ status: 'modified' }),
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
