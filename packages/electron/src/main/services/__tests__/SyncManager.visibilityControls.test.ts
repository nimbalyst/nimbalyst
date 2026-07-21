import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCollabV3Sync: vi.fn(),
  createSyncedSessionStore: vi.fn(),
  createMessageSyncHandler: vi.fn(() => ({})),
  stopAllProjectFileSync: vi.fn(),
  projectFileShutdown: vi.fn(),
  getAllSessionsForSync: vi.fn().mockResolvedValue([]),
  getSessionMessagesForSyncBatch: vi.fn(),
  resolvePersonalUserId: vi.fn().mockResolvedValue('personal-user'),
}));

vi.mock('@nimbalyst/runtime/sync', () => ({
  setSyncClientInfo: vi.fn(),
  createCollabV3Sync: mocks.createCollabV3Sync,
  createSyncedSessionStore: mocks.createSyncedSessionStore,
  createMessageSyncHandler: mocks.createMessageSyncHandler,
}));
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../utils/store', () => ({
  getSessionSyncConfig: () => ({
    enabled: true,
    environment: 'production',
    personalOrgId: 'personal-org',
    personalUserId: 'personal-user',
  }),
  setSessionSyncConfig: vi.fn(),
  getReleaseChannel: () => 'beta',
  getDefaultAIModel: vi.fn(),
  getAlphaFeatures: () => ({}),
  getPreferredAgentLanguage: () => 'en',
  store: { get: () => ({ enabledProjects: [] }) },
}));
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../CredentialService', () => ({
  getCredentials: () => ({ encryptionKeySeed: 'test-seed' }),
}));
vi.mock('../StytchAuthService', () => ({
  getStytchUserId: () => 'personal-user',
  isAuthenticated: () => true,
  getPersonalOrgId: () => 'personal-org',
  getPersonalUserId: () => 'personal-user',
  resolvePersonalUserId: mocks.resolvePersonalUserId,
  getPersonalSessionJwt: () => 'header.payload.signature',
  refreshPersonalSession: vi.fn().mockResolvedValue(true),
}));
vi.mock('../ProjectFileSyncService', () => ({
  getProjectFileSyncService: () => ({ initialize: vi.fn(), shutdown: mocks.projectFileShutdown }),
}));
vi.mock('../../file/WorkspaceWatcher', () => ({
  startProjectFileSync: vi.fn(),
  stopAllProjectFileSync: mocks.stopAllProjectFileSync,
}));
vi.mock('../../window/WindowManager', () => ({ windowStates: new Map() }));
vi.mock('../../utils/gitUtils', () => ({ getNormalizedGitRemote: vi.fn() }));
vi.mock('../../utils/workspaceDetection', () => ({ resolveProjectPath: (value: string) => value }));
vi.mock('../PowerSaveService', () => ({
  setSleepPreventionMode: vi.fn(), setSyncConnected: vi.fn(), shutdownSleepPrevention: vi.fn(),
}));
vi.mock('../TrackerSyncManager', () => ({ reconnectAllTrackerSyncs: vi.fn() }));
vi.mock('../../utils/startupTiming', () => ({
  timeStartupPhase: async (_label: string, work: () => Promise<unknown>) => work(),
}));
vi.mock('../PGLiteSessionStore', () => ({
  getAllSessionsForSync: mocks.getAllSessionsForSync,
  getSessionMessagesForSyncBatch: mocks.getSessionMessagesForSyncBatch,
}));

import { initializeSync, reinitializeSync, shutdownSync } from '../SyncManager';

function baseStore() {
  return {
    ensureReady: vi.fn(), create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn(),
    list: vi.fn(), search: vi.fn(), delete: vi.fn(),
  } as any;
}

function provider(name: string) {
  return {
    name,
    disconnectAll: vi.fn(),
    onDeviceStatusChange: vi.fn(),
  } as any;
}

describe('SyncManager visibility publication lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('crypto', {
      subtle: {
        importKey: vi.fn().mockResolvedValue({}),
        deriveKey: vi.fn().mockResolvedValue({}),
      },
    });
    mocks.createCollabV3Sync.mockReset();
    mocks.createSyncedSessionStore.mockReset();
    mocks.getAllSessionsForSync.mockReset().mockResolvedValue([]);
    mocks.resolvePersonalUserId.mockReset().mockResolvedValue('personal-user');
  });

  afterEach(async () => {
    await shutdownSync();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('drains an ordinary disposal and retires a non-settling superseded disposal', async () => {
    const base = baseStore();
    const oldProvider = provider('old');
    const newProvider = provider('new');
    const thirdProvider = provider('third');
    mocks.createCollabV3Sync
      .mockReturnValueOnce(oldProvider)
      .mockReturnValueOnce(newProvider)
      .mockReturnValueOnce(thirdProvider);

    let releaseOldDispose!: () => void;
    const oldDisposeGate = new Promise<void>((resolve) => { releaseOldDispose = resolve; });
    const oldDecorator = { ...base, dispose: vi.fn(() => oldDisposeGate) };
    let releaseNewDispose!: () => void;
    const newDisposeGate = new Promise<void>((resolve) => { releaseNewDispose = resolve; });
    const newDecorator = { ...base, dispose: vi.fn(() => newDisposeGate) };
    const thirdDecorator = { ...base, dispose: vi.fn().mockResolvedValue(undefined) };
    mocks.createSyncedSessionStore
      .mockReturnValueOnce(oldDecorator)
      .mockReturnValueOnce(newDecorator)
      .mockReturnValueOnce(thirdDecorator);

    await expect(initializeSync(base)).resolves.toBe(oldDecorator);
    const replacing = reinitializeSync(base);
    await Promise.resolve();
    await Promise.resolve();
    expect(oldDecorator.dispose).toHaveBeenCalledTimes(1);
    expect(oldProvider.disconnectAll).not.toHaveBeenCalled();
    expect(mocks.createSyncedSessionStore).toHaveBeenCalledTimes(1);

    releaseOldDispose();
    await expect(replacing).resolves.toBe(newDecorator);
    expect(oldProvider.disconnectAll).toHaveBeenCalledTimes(1);
    expect(mocks.createSyncedSessionStore).toHaveBeenCalledTimes(2);

    // A later request retires the owner blocked in an obsolete disposal. The
    // cancelled caller completes boundedly and only the newest request may
    // construct the successor.
    const replacingAgain = reinitializeSync(base);
    await Promise.resolve();
    await Promise.resolve();
    expect(newDecorator.dispose).toHaveBeenCalledTimes(1);
    const replacingConcurrently = reinitializeSync(base);
    await expect(replacingAgain).resolves.toBe(base);
    await Promise.resolve();
    expect(newProvider.disconnectAll).not.toHaveBeenCalled();
    expect(mocks.createSyncedSessionStore).toHaveBeenCalledTimes(2);

    releaseNewDispose();
    await expect(replacingConcurrently).resolves.toBe(thirdDecorator);
    expect(newProvider.disconnectAll).toHaveBeenCalledTimes(1);
    expect(mocks.createSyncedSessionStore).toHaveBeenCalledTimes(3);
    expect(thirdDecorator.dispose).not.toHaveBeenCalled();
    expect(thirdProvider.disconnectAll).not.toHaveBeenCalled();
  });

  it('suppresses a late generation-A startup sync without clearing generation-B ownership', async () => {
    const base = baseStore();
    let resolveFetchA!: (value: any) => void;
    const fetchA = new Promise<any>((resolve) => { resolveFetchA = resolve; });
    let resolveFetchB!: (value: any) => void;
    const fetchB = new Promise<any>((resolve) => { resolveFetchB = resolve; });
    const oldProvider = {
      ...provider('old-startup'),
      fetchIndex: vi.fn(() => fetchA),
      syncSessionsToIndex: vi.fn(),
    };
    const currentProvider = {
      ...provider('current-startup'),
      fetchIndex: vi.fn(() => fetchB),
      syncSessionsToIndex: vi.fn(),
    };
    const oldDecorator = { ...base, dispose: vi.fn().mockResolvedValue(undefined) };
    const currentDecorator = { ...base, dispose: vi.fn().mockResolvedValue(undefined) };
    mocks.createCollabV3Sync
      .mockReturnValueOnce(oldProvider)
      .mockReturnValueOnce(currentProvider);
    mocks.createSyncedSessionStore
      .mockReturnValueOnce(oldDecorator)
      .mockReturnValueOnce(currentDecorator);
    mocks.getAllSessionsForSync.mockResolvedValue([{
      id: 'current-startup-session', title: 'Current', provider: 'claude-code',
      workspaceId: '/repo', messageCount: 0, updatedAt: Date.now(), createdAt: 1,
    }]);

    await initializeSync(base);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(oldProvider.fetchIndex).toHaveBeenCalledTimes(1);

    const replaced = reinitializeSync(base);
    await expect(replaced).resolves.toBe(currentDecorator);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(currentProvider.fetchIndex).toHaveBeenCalledTimes(1);

    resolveFetchA({ sessions: [], projects: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(oldProvider.syncSessionsToIndex).not.toHaveBeenCalled();

    resolveFetchB({ sessions: [], projects: [] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(currentProvider.syncSessionsToIndex).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'current-startup-session' })],
      expect.objectContaining({ syncMessages: true }),
    );
  });

  it('retires a never-settling initialization so B and C can become the sole newest owner', async () => {
    const base = baseStore();
    let resolveA!: (value: any) => void;
    const stalledA = new Promise<any>((resolve) => { resolveA = resolve; });
    mocks.resolvePersonalUserId
      .mockImplementationOnce(() => stalledA)
      .mockResolvedValueOnce('personal-user')
      .mockResolvedValueOnce('personal-user');
    const providerB = provider('provider-b');
    const providerC = provider('provider-c');
    const decoratorB = { ...base, name: 'decorator-b', dispose: vi.fn().mockResolvedValue(undefined) };
    const decoratorC = { ...base, name: 'decorator-c', dispose: vi.fn().mockResolvedValue(undefined) };
    mocks.createCollabV3Sync.mockReturnValueOnce(providerB).mockReturnValueOnce(providerC);
    mocks.createSyncedSessionStore.mockReturnValueOnce(decoratorB).mockReturnValueOnce(decoratorC);

    const initializingA = reinitializeSync(base);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.resolvePersonalUserId).toHaveBeenCalledTimes(1);

    const initializingB = reinitializeSync(base);
    await expect(initializingA).resolves.toBe(base);
    await expect(initializingB).resolves.toBe(decoratorB);
    const initializingC = reinitializeSync(base);
    await expect(initializingC).resolves.toBe(decoratorC);

    expect(providerB.disconnectAll).toHaveBeenCalledTimes(1);
    expect(mocks.createCollabV3Sync).toHaveBeenCalledTimes(2);
    expect(mocks.createSyncedSessionStore).toHaveBeenCalledTimes(2);

    // The abandoned A continuation may finish later, but its exact lifetime
    // predicate fails before provider/decorator publication.
    resolveA('personal-user');
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.createCollabV3Sync).toHaveBeenCalledTimes(2);
    expect(providerC.disconnectAll).not.toHaveBeenCalled();
  });

  it('lets production shutdown cancel a never-settling initialization promptly', async () => {
    const base = baseStore();
    let resolveA!: (value: any) => void;
    mocks.resolvePersonalUserId.mockImplementationOnce(() => (
      new Promise<any>((resolve) => { resolveA = resolve; })
    ));

    const initializingA = reinitializeSync(base);
    await Promise.resolve();
    await Promise.resolve();
    const stopping = shutdownSync();
    await expect(initializingA).resolves.toBe(base);
    await expect(stopping).resolves.toBeUndefined();
    expect(mocks.createCollabV3Sync).not.toHaveBeenCalled();

    resolveA('personal-user');
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.createCollabV3Sync).not.toHaveBeenCalled();
  });

  it('contains a late rejected initialization after a replacement owns sync', async () => {
    const base = baseStore();
    let rejectA!: (error: Error) => void;
    const stalledA = new Promise<any>((_resolve, reject) => { rejectA = reject; });
    mocks.resolvePersonalUserId
      .mockImplementationOnce(() => stalledA)
      .mockResolvedValueOnce('personal-user');
    const providerB = provider('provider-after-rejection');
    const decoratorB = { ...base, dispose: vi.fn().mockResolvedValue(undefined) };
    mocks.createCollabV3Sync.mockReturnValueOnce(providerB);
    mocks.createSyncedSessionStore.mockReturnValueOnce(decoratorB);

    const initializingA = reinitializeSync(base);
    await Promise.resolve();
    await Promise.resolve();
    const initializingB = reinitializeSync(base);
    await expect(initializingA).resolves.toBe(base);
    await expect(initializingB).resolves.toBe(decoratorB);

    rejectA(new Error('late retired identity failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.createCollabV3Sync).toHaveBeenCalledTimes(1);
    expect(providerB.disconnectAll).not.toHaveBeenCalled();
  });
});
