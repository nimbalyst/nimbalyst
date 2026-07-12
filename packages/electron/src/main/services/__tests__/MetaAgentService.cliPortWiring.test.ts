import { beforeEach, describe, expect, it, vi } from 'vitest';

// NIM-828 (original): MetaAgentService.start() had to wire the standalone
// meta-agent MCP port into ClaudeCliLauncherConfig so claude-code-cli sessions
// got an --mcp-config including the meta-agent tools.
//
// MCP consolidation Phase 7: the standalone meta-agent server is retired — its
// tools fold onto the unified server's `/mcp/host` endpoint, which every
// provider (including the CLI launcher) already receives via the shared MCP
// config. So there is no longer a port to wire; the meaningful invariant is that
// `start()` still injects the tool fns that the unified server's
// `dispatchMetaAgentTool` calls.
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
  setMetaAgentToolFns: vi.fn(),
}));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));

import { setMetaAgentToolFns } from '../../mcp/metaAgentServer';
import { MetaAgentService } from '../MetaAgentService';

describe('MetaAgentService tool-fn injection (Phase 7: no standalone server)', () => {
  beforeEach(() => {
    vi.mocked(setMetaAgentToolFns).mockReset();
  });

  it('injects the meta-agent tool fns into the unified-server dispatch on start', async () => {
    const service = MetaAgentService.getInstance();

    await service.start({} as any);

    // The dispatch (dispatchMetaAgentTool) used by the unified `/mcp/host`
    // endpoint reads these injected fns.
    expect(setMetaAgentToolFns).toHaveBeenCalledTimes(1);
    const fns = vi.mocked(setMetaAgentToolFns).mock.calls[0][0];
    expect(typeof fns.createSession).toBe('function');
    expect(typeof fns.spawnSession).toBe('function');
    expect(typeof fns.listWorktrees).toBe('function');
    expect(typeof fns.compactSession).toBe('function');

    await service.shutdown();
  });
});
