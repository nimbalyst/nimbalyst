import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    create: vi.fn(),
    updateMetadata: vi.fn(),
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
// NIM-828: MetaAgentService statically imports the CLI launcher singleton (to wire
// the meta-agent port); mock it so node-pty/electron-app don't enter the graph.
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AISessionsRepository } from '@nimbalyst/runtime';
import { MetaAgentService } from '../MetaAgentService';

describe('MetaAgentService.resolveOrCreateWorkstream', () => {
  beforeEach(() => {
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.updateMetadata).mockReset();
    mockPushChange.mockReset();
  });

  // After the Option B refactor, MetaAgentService no longer pushes to sync
  // directly. AISessionsRepository.create() and updateMetadata() flow through
  // SyncedSessionStore, which is the single push path. These tests therefore
  // assert on the repository calls -- the SyncedSessionStore unit tests cover
  // that those calls reach the wire.

  it('promotes a standalone session: creates a workstream container and reparents the child', async () => {
    const service = MetaAgentService.getInstance();
    const parent = {
      id: 'parent-session-id',
      title: 'My session',
      provider: 'claude-code',
      model: 'claude-code:opus',
      sessionType: 'session',
      parentSessionId: null,
      worktreeId: null,
    };

    const result = await (service as any).resolveOrCreateWorkstream(parent, '/workspace/path');

    expect(result.promotedParent).toBe(true);
    expect(result.workstreamId).toBeTruthy();

    // The workstream container is created with sessionType='workstream' --
    // SyncedSessionStore.create() picks that up via SYNC_RELEVANT_FIELDS and
    // forwards it on the metadata_updated push.
    expect(AISessionsRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      id: result.workstreamId,
      provider: 'claude-code',
      sessionType: 'workstream',
      title: 'My session',
      workspaceId: '/workspace/path',
    }));

    // The child gets reparented under the new workstream. updateMetadata
    // routes the parentSessionId change through SyncedSessionStore.
    expect(AISessionsRepository.updateMetadata).toHaveBeenCalledWith(
      'parent-session-id',
      expect.objectContaining({ parentSessionId: result.workstreamId }),
    );

    // No direct sync push from MetaAgentService anymore.
    expect(mockPushChange).not.toHaveBeenCalled();
  });

  it('does nothing when the parent is in a worktree (workstream creation is skipped)', async () => {
    const service = MetaAgentService.getInstance();
    const parent = {
      id: 'worktree-resident-session',
      title: 'In a worktree',
      provider: 'claude-code',
      worktreeId: 'some-worktree-id',
    };

    const result = await (service as any).resolveOrCreateWorkstream(parent, '/workspace/path');

    expect(result).toEqual({ workstreamId: null, promotedParent: false });
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(mockPushChange).not.toHaveBeenCalled();
  });

  it('does nothing when the parent is already in a workstream', async () => {
    const service = MetaAgentService.getInstance();
    const parent = {
      id: 'child-in-existing-workstream',
      title: 'Already nested',
      provider: 'claude-code',
      parentSessionId: 'existing-workstream-id',
    };

    const result = await (service as any).resolveOrCreateWorkstream(parent, '/workspace/path');

    expect(result.workstreamId).toBe('existing-workstream-id');
    expect(result.promotedParent).toBe(false);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
    expect(mockPushChange).not.toHaveBeenCalled();
  });
});
