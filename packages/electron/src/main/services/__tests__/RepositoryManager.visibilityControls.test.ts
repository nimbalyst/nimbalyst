import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setSessionStore: vi.fn(), clearSessionStore: vi.fn(),
  setAgentStore: vi.fn(), clearAgentStore: vi.fn(),
  clearSessionFileStore: vi.fn(), clearTranscript: vi.fn(),
  reinitializeSync: vi.fn(), shutdownSync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: { setStore: mocks.setSessionStore, clearStore: mocks.clearSessionStore },
  SessionFilesRepository: { setStore: vi.fn(), clearStore: mocks.clearSessionFileStore },
  AgentMessagesRepository: { setStore: mocks.setAgentStore, clearStore: mocks.clearAgentStore },
  TranscriptMigrationRepository: { setService: vi.fn(), clearService: mocks.clearTranscript },
}));
vi.mock('../SyncManager', () => ({
  initializeSync: vi.fn(), reinitializeSync: mocks.reinitializeSync,
  shutdownSync: mocks.shutdownSync, isSyncEnabled: () => false,
}));
vi.mock('../TrackerSyncManager', () => ({
  shutdownTrackerSync: vi.fn(), initializeTrackerSync: vi.fn(),
}));
vi.mock('../../window/WindowManager', () => ({ windows: new Map(), windowStates: new Map() }));
vi.mock('../SyncedAgentMessagesStore', () => ({ createSyncedAgentMessagesStore: vi.fn() }));
vi.mock('../PGLiteSessionStore', () => ({ createPGLiteSessionStore: vi.fn() }));
vi.mock('../PGLiteSessionFileStore', () => ({ createPGLiteSessionFileStore: vi.fn() }));
vi.mock('../PGLiteAgentMessagesStore', () => ({ createPGLiteAgentMessagesStore: vi.fn() }));
vi.mock('../PGLiteWorkspaceRepository', () => ({ createPGLiteWorkspaceRepository: vi.fn() }));
vi.mock('../PGLiteDocumentsRepository', () => ({ createPGLiteDocumentsRepository: vi.fn() }));
vi.mock('../PGLiteQueuedPromptsStore', () => ({ createPGLiteQueuedPromptsStore: vi.fn() }));
vi.mock('../PGLiteSessionWakeupsStore', () => ({ createPGLiteSessionWakeupsStore: vi.fn() }));
vi.mock('../AgentMessagesBackfill', () => ({ runAgentMessagesBackfill: vi.fn() }));
vi.mock('../startupMaintenanceGate', () => ({ runWhenFirstUsable: vi.fn() }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: {} }));
vi.mock('../../database/sqlite/SQLiteStoreAdapter', () => ({ createSQLiteStoreAdapter: vi.fn() }));
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../StytchAuthService', () => ({ onAuthStateChange: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/transcript/TranscriptMigrationService', () => ({
  TranscriptMigrationService: class {},
}));
vi.mock('../TranscriptMigrationAdapters', () => ({ createRawMessageStoreAdapter: vi.fn() }));

import { repositoryManager } from '../RepositoryManager';

function seedManager(): any {
  const manager = repositoryManager as any;
  manager.initialized = true;
  manager.baseSessionStore = { name: 'base-session' };
  manager.sessionStore = { name: 'old-session' };
  manager.baseAgentMessagesStore = { name: 'base-agent' };
  manager.agentMessagesStore = { name: 'old-agent' };
  manager.lifecycleGeneration = 0;
  manager.activeLifecycleCancellation = null;
  return manager;
}

afterEach(() => {
  const manager = repositoryManager as any;
  manager.initialized = false;
  manager.baseSessionStore = null;
  manager.sessionStore = null;
  manager.baseAgentMessagesStore = null;
  manager.agentMessagesStore = null;
  manager.lifecycleGeneration = 0;
  manager.activeLifecycleCancellation = null;
  vi.clearAllMocks();
});

describe('RepositoryManager sync-store replacement lifetime', () => {
  it('publishes the replacement repository only after SyncManager disposal/reinit settles', async () => {
    const manager = seedManager();
    const replacement = { name: 'current-session' };
    let releaseReinitialize!: () => void;
    const gate = new Promise<void>((resolve) => { releaseReinitialize = resolve; });
    mocks.reinitializeSync.mockImplementationOnce(async () => {
      await gate;
      return replacement;
    });

    const reinitializing = manager.reinitializeSyncWithNewConfig();
    await Promise.resolve();
    expect(mocks.setSessionStore).not.toHaveBeenCalled();
    expect(manager.sessionStore).toEqual({ name: 'old-session' });

    releaseReinitialize();
    await reinitializing;
    expect(manager.sessionStore).toBe(replacement);
    expect(mocks.setSessionStore).toHaveBeenCalledWith(replacement);
  });

  it('clears repository ownership before awaiting scheduler shutdown', async () => {
    const manager = seedManager();
    let releaseShutdown!: () => void;
    mocks.shutdownSync.mockImplementationOnce(() => (
      new Promise<void>((resolve) => { releaseShutdown = resolve; })
    ));

    const cleaning = manager.cleanup();
    await Promise.resolve();
    expect(mocks.clearSessionStore).toHaveBeenCalledTimes(1);
    expect(manager.sessionStore).toBeNull();
    releaseShutdown();
    await cleaning;
  });

  it('invalidates a delayed reinitialize before cleanup can be resurrected', async () => {
    const manager = seedManager();
    const stale = { name: 'stale-after-cleanup' };
    let releaseReinitialize!: () => void;
    let providerPublished = false;
    mocks.reinitializeSync.mockImplementationOnce(async (base, lifetimeStillCurrent) => {
      await new Promise<void>((resolve) => { releaseReinitialize = resolve; });
      if (!lifetimeStillCurrent()) return base;
      providerPublished = true;
      return stale;
    });

    const reinitializing = manager.reinitializeSyncWithNewConfig();
    await Promise.resolve();
    const cleaning = manager.cleanup();
    expect(manager.initialized).toBe(false);
    releaseReinitialize();
    await reinitializing;
    await cleaning;

    expect(mocks.setSessionStore).not.toHaveBeenCalled();
    expect(mocks.setAgentStore).not.toHaveBeenCalled();
    expect(providerPublished).toBe(false);
    expect(mocks.clearSessionStore).toHaveBeenCalledTimes(1);
    expect(manager.sessionStore).toBeNull();
  });

  it('publishes only the latest of two overlapping outer reinitializations', async () => {
    const manager = seedManager();
    const stale = { name: 'superseded-session' };
    const current = { name: 'current-session' };
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const providerPublications: string[] = [];
    mocks.reinitializeSync
      .mockImplementationOnce(async (base, lifetimeStillCurrent) => {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        if (!lifetimeStillCurrent()) return base;
        providerPublications.push('stale');
        return stale;
      })
      .mockImplementationOnce(async (_base, lifetimeStillCurrent) => {
        await new Promise<void>((resolve) => { releaseSecond = resolve; });
        if (!lifetimeStillCurrent()) throw new Error('current lifetime unexpectedly invalid');
        providerPublications.push('current');
        return current;
      });

    const first = manager.reinitializeSyncWithNewConfig();
    await Promise.resolve();
    const second = manager.reinitializeSyncWithNewConfig();
    releaseFirst();
    await first;
    expect(mocks.setSessionStore).not.toHaveBeenCalled();
    releaseSecond();
    await second;

    expect(mocks.setSessionStore).toHaveBeenCalledTimes(1);
    expect(mocks.setSessionStore).toHaveBeenCalledWith(current);
    expect(manager.sessionStore).toBe(current);
    expect(providerPublications).toEqual(['current']);
  });

  it('lets cleanup complete while generation A never settles', async () => {
    const manager = seedManager();
    mocks.reinitializeSync.mockImplementationOnce(() => new Promise(() => undefined));

    const generationA = manager.reinitializeSyncWithNewConfig();
    await Promise.resolve();
    const cleaning = manager.cleanup();
    await expect(generationA).resolves.toBeUndefined();
    await expect(cleaning).resolves.toBeUndefined();

    expect(mocks.clearSessionStore).toHaveBeenCalledTimes(1);
    expect(mocks.clearAgentStore).toHaveBeenCalledTimes(1);
    expect(manager.sessionStore).toBeNull();
    expect(manager.agentMessagesStore).toBeNull();
    expect(mocks.setSessionStore).not.toHaveBeenCalled();
  });

  it('retires delayed A and B so only C can publish, even after late settle/reject', async () => {
    const manager = seedManager();
    let resolveA!: (value: any) => void;
    let rejectB!: (error: Error) => void;
    mocks.reinitializeSync
      .mockImplementationOnce(() => new Promise<any>((resolve) => { resolveA = resolve; }))
      .mockImplementationOnce(() => new Promise<any>((_resolve, reject) => { rejectB = reject; }))
      .mockResolvedValueOnce({ name: 'generation-c' });

    const generationA = manager.reinitializeSyncWithNewConfig();
    await Promise.resolve();
    const generationB = manager.reinitializeSyncWithNewConfig();
    await expect(generationA).resolves.toBeUndefined();
    await Promise.resolve();
    const generationC = manager.reinitializeSyncWithNewConfig();
    await expect(generationB).resolves.toBeUndefined();
    await expect(generationC).resolves.toBeUndefined();

    expect(mocks.setSessionStore).toHaveBeenCalledTimes(1);
    expect(mocks.setSessionStore).toHaveBeenCalledWith({ name: 'generation-c' });
    resolveA({ name: 'late-generation-a' });
    rejectB(new Error('late-generation-b'));
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.setSessionStore).toHaveBeenCalledTimes(1);
    expect(manager.sessionStore).toEqual({ name: 'generation-c' });
  });
});
