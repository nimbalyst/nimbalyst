import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: vi.fn(),
  },
  AgentMessagesRepository: {
    list: vi.fn(),
  },
  SessionFilesRepository: {
    getFilesBySession: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class { async initialize() {} },
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => ({ provider: id.split(':')[0], model: id.split(':')[1], combined: id }),
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn(() => () => {}) }),
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn() } }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));

import { AISessionsRepository } from '@nimbalyst/runtime';
import { MetaAgentService } from '../MetaAgentService';

const WORKSPACE = '/workspace';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'caller-1',
    title: 'Session',
    provider: 'openai-codex',
    model: 'openai-codex:gpt-5.6-sol',
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    workspacePath: WORKSPACE,
    worktreePath: null,
    worktreeId: null,
    agentRole: 'standard',
    createdBySessionId: null,
    metadata: {},
    ...overrides,
  } as never;
}

describe('MetaAgentService.compactSessionJson', () => {
  let service: any;

  beforeEach(() => {
    vi.clearAllMocks();
    service = MetaAgentService.getInstance() as any;
  });

  it('schedules Codex self-compaction without invoking native compaction inside the active turn', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession());
    const compactSessionNative = vi.fn();
    const queuePromptForSession = vi.fn().mockResolvedValue({
      id: 'queued-codex-1',
      prompt: '/compact',
    });
    const triggerQueuedPromptProcessingForSession = vi.fn();
    service.getSessionStatusRow = vi.fn().mockResolvedValue({ status: 'idle' });
    service.aiService = {
      compactSessionNative,
      queuePromptForSession,
      triggerQueuedPromptProcessingForSession,
    };

    const raw = await service.compactSessionJson('caller-1', WORKSPACE, {});

    expect(compactSessionNative).not.toHaveBeenCalled();
    expect(queuePromptForSession).toHaveBeenCalledWith(
      'caller-1',
      '/compact',
      undefined,
      { promptOrigin: 'agent_compaction' },
    );
    expect(triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
    expect(JSON.parse(raw)).toEqual({
      sessionId: 'caller-1',
      provider: 'openai-codex',
      compacted: false,
      scheduled: true,
      method: 'queued-native-compaction',
      queuedPromptId: 'queued-codex-1',
      processingTriggered: false,
    });
  });

  it('single-line normalizes focus while reporting that queued Codex native compaction cannot apply it', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession());
    const queuePromptForSession = vi.fn().mockResolvedValue({
      id: 'queued-codex-2',
      prompt: '/compact',
    });
    service.aiService = {
      compactSessionNative: vi.fn(),
      queuePromptForSession,
      triggerQueuedPromptProcessingForSession: vi.fn(),
    };
    service.getSessionStatusRow = vi.fn().mockResolvedValue({ status: 'running' });

    const raw = await service.compactSessionJson('caller-1', WORKSPACE, {
      focus: '  preserve\r\ncurrent\tstate\x00safely  ',
    });

    expect(JSON.parse(raw)).toEqual({
      sessionId: 'caller-1',
      provider: 'openai-codex',
      compacted: false,
      scheduled: true,
      method: 'queued-native-compaction',
      queuedPromptId: 'queued-codex-2',
      processingTriggered: false,
      focus: 'preserve current state safely',
      focusApplied: false,
    });
  });

  it('queues Claude self-compaction for after the active turn and reports scheduling honestly', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession({
      provider: 'claude-code',
      model: 'claude-code:sonnet',
    }));
    const queuePromptForSession = vi.fn().mockResolvedValue({
      id: 'queued-1',
      prompt: '/compact focus on preserve current state',
    });
    const triggerQueuedPromptProcessingForSession = vi.fn();
    // Persisted status can lag the live turn. Self-targeting must remain
    // deferred even when the row still says idle.
    service.getSessionStatusRow = vi.fn().mockResolvedValue({ status: 'idle' });
    service.aiService = {
      compactSessionNative: vi.fn().mockResolvedValue({ supported: false, compacted: false }),
      queuePromptForSession,
      triggerQueuedPromptProcessingForSession,
    };

    const raw = await service.compactSessionJson('caller-1', WORKSPACE, {
      focus: 'preserve\ncurrent state',
    });

    expect(queuePromptForSession).toHaveBeenCalledWith(
      'caller-1',
      '/compact focus on preserve current state',
    );
    expect(triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
    expect(JSON.parse(raw)).toEqual({
      sessionId: 'caller-1',
      provider: 'claude-code',
      compacted: false,
      scheduled: true,
      method: 'queued-slash-command',
      queuedPromptId: 'queued-1',
      processingTriggered: false,
      focus: 'preserve current state',
      focusApplied: false,
    });
  });

  it('allows an owned child target and triggers its queued Claude compaction when idle', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession({
      id: 'child-1',
      provider: 'claude-code',
      createdBySessionId: 'caller-1',
      status: 'idle',
    }));
    const queuePromptForSession = vi.fn().mockResolvedValue({ id: 'queued-2', prompt: '/compact' });
    const triggerQueuedPromptProcessingForSession = vi.fn().mockResolvedValue(true);
    service.getSessionStatusRow = vi.fn().mockResolvedValue({ status: 'idle' });
    service.aiService = {
      compactSessionNative: vi.fn().mockResolvedValue({ supported: false, compacted: false }),
      queuePromptForSession,
      triggerQueuedPromptProcessingForSession,
    };

    const raw = await service.compactSessionJson('caller-1', WORKSPACE, { sessionId: 'child-1' });

    expect(triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith('child-1', WORKSPACE);
    expect(JSON.parse(raw)).toMatchObject({
      sessionId: 'child-1',
      compacted: false,
      scheduled: true,
      processingTriggered: true,
    });
  });

  it('rejects a same-workspace target that is neither self nor an owned child', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession({
      id: 'other-1',
      createdBySessionId: 'someone-else',
    }));
    service.aiService = { compactSessionNative: vi.fn() };

    await expect(
      service.compactSessionJson('caller-1', WORKSPACE, { sessionId: 'other-1' }),
    ).rejects.toThrow('not owned by caller-1');
  });

  it('rejects a target from another workspace without revealing its provider', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession({
      id: 'other-workspace-1',
      workspacePath: '/another-workspace',
      provider: 'claude-code',
    }));
    service.aiService = { compactSessionNative: vi.fn() };

    await expect(
      service.compactSessionJson('caller-1', WORKSPACE, { sessionId: 'other-workspace-1' }),
    ).rejects.toThrow('Session other-workspace-1 not found');
    expect(service.aiService.compactSessionNative).not.toHaveBeenCalled();
  });

  it('reports an unsupported provider without scheduling a chat turn', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession({
      provider: 'fable',
      model: 'fable:default',
    }));
    const queuePromptForSession = vi.fn();
    const compactSessionNative = vi.fn();
    service.aiService = { compactSessionNative, queuePromptForSession };

    const raw = await service.compactSessionJson('caller-1', WORKSPACE, {});

    expect(queuePromptForSession).not.toHaveBeenCalled();
    expect(compactSessionNative).not.toHaveBeenCalled();
    expect(JSON.parse(raw)).toEqual({
      sessionId: 'caller-1',
      provider: 'fable',
      compacted: false,
      scheduled: false,
      error: 'Provider fable does not support compaction',
    });
  });

  it('rejects focus text over the supported input bound', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession());
    service.aiService = { compactSessionNative: vi.fn() };

    await expect(
      service.compactSessionJson('caller-1', WORKSPACE, { focus: 'x'.repeat(1001) }),
    ).rejects.toThrow('focus must be at most 1000 characters');
  });
});
