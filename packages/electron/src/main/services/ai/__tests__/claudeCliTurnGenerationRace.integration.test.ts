import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('long-lived Claude CLI turn generation integration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('lets prompt B rotate while A-idle is in flight and rejects every late A side effect', async () => {
    const stateModule = await vi.importActual<
      typeof import('@nimbalyst/runtime/ai/server/SessionStateManager')
    >('@nimbalyst/runtime/ai/server/SessionStateManager');
    const stateManager = new stateModule.SessionStateManager();
    const metadataFixture = { value: {} as Record<string, unknown> };
    const getSession = vi.fn(async () => ({
      id: 'session-1',
      workspacePath: '/work',
      metadata: metadataFixture.value,
    }));
    const updateMetadata = vi.fn(async (_id, update) => {
      metadataFixture.value = { ...metadataFixture.value, ...(update.metadata ?? {}) };
    });
    const pushMetadataChangeWithResult = vi.fn().mockResolvedValue({
      outcome: 'index_frame_written',
      attempted: true,
      indexFrameWritten: true,
      skippedReason: null,
    });

    vi.doMock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
      ...stateModule,
      getSessionStateManager: () => stateManager,
    }));
    vi.doMock('@nimbalyst/runtime', async () => ({
      ...await vi.importActual<typeof import('@nimbalyst/runtime')>('@nimbalyst/runtime'),
      AISessionsRepository: { get: getSession, updateMetadata },
    }));
    vi.doMock('../../SyncManager', () => ({
      getSyncProvider: () => ({ pushMetadataChangeWithResult }),
    }));
    vi.doMock('../../../mcp/httpServer', () => ({
      revokeHostBoundMcpAuthority: vi.fn(async () => undefined),
    }));

    const terminalManager = { isTerminalActive: vi.fn(() => false) };
    const launch = vi.fn(async (_input?: any): Promise<void> => undefined);
    const fileWatcher = {
      ensureForSession: vi.fn(async () => undefined),
      scheduleStop: vi.fn(),
      stopForSession: vi.fn(async () => undefined),
    };
    const fireCompletion = vi.fn();
    const flushQueue = vi.fn(async () => false);
    vi.doMock('../../TerminalSessionManager', () => ({
      getTerminalSessionManager: () => terminalManager,
    }));
    vi.doMock('@nimbalyst/runtime/ai/server', () => ({
      McpConfigService: class {
        getMcpServersConfig = vi.fn(async () => ({}));
      },
      getMcpConfigService: () => ({ getMcpServersConfig: vi.fn(async () => ({})) }),
      configureMcpServers: vi.fn(),
    }));
    vi.doMock('../../CLIManager', () => ({
      getEnhancedPath: () => '/bin',
      getShellEnvironment: () => ({}),
    }));
    vi.doMock('../claudeExecutableResolver', () => ({
      resolveClaudeExecutablePath: () => '/usr/local/bin/claude',
      isClaudeExecutableInstalled: () => true,
    }));
    vi.doMock('../claudeCliPermissionHookPath', () => ({
      resolveClaudePermissionHookScriptPath: () => undefined,
    }));
    vi.doMock('../claudeCliObservationSingleton', () => ({
      startClaudeCliProxyObservation: vi.fn(),
      fireClaudeCliTurnCompletion: fireCompletion,
    }));
    vi.doMock('../claudeCliQueueFlushSingleton', () => ({
      flushNextClaudeCliQueuedPromptForSession: flushQueue,
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

    let releaseIdleWrite!: () => void;
    let signalIdleWriteStarted!: () => void;
    const idleWriteStarted = new Promise<void>((resolve) => {
      signalIdleWriteStarted = resolve;
    });
    const idleWriteGate = new Promise<void>((resolve) => {
      releaseIdleWrite = resolve;
    });
    stateManager.setDatabase({
      query: vi.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('UPDATE ai_sessions') && params?.[0] === 'idle') {
          signalIdleWriteStarted();
          return idleWriteGate.then(() => ({ rows: [] }));
        }
        return Promise.resolve({ rows: [] });
      }),
    });
    await Promise.resolve();

    const [launcherModule, promptModule, attentionModule, terminalModule] = await Promise.all([
      import('../claudeCliLauncherSingleton'),
      import('../pendingPromptPersistence'),
      import('../../AttentionEventService'),
      import('../pendingPromptTerminalClear'),
    ]);
    let onTurnState:
      | ((state: 'running' | 'waiting_for_input' | 'idle') => Promise<void> | void)
      | undefined;
    launch.mockImplementationOnce(async (input: {
      onTurnState?: (state: 'running' | 'waiting_for_input' | 'idle') => Promise<void> | void;
    }) => {
      onTurnState = input.onTurnState;
    });
    await launcherModule.ensureClaudeCliSession({
      sessionId: 'session-1',
      workspacePath: '/work',
    });
    const turnA = stateManager.getSessionState('session-1')?.attentionGeneration;
    expect(turnA).toBeTruthy();
    await promptModule.setSessionPendingPrompt('session-1', true, {
      promptId: 'prompt-a',
      generation: turnA,
    });

    const attention = new attentionModule.AttentionEventService({
      getSession,
      updateSessionMetadata: async (_id, metadata) => {
        metadataFixture.value = { ...metadataFixture.value, ...metadata };
      },
      pushAttentionSummary: vi.fn().mockResolvedValue(undefined),
      notifyUserJson: vi.fn().mockResolvedValue(JSON.stringify({
        result: { attempted: true, shown: true, skippedReason: null },
        mobilePush: {
          attempted: true,
          requestFrameWritten: true,
          outcome: 'request_frame_written',
          skippedReason: null,
          bypassActiveDeviceRouting: true,
          forceDesktopAwayForPush: true,
        },
      })),
    });
    const backstopClears = vi.fn();
    const terminalTasks: Promise<unknown>[] = [];
    const unsubscribe = stateManager.subscribe((event) => {
      terminalTasks.push(Promise.all([
        terminalModule.clearStalePendingPromptOnTerminal(event, {
          readHasPendingPrompt: async () => ({
            hasPendingPrompt: metadataFixture.value.hasPendingPrompt === true,
            promptId: metadataFixture.value.pendingPromptId as string | undefined,
            generation: metadataFixture.value.pendingPromptGeneration as string | undefined,
          }),
          clearPendingPrompt: async (id, { expectedGeneration }) => {
            const result = await promptModule.setSessionPendingPrompt(id, false, {
              expectedGeneration,
            });
            if (result.local.succeeded) backstopClears();
          },
        }),
        attention.handleSessionStateEvent(event),
      ]));
    });

    // The PID callback has already made A idle in memory but is held in its DB
    // write. The production prompt opener observes that real boundary, rotates
    // B, and persists B's exact generation before A resumes.
    const lateAIdle = Promise.resolve(onTurnState?.('idle'));
    await idleWriteStarted;
    expect(stateManager.getSessionState('session-1')).toMatchObject({
      status: 'idle',
      attentionGeneration: turnA,
    });
    const openedB = await promptModule.setSessionPendingPrompt('session-1', true, {
      promptId: 'prompt-b',
    });
    const turnB = openedB.generation;
    expect(turnB).toBeTruthy();
    expect(turnB).not.toBe(turnA);
    await attention.arm('/work', {
      sessionId: 'session-1',
      promptId: 'prompt-b',
      attentionGeneration: turnB ?? undefined,
      severity: 'normal',
      dedupeKey: 'waiting:prompt-b',
    });
    releaseIdleWrite();
    await lateAIdle;

    // Release an already-queued A terminal notification as well. Both the PID
    // callback and real terminal subscribers must preserve B.
    stateManager.emit('session:completed', {
      sessionId: 'session-1',
      workspacePath: '/work',
      timestamp: new Date(),
      attentionGeneration: turnA,
    });
    await Promise.all(terminalTasks);

    expect(stateManager.getSessionState('session-1')).toMatchObject({
      status: 'waiting_for_input',
      attentionGeneration: turnB,
    });
    expect(metadataFixture.value).toMatchObject({
      hasPendingPrompt: true,
      pendingPromptId: 'prompt-b',
      pendingPromptGeneration: turnB,
    });
    expect(backstopClears).not.toHaveBeenCalled();
    expect(fileWatcher.scheduleStop).not.toHaveBeenCalled();
    expect(fireCompletion).not.toHaveBeenCalled();
    expect(flushQueue).not.toHaveBeenCalled();
    const status = await attention.status('/work', {
      sessionId: 'session-1',
      includeCancelled: true,
    });
    expect(status.events).toContainEqual(expect.objectContaining({
      promptId: 'prompt-b',
      attentionGeneration: turnB,
      status: 'pending',
    }));
    unsubscribe();
  }, 20000);
});
