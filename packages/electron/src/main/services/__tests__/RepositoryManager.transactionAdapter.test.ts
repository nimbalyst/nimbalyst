import { beforeEach, describe, expect, it, vi } from 'vitest';

interface SessionStoreTransactionAdapter {
  transaction<T = unknown>(statements: Array<{
    sql: string;
    params?: unknown[];
    expectedRowCount?: number;
  }>): Promise<Array<{ rows: T[] }>>;
}

const harness = vi.hoisted(() => ({
  runTransaction: vi.fn(),
  createSessionStore: vi.fn((_adapter: SessionStoreTransactionAdapter) => ({ list: vi.fn() })),
  sink: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
}));

vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    isInitialized: vi.fn(() => true), initialize: vi.fn(), getActiveSQLiteDatabase: vi.fn(() => null),
    query: vi.fn(), runTransaction: harness.runTransaction,
  },
}));
vi.mock('../PGLiteSessionStore', () => ({ createPGLiteSessionStore: harness.createSessionStore }));
vi.mock('../PGLiteSessionFileStore', () => ({ createPGLiteSessionFileStore: vi.fn(() => ({})) }));
vi.mock('../PGLiteAgentMessagesStore', () => ({ createPGLiteAgentMessagesStore: vi.fn(() => ({})) }));
vi.mock('../PGLiteWorkspaceRepository', () => ({ createPGLiteWorkspaceRepository: vi.fn(() => ({})) }));
vi.mock('../PGLiteDocumentsRepository', () => ({ createPGLiteDocumentsRepository: vi.fn(() => ({})) }));
vi.mock('../PGLiteQueuedPromptsStore', () => ({ createPGLiteQueuedPromptsStore: vi.fn(() => ({})) }));
vi.mock('../HostControlReceiptsStore', () => ({ createHostControlReceiptsStore: vi.fn(() => ({})) }));
vi.mock('../PGLiteSessionWakeupsStore', () => ({ createPGLiteSessionWakeupsStore: vi.fn(() => ({})) }));
vi.mock('../SyncManager', () => ({ initializeSync: vi.fn(async (value) => value), isSyncEnabled: vi.fn(() => false), onAuthStateChange: vi.fn() }));
vi.mock('../../utils/logger', () => ({ logger: { main: harness.sink } }));
vi.mock('../../window/WindowManager', () => ({ windows: new Map(), windowStates: new Map() }));
vi.mock('../NativeWinnerNotificationService', () => ({ configureNativeWinnerNotificationStore: vi.fn() }));
vi.mock('../TranscriptMigrationAdapters', () => ({ createRawMessageStoreAdapter: vi.fn(() => ({})) }));
vi.mock('../AgentMessagesBackfill', () => ({ runAgentMessagesBackfill: vi.fn() }));
vi.mock('../startupMaintenanceGate', () => ({ runWhenFirstUsable: vi.fn() }));
vi.mock('../StytchAuthService', () => ({ onAuthStateChange: vi.fn(() => () => undefined) }));
vi.mock('../TrackerSyncManager', () => ({ shutdownTrackerSync: vi.fn(), initializeTrackerSync: vi.fn() }));

describe('RepositoryManager PGLite transaction adapter', () => {
  beforeEach(() => {
    vi.resetModules();
    harness.runTransaction.mockReset();
    harness.createSessionStore.mockClear();
  });

  it('passes the real database.runTransaction binding to the session store', async () => {
    const { repositoryManager } = await import('../RepositoryManager');
    await repositoryManager.initialize();

    const adapter = harness.createSessionStore.mock.calls[0]?.[0];
    expect(adapter.transaction).toBeDefined();
    await adapter.transaction([{ sql: 'SELECT 1 RETURNING 1', expectedRowCount: 1 }]);
    expect(harness.runTransaction).toHaveBeenCalledWith([{ sql: 'SELECT 1 RETURNING 1', expectedRowCount: 1 }]);
  });
});
