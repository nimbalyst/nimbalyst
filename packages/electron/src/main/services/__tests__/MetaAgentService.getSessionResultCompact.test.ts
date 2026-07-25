import { describe, expect, it, vi } from 'vitest';

// FIX C: get_session_result gained an optional includeFullResponse param
// (default true, unchanged behavior). This guards the new wiring from the
// MCP tool schema down through getSessionResultJson to buildSessionResultData
// -- the truncation/compaction logic itself already existed and is covered
// by MetaAgentService.fullResponse.test.ts; this file only covers the new
// options threading.
//
// Mock surface mirrors MetaAgentService.fullResponse.test.ts.
vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
  AgentMessagesRepository: { list: vi.fn() },
  SessionFilesRepository: { getFilesBySession: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class { async initialize() {} },
}));
vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => ({ provider: id.split(':')[0], model: id.split(':')[1], combined: id }),
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
  database: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({
  setMetaAgentToolFns: vi.fn(),
}));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: (content: unknown) => (typeof content === 'string' ? content : ''),
  extractUserPrompts: () => ['original task'],
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AISessionsRepository, AgentMessagesRepository } from '@nimbalyst/runtime';
import { MetaAgentService } from '../MetaAgentService';

const SESSION_ROW = {
  id: 'child-1',
  title: 'Child: research',
  provider: 'claude-code',
  model: 'claude-code:sonnet',
  workspacePath: '/ws',
  worktreeId: null,
  metadata: null,
  createdAt: 1,
  updatedAt: 2,
};

describe('MetaAgentService.getSessionResultJson includeFullResponse (FIX C)', () => {
  it('includes fullResponse by default (no options passed -- unchanged behavior)', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(SESSION_ROW as never);
    const longReport = 'R'.repeat(2000);
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'output', content: longReport, metadata: null },
    ] as never);

    const service = MetaAgentService.getInstance();
    const json = await (service as any).getSessionResultJson('child-1', '/ws');
    const data = JSON.parse(json);

    expect(data.fullResponse).toBe(longReport);
  });

  it('omits fullResponse (null) when includeFullResponse is explicitly false', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(SESSION_ROW as never);
    const longReport = 'R'.repeat(2000);
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'output', content: longReport, metadata: null },
    ] as never);

    const service = MetaAgentService.getInstance();
    const json = await (service as any).getSessionResultJson('child-1', '/ws', {
      includeFullResponse: false,
    });
    const data = JSON.parse(json);

    expect(data.fullResponse).toBeNull();
    // Compact mode still returns everything else -- status/prompts/editedFiles,
    // just not the heavy full-turn text.
    expect(data.sessionId).toBe('child-1');
    expect(data.lastResponse).not.toBeNull();
  });

  it('includes fullResponse when includeFullResponse is explicitly true', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue(SESSION_ROW as never);
    const longReport = 'R'.repeat(2000);
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'output', content: longReport, metadata: null },
    ] as never);

    const service = MetaAgentService.getInstance();
    const json = await (service as any).getSessionResultJson('child-1', '/ws', {
      includeFullResponse: true,
    });
    const data = JSON.parse(json);

    expect(data.fullResponse).toBe(longReport);
  });
});
