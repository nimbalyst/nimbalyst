// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { openDatabase } from '../db/openDatabase.js';
import { createQueuedPromptStore } from '../serve/queuedPrompts.js';
import { createHeadlessDeviceInfo } from '../serve/deviceIdentity.js';
import { ensureCheckout } from '../serve/repoCheckout.js';
import { findWorkspace, loadWorkspaces } from '../serve/workspaces.js';
import { createStderrLogger } from '../serve/log.js';
import { createRefreshLoop, shutdownServe } from '../serve/lifecycle.js';
import { CredentialRevokedError } from '../serve/credentials.js';
import { createSyncedAgentMessagesStore } from '../serve/syncedAgentMessagesStore.js';
import { ensureIndexSynced } from '../serve/indexEligibility.js';
import { withHostAttribution } from '../serve/hostAttributionStore.js';
import {
  createMessageSyncHandler,
  createSyncedSessionStore,
} from '@nimbalyst/runtime/sync/SyncedSessionStore';

const PROJECT_ID_FOR_ATTRIBUTION = '/Users/someone/sources/stravu-editor';

describe('queued prompt store', () => {
  let directory: string;
  let db: SqliteDatabase;

  beforeAll(() => {
    // The real shared schema, not a hand-written table: `queued_prompts` has a
    // status CHECK constraint and a session foreign key, and a fixture that
    // omits either would certify transitions the desktop's database rejects.
    directory = mkdtempSync(join(tmpdir(), 'nimbalyst-node-queue-'));
    db = openDatabase(join(directory, 'nimbalyst.sqlite')).db;
    db.prepare(`
      INSERT INTO ai_sessions (id, workspace_id, provider, created_at, updated_at)
      VALUES ('session-1', '/project', 'claude-code',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();
  });

  afterAll(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('retains encrypted attachments through queue reload without replaying an accepted id', () => {
    const attachments = [{id: 'image', filename: 'image.png', mimeType: 'image/png', encryptedData: 'cipher', iv: 'nonce', size: 5}];
    const queue = createQueuedPromptStore(db);
    const row = {id: 'attachment-prompt', sessionId: 'session-1', prompt: 'read image', createdAt: 10, attachments};
    queue.offer(row);
    expect(createQueuedPromptStore(db).listPending('session-1')).toContainEqual(row);
    queue.claim(row.id); queue.complete(row.id);
    expect(queue.offer(row)).toBe(false);
  });

  it('runs a replayed prompt id exactly once, whatever status it reached', () => {
    const queue = createQueuedPromptStore(db);
    const prompt = { id: 'p1', sessionId: 'session-1', prompt: 'first', createdAt: 1_000 };

    expect(queue.offer(prompt)).toBe(true);
    // A reconnect replays the same broadcast. The row already exists, so the
    // second offer is a no-op -- this is what stops a re-run.
    expect(queue.offer(prompt)).toBe(false);

    expect(queue.claim('p1')).toBe(true);
    // A second claimer loses; only the winner runs the turn.
    expect(queue.claim('p1')).toBe(false);
    expect(queue.listPending('session-1')).toEqual([]);

    queue.complete('p1');
    // Completed is still "seen": the id must never come back as pending.
    expect(queue.offer(prompt)).toBe(false);
    expect(queue.listPending('session-1')).toEqual([]);
  });

  it('fails rows stranded in executing rather than replaying them', () => {
    const queue = createQueuedPromptStore(db);
    queue.offer({ id: 'p2', sessionId: 'session-1', prompt: 'second', createdAt: 2_000 });
    queue.offer({ id: 'p3', sessionId: 'session-1', prompt: 'third', createdAt: 3_000 });
    queue.claim('p2');

    // p2's turn wrote files and ran commands before the process died. Putting it
    // back in the queue would be a second uncoordinated attempt, not a retry.
    const interrupted = queue.failInterrupted();
    expect(interrupted).toEqual([
      { id: 'p2', sessionId: 'session-1', prompt: 'second', createdAt: 2_000 },
    ]);

    // p3 never started, so it is still safe to run.
    expect(queue.listPending('session-1').map((row) => row.id)).toEqual(['p3']);
    expect(queue.listPendingSessions()).toEqual(['session-1']);

    // Idempotent across restarts: a second recovery pass finds nothing to fail.
    expect(queue.failInterrupted()).toEqual([]);
  });
});

describe('headless device identity', () => {
  it('announces the configured device id as a headless, unfocused host', () => {
    let clock = 1_000;
    const getDeviceInfo = createHeadlessDeviceInfo(
      { deviceId: 'sandbox-abc', deviceName: 'Cloudflare sandbox' },
      { now: () => clock, platform: 'linux', appVersion: '0.1.0' },
    );

    expect(getDeviceInfo()).toEqual({
      deviceId: 'sandbox-abc',
      name: 'Cloudflare sandbox',
      // 'headless' is what makes this node an eligible execution host and keeps
      // it out of the desktop's "your other Mac" grouping.
      type: 'headless',
      platform: 'linux',
      appVersion: '0.1.0',
      connectedAt: 1_000,
      lastActiveAt: 1_000,
      // Reporting focus would let the server suppress the push notifications
      // meant for the user's phone.
      isFocused: false,
      status: 'active',
    });

    // Re-announced every 30s: a frozen lastActiveAt renders as a stale device.
    clock = 31_000;
    expect(getDeviceInfo()).toMatchObject({ connectedAt: 1_000, lastActiveAt: 31_000 });
  });
});

describe('repo checkout', () => {
  const MAPPING = {
    projectId: '/Users/someone/repo',
    repoUrl: 'https://github.com/nimbalyst/nimbalyst.git',
    branch: 'main',
    checkoutDir: '/workspace/repo',
  };

  it('clones on first sight and fast-forwards afterwards, never through a shell', async () => {
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const runGit = vi.fn(async (args: string[], cwd?: string) => { calls.push({ args, cwd }); });

    expect(await ensureCheckout(MAPPING, {
      runGit, exists: () => false, makeDirectory: () => {},
    })).toBe('cloned');

    expect(await ensureCheckout(MAPPING, {
      runGit, exists: () => true, makeDirectory: () => {},
    })).toBe('updated');

    // argv arrays only, plus `--end-of-options` where git accepts it (verified
    // against git 2.50 for clone and fetch). Not on `checkout`, where that
    // region is a pathspec and would change what the command means.
    expect(calls).toEqual([
      {
        args: ['clone', '--depth', '1', '--branch', 'main', '--end-of-options',
               'https://github.com/nimbalyst/nimbalyst.git', '/workspace/repo'],
        cwd: undefined,
      },
      { args: ['fetch', '--depth', '1', '--end-of-options', 'origin', 'main'], cwd: '/workspace/repo' },
      { args: ['checkout', '-B', 'main', 'FETCH_HEAD'], cwd: '/workspace/repo' },
    ]);
  });

  it('refuses an option-shaped branch before git can execute it', async () => {
    const runGit = vi.fn(async () => {});
    // argv arrays stop the SHELL, not git's own option parsing: git reads
    // `--upload-pack=` as an option and runs the command it names.
    await expect(ensureCheckout(
      { ...MAPPING, branch: '--upload-pack=/bin/sh' },
      { runGit, exists: () => true, makeDirectory: () => {} },
    )).rejects.toThrow(/starts with "-", which git parses as an option/);

    for (const branch of ['../../etc', 'main..evil', 'a b', 'refs/heads/x.lock', '']) {
      await expect(ensureCheckout(
        { ...MAPPING, branch },
        { runGit, exists: () => true, makeDirectory: () => {} },
      )).rejects.toThrow(/invalid branch/);
    }

    expect(runGit).not.toHaveBeenCalled();
  });

  it('refuses a non-https remote', async () => {
    const runGit = vi.fn(async () => {});
    for (const repoUrl of ['file:///etc', 'ssh://git@host/x.git', 'git@github.com:x/y.git', '--upload-pack=x']) {
      await expect(ensureCheckout(
        { ...MAPPING, repoUrl },
        { runGit, exists: () => false, makeDirectory: () => {} },
      )).rejects.toThrow(/invalid repoUrl/);
    }
    expect(runGit).not.toHaveBeenCalled();
  });

  it('confines the checkout to its root, including through a symlink', async () => {
    const runGit = vi.fn(async () => {});

    for (const checkoutDir of ['/etc/passwd', '/workspace/../etc', 'relative/path', '/workspace']) {
      await expect(ensureCheckout(
        { ...MAPPING, checkoutDir },
        { runGit, exists: () => true, makeDirectory: () => {} },
      )).rejects.toThrow(/invalid checkoutDir/);
    }

    // A real symlink: `<root>/escape` points outside the root, so the path is
    // lexically contained but physically is not. The update path resets a git
    // tree, so following this resets a tree nobody authorised.
    const directory = mkdtempSync(join(tmpdir(), 'nimbalyst-node-root-'));
    try {
      const root = join(directory, 'root');
      const outside = join(directory, 'outside');
      mkdirSync(root);
      mkdirSync(outside);
      symlinkSync(outside, join(root, 'escape'));

      await expect(ensureCheckout(
        { ...MAPPING, checkoutDir: join(root, 'escape', 'repo') },
        { runGit, exists: () => true, makeDirectory: () => {}, checkoutRoot: root },
      )).rejects.toThrow(/symlink/);

      // The same shape without the symlink is fine, so the guard is discriminating.
      mkdirSync(join(root, 'legit'), { recursive: true });
      await expect(ensureCheckout(
        { ...MAPPING, checkoutDir: join(root, 'legit') },
        { runGit, exists: () => true, makeDirectory: () => {}, checkoutRoot: root },
      )).resolves.toBe('updated');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    // Only the legitimate path reached git.
    expect(runGit).toHaveBeenCalledTimes(2);
  });
});

describe('workspaces file', () => {
  it('maps a requester projectId to a checkout and rejects a malformed entry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nimbalyst-node-workspaces-'));
    const file = join(directory, 'workspaces.json');
    try {
      writeFileSync(file, JSON.stringify({
        workspaces: [{
          projectId: '/Users/someone/sources/stravu-editor',
          repoUrl: 'https://github.com/nimbalyst/nimbalyst.git',
          branch: 'main',
          checkoutDir: '/workspace/stravu-editor',
        }],
      }));

      const mappings = loadWorkspaces(file);
      // A trailing separator is not a different project.
      expect(findWorkspace(mappings, '/Users/someone/sources/stravu-editor/')?.checkoutDir)
        .toBe('/workspace/stravu-editor');
      expect(findWorkspace(mappings, '/Users/someone/sources/other')).toBeUndefined();

      writeFileSync(file, JSON.stringify({ workspaces: [{ projectId: '/p', branch: 'main' }] }));
      expect(() => loadWorkspaces(file)).toThrow(/entry 0 is missing "repoUrl"/);

      writeFileSync(file, JSON.stringify({ projects: [] }));
      expect(() => loadWorkspaces(file)).toThrow(/must contain a "workspaces" array/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('host attribution', () => {
  it('carries hostDeviceId in the FIRST publication, through the real synced store', async () => {
    const pushes: Array<{ sessionId: string; change: any }> = [];
    const created: Array<Record<string, unknown>> = [];

    const base = {
      ensureReady: async () => {},
      create: async (payload: any) => { created.push(payload); },
      updateMetadata: async () => {},
      get: async () => null,
      list: async () => [],
      search: async () => [],
      delete: async () => {},
    } as any;

    const syncProvider = {
      connect: async () => {},
      disconnect: () => {},
      disconnectAll: () => {},
      isConnected: () => true,
      getStatus: () => ({ connected: true, syncing: false, lastSyncedAt: null, error: null }),
      onStatusChange: () => () => {},
      onRemoteChange: () => () => {},
      pushChange: (sessionId: string, change: any) => { pushes.push({ sessionId, change }); },
    } as any;

    // The real runtime decorator, in the real order serve uses. Wrapping the
    // other way round would stamp the database and miss the wire.
    const store = withHostAttribution(
      createSyncedSessionStore(base, syncProvider),
      'sandbox-abc',
    );

    await store.create({
      id: 'session-1',
      workspaceId: PROJECT_ID_FOR_ATTRIBUTION,
      provider: 'claude-code',
    } as any);

    // The index entry is built from the create payload. A hostDeviceId written
    // afterwards is a second write racing the first -- and if it loses, the
    // session is published unattributed and the desktop offers it to nobody.
    expect(pushes).toHaveLength(1);
    expect(pushes[0].change.metadata).toMatchObject({ hostDeviceId: 'sandbox-abc' });
    expect((created[0] as any).metadata).toMatchObject({ hostDeviceId: 'sandbox-abc' });

    // And a later metadata write cannot drop it.
    pushes.length = 0;
    await store.updateMetadata('session-1', { metadata: { phase: 'implementing' } } as any);
    expect(pushes[0].change.metadata).toMatchObject({
      hostDeviceId: 'sandbox-abc',
      phase: 'implementing',
    });
  });
});

describe('execution-host eligibility', () => {
  it('reads the index after the socket settles, because announcing alone is not enough', async () => {
    const order: string[] = [];
    const log = vi.fn();

    const synced = await ensureIndexSynced({
      provider: {
        waitForIndexReady: async () => { order.push('ready'); },
        // The server marks the socket `synced` when it answers this, and
        // `selectExecutionHost` skips a socket that is not. CollabV3Sync issues
        // it from fetchIndex() and nowhere on connect.
        fetchIndex: async () => { order.push('fetch'); return { sessions: [{}, {}] }; },
      },
      log,
    });

    expect(synced).toBe(true);
    expect(order).toEqual(['ready', 'fetch']);
    expect(log).toHaveBeenCalledWith('index-synced', { sessions: 2 });
  });

  it('reports the consequence rather than throwing when the index read fails', async () => {
    const log = vi.fn();
    const synced = await ensureIndexSynced({
      provider: {
        waitForIndexReady: async () => {},
        fetchIndex: async () => { throw new Error('Index connection not available'); },
      },
      log,
    });

    expect(synced).toBe(false);
    expect(log).toHaveBeenCalledWith('index-sync-failed', expect.objectContaining({
      error: 'Index connection not available',
      consequence: 'this node is not yet eligible to host sessions',
    }));
  });
});

describe('credential rotation loop', () => {
  /**
   * A timer that never fires on its own. The point of every test here is WHEN
   * the next attempt was scheduled for, and a real timer would either make the
   * suite wait minutes or make the assertion about `vi.advanceTimersByTime`
   * rather than about the policy.
   */
  function fakeTimers() {
    const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    return {
      scheduled,
      setTimer: (fn: () => void, ms: number) => {
        scheduled.push({ fn, ms, cleared: false });
        return scheduled.length - 1;
      },
      clearTimer: (handle: unknown) => {
        const entry = scheduled[handle as number];
        if (entry) entry.cleared = true;
      },
      /** Fire the most recently scheduled timer, as the event loop would. */
      fire: async () => {
        const entry = scheduled[scheduled.length - 1];
        entry.fn();
        // Let the async tick behind the timer settle.
        await new Promise((resolve) => { setImmediate(resolve); });
        await new Promise((resolve) => { setImmediate(resolve); });
      },
    };
  }

  it('backs off on an unreachable server and never reports a revocation', async () => {
    const timers = fakeTimers();
    const log = vi.fn();
    const rotate = vi.fn(async () => { throw new Error('fetch failed'); });
    const onRevoked = vi.fn();

    const loop = createRefreshLoop({
      rotate,
      onRevoked,
      log,
      intervalMs: 720_000,
      retryBaseMs: 5_000,
      retryMaxMs: 20_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    loop.start();
    // Steady state first: the rotation is scheduled well inside the token's life.
    expect(loop.nextDelayMs()).toBe(720_000);

    // A blip must not wait out the next rotation cycle: the access token expires
    // at fifteen minutes and rotation runs at twelve, so "retry next cycle" is
    // nine minutes of a node that is up and answering nothing.
    await timers.fire();
    expect(loop.nextDelayMs()).toBe(5_000);
    await timers.fire();
    expect(loop.nextDelayMs()).toBe(10_000);
    await timers.fire();
    expect(loop.nextDelayMs()).toBe(20_000);
    await timers.fire();
    // Capped, not unbounded.
    expect(loop.nextDelayMs()).toBe(20_000);

    expect(onRevoked).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('credential-refresh-failed', expect.objectContaining({
      error: 'fetch failed',
      retryInMs: 5_000,
    }));

    // And a recovery returns to the steady cadence rather than staying in backoff.
    rotate.mockImplementationOnce(async () => {});
    await timers.fire();
    expect(loop.nextDelayMs()).toBe(720_000);
  });

  it('stops for good on a revoked credential and schedules nothing further', async () => {
    const timers = fakeTimers();
    const onRevoked = vi.fn();

    const loop = createRefreshLoop({
      rotate: async () => {
        throw new CredentialRevokedError('invalid_grant', 'rejected');
      },
      onRevoked,
      log: vi.fn(),
      intervalMs: 720_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    loop.start();
    await timers.fire();

    expect(onRevoked).toHaveBeenCalledWith('invalid_grant');
    expect(onRevoked).toHaveBeenCalledTimes(1);
    // Nothing pending: every further attempt is another chance to destroy a
    // replacement credential the desktop has since issued.
    expect(loop.nextDelayMs()).toBeUndefined();
    expect(timers.scheduled).toHaveLength(1);
  });
});

describe('serve shutdown', () => {
  function shutdownHarness(idle: () => Promise<void>) {
    const calls: string[] = [];
    return {
      calls,
      runtime: {
        stopIntake: () => { calls.push('stopIntake'); },
        cancelAll: async () => { calls.push('cancelAll'); },
        idle: async () => { calls.push('idle'); await idle(); },
      },
      disconnect: () => { calls.push('disconnect'); },
    };
  }

  it('cuts turns off before draining when the credential is revoked', async () => {
    const harness = shutdownHarness(async () => {});
    const unsubscribed = vi.fn();

    await shutdownServe({
      runtime: harness.runtime,
      unsubscribes: [
        () => { throw new Error('listener already gone'); },
        unsubscribed,
      ],
      disconnect: harness.disconnect,
      revoked: true,
      log: vi.fn(),
    });

    // cancelAll BEFORE idle: a dead socket cannot publish, so waiting for the
    // turn to finish streaming only burns the container's grace period.
    expect(harness.calls).toEqual(['stopIntake', 'cancelAll', 'idle', 'disconnect']);
    // A listener that throws must not strand the ones after it.
    expect(unsubscribed).toHaveBeenCalled();
  });

  it('holds cancellation to the same deadline as the drain', async () => {
    // A `cancel()` that never settles -- an SDK generator wedged on a socket
    // read -- used to sit OUTSIDE the timeout race and hold shutdown open until
    // the container's grace period ran out into a SIGKILL mid-write.
    const calls: string[] = [];
    const log = vi.fn();

    const started = Date.now();
    await shutdownServe({
      runtime: {
        stopIntake: () => { calls.push('stopIntake'); },
        cancelAll: () => new Promise<void>(() => { calls.push('cancelAll'); }),
        idle: async () => { calls.push('idle'); },
      },
      unsubscribes: [],
      disconnect: () => { calls.push('disconnect'); },
      revoked: true,
      graceMs: 20,
      log,
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toContain('disconnect');
    expect(log).toHaveBeenCalledWith('drain-timeout', expect.objectContaining({ timeoutMs: 20 }));
    // A tight per-test timeout on purpose: the regression this guards is a
    // shutdown that never returns, and the default 20s would be paid on every
    // future run that reintroduces it.
  }, 2_000);

  it('bounds the drain and still disconnects when work will not finish', async () => {
    const harness = shutdownHarness(() => new Promise<void>(() => {}));
    const log = vi.fn();

    await shutdownServe({
      runtime: harness.runtime,
      unsubscribes: [],
      disconnect: harness.disconnect,
      revoked: false,
      graceMs: 20,
      log,
    });

    expect(harness.calls).toEqual(['stopIntake', 'idle', 'cancelAll', 'disconnect']);
    expect(log).toHaveBeenCalledWith('drain-timeout', expect.objectContaining({ timeoutMs: 20 }));
  });
});

describe('transcript publication', () => {
  it('preserves provider message identity through the node publication adapter', async () => {
    const onMessageCreated = vi.fn(async () => ({ published: true }));
    const store = createSyncedAgentMessagesStore(baseStore().store, { onMessageCreated }, vi.fn());
    await store.create({ ...message('answer'), providerMessageId: 'sdk-uuid' });
    await store.flushPending();
    expect(onMessageCreated).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: 'sdk-uuid' }), expect.any(Number));
  });
  function baseStore() {
    const written: string[] = [];
    return {
      written,
      store: {
        create: async (message: { content: string }) => { written.push(message.content); },
        list: async () => [],
      } as unknown as Parameters<typeof createSyncedAgentMessagesStore>[0],
    };
  }

  function message(content: string) {
    return {
      sessionId: 'session-1',
      source: 'assistant' as const,
      direction: 'output' as const,
      content,
      createdAt: new Date(1_700_000_000_000),
    };
  }

  it('waits for the REAL send, not just the decision to send', async () => {
    // Deliberately the production `createMessageSyncHandler`, not a stub. The
    // handler used to call `pushChange` without awaiting it, so every flush here
    // resolved while encryption and the socket write were still outstanding --
    // and a stub that resolves when it is called cannot tell the difference. If
    // the runtime's `await syncProvider.pushChange(...)` is removed, this test
    // is the one that goes red.
    const base = baseStore();
    const log = vi.fn();
    let release: (() => void) | undefined;
    const sent: string[] = [];

    const provider = {
      isConnected: () => true,
      connect: async () => {},
      pushChange: async (_sessionId: string, change: { type: string }) => {
        if (change.type !== 'message_added') return;
        await new Promise<void>((resolve) => { release = resolve; });
        sent.push('message_added');
      },
    } as unknown as Parameters<typeof createMessageSyncHandler>[0];

    const store = createSyncedAgentMessagesStore(
      base.store,
      createMessageSyncHandler(provider),
      log,
    );

    await store.create(message('first'));
    // The local write is done and the row is NOT on the wire. Disconnecting here
    // strands it: correct in this container's database, invisible on every
    // device the user owns.
    expect(base.written).toEqual(['first']);
    expect(sent).toEqual([]);

    expect(await store.flushPending(10)).toBe(1);

    release!();
    expect(await store.flushPending(200)).toBe(0);
    expect(sent).toEqual(['message_added']);
  });

  it('retains a row the REAL handler could not connect for', async () => {
    // The handler reports a failed connect by RETURNING `{ published: false }`
    // -- it never threw, and it still does not. A store that only watched for a
    // rejection therefore recorded zero failures while sending nothing, which
    // is the worst possible shape: a node that looks healthy and is silent.
    const base = baseStore();
    const log = vi.fn();
    let reachable = false;
    const pushed: string[] = [];

    const provider = {
      isConnected: () => reachable,
      connect: async () => {
        if (!reachable) throw new Error('index socket is not open');
      },
      pushChange: async (_sessionId: string, change: { type: string }) => {
        pushed.push(change.type);
      },
    } as unknown as Parameters<typeof createMessageSyncHandler>[0];

    const store = createSyncedAgentMessagesStore(
      base.store,
      createMessageSyncHandler(provider),
      log,
    );

    await store.create(message('stranded'));
    expect(await store.flushPending(50)).toBe(0);
    expect(pushed).toEqual([]);
    expect(store.failedCount()).toBe(1);

    reachable = true;
    expect(await store.retryFailed()).toBe(0);
    expect(pushed).toContain('message_added');
  });

  it('keeps the flush open while a reconnect retry is still publishing', async () => {
    // The retry runs on a reconnect, and shutdown can begin at any point after
    // that. A retry that is not registered as pending makes `flushPending()`
    // report zero while rows are still on their way out, and the socket is then
    // torn down underneath them -- the exact loss the flush exists to prevent.
    const base = baseStore();
    const log = vi.fn();
    let connected = false;
    let release: (() => void) | undefined;
    const sent: string[] = [];

    const store = createSyncedAgentMessagesStore(
      base.store,
      {
        onMessageCreated: async (published) => {
          if (!connected) throw new Error('socket closed');
          await new Promise<void>((resolve) => { release = resolve; });
          sent.push(published.content);
        },
      },
      log,
    );

    await store.create(message('slow-retry'));
    expect(await store.flushPending(50)).toBe(0);
    expect(store.failedCount()).toBe(1);

    connected = true;
    const retrying = store.retryFailed();
    // Give the batch a tick to start and park on the deferred publication.
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(await store.flushPending(10)).toBe(1);
    expect(sent).toEqual([]);

    release!();
    expect(await retrying).toBe(0);
    expect(await store.flushPending(200)).toBe(0);
    expect(sent).toEqual(['slow-retry']);
  });

  it('does not retain a row the provider deliberately did not send', async () => {
    // Filtered content and sync-disabled sessions come back `published: false`
    // too. Retaining those means retrying forever something that will be
    // refused identically every time.
    const base = baseStore();
    const log = vi.fn();

    const store = createSyncedAgentMessagesStore(
      base.store,
      {
        onMessageCreated: async () => ({
          published: false,
          reason: 'filtered from session-room sync',
          retryable: false,
        }),
      },
      log,
    );

    await store.create(message('filtered'));
    expect(await store.flushPending(50)).toBe(0);
    expect(store.failedCount()).toBe(0);
    expect(log).toHaveBeenCalledWith('transcript-not-published', expect.objectContaining({
      reason: 'filtered from session-room sync',
    }));
  });

  it('retains a failed publication and retries it when the socket comes back', async () => {
    const base = baseStore();
    const log = vi.fn();
    let connected = false;
    const sent: string[] = [];

    const store = createSyncedAgentMessagesStore(
      base.store,
      {
        onMessageCreated: async (published) => {
          if (!connected) throw new Error('socket closed');
          sent.push(published.content);
        },
      },
      log,
    );

    // The local write still succeeds: a sync failure must never fail a write
    // that already landed.
    await expect(store.create(message('orphan'))).resolves.toBeUndefined();
    expect(await store.flushPending(50)).toBe(0);
    expect(base.written).toEqual(['orphan']);
    expect(store.failedCount()).toBe(1);
    expect(log).toHaveBeenCalledWith('transcript-sync-failed', expect.objectContaining({
      sessionId: 'session-1',
      error: 'socket closed',
    }));

    // The usual cause is a send that raced the twelve-minute rotation, so the
    // reconnect is exactly when a retry can work.
    connected = true;
    expect(await store.retryFailed()).toBe(0);
    expect(sent).toEqual(['orphan']);
    expect(store.failedCount()).toBe(0);
  });
});

describe('serve log', () => {
  it('renders one line per transition and never breaks it across a multi-line value', () => {
    const lines: string[] = [];
    const log = createStderrLogger((line) => lines.push(line));

    log('turn-finished', {
      sessionId: 'session-1',
      error: 'fatal: could not read\nUsername for https://github.com',
      absent: undefined,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      '[nimbalyst-node] turn-finished sessionId=session-1 '
      + 'error="fatal: could not read Username for https://github.com"\n',
    );
    expect(lines[0]).not.toContain('absent');
  });
});
