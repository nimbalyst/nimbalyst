import { beforeEach, describe, expect, it, vi } from 'vitest';

// NIM-828: MetaAgentService.start() wired the meta-agent MCP port into the SDK
// providers but never into ClaudeCliLauncherConfig, so claude-code-cli sessions
// were launched with an --mcp-config missing nimbalyst-meta-agent (spawn_session
// et al unavailable). Mock surface mirrors MetaAgentService.providerInheritance.test.ts.
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
  ModelIdentifier: {},
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn(() => () => {}) }),
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
  startMetaAgentServer: vi.fn(async () => ({ port: 45678 })),
  setMetaAgentToolFns: vi.fn(),
  shutdownMetaAgentServer: vi.fn(async () => {}),
}));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { ClaudeCliLauncherConfig } from '../ai/claudeCliLauncherSingleton';
import { MetaAgentService } from '../MetaAgentService';

describe('MetaAgentService CLI launcher port wiring (NIM-828)', () => {
  beforeEach(() => {
    vi.mocked(ClaudeCliLauncherConfig.setMetaAgentServerPort).mockReset();
  });

  it('injects the meta-agent server port into ClaudeCliLauncherConfig on start and clears it on shutdown', async () => {
    const service = MetaAgentService.getInstance();

    await service.start({} as any);
    expect(ClaudeCliLauncherConfig.setMetaAgentServerPort).toHaveBeenCalledWith(45678);

    await service.shutdown();
    expect(ClaudeCliLauncherConfig.setMetaAgentServerPort).toHaveBeenLastCalledWith(null);
  });
});
