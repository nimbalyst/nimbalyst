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
    let currentState: {
      sessionId: string;
      workspacePath: string;
      status: 'running' | 'waiting_for_input' | 'idle';
      lastActivity: Date;
      isStreaming: boolean;
      attentionGeneration: string;
    } | null = null;
    let rotatedGeneration = 0;
    const stateManager = {
      startSession: vi.fn(async () => {
        currentState = {
          sessionId: 'session-1',
          workspacePath: '/work',
          status: 'running',
          lastActivity: new Date(),
          isStreaming: true,
          attentionGeneration: 'turn-a',
        };
        return 'turn-a';
      }),
      endSession: vi.fn(async (_sessionId: string, options?: { attentionGeneration?: string }) => {
        if (
          options?.attentionGeneration &&
          currentState?.attentionGeneration !== options.attentionGeneration
        ) {
          return;
        }
        currentState = null;
      }),
      updateActivity: vi.fn(async (options: {
        status: 'running' | 'waiting_for_input' | 'idle';
        isStreaming: boolean;
        attentionGeneration?: string;
      }) => {
        if (
          options.attentionGeneration &&
          currentState?.attentionGeneration !== options.attentionGeneration
        ) {
          return;
        }
        if (currentState) {
          const previousStatus = currentState.status;
          if (
            !options.attentionGeneration &&
            (options.status === 'running' || options.status === 'waiting_for_input') &&
            previousStatus === 'idle'
          ) {
            rotatedGeneration += 1;
            currentState.attentionGeneration = `turn-${String.fromCharCode(97 + rotatedGeneration)}`;
          }
          currentState.status = options.status;
          currentState.isStreaming = options.isStreaming;
        }
      }),
      getSessionState: vi.fn(() => currentState),
    };
    const launch = vi.fn(async (_input?: any): Promise<void> => undefined);
    const fileWatcher = {
      ensureForSession: vi.fn(async () => undefined),
      scheduleStop: vi.fn(),
      stopForSession: vi.fn(async () => undefined),
    };

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
    vi.doMock('../claudeCliSessionAutoNameSingleton', () => ({
      maybeAutoNameClaudeCliSessionProduction: vi.fn(async () => undefined),
    }));
    vi.doMock('../HooklessAgentFileWatcher', () => ({
      HooklessAgentFileWatcher: class {
        ensureForSession = fileWatcher.ensureForSession;
        scheduleStop = fileWatcher.scheduleStop;
        stopForSession = fileWatcher.stopForSession;
      },
    }));
    vi.doMock('../ClaudeCliSessionLauncher', () => ({
      ClaudeCliSessionLauncher: class {
        constructor() {
          (this as any).launch = launch;
        }
      },
    }));

    const mod = await import('../claudeCliLauncherSingleton');
    return {
      ...mod,
      manager,
      stateManager,
      launch,
      fileWatcher,
      replaceCurrentTurn: (attentionGeneration: string) => {
        currentState = {
          sessionId: 'session-1',
          workspacePath: '/work',
          status: 'running',
          lastActivity: new Date(),
          isStreaming: true,
          attentionGeneration,
        };
      },
      getCurrentState: () => currentState,
    };
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

    await vi.waitFor(() => {
      expect(h.stateManager.endSession).toHaveBeenCalledWith('session-1', {
        attentionGeneration: 'turn-a',
      });
    });
  }, 20000);

  it('rotates generation at each real long-lived CLI turn boundary', async () => {
    const h = await loadHarness();
    let onTurnState: ((state: 'running' | 'waiting_for_input' | 'idle') => void) | undefined;
    h.launch.mockImplementationOnce(async (input: {
      onTurnState?: (state: 'running' | 'waiting_for_input' | 'idle') => void;
    }) => {
      onTurnState = input.onTurnState;
    });

    await h.ensureClaudeCliSession({ sessionId: 'session-1', workspacePath: '/work' });
    onTurnState?.('running');
    onTurnState?.('waiting_for_input');
    onTurnState?.('idle');

    await vi.waitFor(() => {
      expect(h.stateManager.updateActivity).toHaveBeenCalledTimes(3);
    });
    expect(h.stateManager.updateActivity).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      status: 'running',
      isStreaming: true,
      attentionGeneration: 'turn-a',
    });
    expect(h.stateManager.updateActivity).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      status: 'waiting_for_input',
      isStreaming: false,
      attentionGeneration: 'turn-a',
    });
    expect(h.stateManager.updateActivity).toHaveBeenNthCalledWith(3, {
      sessionId: 'session-1',
      status: 'idle',
      isStreaming: false,
      attentionGeneration: 'turn-a',
    });
    onTurnState?.('running');
    await vi.waitFor(() => {
      expect(h.stateManager.updateActivity).toHaveBeenCalledTimes(4);
    });
    expect(h.stateManager.updateActivity).toHaveBeenNthCalledWith(4, {
      sessionId: 'session-1',
      status: 'running',
      isStreaming: true,
    });
    expect(h.getCurrentState()).toMatchObject({
      status: 'running',
      attentionGeneration: 'turn-b',
    });
  }, 20000);

  it('serializes overlapping PID callbacks before applying the next state', async () => {
    const h = await loadHarness();
    let onTurnState: ((state: 'running' | 'waiting_for_input' | 'idle') => Promise<void> | void) | undefined;
    h.launch.mockImplementationOnce(async (input: {
      onTurnState?: (state: 'running' | 'waiting_for_input' | 'idle') => Promise<void> | void;
    }) => {
      onTurnState = input.onTurnState;
    });
    await h.ensureClaudeCliSession({ sessionId: 'session-1', workspacePath: '/work' });

    let releaseFirst!: () => void;
    h.stateManager.updateActivity.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseFirst = resolve; }),
    );
    const first = onTurnState?.('running');
    const second = onTurnState?.('waiting_for_input');

    await vi.waitFor(() => expect(h.stateManager.updateActivity).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([first, second]);
    expect(h.stateManager.updateActivity).toHaveBeenCalledTimes(2);
    expect(h.stateManager.updateActivity).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      status: 'waiting_for_input',
      isStreaming: false,
      attentionGeneration: 'turn-a',
    });
  }, 20000);

  it('uses the captured generation when launch fails after starting state', async () => {
    const h = await loadHarness();
    h.launch.mockRejectedValueOnce(new Error('launch failed'));

    await expect(h.ensureClaudeCliSession({
      sessionId: 'session-1',
      workspacePath: '/work',
    })).resolves.toMatchObject({ success: false });

    expect(h.stateManager.endSession).toHaveBeenCalledWith('session-1', {
      attentionGeneration: 'turn-a',
    });
  }, 20000);

  it('keeps replacement turn B active across stale PID-idle and exit callbacks from A', async () => {
    const h = await loadHarness();
    let onExit: ((exitCode: number) => void) | undefined;
    let onTurnState: ((state: 'running' | 'waiting_for_input' | 'idle') => void) | undefined;
    h.launch.mockImplementationOnce(async (input: {
      onExit?: (exitCode: number) => void;
      onTurnState?: (state: 'running' | 'waiting_for_input' | 'idle') => void;
    }) => {
      onExit = input.onExit;
      onTurnState = input.onTurnState;
    });

    await h.ensureClaudeCliSession({ sessionId: 'session-1', workspacePath: '/work' });
    h.replaceCurrentTurn('turn-b');
    onTurnState?.('idle');
    onExit?.(0);

    await vi.waitFor(() => {
      expect(h.stateManager.updateActivity).toHaveBeenCalledWith({
        sessionId: 'session-1',
        status: 'idle',
        isStreaming: false,
        attentionGeneration: 'turn-a',
      });
      expect(h.stateManager.endSession).toHaveBeenCalledWith('session-1', {
        attentionGeneration: 'turn-a',
      });
    });
    expect(h.getCurrentState()).toMatchObject({
      status: 'running',
      attentionGeneration: 'turn-b',
    });
    expect(h.fileWatcher.scheduleStop).not.toHaveBeenCalled();
    expect(h.fileWatcher.stopForSession).not.toHaveBeenCalled();
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
