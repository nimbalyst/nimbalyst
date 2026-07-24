import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('claudeCliLauncherSingleton', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function loadHarness(opts?: {
    claudeInstalled?: boolean;
    /** When set, the mocked session resolves to this worktree (id + on-disk path). */
    worktree?: { id: string; path: string } | null;
  }) {
    const claudeInstalled = opts?.claudeInstalled ?? true;
    const worktree = opts?.worktree ?? null;
    const manager = {
      isTerminalActive: vi.fn(() => false),
    };
    const stateManager = {
      startSession: vi.fn(async () => undefined),
      endSession: vi.fn(async () => undefined),
      updateActivity: vi.fn(async () => undefined),
    };
    const launch = vi.fn(async (_input?: any): Promise<void> => undefined);

    vi.doMock('../../TerminalSessionManager', () => ({
      getTerminalSessionManager: () => manager,
    }));
    vi.doMock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
      getSessionStateManager: () => stateManager,
    }));
    vi.doMock('@nimbalyst/runtime/ai/server', () => ({
      McpConfigService: class {
        getMcpServersConfig = vi.fn(async () => ({}));
      },
      getMcpConfigService: () => ({
        getMcpServersConfig: vi.fn(async () => ({})),
      }),
      configureMcpServers: vi.fn(),
    }));
    vi.doMock('../../CLIManager', () => ({
      getEnhancedPath: () => '/bin',
      getShellEnvironment: () => ({}),
    }));
    vi.doMock('../claudeExecutableResolver', () => ({
      resolveClaudeExecutablePath: () => '/usr/local/bin/claude',
      isClaudeExecutableInstalled: () => claudeInstalled,
    }));
    vi.doMock('../claudeCliPermissionHookPath', () => ({
      resolveClaudePermissionHookScriptPath: () => undefined,
    }));
    vi.doMock('../claudeCliObservationSingleton', () => ({
      startClaudeCliProxyObservation: vi.fn(),
      fireClaudeCliTurnCompletion: vi.fn(),
    }));
    vi.doMock('../claudeCliQueueFlushSingleton', () => ({
      flushNextClaudeCliQueuedPromptForSession: vi.fn(async () => false),
    }));
    vi.doMock('../ClaudeCliSessionLauncher', () => ({
      ClaudeCliSessionLauncher: class {
        constructor() {
          (this as any).launch = launch;
        }
      },
    }));

    // Worktree resolution deps (#933 / NIM-2001). The session resolves to a
    // worktreeId iff `worktree` is set; the store maps it to the on-disk path.
    vi.doMock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
      AISessionsRepository: {
        get: vi.fn(async () => ({ worktreeId: worktree?.id ?? null })),
      },
    }));
    vi.doMock('../../WorktreeStore', () => ({
      createWorktreeStore: () => ({
        get: vi.fn(async (id: string) => (worktree && worktree.id === id ? { path: worktree.path } : null)),
      }),
    }));
    vi.doMock('../../database/initialize', () => ({
      getDatabase: () => ({}),
    }));

    const mod = await import('../claudeCliLauncherSingleton');
    return { ...mod, manager, stateManager, launch };
  }

  // loadHarness() dynamically imports the real launcher module after
  // vi.resetModules(), which cold-loads electron/analytics/store + the runtime
  // MCP config chain (~4s). That's fine solo but crosses the 5s default under
  // full-suite parallel CPU contention, so give these a generous timeout.
  it('coalesces concurrent ensure calls for the same session', async () => {
    const h = await loadHarness();
    let releaseLaunch: (() => void) | undefined;
    h.launch.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseLaunch = resolve;
      }),
    );

    const input = { sessionId: 'session-1', workspacePath: '/work' };
    const first = h.ensureClaudeCliSession(input);
    const second = h.ensureClaudeCliSession(input);
    // Launch now runs after the async worktree-cwd resolution (dynamic imports),
    // so flush until it's invoked rather than a single microtask.
    for (let i = 0; i < 20 && h.launch.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Coalescing: two concurrent ensure calls → exactly one startSession + launch.
    expect(h.stateManager.startSession).toHaveBeenCalledTimes(1);
    expect(h.launch).toHaveBeenCalledTimes(1);

    releaseLaunch?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { success: true },
      { success: true },
    ]);
  }, 20000);

  it('ends session state when the launched CLI terminal exits', async () => {
    const h = await loadHarness();
    let onExit: ((exitCode: number) => void) | undefined;
    h.launch.mockImplementationOnce(async (input: { onExit?: (exitCode: number) => void }) => {
      onExit = input.onExit;
    });

    await h.ensureClaudeCliSession({ sessionId: 'session-1', workspacePath: '/work' });
    onExit?.(7);

    expect(h.stateManager.endSession).toHaveBeenCalledWith('session-1');
  }, 20000);

  it('short-circuits without launching when claude is not installed (NIM-852)', async () => {
    const h = await loadHarness({ claudeInstalled: false });

    const result = await h.ensureClaudeCliSession({ sessionId: 'session-1', workspacePath: '/work' });

    expect(result).toEqual({
      success: false,
      claudeNotInstalled: true,
      error: 'Claude Code CLI is not installed',
    });
    expect(h.stateManager.startSession).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
  }, 20000);

  it('spawns a worktree session in its worktree, not the parent workspace (#933)', async () => {
    // A real dir so the existence guard in resolveClaudeCliWorktreeCwd passes.
    const worktreePath = mkdtempSync(join(tmpdir(), 'nim-wt-'));
    const h = await loadHarness({ worktree: { id: 'wt-1', path: worktreePath } });

    // The renderer only knows the parent path and passes it as `cwd`.
    await h.ensureClaudeCliSession({ sessionId: 'session-1', workspacePath: '/project', cwd: '/project' });

    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.launch.mock.calls[0][0]).toMatchObject({
      sessionId: 'session-1',
      workspacePath: '/project',
      cwd: worktreePath,
    });
  }, 20000);

  it('leaves the requested cwd unchanged for a non-worktree session', async () => {
    const h = await loadHarness({ worktree: null });

    await h.ensureClaudeCliSession({ sessionId: 'session-1', workspacePath: '/project', cwd: '/project' });

    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.launch.mock.calls[0][0]).toMatchObject({ cwd: '/project' });
  }, 20000);
});
