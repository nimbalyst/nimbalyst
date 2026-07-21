import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  return {
    handlers,
    sender: {},
    browserWindow: {},
    windows: new Map<number, unknown>(),
    windowStates: new Map<number, unknown>(),
    fromWebContents: vi.fn(),
    get: vi.fn(),
    setPinned: vi.fn(),
    setWorkstream: vi.fn(),
    rename: vi.fn(),
    acknowledgeRendererDelivery: vi.fn(),
    configureHostBroadcast: vi.fn(),
    findWindowByWorkspace: vi.fn(),
    workspaceWindows: new Map<string, any>(),
    hostBroadcast: undefined as undefined | ((workspacePath: string, channel: string, ...args: unknown[]) => unknown),
    operationalResolver: undefined as undefined | ((workspaceId: string, workspacePath: string) => string | null),
    storageRootOwnershipCheck: undefined as undefined | (() => void),
    protectedStorageWrite: undefined as undefined | (<T>(work: () => Promise<T>) => Promise<T>),
    configureVisibilityStorageFence: vi.fn(),
    databaseQuery: vi.fn(async () => ({ rows: [] })),
    revokeHostBoundMcpAuthority: vi.fn(),
    deleteSession: vi.fn(),
    deleteRepositorySession: vi.fn(),
  };
});

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (...args: any[]) => Promise<any>) => {
    mocks.handlers.set(channel, handler);
  },
  safeOn: vi.fn(),
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class {
    initialize = vi.fn().mockResolvedValue(undefined);
    deleteSession = mocks.deleteSession;
  },
  ProviderFactory: { destroyProvider: vi.fn() },
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    get: mocks.get,
    create: vi.fn(),
    updateMetadata: vi.fn(),
    delete: mocks.deleteRepositorySession,
    configureVisibilityStorageFence: mocks.configureVisibilityStorageFence,
  },
  TranscriptMigrationRepository: { hasService: () => false },
}));

vi.mock('../../services/SessionVisibilityControlService', () => ({
  SessionVisibilityControlService: {
    getInstance: (deps: {
      assertStorageRootOwnership?: () => void;
      withStorageRootWriteFence?: <T>(work: () => Promise<T>) => Promise<T>;
    }) => {
      mocks.storageRootOwnershipCheck = deps.assertStorageRootOwnership;
      mocks.protectedStorageWrite = deps.withStorageRootWriteFence;
      return {
        setPinned: mocks.setPinned,
        setWorkstream: mocks.setWorkstream,
        rename: mocks.rename,
        acknowledgeRendererDelivery: mocks.acknowledgeRendererDelivery,
        configureHostBroadcast: mocks.configureHostBroadcast,
      };
    },
  },
  toSessionVisibilityErrorPayload: (error: any) => ({
    code: error.code ?? 'INTERNAL_ERROR',
    auditId: error.auditId,
  }),
  canonicalizeSessionWorkspacePath: (workspacePath: string) => (
    workspacePath.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  ),
  workspaceReceiptId: (workspacePath: string) => `receipt:${workspacePath}`,
}));
vi.mock('../../mcp/httpServer', () => ({
  revokeHostBoundMcpAuthority: mocks.revokeHostBoundMcpAuthority,
}));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: mocks.databaseQuery },
}));

vi.mock('@nimbalyst/runtime/ai/server/transcript', () => ({ TranscriptProjector: class {} }));
vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock('../../tray/TrayManager', () => ({
  TrayManager: { getInstance: () => ({ onPromptResolved: vi.fn() }) },
}));
vi.mock('../../services/TranscriptToolCallEnricher', () => ({ enrichTranscriptMessagesWithToolCallDiffs: vi.fn() }));
vi.mock('../../services/ai/pendingPromptPersistence', () => ({
  capturePendingPromptActionOwnership: vi.fn(),
  promptActionOwnsCurrentGeneration: vi.fn(),
  setSessionPendingPrompt: vi.fn(),
}));
vi.mock('../../services/ai/orphanedPromptTurnSettlement', () => ({ settleOrphanedPromptTurn: vi.fn() }));
vi.mock('../../services/AttentionEventService', () => ({ attentionEventService: { cancelInteractivePrompt: vi.fn() } }));
vi.mock('../../window/windowState', () => ({
  windows: mocks.windows,
  windowStates: mocks.windowStates,
}));
vi.mock('../../window/WindowManager', () => ({
  findWindowByWorkspace: mocks.findWindowByWorkspace,
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents, getAllWindows: () => [] },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { listenerCount: () => 0, emit: vi.fn() },
}));

import {
  acquireVisibilityStorageRootOwnership,
  registerSessionHandlers,
  resolveVisibilityStorageRootEndpoint,
} from '../SessionHandlers';

async function invoke(channel: string, ...args: any[]) {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler({ sender: mocks.sender }, ...args);
}

describe('SessionHandlers visibility-control convergence', () => {
  beforeAll(async () => {
    mocks.configureHostBroadcast.mockImplementation(async (callback, resolver) => {
      mocks.hostBroadcast = callback;
      mocks.operationalResolver = resolver;
    });
    mocks.findWindowByWorkspace.mockImplementation((workspacePath: string) => (
      mocks.workspaceWindows.get(workspacePath) ?? null
    ));
    await registerSessionHandlers();
  });

  it('rejects a second production-boundary owner for the same storage root', async () => {
    expect(mocks.storageRootOwnershipCheck).toBeTypeOf('function');
    expect(mocks.protectedStorageWrite).toBeTypeOf('function');
    expect(mocks.configureVisibilityStorageFence).toHaveBeenCalledOnce();
    const databaseFence = mocks.configureVisibilityStorageFence.mock.calls[0][0];
    expect(databaseFence).toMatchObject({
      rootIdentity: expect.stringMatching(/^[0-9a-f]+:[0-9a-f]+$/),
      ownerId: expect.stringMatching(/^sv-root-/),
    });
    expect(databaseFence).not.toHaveProperty('assertOwned');
    expect(mocks.databaseQuery.mock.calls.some(([sql]) => (
      String(sql).includes('CREATE TABLE IF NOT EXISTS session_visibility_storage_fence')
    ))).toBe(true);
    expect(mocks.databaseQuery.mock.calls.some(([sql, values]) => (
      String(sql).includes('ON CONFLICT (root_identity)')
      && values[0] === databaseFence.rootIdentity
      && values[1] === databaseFence.ownerId
    ))).toBe(true);
    expect(() => mocks.storageRootOwnershipCheck?.()).not.toThrow();
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'nim-366-root-owner-'));
    const firstOwner = await acquireVisibilityStorageRootOwnership(rootPath);
    try {
      await expect(acquireVisibilityStorageRootOwnership(rootPath))
        .rejects.toThrow('already owned');
    } finally {
      await firstOwner.release();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('maps a junction alias to the same physical root fence', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'nim-366-physical-root-'));
    const physical = path.join(parent, 'physical');
    const alias = path.join(parent, 'junction-alias');
    await mkdir(physical);
    await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const owner = await acquireVisibilityStorageRootOwnership(physical);
    try {
      expect(resolveVisibilityStorageRootEndpoint(alias)).toEqual(
        resolveVisibilityStorageRootEndpoint(physical),
      );
      await expect(acquireVisibilityStorageRootOwnership(alias))
        .rejects.toThrow('already owned');
    } finally {
      await owner.release();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects an independent live owner and reclaims its dead nonce', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'nim-366-root-process-owner-'));
    const endpoint = resolveVisibilityStorageRootEndpoint(rootPath);
    const childSource = String.raw`
      const fs = require('node:fs');
      const net = require('node:net');
      const path = require('node:path');
      const root = process.argv[1];
      const host = process.argv[2];
      const port = Number(process.argv[3]);
      const lock = path.join(root, '.session-visibility-owner');
      const ownerId = 'independent-' + process.pid;
      const server = net.createServer((socket) => socket.end(ownerId));
      server.listen({ host, port, exclusive: true }, () => {
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
          protocol: 2, ownerId, pid: process.pid, acquiredAt: Date.now(),
          endpoint: { host, port },
        }));
        process.stdout.write('ready\n');
      });
    `;
    const child = spawn(process.execPath, [
      '-e', childSource, rootPath, endpoint.host, String(endpoint.port),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await once(child.stdout!, 'data');
      await expect(acquireVisibilityStorageRootOwnership(rootPath, {
        now: () => Number.MAX_SAFE_INTEGER,
        staleAfterMs: 1,
      }))
        .rejects.toThrow('already owned');
      await expect(acquireVisibilityStorageRootOwnership(rootPath, {
        now: () => Number.MIN_SAFE_INTEGER,
        staleAfterMs: 1,
      }))
        .rejects.toThrow('already owned');
      const exited = once(child, 'exit');
      child.kill();
      await exited;
      const replacement = await acquireVisibilityStorageRootOwnership(rootPath);
      await replacement.release();
    } finally {
      if (child.exitCode === null) child.kill();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('reclaims crash fragments and arbitrary reused-PID metadata only when the OS fence is free', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'nim-366-root-reclaim-'));
    const lockPath = path.join(rootPath, '.session-visibility-owner');
    try {
      await mkdir(lockPath);
      const afterMkdirCrash = await acquireVisibilityStorageRootOwnership(rootPath);
      await afterMkdirCrash.release();

      await mkdir(lockPath);
      await writeFile(path.join(lockPath, 'owner.json'), '{malformed');
      const afterMalformedOwner = await acquireVisibilityStorageRootOwnership(rootPath);
      await afterMalformedOwner.release();

      const reusedOwnerId = 'dead-owner-reused-pid';
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
        ownerId: reusedOwnerId,
        pid: process.pid,
        processStartEpochSecond: Math.floor(
          (Date.now() - process.uptime() * 1_000) / 1_000,
        ) - 100,
        acquiredAt: Date.now() + 10_000_000,
      }));
      const afterPidReuse = await acquireVisibilityStorageRootOwnership(rootPath, {
        now: () => -10_000_000,
      });
      await afterPidReuse.release();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('treats owner.json as discovery-only while the kernel endpoint remains exclusive', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'nim-366-root-release-race-'));
    let releaseQuarantine!: () => void;
    const quarantineGate = new Promise<void>((resolve) => { releaseQuarantine = resolve; });
    let reachedQuarantine!: () => void;
    const atQuarantine = new Promise<void>((resolve) => { reachedQuarantine = resolve; });
    try {
      const first = await acquireVisibilityStorageRootOwnership(rootPath, {
        beforeReleaseQuarantine: async () => {
          reachedQuarantine();
          await quarantineGate;
        },
      });
      const releasing = first.release();
      await atQuarantine;
      await expect(acquireVisibilityStorageRootOwnership(rootPath))
        .rejects.toThrow('already owned');
      releaseQuarantine();
      await releasing;

      const displaced = await acquireVisibilityStorageRootOwnership(rootPath);
      await writeFile(
        path.join(rootPath, '.session-visibility-owner', 'owner.json'),
        JSON.stringify({ ownerId: 'replacement-nonce' }),
      );
      expect(() => displaced.assertOwned()).not.toThrow();
      await expect(acquireVisibilityStorageRootOwnership(rootPath))
        .rejects.toThrow('already owned');
      await displaced.release();
      const replacement = await acquireVisibilityStorageRootOwnership(rootPath);
      replacement.assertOwned();
      await replacement.release();
    } finally {
      releaseQuarantine?.();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('makes release and takeover wait for an in-flight protected storage write', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'nim-366-root-await-fence-'));
    const lease = await acquireVisibilityStorageRootOwnership(rootPath);
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => { resume = resolve; });
    let paused!: () => void;
    const atPause = new Promise<void>((resolve) => { paused = resolve; });
    const commit = vi.fn();
    try {
      const operation = lease.runProtectedWrite(async () => {
        paused();
        await wait;
        commit();
      });
      await atPause;
      const release = lease.release();
      await expect(acquireVisibilityStorageRootOwnership(rootPath))
        .rejects.toThrow('already owned');
      expect(commit).not.toHaveBeenCalled();
      resume();

      await operation;
      await release;
      expect(commit).toHaveBeenCalledTimes(1);
      const replacement = await acquireVisibilityStorageRootOwnership(rootPath);
      await replacement.release();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('does not transfer operational ownership through discovery-file replacement', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'nim-366-root-inflight-fence-'));
    const lease = await acquireVisibilityStorageRootOwnership(rootPath);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let reached!: () => void;
    const atPrecommit = new Promise<void>((resolve) => { reached = resolve; });
    const commit = vi.fn();
    try {
      const write = lease.runProtectedWrite(async () => {
        reached();
        await gate;
        // The kernel endpoint, not mutable discovery metadata, remains the
        // process-level admission authority. The database owner row is the
        // separate canonical commit predicate exercised at the real stores.
        lease.assertOwned();
        commit();
      });
      await atPrecommit;
      await writeFile(
        path.join(rootPath, '.session-visibility-owner', 'owner.json'),
        JSON.stringify({ ownerId: 'replacement-owner-before-cas' }),
      );
      resume();

      await expect(write).resolves.toBeUndefined();
      expect(commit).toHaveBeenCalledTimes(1);
      await expect(acquireVisibilityStorageRootOwnership(rootPath))
        .rejects.toThrow('already owned');
      await lease.release();
    } finally {
      resume?.();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.windows.clear();
    mocks.windowStates.clear();
    mocks.workspaceWindows.clear();
    mocks.windows.set(7, mocks.browserWindow);
    mocks.windowStates.set(7, {
      mode: 'workspace',
      workspacePath: '/startup-repo',
      activeWorkspacePath: '/canonical-repo',
    });
    mocks.fromWebContents.mockReturnValue(mocks.browserWindow);
  });

  it('does not consume delivery with a wrong-workspace window and targets the exact match when it attaches', () => {
    const sendB = vi.fn();
    const sendA = vi.fn();
    mocks.workspaceWindows.set('/workspace-b', {
      isDestroyed: () => false,
      webContents: { send: sendB },
    });

    expect(() => mocks.hostBroadcast?.(
      '/workspace-a', 'sessions:session-updated', 'target', { isPinned: true },
    )).toThrow('no matching renderer window available');
    expect(sendB).not.toHaveBeenCalled();

    mocks.workspaceWindows.set('/workspace-a', {
      isDestroyed: () => false,
      webContents: { send: sendA },
    });
    expect(mocks.hostBroadcast?.(
      '/workspace-a', 'sessions:session-updated', 'target', { isPinned: true },
    )).toBe(false);
    expect(sendA).toHaveBeenCalledWith(
      'sessions:session-updated', 'target', { isPinned: true },
    );
    expect(sendB).not.toHaveBeenCalled();
  });

  it('routes the durable Windows host alias to the exact live window spelling', () => {
    const send = vi.fn();
    mocks.workspaceWindows.set('c:/repo/', {
      isDestroyed: () => false,
      webContents: { send },
    });

    expect(mocks.hostBroadcast?.(
      'c:/repo/',
      'sessions:session-updated',
      'target',
      { workspacePath: 'c:/repo/', isPinned: true, visibilityAuditId: 'audit-alias' },
    )).toBe(false);
    expect(send).toHaveBeenCalledWith(
      'sessions:session-updated',
      'target',
      { workspacePath: 'c:/repo/', isPinned: true, visibilityAuditId: 'audit-alias' },
    );
    expect(mocks.findWindowByWorkspace).toHaveBeenCalledWith('c:/repo/');
    expect(mocks.findWindowByWorkspace).not.toHaveBeenCalledWith('C:\\Repo');
  });

  it.skipIf(process.platform !== 'win32')(
    'resolves restart replay to the current equivalent window spelling',
    () => {
    const liveWindow = { isDestroyed: () => false };
    mocks.windows.set(8, liveWindow);
    mocks.windowStates.set(8, {
      mode: 'workspace',
      workspacePath: 'C:/Repo',
      activeWorkspacePath: 'C:/Repo',
    });
    const workspaceId = 'receipt:c:/repo';
    expect(mocks.operationalResolver?.(workspaceId, 'c:/repo/')).toBe('C:/Repo');
    mocks.windows.set(9, { isDestroyed: () => false });
    mocks.windowStates.set(9, {
      mode: 'workspace',
      workspacePath: 'c:\\repo',
      activeWorkspacePath: 'c:\\repo',
      storageRoot: 'distinct-root-that-must-not-consume-the-obligation',
    });
    expect(mocks.operationalResolver?.(workspaceId, 'c:/repo/')).toBeNull();
    mocks.windows.delete(9);
    mocks.windowStates.delete(9);
    expect(mocks.operationalResolver?.(workspaceId, 'c:/repo/')).toBe('C:/Repo');
    expect(mocks.operationalResolver?.('receipt:d:/other', 'c:/repo/')).toBeNull();
    mocks.windowStates.set(8, {
      mode: 'workspace',
      workspacePath: 'D:/Other',
      activeWorkspacePath: 'D:/Other',
    });
    expect(mocks.operationalResolver?.(workspaceId, 'c:/repo/')).toBeNull();
    },
  );

  it('revokes host MCP ownership from both production deletion lifecycles', async () => {
    mocks.deleteSession.mockResolvedValue(undefined);
    mocks.deleteRepositorySession.mockResolvedValue(undefined);
    await invoke('session:delete', 'legacy-session');
    await invoke('sessions:delete', 'agent-session');
    expect(mocks.revokeHostBoundMcpAuthority).toHaveBeenNthCalledWith(1, 'legacy-session');
    expect(mocks.revokeHostBoundMcpAuthority).toHaveBeenNthCalledWith(2, 'agent-session');
  });

  it('binds renderer delivery acknowledgement to the sender window workspace', async () => {
    mocks.acknowledgeRendererDelivery.mockReturnValue(true);

    await expect(invoke('sessions:visibility-delivery-ack', {
      auditId: 'audit-1',
      workspacePath: '/spoofed-repo',
    })).resolves.toBe(true);
    expect(mocks.acknowledgeRendererDelivery).toHaveBeenCalledWith(
      'audit-1', '/canonical-repo',
    );
  });

  it('routes pinning through the shared service with server-derived target context', async () => {
    mocks.setPinned.mockResolvedValue({ ok: true, changed: true, after: { pinned: true } });

    const result = await invoke('sessions:update-pinned', 'target', true);

    expect(result).toMatchObject({ success: true, changed: true });
    expect(mocks.setPinned).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSessionId: 'renderer-window:7',
        actorKind: 'renderer-user',
        workspacePath: '/canonical-repo',
        source: 'renderer-ipc',
      }),
      'target',
      true,
    );
  });

  it('routes reparenting through the same structural boundary', async () => {
    mocks.setWorkstream.mockResolvedValue({
      ok: true,
      changed: true,
      before: { workstreamId: null },
      after: { workstreamId: 'workstream' },
    });

    const result = await invoke('sessions:set-parent', {
      sessionId: 'target',
      newParentId: 'workstream',
      workspacePath: '/spoofed-repo',
    });

    expect(result).toMatchObject({ success: true, changed: true });
    expect(mocks.setWorkstream).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSessionId: 'renderer-window:7',
        actorKind: 'renderer-user',
        workspacePath: '/canonical-repo',
      }),
      'target',
      'workstream',
    );
  });

  it('routes exact-title changes without SessionNamingService propagation', async () => {
    mocks.rename.mockResolvedValue({ ok: true, changed: true, after: { name: 'New name' } });

    const result = await invoke('sessions:update-title', 'target', 'New name');

    expect(result).toMatchObject({ success: true, changed: true });
    expect(mocks.rename).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSessionId: 'renderer-window:7',
        actorKind: 'renderer-user',
        workspacePath: '/canonical-repo',
      }),
      'target',
      'New name',
    );
  });
});
