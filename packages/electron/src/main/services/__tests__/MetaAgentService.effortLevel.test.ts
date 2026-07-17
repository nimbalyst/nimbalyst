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
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (value: unknown) => value }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: vi.fn(),
  },
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
  metadata: { effortLevel: 'max' },
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

describe('MetaAgentService per-child requested effort (#899)', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.create).mockReset().mockResolvedValue(undefined);
    vi.mocked(AISessionsRepository.updateMetadata).mockReset().mockResolvedValue(undefined);
    vi.mocked(AISessionsRepository.get).mockReset();
    vi.mocked(AgentMessagesRepository.create).mockReset().mockResolvedValue(undefined);
    vi.mocked(AgentMessagesRepository.list).mockReset().mockResolvedValue([] as never);
    vi.mocked(SessionFilesRepository.getFilesBySession).mockReset().mockResolvedValue([] as never);
    vi.mocked(databaseWorker.query)
      .mockReset()
      .mockResolvedValue({ rows: [{ in_flight: '0', total: '0' }] } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists explicit max before queue/trigger and reports it as requested, not effective', async () => {
    const service = MetaAgentService.getInstance();
    const { queuePromptForSession, triggerQueuedPromptProcessingForSession } = installAIService(service);
    vi.spyOn(service as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CODEX_PARENT as any);

    const json = await (service as any).createChildSession('parent-codex-session', WORKSPACE, {
      prompt: 'Implement the focused fix',
      effortLevel: 'max',
    });
    const result = JSON.parse(json);

    expect(result.requestedEffortLevel).toBe('max');
    expect(result.effectiveEffortLevel).toBeUndefined();
    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledWith(result.sessionId, {
      metadata: { effortLevel: 'max' },
    });

    const persistOrder = vi.mocked(AISessionsRepository.updateMetadata).mock.invocationCallOrder[0];
    const queueOrder = queuePromptForSession.mock.invocationCallOrder[0];
    const triggerOrder = triggerQueuedPromptProcessingForSession.mock.invocationCallOrder[0];
    expect(persistOrder).toBeLessThan(queueOrder);
    expect(queueOrder).toBeLessThan(triggerOrder);
  });

  it('keeps effort metadata absent when omitted and does not inherit the parent effort', async () => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CODEX_PARENT as any);

    const result = await (service as any).createChildSessionInternal('parent-codex-session', WORKSPACE, {
      model: 'openai-codex:gpt-5.6-sol',
    });

    expect(result.requestedEffortLevel).toBeUndefined();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.model).toBe('openai-codex:gpt-5.6-sol');
    expect(created).not.toHaveProperty('effortLevel');
  });

  it('applies explicit effort only to the target child', async () => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CODEX_PARENT as any);

    const explicit = await (service as any).createChildSessionInternal('parent-codex-session', WORKSPACE, {
      effortLevel: 'low',
    });
    const omitted = await (service as any).createChildSessionInternal('parent-codex-session', WORKSPACE, {});

    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledTimes(1);
    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledWith(explicit.sessionId, {
      metadata: { effortLevel: 'low' },
    });
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalledWith(
      omitted.sessionId,
      expect.objectContaining({ metadata: expect.objectContaining({ effortLevel: expect.anything() }) }),
    );
  });

  it('rejects invalid effort before creating a session', async () => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CODEX_PARENT as any);

    await expect(
      (service as any).createChildSessionInternal('parent-codex-session', WORKSPACE, {
        effortLevel: 'ultra',
      }),
    ).rejects.toThrow('Invalid effortLevel "ultra". Expected one of: low, medium, high, xhigh, max');

    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
  });

  it('rejects invalid spawn_session effort before resolving or mutating an ungrouped parent', async () => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CODEX_PARENT as any);
    const resolveWorkstream = vi.spyOn(service as any, 'resolveOrCreateWorkstream');

    await expect(
      (service as any).spawnSession('parent-codex-session', WORKSPACE, {
        prompt: 'Spawn with invalid effort',
        effortLevel: 'ultra',
      }),
    ).rejects.toThrow('Invalid effortLevel "ultra". Expected one of: low, medium, high, xhigh, max');

    expect(resolveWorkstream).not.toHaveBeenCalled();
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
  });

  it('rejects unsupported-provider spawn_session effort before resolving or mutating an ungrouped parent', async () => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      ...CODEX_PARENT,
      provider: 'openai-codex-acp',
      model: 'openai-codex-acp:gpt-5.6-sol',
    } as any);
    const resolveWorkstream = vi.spyOn(service as any, 'resolveOrCreateWorkstream');

    await expect(
      (service as any).spawnSession('parent-codex-acp-session', WORKSPACE, {
        prompt: 'Spawn with unsupported effort',
        effortLevel: 'max',
      }),
    ).rejects.toThrow(
      'effortLevel is supported only for openai-codex child sessions; resolved provider was openai-codex-acp',
    );

    expect(resolveWorkstream).not.toHaveBeenCalled();
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
  });

  it.each([
    ['openai-codex-acp', 'openai-codex-acp:gpt-5.6-sol'],
    ['claude-code', 'claude-code:opus'],
    ['opencode', 'opencode:default'],
  ])('rejects explicit effort for resolved provider %s before creation', async (provider, model) => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      ...CODEX_PARENT,
      provider,
      model,
    } as any);

    await expect(
      (service as any).createChildSessionInternal('parent-non-codex', WORKSPACE, {
        effortLevel: 'high',
      }),
    ).rejects.toThrow(`effortLevel is supported only for openai-codex child sessions; resolved provider was ${provider}`);

    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('forwards explicit effort through default spawn_session and leaves completion notification disabled', async () => {
    const service = MetaAgentService.getInstance();
    installAIService(service);
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CODEX_PARENT as any);

    const json = await (service as any).spawnSession('parent-codex-session', WORKSPACE, {
      prompt: 'Continue in a sibling',
      effortLevel: 'xhigh',
      isolated: true,
    });
    const result = JSON.parse(json);

    expect(result.requestedEffortLevel).toBe('xhigh');
    expect(result.effectiveEffortLevel).toBeUndefined();
    expect(result.notifyOnComplete).toBe(false);
    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledWith(result.sessionId, {
      metadata: { effortLevel: 'xhigh' },
    });
    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledWith(result.sessionId, {
      metadata: { notifyParent: false },
    });
  });

  it('reports requested effort in get_session_status without claiming an effective effort', async () => {
    const service = MetaAgentService.getInstance();
    vi.mocked(databaseWorker.query).mockResolvedValueOnce({
      rows: [{
        id: 'child-1',
        title: 'Effort child',
        status: 'idle',
        last_activity: 10,
        updated_at: 11,
        provider: 'openai-codex',
        model: 'openai-codex:gpt-5.6-sol',
        created_by_session_id: 'parent-1',
        agent_role: 'standard',
        metadata: { effortLevel: 'max' },
      }],
    } as any);

    const status = JSON.parse(await (service as any).getSessionStatusJson('child-1', WORKSPACE));

    expect(status.requestedEffortLevel).toBe('max');
    expect(status.effectiveEffortLevel).toBeUndefined();
  });

  it('reports requested effort in get_session_result without claiming an effective effort', async () => {
    const service = MetaAgentService.getInstance();
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      id: 'child-1',
      title: 'Effort child',
      provider: 'openai-codex',
      model: 'openai-codex:gpt-5.6-sol',
      workspacePath: WORKSPACE,
      worktreeId: null,
      createdAt: 1,
      updatedAt: 2,
      metadata: { effortLevel: 'max' },
    } as any);
    vi.mocked(databaseWorker.query)
      .mockResolvedValueOnce({ rows: [{ status: 'idle', last_activity: 3 }] } as any)
      .mockResolvedValueOnce({ rows: [] } as any);

    const result = JSON.parse(await (service as any).getSessionResultJson('child-1', WORKSPACE));

    expect(result.requestedEffortLevel).toBe('max');
    expect(result.effectiveEffortLevel).toBeUndefined();
  });
});
