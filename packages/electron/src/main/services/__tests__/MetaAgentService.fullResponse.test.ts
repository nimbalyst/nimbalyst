import { describe, expect, it, vi } from 'vitest';

// FIX A regression guard: get_session_result (via buildSessionResultData) must
// hand the meta-agent the child's FULL final response, not a 500-char stub. The
// 500-char truncation was the root cause of thin meta-agent synthesis: the model
// was summarizing from a decapitated preview. lastResponse stays the short
// notification preview; fullResponse carries the real content.
//
// Mock surface mirrors MetaAgentService.providerInheritance.test.ts (enough to
// import MetaAgentService without pulling electron-app / node-pty into the graph),
// plus AgentMessagesRepository.list and a real extractMessageText so the result
// builder sees actual message text.
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
  startMetaAgentServer: vi.fn(),
  setMetaAgentToolFns: vi.fn(),
  shutdownMetaAgentServer: vi.fn(),
}));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: (content: unknown) => (typeof content === 'string' ? content : ''),
  extractUserPrompts: () => ['original task'],
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AgentMessagesRepository } from '@nimbalyst/runtime';
import { MetaAgentService } from '../MetaAgentService';

const PREFETCHED = {
  title: 'Child: research',
  provider: 'antigravity-gemini-agent',
  model: 'antigravity-gemini-agent:gemini-3-flash-agent',
  status: 'idle',
  lastActivity: 1,
  createdAt: 1,
  updatedAt: 2,
  worktreeId: null,
};

describe('MetaAgentService buildSessionResultData full child response (FIX A)', () => {
  it('returns the full final response in fullResponse while lastResponse stays a 500-char preview', async () => {
    // A long, substantive child report (the kind the meta-agent must synthesize).
    const longReport = 'R'.repeat(2000);
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'input', content: 'do the research', metadata: null },
      { direction: 'output', content: longReport, metadata: null },
    ] as never);

    const service = MetaAgentService.getInstance();
    const data = await (service as any).buildSessionResultData('child-1', '/ws', PREFETCHED);

    // lastResponse: the short notification preview - truncated at 500 + ellipsis.
    expect(data.lastResponse).not.toBeNull();
    expect(data.lastResponse.length).toBe(503);
    expect(data.lastResponse.endsWith('...')).toBe(true);

    // fullResponse: the meta-agent's real material - the complete 2000 chars,
    // NOT truncated, NOT ending in an ellipsis.
    expect(data.fullResponse).toBe(longReport);
    expect(data.fullResponse.length).toBe(2000);
    expect(data.fullResponse.endsWith('...')).toBe(false);
  });

  it('does not truncate a response already under the preview cap (full == preview)', async () => {
    const shortReport = 'concise finding at file.ts:42';
    vi.mocked(AgentMessagesRepository.list).mockResolvedValue([
      { direction: 'output', content: shortReport, metadata: null },
    ] as never);

    const service = MetaAgentService.getInstance();
    const data = await (service as any).buildSessionResultData('child-2', '/ws', PREFETCHED);

    expect(data.lastResponse).toBe(shortReport);
    expect(data.fullResponse).toBe(shortReport);
  });
});
