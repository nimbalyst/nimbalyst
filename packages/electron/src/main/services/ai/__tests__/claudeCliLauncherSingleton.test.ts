import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('claudeCliLauncherSingleton', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function loadHarness(opts?: { claudeInstalled?: boolean }) {
    const claudeInstalled = opts?.claudeInstalled ?? true;
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
    await Promise.resolve();

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
});
