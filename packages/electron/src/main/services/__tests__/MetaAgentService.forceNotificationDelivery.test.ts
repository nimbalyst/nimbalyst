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
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));

vi.mock('../ai/providerResolution', () => ({
  resolveExtensionAgentRef: () => null,
  isExtensionAgentProvider: () => false,
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn() },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({
  setMetaAgentToolFns: vi.fn(),
}));

import { AISessionsRepository, AgentMessagesRepository } from '@nimbalyst/runtime';
import { database as databaseWorker } from '../../database/PGLiteDatabaseWorker';
import { MetaAgentService } from '../MetaAgentService';

const WORKSPACE = '/workspace';

describe('MetaAgentService child notification force delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const service = MetaAgentService.getInstance() as any;
    service.notificationSignatures = new Map();
    service.shouldBypassChildAgentExecutionForTests = () => false;
  });

  it('force-delivers child completion updates to a running parent session', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (sessionId: string) => {
      if (sessionId === 'child-1') {
        return {
          id: 'child-1',
          title: 'Child worker',
          provider: 'claude-code',
          model: 'claude-code:sonnet',
          status: 'idle',
          createdAt: 1,
          updatedAt: 2,
          workspacePath: WORKSPACE,
          worktreePath: null,
          worktreeId: null,
          agentRole: 'standard',
          createdBySessionId: 'parent-1',
          metadata: {},
        } as never;
      }
      if (sessionId === 'parent-1') {
        return {
          id: 'parent-1',
          title: 'Parent orchestrator',
          provider: 'claude-code',
          model: 'claude-code:sonnet',
          status: 'running',
          createdAt: 1,
          updatedAt: 2,
          workspacePath: WORKSPACE,
          worktreePath: null,
          worktreeId: null,
          agentRole: 'meta-agent',
          createdBySessionId: null,
          metadata: {},
        } as never;
      }
      return null;
    });

    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'input', content: 'do the task', metadata: null },
      { direction: 'output', content: 'task complete', metadata: null },
    ] as never);

    vi.mocked(databaseWorker.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('COUNT(*)::text AS count') && params?.[0] === 'child-1') {
        return { rows: [{ count: '0' }] };
      }
      if (sql.includes('FROM ai_sessions') && params?.[0] === 'parent-1') {
        return { rows: [{ status: 'running', last_activity: 3, updated_at: 4 }] };
      }
      if (sql.includes('FROM ai_sessions') && params?.[0] === 'child-1') {
        return { rows: [{ status: 'idle', last_activity: 3, updated_at: 4 }] };
      }
      return { rows: [] };
    });

    const aiService = {
      queuePromptForSession: vi.fn().mockResolvedValue({
        id: 'queued-notification-1',
        prompt: '[Child Session Update]\nSession: "Child worker" (child-1)',
        createdAt: 10,
      }),
      interruptCurrentTurnForSession: vi.fn().mockResolvedValue({
        success: true,
        method: 'interrupt',
        completed: 0,
        rolledBack: 0,
      }),
      triggerQueuedPromptProcessingForSession: vi.fn().mockResolvedValue(true),
    };

    const service = MetaAgentService.getInstance() as any;
    service.aiService = aiService;

    await service.handleChildSessionEvent('child-1', 'session:completed');

    expect(aiService.queuePromptForSession).toHaveBeenCalledWith(
      'parent-1',
      expect.stringContaining('[Child Session Update]')
    );
    expect(aiService.interruptCurrentTurnForSession).toHaveBeenCalledWith('parent-1');
    expect(aiService.triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith('parent-1', WORKSPACE);
  });

  it('keeps child error notifications queue-only to avoid error-loop churn', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (sessionId: string) => {
      if (sessionId === 'child-err') {
        return {
          id: 'child-err',
          title: 'Failing child',
          provider: 'claude-code',
          model: 'claude-code:sonnet',
          status: 'error',
          createdAt: 1,
          updatedAt: 2,
          workspacePath: WORKSPACE,
          agentRole: 'standard',
          createdBySessionId: 'parent-1',
          metadata: {},
        } as never;
      }
      if (sessionId === 'parent-1') {
        return {
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
        } as never;
      }
      return null;
    });
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'input', content: 'do the task', metadata: null },
      { direction: 'output', content: 'failed', metadata: null },
    ] as never);
    vi.mocked(databaseWorker.query).mockResolvedValue({ rows: [] });

    const aiService = {
      queuePromptForSession: vi.fn().mockResolvedValue({
        id: 'queued-error-notification-1',
        prompt: '[Child Session Update]\nSession: "Failing child" (child-err)',
        createdAt: 10,
      }),
      interruptCurrentTurnForSession: vi.fn(),
      triggerQueuedPromptProcessingForSession: vi.fn(),
    };

    const service = MetaAgentService.getInstance() as any;
    service.aiService = aiService;

    await service.handleChildSessionEvent('child-err', 'session:error');

    expect(aiService.queuePromptForSession).toHaveBeenCalledWith(
      'parent-1',
      expect.stringContaining('[Child Session Update]')
    );
    expect(aiService.interruptCurrentTurnForSession).not.toHaveBeenCalled();
    expect(aiService.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
  });
});
