// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';

const boundary = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const status = vi.fn();
  const journal = { onOperationTerminal: vi.fn(), start: vi.fn() };
  const spawn = vi.fn();
  const streaming = vi.fn(async (_journal: unknown, _cwd: string, _args: string[]): Promise<{ success: boolean; error?: string }> => {
    journal.start();
    spawn();
    return { success: true };
  });
  return {
    handlers, status, journal, spawn, streaming,
    git: vi.fn(() => ({ status })),
    lock: vi.fn(async (_path: string, _name: string, fn: () => Promise<unknown>) => fn()),
  };
});
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => boundary.handlers.set(channel, handler),
}));
vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>(), existsSync: vi.fn(() => true) }));
vi.mock('simple-git', () => ({ default: boundary.git }));
vi.mock('../../services/gitEnv', () => ({ simpleGitWithHookEnv: boundary.git, getGitSubprocessEnv: vi.fn() }));
vi.mock('../../services/GitOperationLock', () => ({ gitOperationLock: { withLock: boundary.lock } }));
vi.mock('../../services/GitOperationLogService', () => ({
  getGitOperationLogService: () => boundary.journal,
  runGitCommandStreaming: boundary.streaming,
  withGitOperationLog: vi.fn(),
}));
import { registerGitHandlers } from '../GitHandlers';

beforeEach(() => {
  vi.clearAllMocks();
  boundary.handlers.clear();
  vi.mocked(existsSync).mockReturnValue(true);
  boundary.status.mockResolvedValue({ current: 'topic/日本語', conflicted: [] });
  boundary.streaming.mockImplementation(async () => {
    boundary.journal.start();
    boundary.spawn();
    return { success: true };
  });
  registerGitHandlers();
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return boundary.handlers.get(channel)!({}, ...args);
}

function expectNoOperations(): void {
  expect(boundary.lock).not.toHaveBeenCalled();
  expect(boundary.git).not.toHaveBeenCalled();
  expect(boundary.status).not.toHaveBeenCalled();
  expect(boundary.journal.start).not.toHaveBeenCalled();
  expect(boundary.streaming).not.toHaveBeenCalled();
  expect(boundary.spawn).not.toHaveBeenCalled();
}

describe('registered Git operand boundaries', () => {
  it('rejects an option-shaped push remote before lock, status, journal and spawn', async () => {
    await expect(invoke('git:push', '/fixture', { remote: '--dry-run' })).rejects.toThrow(/remote/);
    expectNoOperations();
  });
});

const invalidOperands = [null, false, 0, 17, {}, [], '', 'a\0b', '-', '--dry-run'];
const operandSlots: Array<[string, string, (value: unknown) => unknown[]]> = [
  ['git:push', 'remote', value => [{ remote: value }]],
  ['git:push', 'branch', value => [{ branch: value }]],
  ['git:fetch', 'remote', value => [{ remote: value }]],
  ['git:set-upstream', 'remote', value => [value]],
  ['git:set-upstream', 'branch', value => ['origin', value]],
  ['git:checkout', 'ref', value => [value]],
  ['git:cherry-pick', 'hash', value => [value]],
  ['git:create-branch', 'branchName', value => [value, 'HEAD']],
  ['git:create-branch', 'fromHash', value => ['topic', value]],
  ['git:rebase', 'target', value => [{ target: value }]],
  ['git:rebase', 'target with action', value => [{ action: 'continue', target: value }]],
];
const validCalls: Array<[string, unknown[]]> = [
  ['git:push', []], ['git:fetch', []], ['git:set-upstream', ['origin']],
  ['git:checkout', ['HEAD~1']], ['git:cherry-pick', ['HEAD^']],
  ['git:create-branch', ['topic']], ['git:rebase', [{ target: 'main' }]],
];

describe('runtime input rejection before operations', () => {
  it.each(operandSlots)('%s validates %s', async (channel, _slot, args) => {
    for (const value of invalidOperands) {
      await expect(invoke(channel, '/fixture', ...args(value))).rejects.toThrow();
      expectNoOperations();
    }
  });

  it.each(validCalls)('%s validates cwd without Git operand rules', async (channel, args) => {
    for (const value of [undefined, null, false, 0, {}, [], '', 'a\0b']) {
      await expect(invoke(channel, value, ...args)).rejects.toThrow(/repoPath/);
      expectNoOperations();
    }
    await expect(invoke(channel, '-relative repo', ...args)).resolves.toEqual({ success: true });
    expect(boundary.streaming.mock.calls[0][1]).toBe('-relative repo');
  });

  it.each(['git:push', 'git:fetch', 'git:rebase'])('%s validates its options container', async channel => {
    for (const options of [null, [], 'origin', false, 0, () => undefined]) {
      await expect(invoke(channel, '/fixture', options)).rejects.toThrow(/options/);
      expectNoOperations();
    }
  });

  it('validates supplied booleans rather than accepting truthy values', async () => {
    for (const field of ['force', 'setUpstream']) {
      for (const value of [null, 0, 1, '', 'true', [], {}]) {
        await expect(invoke('git:push', '/fixture', { [field]: value })).rejects.toThrow(/boolean/);
        expectNoOperations();
      }
    }
  });

  it('requires explicit operands and a rebase target when action is absent', async () => {
    for (const channel of ['git:set-upstream', 'git:checkout', 'git:cherry-pick', 'git:create-branch']) {
      await expect(invoke(channel, '/fixture')).rejects.toThrow();
      expectNoOperations();
    }
    for (const options of [undefined, {}, { action: undefined }, { target: undefined }]) {
      await expect(invoke('git:rebase', '/fixture', options)).rejects.toThrow(/target/);
      expectNoOperations();
    }
  });

  it('rejects every non-enum action and does not reflect rejected values in errors', async () => {
    for (const action of [null, false, 0, '', 'exec', '--continue', 'toString', [], {}, 'https://user:secret@example.test']) {
      await expect(invoke('git:rebase', '/fixture', { action, target: 'main' })).rejects.toThrow('action must be continue, abort or skip');
      expectNoOperations();
    }
    await expect(invoke('git:fetch', '/fixture', { remote: '-https://user:secret@example.test' }))
      .rejects.toThrow('remote must not start with a dash');
    expectNoOperations();
  });
});

function expectArgv(args: string[]): void {
  expect(boundary.streaming).toHaveBeenLastCalledWith(boundary.journal, '/fixture', args);
}

describe('exact argv and preserved behavior', () => {
  it('defaults only absent or undefined fields and preserves push precedence and ignored branch', async () => {
    for (const options of [undefined, {}, { remote: undefined, branch: undefined, force: undefined, setUpstream: undefined }]) {
      await invoke('git:push', '/fixture', options);
      expectArgv(['push', '--', 'origin', 'topic/日本語']);
      await invoke('git:fetch', '/fixture', options);
      expectArgv(['fetch', '--', 'origin']);
    }
    for (const [options, flags] of [
      [{ branch: 'ignored', force: false, setUpstream: false }, []],
      [{ force: true }, ['--force-with-lease']],
      [{ force: true, setUpstream: true }, ['--set-upstream']],
    ] as const) {
      await invoke('git:push', '/fixture', options);
      expectArgv(['push', ...flags, '--', 'origin', 'topic/日本語']);
    }
    for (const branch of [undefined, 'refs/heads/explicit']) {
      await invoke('git:set-upstream', '/fixture', 'origin', branch);
      expectArgv(['push', '--set-upstream', '--', 'origin', branch ?? 'topic/日本語']);
    }
    for (const fromHash of [undefined, 'HEAD^']) {
      await invoke('git:create-branch', '/fixture', 'topic/日本語', fromHash);
      expectArgv(['checkout', '-b', 'topic/日本語', fromHash ?? 'HEAD']);
    }
  });

  it('preserves remote forms as single unchanged operands', async () => {
    for (const remote of ['origin', 'git@example.test:owner/repo', 'ssh://git@example.test/repo',
      'https://example.test/repo', 'file:///tmp/local repo', '/tmp/local repo', '../local repo', ' Unicode remote ']) {
      await invoke('git:push', '/fixture', { remote });
      expectArgv(['push', '--', remote, 'topic/日本語']);
      await invoke('git:fetch', '/fixture', { remote });
      expectArgv(['fetch', '--', remote]);
      await invoke('git:set-upstream', '/fixture', remote, 'explicit');
      expectArgv(['push', '--set-upstream', '--', remote, 'explicit']);
    }
  });

  it('keeps revision expressions and checkout ordering', async () => {
    for (const revision of ['HEAD~1', 'HEAD^', '@{-1}', 'refs/heads/topic', 'origin/topic', 'abc123', 'topic/日本語', ' value ']) {
      await invoke('git:checkout', '/fixture', revision);
      expectArgv(['checkout', revision]);
      await invoke('git:cherry-pick', '/fixture', revision);
      expectArgv(['cherry-pick', revision]);
      await invoke('git:create-branch', '/fixture', 'new/topic', revision);
      expectArgv(['checkout', '-b', 'new/topic', revision]);
      await invoke('git:rebase', '/fixture', { target: revision, action: undefined });
      expectArgv(['rebase', revision]);
    }
  });

  it('uses fixed action options and preserves action precedence over a valid target', async () => {
    for (const action of ['continue', 'abort', 'skip']) {
      for (const target of [undefined, 'HEAD~1']) {
        await invoke('git:rebase', '/fixture', { action, target });
        expectArgv(['rebase', `--${action}`]);
      }
    }
  });

  it.each(['git:push', 'git:set-upstream'])('%s rejects invalid derived branches after status but before streaming', async channel => {
    for (const branch of ['--dry-run', 'a\0b']) {
      boundary.status.mockResolvedValue({ current: branch });
      await expect(invoke(channel, '/fixture', ...(channel === 'git:push' ? [] : ['origin'])))
        .resolves.toMatchObject({ success: false, error: expect.stringMatching(/branch/) });
      expect(boundary.status).toHaveBeenCalled();
      expect(boundary.streaming).not.toHaveBeenCalled();
      expect(boundary.journal.start).not.toHaveBeenCalled();
      expect(boundary.spawn).not.toHaveBeenCalled();
    }
  });

  it('preserves detached HEAD errors and explicit upstream branch behavior', async () => {
    for (const branch of ['', 'HEAD', '(no branch)', '(HEAD detached at abc123)']) {
      boundary.status.mockResolvedValue({ current: branch });
      await expect(invoke('git:push', '/fixture')).resolves.toMatchObject({ success: false, error: expect.stringContaining('detached HEAD') });
      await expect(invoke('git:set-upstream', '/fixture', 'origin')).resolves.toMatchObject({ success: false, error: expect.stringContaining('detached HEAD') });
      expect(boundary.streaming).not.toHaveBeenCalled();
    }
    await invoke('git:set-upstream', '/fixture', 'origin', 'topic');
    expectArgv(['push', '--set-upstream', '--', 'origin', 'topic']);
  });

  it('preserves non-repository results without starting an operation', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    for (const [channel, args] of validCalls) {
      await expect(invoke(channel, '/fixture', ...args)).resolves.toEqual({ success: false, error: 'Not a git repository' });
      expectNoOperations();
    }
  });

  it('preserves conflict status after unsuccessful rebase and cherry-pick', async () => {
    boundary.streaming.mockResolvedValue({ success: false, error: 'CONFLICT' });
    boundary.status.mockResolvedValue({ current: 'topic', conflicted: ['file.txt'] });
    for (const [channel, args] of [['git:rebase', [{ action: 'continue' }]], ['git:cherry-pick', ['HEAD^']]] as const) {
      await expect(invoke(channel, '/fixture', ...args)).resolves.toEqual({ success: false, error: 'CONFLICT', conflicts: ['file.txt'] });
    }
  });
});
