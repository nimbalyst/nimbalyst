import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    create: vi.fn(),
    updateMetadata: vi.fn(),
    get: vi.fn(),
  },
  AgentMessagesRepository: {
    create: vi.fn(),
    list: vi.fn(),
  },
  SessionFilesRepository: {
    getFilesBySession: vi.fn(),
  },
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class {
    async initialize() {}
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => {
      const separator = id.indexOf(':');
      if (separator <= 0) throw new Error(`invalid model: ${id}`);
      return {
        provider: id.slice(0, separator),
        model: id.slice(separator + 1),
        combined: id,
      };
    },
    tryParse: (id: string) => {
      const separator = typeof id === 'string' ? id.indexOf(':') : -1;
      return separator > 0
        ? { provider: id.slice(0, separator), model: id.slice(separator + 1) }
        : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({
  getDefaultAIModel: () => null,
  getDefaultEffortLevel: () => 'high',
}));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (value: unknown) => value }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn() },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: (content: unknown) => (typeof content === 'string' ? content : ''),
  extractUserPrompts: () => [],
}));

import {
  AISessionsRepository,
  AgentMessagesRepository,
  SessionFilesRepository,
} from '@nimbalyst/runtime';
import { database as databaseWorker } from '../../database/PGLiteDatabaseWorker';
import { MetaAgentService } from '../MetaAgentService';

const WORKSPACE = '/workspace/path';
const CODEX_PARENT = {
  id: 'parent-codex-session',
  provider: 'openai-codex',
  model: 'openai-codex:gpt-5.6-sol',
  title: 'Codex parent',
  workspacePath: WORKSPACE,
  worktreeId: null,
  parentSessionId: null,
  sessionType: 'session',
};
const CLAUDE_PARENT = {
  ...CODEX_PARENT,
  id: 'parent-claude-session',
  provider: 'claude-code',
  model: 'claude-code:opus',
  title: 'Claude parent',
};
const STORED_LAUNCH_CONFIGURATION = {
  requested: {
    provider: null,
    model: null,
    effortLevel: 'max',
    thinkingMode: null,
    toolScope: null,
    inheritModel: false,
    isolated: false,
    useWorktree: false,
    notifyOnComplete: null,
  },
  resolved: {
    provider: 'openai-codex',
    model: CODEX_PARENT.model,
    effortLevel: 'max',
    thinkingMode: null,
    toolScope: 'full',
    isolated: false,
    worktreeMode: 'none',
    notifyOnComplete: true,
    sources: {
      provider: 'inherited',
      model: 'inherited',
      effortLevel: 'requested',
      thinkingMode: null,
      toolScope: 'default',
    },
  },
  effectiveness: 'not-provider-confirmed',
};

function installAIService(service: MetaAgentService) {
  const queuePromptForSession = vi.fn().mockResolvedValue({ id: 'queued-1' });
  const triggerQueuedPromptProcessingForSession = vi.fn().mockResolvedValue(undefined);
  (service as any).aiService = {
    queuePromptForSession,
    triggerQueuedPromptProcessingForSession,
  };
  return { queuePromptForSession, triggerQueuedPromptProcessingForSession };
}

describe('MetaAgentService launch configuration', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.create).mockReset().mockResolvedValue(undefined);
    vi.mocked(AISessionsRepository.updateMetadata).mockReset().mockResolvedValue(undefined);
    vi.mocked(AISessionsRepository.get).mockReset();
    vi.mocked(AgentMessagesRepository.create).mockReset().mockResolvedValue(undefined);
    vi.mocked(AgentMessagesRepository.list).mockReset().mockResolvedValue([] as never);
    vi.mocked(SessionFilesRepository.getFilesBySession)
      .mockReset()
      .mockResolvedValue([] as never);
    vi.mocked(databaseWorker.query)
      .mockReset()
      .mockResolvedValue({ rows: [{ in_flight: '0', total: '0' }] } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists requested/resolved Codex configuration before queue and trigger', async () => {
    const service = MetaAgentService.getInstance();
    const { queuePromptForSession, triggerQueuedPromptProcessingForSession } =
      installAIService(service);
    vi.spyOn(service as any, 'shouldBypassChildAgentExecutionForTests')
      .mockReturnValue(false);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CODEX_PARENT as any);

    const result = JSON.parse(await (service as any).createChildSession(
      CODEX_PARENT.id,
      WORKSPACE,
      {
        prompt: 'Implement the focused fix',
        effortLevel: 'max',
        toolScope: 'write',
      },
    ));

    expect(result.launchConfiguration).toMatchObject({
      requested: {
        effortLevel: 'max',
        toolScope: 'write',
      },
      resolved: {
        provider: 'openai-codex',
        model: CODEX_PARENT.model,
        effortLevel: 'max',
        toolScope: 'write',
        sources: {
          provider: 'inherited',
          model: 'inherited',
          effortLevel: 'requested',
          toolScope: 'requested',
        },
      },
      effectiveness: 'not-provider-confirmed',
    });
    expect(result.effectiveEffortLevel).toBeUndefined();
    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledWith(
      result.sessionId,
      {
        metadata: expect.objectContaining({
          effortLevel: 'max',
          toolScope: 'write',
          launchConfiguration: result.launchConfiguration,
        }),
      },
    );

    const persistOrder =
      vi.mocked(AISessionsRepository.updateMetadata).mock.invocationCallOrder[0];
    expect(persistOrder).toBeLessThan(
      queuePromptForSession.mock.invocationCallOrder[0],
    );
    expect(queuePromptForSession.mock.invocationCallOrder[0]).toBeLessThan(
      triggerQueuedPromptProcessingForSession.mock.invocationCallOrder[0],
    );
  });

  it('persists supported Claude effort and thinking configuration', async () => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);

    const result = await (service as any).createChildSessionInternal(
      CLAUDE_PARENT.id,
      WORKSPACE,
      {
        effortLevel: 'xhigh',
        thinkingMode: 'disabled',
      },
    );

    expect(result.launchConfiguration.resolved).toMatchObject({
      effortLevel: 'xhigh',
      thinkingMode: 'disabled',
    });
    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledWith(
      result.sessionId,
      {
        metadata: expect.objectContaining({
          effortLevel: 'xhigh',
          thinkingMode: 'disabled',
        }),
      },
    );
  });

  it('snapshots supported app defaults with explicit default provenance', async () => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CODEX_PARENT as any);

    const result = await (service as any).createChildSessionInternal(
      CODEX_PARENT.id,
      WORKSPACE,
      {},
    );

    expect(result.launchConfiguration.resolved.effortLevel).toBe('high');
    expect(result.launchConfiguration.resolved.sources.effortLevel).toBe(
      'app-default',
    );
    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledWith(
      result.sessionId,
      {
        metadata: expect.objectContaining({ effortLevel: 'high' }),
      },
    );
  });

  it('rejects unsupported reasoning before creating a session', async () => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      ...CLAUDE_PARENT,
      model: 'claude-code:haiku',
    } as any);

    await expect((service as any).createChildSessionInternal(
      CLAUDE_PARENT.id,
      WORKSPACE,
      { effortLevel: 'high' },
    )).rejects.toThrow('Supported values: none');
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('rejects provider/model mismatches before creating a session', async () => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);

    await expect((service as any).createChildSessionInternal(
      CLAUDE_PARENT.id,
      WORKSPACE,
      {
        provider: 'claude-code',
        model: 'openai-codex:gpt-5.6-sol',
      },
    )).rejects.toThrow(
      'provider claude-code does not match model provider openai-codex',
    );
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('rejects invalid spawn configuration before workstream mutation', async () => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CODEX_PARENT as any);
    const resolveWorkstream = vi.spyOn(service as any, 'resolveOrCreateWorkstream');

    await expect((service as any).spawnSession(
      CODEX_PARENT.id,
      WORKSPACE,
      {
        prompt: 'Spawn with invalid scope',
        toolScope: 'admin',
      },
    )).rejects.toThrow('Invalid toolScope "admin"');
    expect(resolveWorkstream).not.toHaveBeenCalled();
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('rejects unsupported spawn reasoning before workstream mutation', async () => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      ...CODEX_PARENT,
      provider: 'openai-codex-acp',
      model: 'openai-codex-acp:gpt-5.6-sol',
    } as any);
    const resolveWorkstream = vi.spyOn(service as any, 'resolveOrCreateWorkstream');

    await expect((service as any).spawnSession(
      CODEX_PARENT.id,
      WORKSPACE,
      {
        prompt: 'Spawn with unsupported effort',
        effortLevel: 'max',
      },
    )).rejects.toThrow('Supported values: none');
    expect(resolveWorkstream).not.toHaveBeenCalled();
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('persists spawn topology, scope, and notification behavior before queueing', async () => {
    const service = MetaAgentService.getInstance();
    const { queuePromptForSession } = installAIService(service);
    vi.spyOn(service as any, 'shouldBypassChildAgentExecutionForTests')
      .mockReturnValue(false);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CODEX_PARENT as any);

    const result = JSON.parse(await (service as any).spawnSession(
      CODEX_PARENT.id,
      WORKSPACE,
      {
        prompt: 'Continue independently',
        isolated: true,
        toolScope: 'read',
        notifyOnComplete: false,
      },
    ));

    expect(result.launchConfiguration.resolved).toMatchObject({
      isolated: true,
      worktreeMode: 'none',
      toolScope: 'read',
      notifyOnComplete: false,
    });
    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledWith(
      result.sessionId,
      {
        metadata: expect.objectContaining({
          notifyParent: false,
          toolScope: 'read',
        }),
      },
    );
    expect(
      vi.mocked(AISessionsRepository.updateMetadata).mock.invocationCallOrder[0],
    ).toBeLessThan(queuePromptForSession.mock.invocationCallOrder[0]);
  });

  it('returns persisted launch provenance from get_session_status', async () => {
    const service = MetaAgentService.getInstance();
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      id: 'child-1',
      workspacePath: WORKSPACE,
      createdBySessionId: CODEX_PARENT.id,
    } as any);
    vi.mocked(databaseWorker.query).mockResolvedValueOnce({
      rows: [{
        id: 'child-1',
        title: 'Launch child',
        status: 'idle',
        last_activity: 10,
        updated_at: 11,
        provider: 'openai-codex',
        model: CODEX_PARENT.model,
        created_by_session_id: CODEX_PARENT.id,
        agent_role: 'standard',
        metadata: { launchConfiguration: STORED_LAUNCH_CONFIGURATION },
      }],
    } as any);

    const status = JSON.parse(await (service as any).getSessionStatusJson(
      CODEX_PARENT.id,
      WORKSPACE,
      'child-1',
    ));
    expect(status.launchConfiguration).toEqual(STORED_LAUNCH_CONFIGURATION);
    expect(status.effectiveEffortLevel).toBeUndefined();
  });

  it('returns persisted launch provenance from get_session_result', async () => {
    const service = MetaAgentService.getInstance();
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      id: 'child-1',
      title: 'Launch child',
      provider: 'openai-codex',
      model: CODEX_PARENT.model,
      workspacePath: WORKSPACE,
      worktreeId: null,
      createdAt: 1,
      updatedAt: 2,
      metadata: { launchConfiguration: STORED_LAUNCH_CONFIGURATION },
    } as any);
    vi.mocked(databaseWorker.query)
      .mockResolvedValueOnce({
        rows: [{ status: 'idle', last_activity: 3 }],
      } as any)
      .mockResolvedValueOnce({ rows: [] } as any);

    const result = JSON.parse(await (service as any).getSessionResultJson(
      CODEX_PARENT.id,
      WORKSPACE,
      'child-1',
    ));
    expect(result.launchConfiguration).toEqual(STORED_LAUNCH_CONFIGURATION);
    expect(result.effectiveEffortLevel).toBeUndefined();
  });
});
