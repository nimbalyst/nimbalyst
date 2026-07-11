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
vi.mock('../SyncManager', () => ({
  getSyncProvider: () => ({ pushChange: vi.fn(), requestMobilePush: vi.fn() }),
  isDesktopTrulyAway: () => false,
}));
vi.mock('../NotificationService', () => ({
  notificationService: { showNotificationWithResult: vi.fn() },
}));
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

import { AISessionsRepository } from '@nimbalyst/runtime';
import { MetaAgentService } from '../MetaAgentService';

const WORKSPACE = '/workspace';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'target-1',
    title: 'Target session',
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    status: 'idle',
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

  it('defaults to the calling session (self-compaction) when sessionId is omitted', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession({ id: 'caller-1' }));
    const sendMessageDirect = vi.fn().mockResolvedValue({
      content: 'Conversation compacted (was 150000 tokens)',
      contextCompacted: true,
    });
    service.aiService = { sendMessageDirect };

    const raw = await service.compactSessionJson('caller-1', WORKSPACE, {});
    const parsed = JSON.parse(raw);

    expect(AISessionsRepository.get).toHaveBeenCalledWith('caller-1');
    expect(sendMessageDirect).toHaveBeenCalledWith('caller-1', WORKSPACE, '/compact');
    expect(parsed).toEqual({
      sessionId: 'caller-1',
      prompt: '/compact',
      compacted: true,
      response: 'Conversation compacted (was 150000 tokens)',
    });
  });

  it('builds "/compact focus on <focus>" when a focus argument is given', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession());
    const sendMessageDirect = vi.fn().mockResolvedValue({
      content: 'Conversation compacted (was 90000 tokens)',
      contextCompacted: true,
    });
    service.aiService = { sendMessageDirect };

    const raw = await service.compactSessionJson('caller-1', WORKSPACE, {
      sessionId: 'target-1',
      focus: 'current task state',
    });
    const parsed = JSON.parse(raw);

    expect(sendMessageDirect).toHaveBeenCalledWith(
      'target-1',
      WORKSPACE,
      '/compact focus on current task state',
    );
    expect(parsed.compacted).toBe(true);
  });

  it('reports compacted:false when contextCompacted is not set on the response (arrived as plain chat text)', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession());
    const sendMessageDirect = vi.fn().mockResolvedValue({
      content: "Sure, I'll compact the conversation now, focusing on X...",
    });
    service.aiService = { sendMessageDirect };

    const raw = await service.compactSessionJson('caller-1', WORKSPACE, { sessionId: 'target-1' });
    const parsed = JSON.parse(raw);

    expect(parsed.compacted).toBe(false);
  });

  it('reports compacted:false even if the response text merely mentions compaction without the structured flag (no false positive)', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession());
    const sendMessageDirect = vi.fn().mockResolvedValue({
      content: 'Conversation compacted is a feature I can describe, but I did not run it here.',
      contextCompacted: false,
    });
    service.aiService = { sendMessageDirect };

    const raw = await service.compactSessionJson('caller-1', WORKSPACE, { sessionId: 'target-1' });
    const parsed = JSON.parse(raw);

    expect(parsed.compacted).toBe(false);
  });

  it('returns a structured error instead of throwing when the send fails', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(makeSession());
    const sendMessageDirect = vi.fn().mockRejectedValue(new Error('No open window for workspace'));
    service.aiService = { sendMessageDirect };

    const raw = await service.compactSessionJson('caller-1', WORKSPACE, { sessionId: 'target-1' });
    const parsed = JSON.parse(raw);

    expect(parsed).toEqual({
      sessionId: 'target-1',
      prompt: '/compact',
      compacted: false,
      error: 'No open window for workspace',
    });
  });

  it('throws when the target session is not found in this workspace', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(null as never);
    service.aiService = { sendMessageDirect: vi.fn() };

    await expect(
      service.compactSessionJson('caller-1', WORKSPACE, { sessionId: 'missing-1' }),
    ).rejects.toThrow('Session missing-1 not found');
  });
});
