// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reportingMode } = vi.hoisted(() => ({ reportingMode: vi.fn() }));
vi.mock('../SettingsService', () => ({ getSettingsService: () => ({ get: reportingMode }) }));

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
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: (event: string) => event }));
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
import { buildClaudeCodeSystemPrompt } from '@nimbalyst/runtime/ai/prompt';

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
    reportingMode.mockReset().mockReturnValue('automatic');
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

  it('an unowned notify-on-complete spawn carries no owner and no notifyParent opt-out', async () => {
    const { svc } = service();
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ ...OWNED_CALLER, metadata: {} } as any);

    await (svc as any).spawnSession('caller', '/workspace/path', { prompt: 'x', notifyOnComplete: true });

    const metadata = (vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any).metadata;
    expect(Object.keys(metadata)).toEqual(['sessionDirective']);
  });

  describe('child reporting', () => {
    // The child's real system prompt for each spawn setting, so a wording change
    // that tells a quiet child to message its parent shows up here.
    async function childPrompt(spawnArgs: Record<string, unknown>, via: 'spawnSession' | 'createChildSession' = 'spawnSession') {
      const { svc } = service();
      vi.mocked(AISessionsRepository.get).mockResolvedValue({ ...OWNED_CALLER, metadata: {} } as any);
      await (svc as any)[via]('caller', '/workspace/path', { prompt: 'x', ...spawnArgs });
      const metadata = (vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any).metadata;
      return { metadata, prompt: buildClaudeCodeSystemPrompt({ hasSessionNaming: true, sessionDirective: metadata.sessionDirective }) };
    }

    it('none (the default for spawn_session and create_session) adds nothing and suppresses the completion notification', async () => {
      for (const via of ['spawnSession', 'createChildSession'] as const) {
        vi.mocked(AISessionsRepository.create).mockReset();
        const { metadata, prompt } = await childPrompt({}, via);
        expect(metadata).toEqual({ notifyParent: false });
        expect(prompt).toBe(buildClaudeCodeSystemPrompt({ hasSessionNaming: true }));
        expect(prompt).not.toMatch(/send_prompt|messageKind|consume_session_inbox|sibling/);
      }
    });

    it('final keeps automatic delivery and allows an explicitly authorized actionable return', async () => {
      const { metadata, prompt } = await childPrompt({ reporting: 'final' });
      expect(metadata.notifyParent).toBeUndefined();
      expect(prompt).toContain('Your final response is delivered');
      expect(prompt).toContain('messageKind=instruction');
      expect(prompt).toContain('interrupt=false');
    });

    it('messages distinguishes reports and authorized actionable returns', async () => {
      const { metadata, prompt } = await childPrompt({ reporting: 'messages' });
      expect(metadata.notifyParent).toBeUndefined();
      expect(prompt).toContain('messageKind=report');
      expect(prompt).toContain('do not wake');
      expect(prompt).toContain('messageKind=instruction');
      expect(prompt).toContain('Your final response is delivered');
    });

    it.each(['spawnSession', 'createChildSession'] as const)('reads the current mode in %s before queueing the child prompt', async via => {
      await childPrompt({ reporting: 'final' }, via);
      vi.mocked(AISessionsRepository.create).mockClear();
      reportingMode.mockReturnValue('manual');
      const { metadata, prompt } = await childPrompt({ reporting: 'messages' }, via);
      expect(reportingMode).toHaveBeenCalledWith('ai.childReportingMode');
      expect(metadata.childReportingMode).toBe('manual');
      expect(metadata.notifyParent).toBeUndefined();
      expect(prompt).toContain('no final response is forwarded automatically');
      expect(prompt).toContain('messageKind=report');
      expect(prompt).toContain('messageKind=instruction');
    });

    it('rejects an unknown setting before creating anything', async () => {
      const { svc } = service();
      vi.mocked(AISessionsRepository.get).mockResolvedValue({ ...OWNED_CALLER, metadata: {} } as any);
      await expect((svc as any).spawnSession('caller', '/workspace/path', { prompt: 'x', reporting: 'chatty' })).rejects.toThrow(/Invalid reporting/);
      expect(AISessionsRepository.create).not.toHaveBeenCalled();
    });
  });

  it('a report to an idle session is queued without waking it; an instruction still wakes it', async () => {
    reportingMode.mockReturnValue('manual');
    const { svc, aiService } = service();
    vi.spyOn(svc as any, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
    vi.spyOn(svc as any, 'getSessionStatusRow').mockResolvedValue({ status: 'idle' });
    aiService.queuePromptForSession.mockResolvedValue({ id: 'q1', prompt: 'p' });
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ id: 'parent', workspacePath: '/workspace/path' } as any);

    const report = JSON.parse(await (svc as any).sendPromptToSession('child', 'parent', '/workspace/path', 'paths released', false, 'report'));
    expect(report).toMatchObject({ processingTriggered: false, heldForNextTurn: true });
    expect(aiService.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();

    await (svc as any).sendPromptToSession('child', 'parent', '/workspace/path', 'do this next', false, 'instruction');
    expect(aiService.triggerQueuedPromptProcessingForSession).toHaveBeenCalledTimes(1);
  });

  it.each(['automatic', 'manual'] as const)('settles an existing child in %s mode with the intended parent traffic', async mode => {
    reportingMode.mockReturnValue(mode);
    const { svc, aiService } = service();
    const sessionId = `child-${mode}`;
    const result = { sessionId, title: 'Child', status: 'idle', recentMessages: [], editedFiles: [] };
    vi.mocked(AISessionsRepository.get).mockImplementation(async id => ({
      id, workspacePath: '/workspace/path', createdBySessionId: id === sessionId ? 'caller' : undefined,
    }) as any);
    const status = vi.spyOn(svc as any, 'getSessionStatusRow').mockResolvedValue({ status: 'idle' });
    const data = vi.spyOn(svc as any, 'buildSessionResultData').mockResolvedValue(result);
    try {
      await (svc as any).handleChildSessionEvent(sessionId, 'session:completed');
      expect(aiService.queuePromptForSession).toHaveBeenCalledTimes(mode === 'automatic' ? 1 : 0);
      expect(aiService.triggerQueuedPromptProcessingForSession).toHaveBeenCalledTimes(mode === 'automatic' ? 1 : 0);
    } finally {
      status.mockRestore();
      data.mockRestore();
    }
  });

  it('keeps a manual child quiet after re-enabling Automatic and still offers a plan review', async () => {
    const { svc, aiService } = service();
    const result = { sessionId: 'child', pendingPrompt: { promptId: 'plan', promptType: 'exit_plan_mode_request' } };
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      id: 'child', workspacePath: '/workspace/path', createdBySessionId: 'caller', metadata: { childReportingMode: 'manual' },
    } as any);
    const data = vi.spyOn(svc as any, 'buildSessionResultData').mockResolvedValue(result);
    const plan = vi.spyOn(svc as any, 'ensurePlanTrackerItem').mockResolvedValue(undefined);
    try {
      await (svc as any).handleChildSessionEvent('child', 'session:waiting');
      expect(plan).toHaveBeenCalledWith('/workspace/path', 'child', result);
      expect(aiService.queuePromptForSession).not.toHaveBeenCalled();
      expect(aiService.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();
    } finally {
      data.mockRestore();
      plan.mockRestore();
    }
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
