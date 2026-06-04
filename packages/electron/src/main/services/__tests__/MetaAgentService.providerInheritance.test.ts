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

// resolveExtensionAgentRef is the "parent is a chat-only extension agent"
// detector the fix keys on. The real impl reads the AgentProviderRegistry
// singleton, which is empty in this hermetic unit test (no extension would be
// registered), so it would return null for 'antigravity-gemini-agent' and the
// redirect would never fire. Mock it to mark only the gemini provider as an
// extension agent; built-ins (claude-code, openai-codex) stay null.
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
// createChildSessionInternal runs an IN_FLIGHT_SPAWN_CAP COUNT(*) query and
// destructures { rows } from the result, so the worker mock must return a shape
// with rows (count '0' => under the cap, spawn proceeds).
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn().mockResolvedValue({ rows: [{ count: '0' }] }) },
}));
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
// NIM-828: MetaAgentService statically imports the CLI launcher singleton (to wire
// the meta-agent port); mock it so node-pty/electron-app don't enter the graph.
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AISessionsRepository } from '@nimbalyst/runtime';
import { database as databaseWorker } from '../../database/PGLiteDatabaseWorker';
import { MetaAgentService } from '../MetaAgentService';

const GEMINI_PARENT = {
  id: 'parent-gemini-session',
  provider: 'antigravity-gemini-agent',
  model: 'antigravity-gemini-agent:gemini-flash-3.5',
};

const CLAUDE_PARENT = {
  id: 'parent-claude-session',
  provider: 'claude-code',
  model: 'claude-code:opus',
};

const CODEX_PARENT = {
  id: 'parent-codex-session',
  provider: 'openai-codex',
  model: 'openai-codex:gpt-5.4',
};


describe('MetaAgentService child-spawn provider inheritance', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.get).mockReset();
  });

  it('defaults to a dev-capable provider (claude-code) when the parent is a chat-only extension agent and no provider is given', async () => {
    const service = MetaAgentService.getInstance();
    // The child-spawn path guards on this.aiService being present.
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(GEMINI_PARENT as any);

    // No explicit model/provider - the default delegated-child case. A gemini
    // (antigravity-gemini-agent) parent is chat-only, so inheriting it would
    // produce a child that cannot run commands or edit files. The fix redirects
    // the child to the dev-capable default instead.
    await (service as any).createChildSessionInternal('parent-gemini-session', '/workspace/path', {});

    expect(AISessionsRepository.create).toHaveBeenCalledTimes(1);

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('claude-code');
    expect(created.model).toMatch(/^claude-code:/);
    // The regression guard: the chat-only gemini parent must NOT be inherited.
    expect(created.provider).not.toBe('antigravity-gemini-agent');
    expect(created.model).not.toBe('antigravity-gemini-agent:gemini-flash-3.5');
  });

  it('honors an explicit args.provider so the model can deliberately spawn a gemini child', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    // Parent is dev-capable claude-code, but the caller explicitly asks for the
    // chat-only gemini provider. The explicit override must win.
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);

    await (service as any).createChildSessionInternal('parent-claude-session', '/workspace/path', {
      provider: 'antigravity-gemini-agent',
    });

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('antigravity-gemini-agent');
  });

  it('still inherits a dev-capable built-in parent (claude-code) when no provider is given', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);

    await (service as any).createChildSessionInternal('parent-claude-session', '/workspace/path', {});

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    // resolveExtensionAgentRef returns null for built-ins, so the redirect does
    // not fire and the child inherits the parent provider+model unchanged.
    expect(created.provider).toBe('claude-code');
    expect(created.model).toBe('claude-code:opus');
  });

  it('still inherits a dev-capable built-in parent (openai-codex) when no provider is given', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CODEX_PARENT as any);

    await (service as any).createChildSessionInternal('parent-codex-session', '/workspace/path', {});

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('openai-codex');
    expect(created.model).toBe('openai-codex:gpt-5.4');
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

  it('lets a claude-code parent launch an explicit openai-codex child without tripping the claude-code guard', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);

    // The "Implement in Codex" action: a claude-code originating session
    // launches a child with an explicit "openai-codex:gpt-5.5" model. The
    // model's own prefix must win over the parent's claude-code provider.
    await (service as any).createChildSessionInternal('parent-claude-session', '/workspace/path', {
      model: 'openai-codex:gpt-5.5',
    });

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('openai-codex');
    expect(created.model).toBe('openai-codex:gpt-5.5');
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

  it('forces claude-code when a chat-only parent inherits its own gemini MODEL via args.model (spawn_session inheritModel path)', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(GEMINI_PARENT as any);

    // Regression guard for the confirmed inherited-model path: spawn_session with
    // inheritModel passes the parent's gemini model verbatim as args.model. Under
    // the old code the pre-resolution redirect was skipped (model wins, tryParse
    // recovers the gemini provider), so the child stayed gemini - a chat-only
    // worker that cannot do work. The post-resolution force must override it.
    await (service as any).createChildSessionInternal('parent-gemini-session', '/workspace/path', {
      model: 'antigravity-gemini-agent:gemini-flash-3.5',
    });

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('claude-code');
    expect(created.model).toMatch(/^claude-code:/);
    expect(created.provider).not.toBe('antigravity-gemini-agent');
    expect(created.model).not.toBe('antigravity-gemini-agent:gemini-flash-3.5');
  });

  it('forces claude-code when a chat-only parent explicitly copies its own gemini provider into args.provider', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(GEMINI_PARENT as any);

    // Regression guard for the explicit-copy path: a weak parent model copies its
    // own chat-only provider into args.provider. The old !args.provider gate on
    // the pre-resolution redirect let this through. Because the PARENT is itself a
    // non-dev extension agent, the post-resolution force overrides the resolved
    // chat-only provider to claude-code. (Contrast with the CLAUDE-parent case
    // below, where the same explicit gemini provider IS honored.)
    await (service as any).createChildSessionInternal('parent-gemini-session', '/workspace/path', {
      provider: 'antigravity-gemini-agent',
    });

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('claude-code');
    expect(created.model).toMatch(/^claude-code:/);
    expect(created.provider).not.toBe('antigravity-gemini-agent');
  });
});

describe('MetaAgentService total spawn cap', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.get).mockReset();
    // Reset the shared worker-query mock back to the under-cap default so other
    // tests in this file are unaffected by the over-cap override below.
    vi.mocked(databaseWorker.query).mockResolvedValue({ rows: [{ count: '0' }] } as any);
  });

  it('throws past the total spawn cap (children counted regardless of status)', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);
    // 15 total children already spawned by this parent (>= TOTAL_SPAWN_CAP). The
    // count includes settled children now, so sequential re-spawning from
    // completion-wakeups is bounded where the old in-flight-only count was not.
    vi.mocked(databaseWorker.query).mockResolvedValue({ rows: [{ count: '15' }] } as any);

    await expect(
      (service as any).createChildSessionInternal('parent-claude-session', '/workspace/path', {})
    ).rejects.toThrow(/spawn cap reached/);

    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });
});
