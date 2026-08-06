import { beforeEach, describe, expect, it, vi } from 'vitest';

const { databaseQueryMock, queuePromptForSessionMock, triggerQueuedPromptProcessingMock } = vi.hoisted(() => ({
  databaseQueryMock: vi.fn(),
  queuePromptForSessionMock: vi.fn(),
  triggerQueuedPromptProcessingMock: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: { get: vi.fn() },
  AgentMessagesRepository: { create: vi.fn(), list: vi.fn().mockResolvedValue([]) },
  SessionFilesRepository: { getFilesBySession: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class { async initialize() {} },
  resolveClaudeCodeBackend: vi.fn(),
  resolveClaudeCodeBackendForConfig: vi.fn(),
}));
vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: { tryParse: vi.fn(), parse: vi.fn(), getDefaultModelId: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn(() => () => {}) }),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: vi.fn(), getDefaultEffortLevel: vi.fn() }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: databaseQueryMock } }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: () => ({}) }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../RepositoryManager', () => ({ getQueuedPromptsStore: vi.fn() }));
vi.mock('../ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({ extractMessageText: vi.fn(), extractUserPrompts: vi.fn(() => []) }));

import { AISessionsRepository } from '@nimbalyst/runtime';
import { MetaAgentService } from '../MetaAgentService';

describe('MetaAgentService queued prompt truth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseQueryMock.mockResolvedValue({ rows: [{ status: 'idle' }] });
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      id: 'target-session',
      workspacePath: '/workspace',
      worktreePath: '/workspace',
    } as any);
    queuePromptForSessionMock.mockResolvedValue({
      id: 'meta-stable-submission',
      prompt: '  keep this exact payload\\n',
      createdAt: 1,
    });
  });

  it('validates whitespace without normalizing the queued orchestration payload', async () => {
    const service = MetaAgentService.getInstance() as any;
    service.shouldBypassChildAgentExecutionForTests = () => false;
    service.aiService = {
      queuePromptForSession: queuePromptForSessionMock,
      triggerQueuedPromptProcessingForSession: triggerQueuedPromptProcessingMock,
    };

    const result = JSON.parse(await service.sendPromptToSession(
      'origin-session',
      '/workspace',
      'target-session',
      '  keep this exact payload\\n',
    ));

    expect(queuePromptForSessionMock).toHaveBeenCalledWith(
      'target-session',
      '  keep this exact payload\\n',
      undefined,
      expect.objectContaining({
        promptProvenance: expect.objectContaining({
          originSessionId: 'origin-session',
          origin: 'session-orchestration',
        }),
      }),
    );
    expect(result).toMatchObject({
      queuedPromptId: 'meta-stable-submission',
      prompt: '  keep this exact payload\\n',
      processingTriggered: true,
    });
    expect(triggerQueuedPromptProcessingMock).toHaveBeenCalledWith(
      'target-session',
      '/workspace',
    );
  });
});
