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
  AgentMessagesRepository: {
    create: vi.fn(),
  },
  SessionFilesRepository: {},
}));

vi.mock('@nimbalyst/runtime/ai/server', () => {
  const backends = [
    {
      id: 'ollama-glm-5-2-cloud',
      persistedModel: 'claude-code:ollama-glm-5-2-cloud',
      provider: 'ollama',
      model: 'glm-5.2:cloud',
      upstreamModel: 'openai/glm-5.2:cloud',
      upstreamBaseUrl: 'https://ollama.com/v1',
      baseUrl: 'http://127.0.0.1:4002',
      claudeModelAlias: 'claude-sonnet-4-5-20250929',
    },
    {
      id: 'ollama-qwen3-5-cloud',
      persistedModel: 'claude-code:ollama-qwen3-5-cloud',
      provider: 'ollama',
      model: 'qwen3.5:cloud',
      upstreamModel: 'openai/qwen3.5:cloud',
      upstreamBaseUrl: 'https://ollama.com/v1',
      baseUrl: 'http://127.0.0.1:4002',
      claudeModelAlias: 'claude-ollama-qwen3-5',
    },
  ];
  const resolveBackend = (id?: string | null) => {
    if (!id) return undefined;
    const backend = backends.find((candidate) => candidate.id === id);
    if (!backend) {
      throw new Error(`Unsupported Claude Code backend profile: ${id}`);
    }
    return backend;
  };
  const resolveBackendForConfig = (config: {
    model?: string;
    claudeCodeBackend?: string;
  }) => {
    const fromModel = backends.find(
      (candidate) => candidate.persistedModel === config.model
    );
    if (config.model?.startsWith('claude-code:ollama-') && !fromModel) {
      throw new Error(`Unsupported Claude Code Ollama model identity: ${config.model}`);
    }
    const configured = resolveBackend(config.claudeCodeBackend);
    if (configured && config.model !== configured.persistedModel) {
      throw new Error(
        `Claude Code backend ${configured.id} requires exact persisted model ${configured.persistedModel}`
      );
    }
    return fromModel ?? configured;
  };
  return {
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  resolveClaudeCodeBackend: resolveBackend,
  resolveClaudeCodeBackendForConfig: resolveBackendForConfig,
  SessionManager: class {
    async initialize() {}
  },
  };
});

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
vi.mock('../../utils/store', () => ({
  getDefaultAIModel: () => null,
  getDefaultEffortLevel: () => 'high',
}));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
// createChildSessionInternal runs a spawn-gate query that selects { in_flight,
// total }, so the worker mock must return a shape with rows (both '0' => under
// both the in-flight cap and the lifetime backstop, spawn proceeds).
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn().mockResolvedValue({ rows: [{ in_flight: '0', total: '0' }] }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../ai/OllamaClaudeCodePreflight', () => ({
  preflightOllamaClaudeCodeBackend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../mcp/metaAgentServer', () => ({
  setMetaAgentToolFns: vi.fn(),
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
import { preflightOllamaClaudeCodeBackend } from '../ai/OllamaClaudeCodePreflight';

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

const OLLAMA_PARENT = {
  id: 'parent-ollama-session',
  provider: 'claude-code',
  model: 'claude-code:ollama-glm-5-2-cloud',
};

const OLLAMA_QWEN_PARENT = {
  id: 'parent-ollama-qwen-session',
  provider: 'claude-code',
  model: 'claude-code:ollama-qwen3-5-cloud',
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
    vi.mocked(AISessionsRepository.updateMetadata).mockReset();
    vi.mocked(preflightOllamaClaudeCodeBackend).mockReset();
    vi.mocked(preflightOllamaClaudeCodeBackend).mockResolvedValue(undefined);
    vi.mocked(databaseWorker.query).mockClear();
  });

  it('inherits the gemini parent provider+model when the parent is a chat-only extension agent and no provider is given', async () => {
    const service = MetaAgentService.getInstance();
    // The child-spawn path guards on this.aiService being present.
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(GEMINI_PARENT as any);

    // No explicit model/provider - the default delegated-child case. A gemini
    // (antigravity-gemini-agent) meta-agent parent spawns a gemini child by
    // default, the same way a claude-code parent spawns claude-code children and
    // an openai-codex parent spawns openai-codex children. The child inherits the
    // parent provider+model verbatim.
    await (service as any).createChildSessionInternal('parent-gemini-session', '/workspace/path', {});

    expect(AISessionsRepository.create).toHaveBeenCalledTimes(1);

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('antigravity-gemini-agent');
    expect(created.model).toBe('antigravity-gemini-agent:gemini-flash-3.5');
    // The regression guard: the gemini parent must NOT be silently redirected to
    // claude-code anymore.
    expect(created.provider).not.toBe('claude-code');
  });

  it('honors an explicit args.provider so the model can deliberately spawn a gemini child from a claude-code parent', async () => {
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

  it('persists the exact Ollama backend on a real claude-code child session', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);

    const result = await (service as any).createChildSessionInternal(
      'parent-claude-session',
      '/workspace/path',
      { claudeCodeBackend: 'ollama-glm-5-2-cloud' }
    );

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('claude-code');
    expect(created.model).toBe('claude-code:ollama-glm-5-2-cloud');
    expect(preflightOllamaClaudeCodeBackend).toHaveBeenCalledTimes(1);
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    expect(result.claudeCodeBackend).toEqual({
      id: 'ollama-glm-5-2-cloud',
      persistedModel: 'claude-code:ollama-glm-5-2-cloud',
      transportProfile: 'litellm',
      provider: 'ollama',
      model: 'glm-5.2:cloud',
      upstreamModel: 'openai/glm-5.2:cloud',
      downstreamAlias: 'claude-sonnet-4-5-20250929',
      baseUrl: 'http://127.0.0.1:4002',
    });
  });

  it('derives and persists the backend from the canonical model without a backend argument', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);

    const result = await (service as any).createChildSessionInternal(
      'parent-claude-session',
      '/workspace/path',
      { model: 'claude-code:ollama-glm-5-2-cloud' }
    );

    expect(preflightOllamaClaudeCodeBackend).toHaveBeenCalledTimes(1);
    expect(AISessionsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude-code',
        model: 'claude-code:ollama-glm-5-2-cloud',
      })
    );
    expect(result.claudeCodeBackend).toMatchObject({
      id: 'ollama-glm-5-2-cloud',
      persistedModel: 'claude-code:ollama-glm-5-2-cloud',
    });
  });

  it('derives the backend from an inherited canonical parent before session or queue mutation', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = {
      queuePromptForSession: vi.fn(),
      triggerQueuedPromptProcessingForSession: vi.fn(),
    };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(OLLAMA_PARENT as any);
    vi.mocked(preflightOllamaClaudeCodeBackend).mockRejectedValue(
      new Error('inherited route is unhealthy')
    );

    await expect(
      (service as any).createChildSessionInternal(
        'parent-ollama-session',
        '/workspace/path',
        { prompt: 'Must remain unqueued.' }
      )
    ).rejects.toThrow('inherited route is unhealthy');

    expect(AISessionsRepository.get).toHaveBeenCalledWith('parent-ollama-session');
    expect(preflightOllamaClaudeCodeBackend).toHaveBeenCalledTimes(1);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect((service as any).aiService.queuePromptForSession).not.toHaveBeenCalled();
    expect(
      (service as any).aiService.triggerQueuedPromptProcessingForSession
    ).not.toHaveBeenCalled();
  });

  it('rejects backend/provider mismatches before creating a session', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);

    await expect(
      (service as any).createChildSessionInternal(
        'parent-claude-session',
        '/workspace/path',
        {
          provider: 'openai-codex',
          model: 'openai-codex:gpt-5.4',
          claudeCodeBackend: 'ollama-glm-5-2-cloud',
        }
      )
    ).rejects.toThrow('require');

    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('rejects unknown backend ids instead of silently creating an Anthropic session', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);

    await expect(
      (service as any).createChildSessionInternal(
        'parent-claude-session',
        '/workspace/path',
        { claudeCodeBackend: 'ollama-unknown' }
      )
    ).rejects.toThrow('Unsupported Claude Code backend profile');

    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('carries the exact backend through spawn_session into the persisted session', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      ...CLAUDE_PARENT,
      workspacePath: '/workspace/path',
    } as any);

    const rawResult = await (service as any).spawnSession(
      'parent-claude-session',
      '/workspace/path',
      {
        prompt: 'Inspect one file with a native child agent.',
        isolated: true,
        claudeCodeBackend: 'ollama-glm-5-2-cloud',
      }
    );

    const result = JSON.parse(rawResult);
    expect(result.provider).toBe('claude-code');
    expect(result.claudeCodeBackend).toMatchObject({
      id: 'ollama-glm-5-2-cloud',
      provider: 'ollama',
      model: 'glm-5.2:cloud',
    });
    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.model).toBe('claude-code:ollama-glm-5-2-cloud');
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        metadata: expect.objectContaining({
          claudeCodeBackend: expect.anything(),
        }),
      })
    );
  });

  it('routes a model-only spawn_session through the canonical backend', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      ...CLAUDE_PARENT,
      workspacePath: '/workspace/path',
    } as any);

    const rawResult = await (service as any).spawnSession(
      'parent-claude-session',
      '/workspace/path',
      {
        prompt: 'Inspect the route.',
        isolated: true,
        model: 'claude-code:ollama-glm-5-2-cloud',
      }
    );

    const result = JSON.parse(rawResult);
    expect(preflightOllamaClaudeCodeBackend).toHaveBeenCalledTimes(1);
    expect(result.claudeCodeBackend).toMatchObject({
      id: 'ollama-glm-5-2-cloud',
      persistedModel: 'claude-code:ollama-glm-5-2-cloud',
    });
    expect(AISessionsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude-code',
        model: 'claude-code:ollama-glm-5-2-cloud',
      })
    );
  });

  it('does not create a worktree, session, or queue row when preflight fails', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = {
      queuePromptForSession: vi.fn(),
      triggerQueuedPromptProcessingForSession: vi.fn(),
    };
    vi.mocked(preflightOllamaClaudeCodeBackend).mockRejectedValue(
      new Error('wrong LiteLLM mapping')
    );

    await expect(
      (service as any).createChildSessionInternal(
        'parent-claude-session',
        '/workspace/path',
        {
          prompt: 'This must never be queued.',
          useWorktree: true,
          claudeCodeBackend: 'ollama-glm-5-2-cloud',
        }
      )
    ).rejects.toThrow('wrong LiteLLM mapping');

    expect(AISessionsRepository.get).toHaveBeenCalledWith('parent-claude-session');
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect((service as any).aiService.queuePromptForSession).not.toHaveBeenCalled();
  });

  it('rejects spawn_session after read-only parent resolution but before workstream mutation when preflight fails', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = {
      queuePromptForSession: vi.fn(),
      triggerQueuedPromptProcessingForSession: vi.fn(),
    };
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      ...CLAUDE_PARENT,
      workspacePath: '/workspace/path',
    } as any);
    vi.mocked(preflightOllamaClaudeCodeBackend).mockRejectedValue(
      new Error('proxy profile mismatch')
    );
    const workstreamSpy = vi.spyOn(service as any, 'resolveOrCreateWorkstream');

    try {
      await expect(
        (service as any).spawnSession(
          'parent-claude-session',
          '/workspace/path',
          {
            prompt: 'This must not create a workstream.',
            claudeCodeBackend: 'ollama-glm-5-2-cloud',
          }
        )
      ).rejects.toThrow('proxy profile mismatch');

      expect(AISessionsRepository.get).toHaveBeenCalledWith('parent-claude-session');
      expect(workstreamSpy).not.toHaveBeenCalled();
      expect(AISessionsRepository.create).not.toHaveBeenCalled();
      expect((service as any).aiService.queuePromptForSession).not.toHaveBeenCalled();
    } finally {
      workstreamSpy.mockRestore();
    }
  });

  it('preflights an inherited canonical spawn route before workstream mutation', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = {
      queuePromptForSession: vi.fn(),
      triggerQueuedPromptProcessingForSession: vi.fn(),
    };
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      ...OLLAMA_PARENT,
      workspacePath: '/workspace/path',
    } as any);
    vi.mocked(preflightOllamaClaudeCodeBackend).mockRejectedValue(
      new Error('targeted upstream unhealthy')
    );
    const workstreamSpy = vi.spyOn(service as any, 'resolveOrCreateWorkstream');

    try {
      await expect(
        (service as any).spawnSession(
          'parent-ollama-session',
          '/workspace/path',
          {
            prompt: 'Must not mutate workstream state.',
            inheritModel: true,
          }
        )
      ).rejects.toThrow('targeted upstream unhealthy');

      expect(AISessionsRepository.get).toHaveBeenCalledWith('parent-ollama-session');
      expect(preflightOllamaClaudeCodeBackend).toHaveBeenCalledTimes(1);
      expect(workstreamSpy).not.toHaveBeenCalled();
      expect(AISessionsRepository.create).not.toHaveBeenCalled();
      expect((service as any).aiService.queuePromptForSession).not.toHaveBeenCalled();
    } finally {
      workstreamSpy.mockRestore();
    }
  });

  it('preflights an omitted-model Ollama parent before every mutation even when inheritModel is false', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = {
      queuePromptForSession: vi.fn(),
      triggerQueuedPromptProcessingForSession: vi.fn(),
    };
    vi.mocked(AISessionsRepository.get).mockResolvedValue({
      ...OLLAMA_QWEN_PARENT,
      workspacePath: '/workspace/path',
      worktreeId: 'existing-parent-worktree',
    } as any);
    vi.mocked(preflightOllamaClaudeCodeBackend).mockRejectedValue(
      new Error('default inherited Ollama route is unhealthy')
    );
    const workstreamSpy = vi.spyOn(service as any, 'resolveOrCreateWorkstream');

    try {
      await expect(
        (service as any).spawnSession(
          'parent-ollama-qwen-session',
          '/workspace/path',
          {
            prompt: 'Must fail before workstream, reparent, worktree, session, or queue writes.',
            inheritModel: false,
            useWorktree: true,
          }
        )
      ).rejects.toThrow('default inherited Ollama route is unhealthy');

      expect(AISessionsRepository.get).toHaveBeenCalledWith('parent-ollama-qwen-session');
      expect(preflightOllamaClaudeCodeBackend).toHaveBeenCalledTimes(1);
      expect(preflightOllamaClaudeCodeBackend).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ollama-qwen3-5-cloud',
          persistedModel: 'claude-code:ollama-qwen3-5-cloud',
        })
      );
      expect(workstreamSpy).not.toHaveBeenCalled();
      expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
      expect(databaseWorker.query).not.toHaveBeenCalled();
      expect(AISessionsRepository.create).not.toHaveBeenCalled();
      expect((service as any).aiService.queuePromptForSession).not.toHaveBeenCalled();
      expect(
        (service as any).aiService.triggerQueuedPromptProcessingForSession
      ).not.toHaveBeenCalled();
    } finally {
      workstreamSpy.mockRestore();
    }
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

  it('inherits the gemini MODEL via args.model from a gemini parent (spawn_session inheritModel path)', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(GEMINI_PARENT as any);

    // spawn_session with inheritModel passes the parent's gemini model verbatim as
    // args.model. The child keeps that model and tryParse recovers the gemini
    // provider, so the child stays gemini - the desired same-provider inheritance.
    await (service as any).createChildSessionInternal('parent-gemini-session', '/workspace/path', {
      model: 'antigravity-gemini-agent:gemini-flash-3.5',
    });

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('antigravity-gemini-agent');
    expect(created.model).toBe('antigravity-gemini-agent:gemini-flash-3.5');
    expect(created.provider).not.toBe('claude-code');
  });

  it('honors an explicit gemini provider on a gemini parent (explicit-copy path is no longer forced to claude-code)', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(GEMINI_PARENT as any);

    // A gemini parent that copies its own provider into args.provider must be
    // honored as gemini - the same-provider default. The old post-resolution force
    // wrongly rewrote this to claude-code; that override is reverted.
    await (service as any).createChildSessionInternal('parent-gemini-session', '/workspace/path', {
      provider: 'antigravity-gemini-agent',
    });

    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('antigravity-gemini-agent');
    expect(created.provider).not.toBe('claude-code');
  });
});

describe('MetaAgentService spawn gates', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.get).mockReset();
    // Reset the shared worker-query mock back to the under-cap default so other
    // tests in this file are unaffected by the over-cap overrides below.
    vi.mocked(databaseWorker.query).mockResolvedValue({ rows: [{ in_flight: '0', total: '0' }] } as any);
  });

  it('throws when the in-flight parallel cap is reached (controllable max-parallel limit)', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);
    // 4 children currently running/waiting (>= MAX_IN_FLIGHT). total is well
    // under the lifetime backstop, proving this gate fires on parallelism alone.
    vi.mocked(databaseWorker.query).mockResolvedValue({ rows: [{ in_flight: '4', total: '4' }] } as any);

    await expect(
      (service as any).createChildSessionInternal('parent-claude-session', '/workspace/path', {})
    ).rejects.toThrow(/Too many child sessions running/);

    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('allows spawning past a low total when nothing is in flight (no lifetime cap on settled children)', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);
    // 10 children spawned over this parent's life, but all settled (0 in flight)
    // and under the lifetime backstop. The old behavior wrongly blocked this.
    vi.mocked(databaseWorker.query).mockResolvedValue({ rows: [{ in_flight: '0', total: '10' }] } as any);

    await (service as any).createChildSessionInternal('parent-claude-session', '/workspace/path', {});

    expect(AISessionsRepository.create).toHaveBeenCalledTimes(1);
  });

  it('throws past the lifetime backstop (runaway protection on total children ever spawned)', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(CLAUDE_PARENT as any);
    // 50 total children (>= LIFETIME_BACKSTOP), 0 in flight. The backstop still
    // bounds a sequential re-spawn loop where the in-flight count stays ~0.
    vi.mocked(databaseWorker.query).mockResolvedValue({ rows: [{ in_flight: '0', total: '50' }] } as any);

    await expect(
      (service as any).createChildSessionInternal('parent-claude-session', '/workspace/path', {})
    ).rejects.toThrow(/lifetime spawn backstop reached/);

    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('never pairs an explicit claude-code provider with the inherited gemini model (consistency guard)', async () => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue(GEMINI_PARENT as any);
    // A Gemini meta-agent explicitly picks claude-code but passes NO model.
    // The child must NOT be persisted as claude-code + the inherited gemini
    // model (which routes to Claude Code, is rejected, and dies with no output).
    await (service as any).createChildSessionInternal('parent-gemini-session', '/workspace/path', { provider: 'claude-code' });
    const created = vi.mocked(AISessionsRepository.create).mock.calls[0][0] as any;
    expect(created.provider).toBe('claude-code');
    expect(String(created.model)).not.toContain('antigravity-gemini-agent');
    expect(String(created.model).startsWith('claude-code:')).toBe(true);
  });
});
