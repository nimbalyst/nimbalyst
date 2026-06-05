import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mirrors the mock surface of MetaAgentService.workstreamSync.test.ts, with two
// additions needed to exercise the child-spawn path:
//   1. AISessionsRepository.get  - the parent-session lookup the fix relies on.
//   2. A working ModelIdentifier.tryParse / getDefaultModelId (the sibling test
//      stubs ModelIdentifier as {}, which throws once tryParse is reached).
vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    create: vi.fn(),
    updateMetadata: vi.fn(),
    get: vi.fn(),
  },
  AgentMessagesRepository: {},
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
      const provider = id.slice(0, i);
      const model = id.slice(i + 1);
      if (provider === 'claude-code') {
        if (model === 'opus-4-8') return { provider, model: 'opus', combined: 'claude-code:opus' };
        if (model === 'opus-4-8-1m') return { provider, model: 'opus-1m', combined: 'claude-code:opus-1m' };
        if (model === 'unknown') throw new Error(`Unsupported Claude Agent model "${id}"`);
      }
      return { provider, model, combined: `${provider}:${model}` };
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

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

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
vi.mock('../../mcp/metaAgentServer', () => ({
  startMetaAgentServer: vi.fn(),
  setMetaAgentToolFns: vi.fn(),
  shutdownMetaAgentServer: vi.fn(),
}));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));

import { AISessionsRepository } from '@nimbalyst/runtime';
import { MetaAgentService } from '../MetaAgentService';

const GEMINI_PARENT = {
  id: 'parent-gemini-session',
  provider: 'antigravity-gemini-agent',
  model: 'antigravity-gemini-agent:gemini-flash-3.5',
};

describe('MetaAgentService child-spawn provider inheritance', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.get).mockReset();
  });

  it('inherits a non-Claude parent provider+model when the spawn omits an explicit model (no silent claude-code:opus fallback)', async () => {
    const service = MetaAgentService.getInstance();
    // The child-spawn path guards on this.aiService being present.
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(GEMINI_PARENT as any);

    // No explicit model/provider - the case the model hits when it leaves the
    // optional `model` arg off. getDefaultAIModel() is mocked to null, so the
    // pre-fix code would resolve to the hardcoded 'claude-code:opus'.
    await (service as any).createChildSessionInternal('parent-gemini-session', '/workspace/path', {});

    expect(AISessionsRepository.create).toHaveBeenCalledTimes(1);

    // Behavior is the contract: the child carries the parent's provider+model.
    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('antigravity-gemini-agent');
    expect(created.model).toBe('antigravity-gemini-agent:gemini-flash-3.5');
    // The regression guard: a Gemini parent must never spawn a Claude/Opus child.
    expect(created.provider).not.toBe('claude-code');
    expect(created.model).not.toBe('claude-code:opus');
  });

  it('still lets an explicit model arg win over the inherited parent', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(GEMINI_PARENT as any);

    await (service as any).createChildSessionInternal('parent-gemini-session', '/workspace/path', {
      model: 'openai-codex:gpt-5.4',
    });

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('openai-codex');
    expect(created.model).toBe('openai-codex:gpt-5.4');
  });

  it('normalizes explicit claude-code opus-4-8 aliases before persisting the child session', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(GEMINI_PARENT as any);

    await (service as any).createChildSessionInternal('parent-gemini-session', '/workspace/path', {
      model: 'claude-code:opus-4-8-1m',
    });

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('claude-code');
    expect(created.model).toBe('claude-code:opus-1m');
  });

  it('rejects unsupported explicit claude-code variants instead of silently falling back', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(GEMINI_PARENT as any);

    await expect(
      (service as any).createChildSessionInternal('parent-gemini-session', '/workspace/path', {
        model: 'claude-code:unknown',
      })
    ).rejects.toThrow('Unsupported Claude Agent model');
  });

  it('falls back to the hardcoded default for a genuine orphan call (no parent session found)', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(null as any);

    await (service as any).createChildSessionInternal('orphan-session', '/workspace/path', {});

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    // With no parent and getDefaultAIModel() null, the child falls back to the
    // claude-code provider's default (stored as normalizedModel via
    // ModelIdentifier.getDefaultModelId('claude-code')). The invariant that
    // matters: an orphan call still resolves to claude-code, unchanged by the fix.
    expect(created.provider).toBe('claude-code');
    expect(created.model).toMatch(/^claude-code:/);
  });
});
