// @vitest-environment node
/**
 * PM-23: the call sites moved onto `runGit` stay importable and testable
 * without Electron. Every module below throws if anything in their import
 * graph loads it, and with no transport configured (the default outside the
 * app) the calls run `execFile` in process exactly as before: synchronously,
 * with the same options, tolerating a mock that calls back synchronously and
 * returns null.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { prepareShellCheckoutBaseline } from '../../ai/ShellCheckoutBaseline';
import { GitStatusService } from '../../GitStatusService';
import { getUntrackedFilesInDirectories } from '../../../utils/gitUtils';

vi.mock('electron', () => { throw new Error('a git call site imported electron'); });
vi.mock('electron-log', () => { throw new Error('a git call site imported electron-log'); });
vi.mock('../../../utils/logger', () => { throw new Error('a git call site imported utils/logger'); });
vi.mock('../../../utils/store', () => { throw new Error('a git call site imported utils/store'); });
vi.mock('../../../utilityProcess/UtilityProcessSupervisor', () => { throw new Error('a git call site imported the supervisor'); });
vi.mock('../gitRunnerClient', () => { throw new Error('a git call site imported the runner client'); });
vi.mock('../gitRunnerService', () => { throw new Error('a git call site imported the runner service'); });

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: vi.fn() };
});

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

afterEach(() => {
  vi.mocked(execFile).mockReset();
  vi.restoreAllMocks();
});

function answerSynchronously(stdout = ''): void {
  vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _options: unknown, callback: Callback) => {
    callback(null, stdout, '');
    return null;
  }) as unknown as typeof execFile);
}

it('PM-23: git status runs in process, in the same tick, with its options unchanged', async () => {
  answerSynchronously(' M a.md\n');
  const pending = (new GitStatusService() as unknown as { executeGitStatus(p: string): Promise<string> }).executeGitStatus('/repo');
  expect(execFile).toHaveBeenCalledWith('git', ['--no-optional-locks', 'status', '--porcelain'],
    { windowsHide: true, encoding: 'utf8', cwd: '/repo', timeout: 5000 }, expect.any(Function));
  await expect(pending).resolves.toBe(' M a.md\n');
});

it('PM-23: the untracked ls-files chunk runs in process, in the same tick, with its options unchanged', async () => {
  answerSynchronously('dir/a.md\0');
  const pending = getUntrackedFilesInDirectories('/repo', ['/repo/dir']);
  expect(execFile).toHaveBeenCalledWith('git',
    ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z', '--', 'dir'],
    { windowsHide: true, encoding: 'utf8', cwd: '/repo', maxBuffer: 64 * 1024 * 1024 }, expect.any(Function));
  expect((await pending).get('/repo/dir')).toEqual(['dir/a.md']);
});

it('PM-23: the shell baseline git query runs in process, in the same tick, with its options unchanged', async () => {
  const error = Object.assign(new Error('Command failed: git -C /ws worktree list --porcelain -z\nfatal: not a git repository'), { code: 128 });
  vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _options: unknown, callback: Callback) => {
    callback(error, '', '');
    return null;
  }) as unknown as typeof execFile);
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const pending = prepareShellCheckoutBaseline('/ws');
  expect(execFile).toHaveBeenCalledWith('git', ['-C', '/ws', 'worktree', 'list', '--porcelain', '-z'],
    { windowsHide: true, encoding: 'utf8', timeout: 625, maxBuffer: 4 * 1024 * 1024 }, expect.any(Function));
  await expect(pending).resolves.toBeUndefined();
});
