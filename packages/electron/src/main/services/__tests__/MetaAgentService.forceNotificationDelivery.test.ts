import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncMocks = vi.hoisted(() => ({
  requestMobilePush: vi.fn(),
  isDesktopTrulyAway: vi.fn(() => false),
}));

const notificationMocks = vi.hoisted(() => ({
  showNotificationWithResult: vi.fn(),
}));

const metaToolMocks = vi.hoisted(() => ({
  toolFns: null as Record<string, (...args: any[]) => any> | null,
}));

vi.mock('@nimbalyst/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nimbalyst/runtime')>();
  return {
    ...actual,
    AISessionsRepository: {
      create: vi.fn(),
      get: vi.fn(),
      updateMetadata: vi.fn(),
    },
    AgentMessagesRepository: {
      create: vi.fn(),
      list: vi.fn(),
    },
    SessionFilesRepository: {
      getFilesBySession: vi.fn().mockResolvedValue([]),
    },
  };
});

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class { async initialize() {} },
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => ({ provider: id.split(':')[0], model: id.split(':')[1], combined: id }),
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));

vi.mock('../ai/providerResolution', () => ({
  resolveExtensionAgentRef: () => null,
  isExtensionAgentProvider: () => false,
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../SyncManager', () => ({
  getSyncProvider: () => ({
    pushChange: vi.fn(),
    requestMobilePush: syncMocks.requestMobilePush,
  }),
  isDesktopTrulyAway: syncMocks.isDesktopTrulyAway,
}));
vi.mock('../NotificationService', () => ({
  notificationService: {
    showNotificationWithResult: notificationMocks.showNotificationWithResult,
  },
}));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (value: unknown) => value }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn() },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('../ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({
  setMetaAgentToolFns: vi.fn((toolFns: Record<string, (...args: any[]) => any>) => {
    metaToolMocks.toolFns = toolFns;
  }),
}));

import { AISessionsRepository } from '@nimbalyst/runtime';
import { MetaAgentService } from '../MetaAgentService';
import { attentionEventService } from '../AttentionEventService';

const WORKSPACE = '/workspace';

describe('MetaAgentService notify_user force delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncMocks.isDesktopTrulyAway.mockReturnValue(false);
    syncMocks.requestMobilePush.mockResolvedValue({
      outcome: 'request_frame_written',
      attempted: true,
      requestFrameWritten: true,
      skippedReason: null,
      forcedAwayFrameWritten: true,
      restorationScheduled: true,
    });
    notificationMocks.showNotificationWithResult.mockResolvedValue({
      success: true,
      attempted: true,
      shown: true,
      skippedReason: null,
      title: 'Agent needs attention',
      bodyPreview: 'Please check Nimbalyst.',
      sessionId: 'parent-1',
      workspacePath: WORKSPACE,
    });
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      id: 'parent-1',
      title: 'Parent orchestrator',
      provider: 'claude-code',
      model: 'claude-code:sonnet',
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      workspacePath: WORKSPACE,
      agentRole: 'meta-agent',
      createdBySessionId: null,
      metadata: {},
    } as never);
    (MetaAgentService.getInstance() as any).directForcedNotificationAttempts.clear();
    metaToolMocks.toolFns = null;
  });

  it('can force a mobile push without active-device routing fallback', async () => {
    const service = MetaAgentService.getInstance() as any;
    const json = await service.notifyUserJson('parent-1', WORKSPACE, {
      title: 'Phone test',
      body: 'Please check Nimbalyst.',
      mobilePush: 'always',
      bypassFocusCheck: true,
    });

    expect(notificationMocks.showNotificationWithResult).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Phone test',
      body: 'Please check Nimbalyst.',
      sessionId: 'parent-1',
      workspacePath: WORKSPACE,
      provider: 'agent',
      bypassFocusCheck: true,
    }));
    expect(syncMocks.requestMobilePush).toHaveBeenCalledWith(
      'parent-1',
      'Phone test',
      'Please check Nimbalyst.',
      {
        bypassActiveDeviceRouting: true,
        forceDesktopAwayForPush: true,
      }
    );
    expect(JSON.parse(json)).toMatchObject({
      mobilePushAttempted: true,
      mobilePush: {
        mode: 'always',
        requested: true,
        attempted: true,
        requestFrameWritten: true,
        outcome: 'request_frame_written',
        skippedReason: null,
        bypassActiveDeviceRouting: true,
        forceDesktopAwayForPush: true,
      },
    });
  });

  it('does not call a skipped socket write an attempted push', async () => {
    syncMocks.requestMobilePush.mockResolvedValueOnce({
      outcome: 'skipped',
      attempted: false,
      requestFrameWritten: false,
      skippedReason: 'socket_not_open',
      forcedAwayFrameWritten: false,
      restorationScheduled: false,
    });
    const service = MetaAgentService.getInstance() as any;
    const receipt = JSON.parse(await service.notifyUserJson('parent-1', WORKSPACE, {
      title: 'Phone test',
      body: 'Please check Nimbalyst.',
      mobilePush: 'always',
    }));

    expect(receipt.mobilePush).toMatchObject({
      attempted: false,
      requestFrameWritten: false,
      outcome: 'skipped',
      skippedReason: 'socket_not_open',
    });
  });

  it('allows an explicit creator to target its child session', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (sessionId: string) => ({
      id: sessionId,
      title: sessionId,
      provider: 'claude-code',
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      workspacePath: WORKSPACE,
      createdBySessionId: sessionId === 'child-1' ? 'parent-1' : null,
      metadata: {},
    } as never));

    await expect((MetaAgentService.getInstance() as any).notifyUserJson('parent-1', WORKSPACE, {
      title: 'Child needs attention',
      body: 'Open the child session.',
      sessionId: 'child-1',
      mobilePush: 'never',
    })).resolves.toContain('"sessionId": "child-1"');
  });

  it('allows an explicitly authorized supervisor and deep-links to the prompt-owning target', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (sessionId: string) => ({
      id: sessionId,
      title: sessionId,
      provider: 'claude-code',
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      workspacePath: WORKSPACE,
      createdBySessionId: null,
      metadata: sessionId === 'blocked-1'
        ? { authorizedAttentionSupervisorSessionIds: ['watcher-1'] }
        : {},
    } as never));

    const json = await (MetaAgentService.getInstance() as any).notifyUserJson('watcher-1', WORKSPACE, {
      title: 'Blocked session needs input',
      body: 'Open the actual question.',
      sessionId: 'blocked-1',
      mobilePush: 'always',
    });

    expect(notificationMocks.showNotificationWithResult).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'blocked-1',
      workspacePath: WORKSPACE,
    }));
    expect(syncMocks.requestMobilePush).toHaveBeenCalledWith(
      'blocked-1',
      'Blocked session needs input',
      'Open the actual question.',
      expect.any(Object),
    );
    expect(JSON.parse(json).sessionId).toBe('blocked-1');
  });

  it('denies revoked, invalid, cross-workspace, and caller-side self-grant claims', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (sessionId: string) => ({
      id: sessionId,
      title: sessionId,
      provider: 'claude-code',
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      workspacePath: sessionId === 'cross-workspace-watcher' ? '/other' : WORKSPACE,
      createdBySessionId: null,
      // Only the target's list is authoritative. A caller cannot self-grant by
      // placing a target id or its own id in caller-owned metadata.
      metadata: sessionId === 'watcher-1'
        ? { authorizedAttentionSupervisorSessionIds: ['watcher-1', 'blocked-1'] }
        : sessionId === 'blocked-invalid'
        ? { authorizedAttentionSupervisorSessionIds: [42, '', 'missing'] }
        : sessionId === 'blocked-cross'
        ? { authorizedAttentionSupervisorSessionIds: ['cross-workspace-watcher'] }
        : {},
    } as never));
    const service = MetaAgentService.getInstance() as any;

    await expect(service.assertCallerCanTarget('watcher-1', 'blocked-1', WORKSPACE))
      .rejects.toThrow('not authorized');
    await expect(service.assertCallerCanTarget('watcher-1', 'blocked-invalid', WORKSPACE))
      .rejects.toThrow('not authorized');
    await expect(service.assertCallerCanTarget('cross-workspace-watcher', 'blocked-cross', WORKSPACE))
      .rejects.toThrow('Caller session');
  });

  it('denies notify and cancel/status authorization for an unrelated same-workspace session', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (sessionId: string) => ({
      id: sessionId,
      title: sessionId,
      provider: 'claude-code',
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      workspacePath: WORKSPACE,
      createdBySessionId: null,
      metadata: {},
    } as never));
    const service = MetaAgentService.getInstance() as any;

    await expect(service.notifyUserJson('parent-1', WORKSPACE, {
      title: 'Unauthorized',
      body: 'No',
      sessionId: 'unrelated-1',
      mobilePush: 'always',
    })).rejects.toThrow('not authorized');
    await expect(service.assertCallerCanTarget('parent-1', 'unrelated-1', WORKSPACE))
      .rejects.toThrow('not authorized');
    expect(notificationMocks.showNotificationWithResult).not.toHaveBeenCalled();
  });

  it('applies explicit supervisor authorization to arm, cancel, and status tools', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (sessionId: string) => ({
      id: sessionId,
      title: sessionId,
      provider: 'claude-code',
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      workspacePath: WORKSPACE,
      createdBySessionId: null,
      metadata: sessionId === 'blocked-1'
        ? { authorizedAttentionSupervisorSessionIds: ['watcher-1'] }
        : {},
    } as never));
    const armSpy = vi.spyOn(attentionEventService, 'armJson').mockResolvedValue('{}');
    const cancelSpy = vi.spyOn(attentionEventService, 'cancelJson').mockResolvedValue('{}');
    const statusSpy = vi.spyOn(attentionEventService, 'statusJson').mockResolvedValue('{}');
    const service = MetaAgentService.getInstance() as any;
    service.started = false;
    service.starting = null;
    await service.start({} as any);
    const toolFns = metaToolMocks.toolFns!;

    await expect(toolFns.armAttention('watcher-1', WORKSPACE, {
      sessionId: 'blocked-1',
      progressFingerprint: 'blocked',
      severity: 'normal',
      dedupeKey: 'blocked',
    })).resolves.toBe('{}');
    await expect(toolFns.cancelAttention('watcher-1', WORKSPACE, {
      sessionId: 'blocked-1',
      eventId: 'event-1',
    })).resolves.toBe('{}');
    await expect(toolFns.getAttentionStatus('watcher-1', WORKSPACE, {
      sessionId: 'blocked-1',
    })).resolves.toBe('{}');
    expect(armSpy).toHaveBeenCalled();
    expect(cancelSpy).toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalled();

    await expect(toolFns.armAttention('sibling-1', WORKSPACE, {
      sessionId: 'blocked-1',
      progressFingerprint: 'unauthorized',
      severity: 'normal',
      dedupeKey: 'unauthorized',
    })).rejects.toThrow('not authorized');
    await expect(toolFns.cancelAttention('sibling-1', WORKSPACE, {
      sessionId: 'blocked-1',
      eventId: 'event-1',
    })).rejects.toThrow('not authorized');
    await expect(toolFns.getAttentionStatus('sibling-1', WORKSPACE, {
      sessionId: 'blocked-1',
    })).rejects.toThrow('not authorized');
  });

  it('rate limits direct forced notifications per caller and target', async () => {
    const service = MetaAgentService.getInstance() as any;
    for (let index = 0; index < 10; index += 1) {
      await service.notifyUserJson('parent-1', WORKSPACE, {
        title: `Phone test ${index}`,
        body: 'Please check Nimbalyst.',
        mobilePush: 'always',
      });
    }
    await expect(service.notifyUserJson('parent-1', WORKSPACE, {
      title: 'One too many',
      body: 'Please check Nimbalyst.',
      mobilePush: 'always',
    })).rejects.toThrow('rate limit exceeded');
    expect(syncMocks.requestMobilePush).toHaveBeenCalledTimes(10);
  });

  it('skips mobile push when requested only for away desktop and desktop is active', async () => {
    const service = MetaAgentService.getInstance() as any;
    const json = await service.notifyUserJson('parent-1', WORKSPACE, {
      title: 'Phone test',
      body: 'Please check Nimbalyst.',
      mobilePush: 'when_desktop_away',
    });

    expect(syncMocks.requestMobilePush).not.toHaveBeenCalled();
    expect(JSON.parse(json)).toMatchObject({
      mobilePushAttempted: false,
      mobilePush: {
        mode: 'when_desktop_away',
        requested: true,
        attempted: false,
        skippedReason: 'desktop_not_truly_away',
        bypassActiveDeviceRouting: false,
        forceDesktopAwayForPush: false,
      },
    });
  });
});
