import { describe, expect, it, vi } from 'vitest';
import {
  dispatchQueuedPromptToClaudeCli,
  dispatchQueuedPromptToClaudeCliWithTarget,
} from '../claudeCliQueueDispatch';
import type { ClaudeCliQueueDispatchDeps } from '../claudeCliQueueDispatch';
import type { QueuedClaudeCliWorktree } from '../claudeCliQueueDispatch';

// NIM-834: queued prompts for claude-code-cli sessions (meta-agent spawns,
// restart continuations, wakeups) were routed through the SDK dispatcher into
// the provider's Phase 1 sendMessage stub and instantly marked failed. The
// dispatch must instead ride the CLI rails: launch the genuine CLI when it
// isn't running and let the PID watcher's idle flush deliver the prompt.

function makeDeps(overrides: Partial<ClaudeCliQueueDispatchDeps> = {}): ClaudeCliQueueDispatchDeps {
  return {
    isTerminalActive: vi.fn(() => false),
    ensureSession: vi.fn(async () => ({ success: true })),
    getLiveTurnState: vi.fn(async () => null),
    getSnapshotStatus: vi.fn(() => null),
    flushNext: vi.fn(async () => undefined),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    ...overrides,
  };
}

describe('dispatchQueuedPromptToClaudeCli (NIM-834)', () => {
  it('launches the CLI for an inactive session instead of dispatching through the SDK provider', async () => {
    const deps = makeDeps();

    const handled = await dispatchQueuedPromptToClaudeCli(deps, {
      sessionId: 's-1',
      workspacePath: '/ws',
      model: 'claude-code-cli:fable-1m',
      cwd: '/ws/.claude/worktrees/wt-1',
    });

    expect(handled).toBe(true);
    expect(deps.ensureSession).toHaveBeenCalledWith({
      sessionId: 's-1',
      workspacePath: '/ws',
      model: 'claude-code-cli:fable-1m',
      cwd: '/ws/.claude/worktrees/wt-1',
    });
    // Launch path: queue drains on the PID watcher's idle transition; no direct
    // flush needed unless the CLI already reports idle.
    expect(deps.flushNext).not.toHaveBeenCalled();
  });

  it.each([
    ['deleted', async (): Promise<QueuedClaudeCliWorktree | null> => null],
    ['archived', async (): Promise<QueuedClaudeCliWorktree | null> => ({ id: 'worktree-a', path: '/repo_worktrees/a', isArchived: true })],
    ['replaced', async (): Promise<QueuedClaudeCliWorktree | null> => ({ id: 'worktree-a', path: '/repo_worktrees/replacement', isArchived: false })],
    ['lookup error', async (): Promise<QueuedClaudeCliWorktree | null> => { throw new Error('worktree lookup exploded'); }],
  ] as const)(
    'fails closed before CLI launch when the preflight worktree is %s at the second lookup',
    async (_label, getWorktree) => {
      const deps = makeDeps();

      const handled = await dispatchQueuedPromptToClaudeCliWithTarget(
        deps,
        {
          sessionId: 's-worktree',
          workspacePath: '/repo',
          model: 'claude-code-cli:fable-1m',
        },
        {
          expectedWorktreeId: 'worktree-a',
          expectedWorktreePath: '/repo_worktrees/a',
        },
        getWorktree,
      );

      expect(handled).toBe(false);
      expect(deps.ensureSession).not.toHaveBeenCalled();
      expect(deps.flushNext).not.toHaveBeenCalled();
      expect(deps.logWarn).toHaveBeenCalledTimes(1);
    },
  );

  it('launches a worktree-owned CLI only with the exact active preflight path', async () => {
    const deps = makeDeps();

    const handled = await dispatchQueuedPromptToClaudeCliWithTarget(
      deps,
      { sessionId: 's-worktree', workspacePath: '/repo' },
      {
        expectedWorktreeId: 'worktree-a',
        expectedWorktreePath: '/repo_worktrees/a',
      },
      async () => ({
        id: 'worktree-a',
        path: '/repo_worktrees/a',
        isArchived: false,
      }),
    );

    expect(handled).toBe(true);
    expect(deps.ensureSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo_worktrees/a',
    }));
  });

  it('preserves canonical-checkout launch for a session with no worktree identity', async () => {
    const deps = makeDeps();
    const getWorktree = vi.fn(async () => null);

    const handled = await dispatchQueuedPromptToClaudeCliWithTarget(
      deps,
      { sessionId: 's-canonical', workspacePath: '/repo' },
      { expectedWorktreeId: null, expectedWorktreePath: null },
      getWorktree,
    );

    expect(handled).toBe(true);
    expect(getWorktree).not.toHaveBeenCalled();
    expect(deps.ensureSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-canonical',
      workspacePath: '/repo',
      cwd: undefined,
    }));
  });

  it('kicks a direct flush when the launched CLI already reports idle', async () => {
    const deps = makeDeps({ getLiveTurnState: vi.fn(async () => 'idle') });

    await dispatchQueuedPromptToClaudeCli(deps, { sessionId: 's-1', workspacePath: '/ws' });

    expect(deps.flushNext).toHaveBeenCalledWith('s-1', '/ws');
  });

  it('returns false and does not flush when the CLI launch fails', async () => {
    const deps = makeDeps({ ensureSession: vi.fn(async () => ({ success: false, error: 'boom' })) });

    const handled = await dispatchQueuedPromptToClaudeCli(deps, { sessionId: 's-1', workspacePath: '/ws' });

    expect(handled).toBe(false);
    expect(deps.flushNext).not.toHaveBeenCalled();
    expect(deps.logWarn).toHaveBeenCalled();
  });

  it('flushes immediately when the terminal is live and the snapshot says idle', async () => {
    const deps = makeDeps({
      isTerminalActive: vi.fn(() => true),
      getSnapshotStatus: vi.fn(() => 'idle'),
    });

    const handled = await dispatchQueuedPromptToClaudeCli(deps, { sessionId: 's-1', workspacePath: '/ws' });

    expect(handled).toBe(true);
    expect(deps.ensureSession).not.toHaveBeenCalled();
    expect(deps.flushNext).toHaveBeenCalledWith('s-1', '/ws');
  });

  it('falls back to the live PID state when the snapshot is stale (NIM-821 gap)', async () => {
    const deps = makeDeps({
      isTerminalActive: vi.fn(() => true),
      getSnapshotStatus: vi.fn(() => 'running'),
      getLiveTurnState: vi.fn(async () => 'idle'),
    });

    const handled = await dispatchQueuedPromptToClaudeCli(deps, { sessionId: 's-1', workspacePath: '/ws' });

    expect(handled).toBe(true);
    expect(deps.flushNext).toHaveBeenCalledWith('s-1', '/ws');
  });

  it('leaves a mid-turn CLI alone — the next idle transition drains the queue', async () => {
    const deps = makeDeps({
      isTerminalActive: vi.fn(() => true),
      getSnapshotStatus: vi.fn(() => 'running'),
      getLiveTurnState: vi.fn(async () => 'running'),
    });

    const handled = await dispatchQueuedPromptToClaudeCli(deps, { sessionId: 's-1', workspacePath: '/ws' });

    expect(handled).toBe(false);
    expect(deps.flushNext).not.toHaveBeenCalled();
  });
});
