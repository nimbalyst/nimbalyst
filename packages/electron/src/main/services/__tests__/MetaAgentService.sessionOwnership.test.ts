// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same hermetic mock surface as MetaAgentService.parentPromotion.test.ts.
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    create: vi.fn(),
    updateMetadata: vi.fn(),
    get: vi.fn(),
  },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({
  SessionFilesRepository: {},
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class {
    async initialize() {}
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      if (i <= 0) {
        throw new Error(`invalid model: ${id}`);
      }
      return { provider: id.slice(0, i), model: id.slice(i + 1), combined: id };
    },
    tryParse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));

vi.mock('../ai/providerResolution', () => ({
  resolveExtensionAgentRef: (provider: string) =>
    provider === 'antigravity-gemini-agent'
      ? { extensionId: 'antigravity-gemini', contributionId: provider }
      : null,
  isExtensionAgentProvider: (provider: string) => provider === 'antigravity-gemini-agent',
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn().mockResolvedValue({ rows: [{ count: '0' }] }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({
  setMetaAgentToolFns: vi.fn(),
}));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { database } from '../../database/PGLiteDatabaseWorker';
import { MetaAgentService } from '../MetaAgentService';

const ROUTED_OWNER = { extensionId: 'com.example.owner', key: 'ada', routeChildUpdatesToOwner: true };
const OWNED_CALLER = {
  id: 'caller',
  provider: 'claude-code',
  model: 'claude-code:opus',
  agentRole: 'standard',
  sessionType: 'session',
  workspacePath: '/workspace/path',
  parentSessionId: 'ws-1',
  metadata: { sessionOwner: ROUTED_OWNER, sessionDirective: 'You are Ada.', ownerMetadata: { chapter: 3 } },
};

function service() {
  const svc = MetaAgentService.getInstance();
  const aiService = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn() };
  (svc as any).aiService = aiService;
  return { svc, aiService };
}

describe('MetaAgentService session ownership', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.get).mockReset();
    vi.mocked(AISessionsRepository.updateMetadata).mockReset();
    vi.mocked(AgentMessagesRepository.create).mockReset();
    vi.mocked(database.query).mockClear();
  });

  it('spawn_session from an owned session writes the owner and notifyParent on the child row itself', async () => {
    const { svc, aiService } = service();
    vi.mocked(AISessionsRepository.get).mockResolvedValue(OWNED_CALLER as any);

    await (svc as any).spawnSession('caller', '/workspace/path', { prompt: 'do the thing' });

    const row = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    // Owner (with its routing opt-in) is inherited; the directive and the
    // owner's per-session bag are not.
    expect(row.metadata).toEqual({ sessionOwner: ROUTED_OWNER, notifyParent: false });
    expect(row.createdBySessionId).toBe('caller');
    // Written at creation, before the first prompt exists -- no follow-up write.
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    // (The first prompt goes to the queue, or to a synthetic message in test mode.)
    const firstPrompt = [
      ...aiService.queuePromptForSession.mock.invocationCallOrder,
      ...vi.mocked(AgentMessagesRepository.create).mock.invocationCallOrder,
    ];
    expect(firstPrompt).toHaveLength(1);
    expect(vi.mocked(AISessionsRepository.create).mock.invocationCallOrder[0]).toBeLessThan(firstPrompt[0]);
  });

  it('refuses to create the child when the caller\'s ownership cannot be read', async () => {
    const { svc } = service();
    // The spawn's own parent check succeeds; the ownership read then fails.
    vi.mocked(AISessionsRepository.get)
      .mockResolvedValueOnce(OWNED_CALLER as any)
      .mockRejectedValueOnce(new Error('database busy'));

    await expect((svc as any).spawnSession('caller', '/workspace/path', { prompt: 'x' })).rejects.toThrow(/database busy/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('an unowned notify-on-complete spawn carries neither an owner nor notifyParent', async () => {
    const { svc } = service();
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ ...OWNED_CALLER, metadata: {} } as any);

    await (svc as any).spawnSession('caller', '/workspace/path', { prompt: 'x', notifyOnComplete: true });

    expect((vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any).metadata).toEqual({});
  });

  it('an owner-routed child settle queues no [Child Session Update] on the parent', async () => {
    const { svc, aiService } = service();
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      id: 'child',
      agentRole: 'standard',
      createdBySessionId: 'caller',
      workspacePath: '/workspace/path',
      metadata: { sessionOwner: ROUTED_OWNER },
    } as any);

    for (const type of ['session:completed', 'session:waiting', 'session:error', 'session:interrupted']) {
      await (svc as any).handleChildSessionEvent('child', type);
    }

    expect(aiService.queuePromptForSession).not.toHaveBeenCalled();
    expect(aiService.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });
});
