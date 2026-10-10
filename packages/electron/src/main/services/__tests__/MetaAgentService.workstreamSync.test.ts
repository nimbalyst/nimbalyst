// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    create: vi.fn(),
    updateMetadata: vi.fn(),
    get: vi.fn(),
  },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: {},
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
    parse: (id: string) => ({ provider: id.split(':')[0], model: id.split(':')[1] }),
    tryParse: (id: string) => ({ provider: id.split(':')[0], model: id.split(':')[1] }),
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

const mockPushChange = vi.fn();
vi.mock('../SyncManager', () => ({
  getSyncProvider: () => ({ pushChange: mockPushChange }),
}));

vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn().mockResolvedValue({ rows: [{ in_flight: '0', total: '0' }] }) } }));
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
// NIM-828: MetaAgentService statically imports the CLI launcher singleton (to wire
// the meta-agent port); mock it so node-pty/electron-app don't enter the graph.
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { MetaAgentService } from '../MetaAgentService';

describe('MetaAgentService tree spawn placement', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.updateMetadata).mockReset();
    vi.mocked(AISessionsRepository.get).mockReset();
    mockPushChange.mockReset();
  });

  it.each([
    { id: 'standalone', parentSessionId: null, worktreeId: null },
    { id: 'nested', parentSessionId: 'outer', worktreeId: null },
    { id: 'worktree-node', parentSessionId: 'outer', worktreeId: 'wt' },
  ])('create_session from $id uses the caller as parent and keeps its container', async parent => {
    const service = MetaAgentService.getInstance();
    (service as any).aiService = { queuePromptForSession: vi.fn() };
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ ...parent, workspacePath: '/workspace/path', provider: 'claude-code', model: 'claude-code:opus' } as any);
    await (service as any).createChildSession(parent.id, '/workspace/path', {});
    expect(AISessionsRepository.create).toHaveBeenCalledTimes(1);
    expect(AISessionsRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: parent.id, createdBySessionId: parent.id, worktreeId: parent.worktreeId ?? undefined,
    }));
    expect(AISessionsRepository.updateMetadata).not.toHaveBeenCalled();
    expect(mockPushChange).not.toHaveBeenCalled();
  });
});
