import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mirrors the mock surface of MetaAgentService.providerInheritance.test.ts so we
// can drive createChildSessionInternal hermetically and assert on the parent
// agent_role promotion behavior (NIM-858).
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
import { MetaAgentService } from '../MetaAgentService';
import { database } from '../../database/PGLiteDatabaseWorker';

const STANDARD_PARENT = {
  id: 'standard-parent',
  provider: 'claude-code',
  model: 'claude-code:opus',
  agentRole: 'standard',
  sessionType: 'session',
  workspacePath: '/workspace/path',
};

function promotedToMetaAgent(parentId: string): boolean {
  return vi.mocked(AISessionsRepository.updateMetadata).mock.calls.some(
    ([id, update]) => id === parentId && (update as any)?.agentRole === 'meta-agent',
  );
}

describe('MetaAgentService parent agent_role promotion (NIM-858)', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.get).mockReset();
    vi.mocked(AISessionsRepository.updateMetadata).mockReset();
    vi.mocked(AgentMessagesRepository.create).mockReset();
    // These tests assert on the real queue path; vitest sets NODE_ENV=test
    // (unless the shell already set it), which would take the synthetic bypass.
    vi.spyOn(MetaAgentService.prototype as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
  });

  it('does NOT promote a standard parent to meta-agent when it spawns a child', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(STANDARD_PARENT as any);

    await (service as any).createChildSessionInternal('standard-parent', '/workspace/path', {});

    // The child must be persisted as a standard session (existing behavior)...
    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.agentRole).toBe('standard');
    // ...and the spawning parent must keep its standard role, so it and its
    // sibling do NOT render under the Meta Agent group in the session list.
    expect(promotedToMetaAgent('standard-parent')).toBe(false);
  });

  it('shows the action label on an action launch but leaves the session free to name itself', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(STANDARD_PARENT as any);

    await service.launchActionSession('standard-parent', '/workspace/path', {
      prompt: 'continue the work',
      title: 'Continue in New Session',
      autoSubmit: false,
    });
    await (service as any).createChildSessionInternal('standard-parent', '/workspace/path', { title: 'Chosen by orchestrator' });

    const [[action], [spawned]] = vi.mocked(AISessionsRepository.create).mock.calls as any[];
    expect(action).toMatchObject({ title: 'Continue in New Session', hasBeenNamed: false });
    expect(spawned).toMatchObject({ title: 'Chosen by orchestrator', hasBeenNamed: true });
  });

  it('parents create_session and spawn_session from a nested caller directly to that caller without creating wrappers', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ ...STANDARD_PARENT, parentSessionId: 'grandparent' } as any);
    await (service as any).createChildSession('standard-parent', '/workspace/path', {});
    await (service as any).spawnSession('standard-parent', '/workspace/path', { prompt: 'review this' });
    const calls = vi.mocked(AISessionsRepository.create).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [child] of calls) expect(child).toMatchObject({ parentSessionId: 'standard-parent', createdBySessionId: 'standard-parent' });
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
  });

  it('reports nested orchestrator completion to its current manager', async () => {
    const service = MetaAgentService.getInstance();
    const ai = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn() };
    (service as any).aiService = ai;
    (service as any).notificationSignatures.clear();
    const { computeNotificationSignature } = await import('../metaAgentNotificationSignature');
    vi.mocked(computeNotificationSignature).mockReturnValue('nested-completed');
    vi.mocked(AISessionsRepository.get).mockImplementation(async id => ({ ...STANDARD_PARENT, id,
      agentRole: 'meta-agent', createdBySessionId: id === 'nested' ? 'manager' : null } as any));
    vi.mocked(database.query).mockResolvedValue({ rows: [{ count: '0', status: 'running' }] } as any);
    const result = vi.spyOn(service as any, 'buildSessionResultData').mockResolvedValue({ sessionId: 'nested', title: 'Nested', status: 'idle', recentMessages: [], editedFiles: [] });
    try {
      await (service as any).handleChildSessionEvent('nested', 'session:completed');
      expect(ai.queuePromptForSession).toHaveBeenCalledWith('manager', expect.any(String), undefined,
        expect.objectContaining({ promptProvenance: expect.objectContaining({ messageKind: 'report', originSessionId: 'nested' }) }));
    } finally { result.mockRestore(); }
  });

  it('reserves capacity before concurrent spawns can both consume the final lifetime slot', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(STANDARD_PARENT as any);
    let created = 49;
    vi.mocked(database.query).mockImplementation(async () => ({ rows: [{ in_flight: '0', total: String(created) }] }) as any);
    vi.mocked(AISessionsRepository.create).mockImplementation(async () => { created++; });
    const results = await Promise.allSettled([
      (service as any).createChildSessionInternal('standard-parent', '/workspace/path', {}),
      (service as any).createChildSessionInternal('standard-parent', '/workspace/path', {}),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(created).toBe(50);
  });

  it('releases a failed spawn reservation so the final slot remains available', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(STANDARD_PARENT as any);
    vi.mocked(database.query).mockResolvedValue({ rows: [{ in_flight: '0', total: '49' }] } as any);
    vi.mocked(AISessionsRepository.create).mockRejectedValueOnce(new Error('insert failed')).mockResolvedValue(undefined);
    await expect((service as any).createChildSessionInternal('standard-parent', '/workspace/path', {})).rejects.toThrow('insert failed');
    await expect((service as any).createChildSessionInternal('standard-parent', '/workspace/path', {})).resolves.toHaveProperty('sessionId');
  });

  it('queues manager-change notes as reports without interrupting running managers', async () => {
    const service = MetaAgentService.getInstance();
    const ai = { queuePromptForSession: vi.fn(async (..._args: any[]) => ({ id: 'report' })), triggerQueuedPromptProcessingForSession: vi.fn(), interruptCurrentTurn: vi.fn() };
    (service as any).aiService = ai;
    vi.mocked(AISessionsRepository.get).mockImplementation(async id => ({ ...STANDARD_PARENT, id, title: id } as any));
    vi.mocked(database.query).mockResolvedValue({ rows: [{ status: 'running' }] } as any);
    await (service as any).reportManagerChange({ sessionId: 'worker', workspaceId: '/workspace/path', title: 'Worker',
      previousParentId: 'old', previousManagerId: 'old', parentId: 'new', managerId: 'new' });
    expect(ai.queuePromptForSession.mock.calls.map(call => call[0])).toEqual(['new', 'old']);
    for (const call of ai.queuePromptForSession.mock.calls) expect(call[3]).toMatchObject({ promptProvenance: { messageKind: 'report', originSessionId: 'worker' } });
    expect(ai.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
    expect(ai.interruptCurrentTurn).not.toHaveBeenCalled();
  });

  it('keeps system reassignments silent (remote snapshot, delete-lift)', async () => {
    const service = MetaAgentService.getInstance();
    const ai = { queuePromptForSession: vi.fn(async (..._args: any[]) => ({ id: 'report' })), triggerQueuedPromptProcessingForSession: vi.fn() };
    (service as any).aiService = ai;
    vi.mocked(AISessionsRepository.get).mockImplementation(async id => ({ ...STANDARD_PARENT, id, title: id } as any));
    vi.mocked(database.query).mockResolvedValue({ rows: [{ status: 'idle' }] } as any);
    for (const source of ['remote', 'system'] as const) {
      await (service as any).reportManagerChange({ sessionId: 'worker', workspaceId: '/workspace/path', title: 'Worker', source,
        previousParentId: 'old', previousManagerId: 'old', parentId: 'new', managerId: 'new' });
    }
    expect(ai.queuePromptForSession).not.toHaveBeenCalled();
    expect(AgentMessagesRepository.create).not.toHaveBeenCalled();
  });

  it('leaves a passive note in an idle manager instead of queueing a turn', async () => {
    const service = MetaAgentService.getInstance();
    const ai = { queuePromptForSession: vi.fn(async (..._args: any[]) => ({ id: 'report' })), triggerQueuedPromptProcessingForSession: vi.fn() };
    (service as any).aiService = ai;
    vi.mocked(AISessionsRepository.get).mockImplementation(async id => ({ ...STANDARD_PARENT, id, title: id } as any));
    vi.mocked(database.query).mockResolvedValue({ rows: [{ status: 'idle' }] } as any);
    await (service as any).reportManagerChange({ sessionId: 'worker', workspaceId: '/workspace/path', title: 'Worker',
      previousParentId: 'old', previousManagerId: 'old', parentId: 'new', managerId: 'new' });
    expect(ai.queuePromptForSession).not.toHaveBeenCalled();
    expect(ai.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
    expect(AgentMessagesRepository.create).toHaveBeenCalledTimes(2);
    expect(vi.mocked(AgentMessagesRepository.create).mock.calls[0][0]).toMatchObject({ sessionId: 'new', content: 'You now manage Worker (moved by the user).' });
  });
});
