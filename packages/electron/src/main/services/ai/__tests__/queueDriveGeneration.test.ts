// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QueueDriveService, type DriveOutcome } from '../QueueDriveService';
import { runQueueDriveAttempt } from '../queueDriveAttempt';
import { SessionProcessingGuard, tryClaimAndDispatchNextQueuedPrompt } from '../queuedPromptDispatcher';
import { performTurnInterruption, isTurnAdmissionBlocked } from '../sessionTurnControl';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { createPGLiteQueuedPromptsStore } from '../../PGLiteQueuedPromptsStore';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
const flush = () => new Promise<void>(done => setImmediate(done));
afterEach(() => vi.useRealTimers());

async function fixture(phase: 'drive-read' | 'window-read' | 'claim-read' | 'claim-write' | 'start-write' | 'provider') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'in09-generation-'));
  const db = new SQLiteDatabase({ dbDir: dir, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas') });
  await db.initialize();
  const sessionId = `generation-${phase}`;
  await db.query('INSERT INTO ai_sessions(id, provider, title) VALUES ($1, $2, $3)', [sessionId, 'opencode', 'test']);
  const store = createPGLiteQueuedPromptsStore(db as never);
  const text = 'Original queued text\n  preserve exactly once.';
  await store.create({ id: 'head', sessionId, prompt: text });
  if (phase === 'claim-write' || phase === 'start-write' || phase === 'provider') {
    await store.create({ id: 'tail', sessionId, prompt: 'Must remain behind the head' });
  }
  const entered = deferred();
  const gate = deferred();
  const retryWriteEntered = deferred();
  const retryWrite = deferred();
  let pauseRetryWrite = false;
  let parked = false;
  const park = async (at: typeof phase) => {
    if (at !== phase || parked) return;
    parked = true;
    entered.resolve();
    await gate.promise;
  };
  const guard = new SessionProcessingGuard();
  const send = vi.fn(async (_event, message: string) => {
    await db.query('INSERT INTO ai_agent_messages(session_id, source, direction, content, created_at) VALUES ($1, $2, $3, $4, $5)', [sessionId, 'test', 'input', message, new Date().toISOString()]);
    await park('provider');
    return { content: 'ok' };
  });
  const releaseClaims = vi.fn((claims) => store.releaseClaims(claims));
  const attempt = vi.fn(({ signal }) => runQueueDriveAttempt({
    listPendingIds: async () => { await park('drive-read'); return (await store.listPending(sessionId)).map(row => row.id); },
    isChainActive: () => guard.has(sessionId), isSessionBusy: () => isTurnAdmissionBlocked(sessionId),
    resolveWindow: async () => { await park('window-read'); return { kind: 'window' as const, window: {} as any, opened: false }; },
    failAllPending: async () => 0, logWarn: vi.fn(),
    dispatch: ({ signal: dispatchSignal }) => tryClaimAndDispatchNextQueuedPrompt({
      signal: dispatchSignal,
      queueStore: {
        ...store,
        listPending: async (id) => { await park('claim-read'); return store.listPending(id); },
        claim: async (id) => {
          const row = await store.claim(id);
          await park('claim-write');
          if (pauseRetryWrite) {
            pauseRetryWrite = false;
            retryWriteEntered.resolve();
            await retryWrite.promise;
          }
          return row;
        },
        releaseClaims,
      },
      processingSet: guard, sendMessageHandler: send,
      startSession: async () => { await park('start-write'); },
      continueQueuedPromptChain: async () => {}, onPromptClaimed: vi.fn(), logError: vi.fn(), logInfo: vi.fn(),
      sessionId, workspacePath: '/workspace', source: 'generation-test',
      targetWindow: { isDestroyed: () => false, webContents: { mainFrame: {} } } as any,
    }),
  }, { sessionId, workspacePath: '/workspace', reason: 'send-now', signal }));
  const logInfo = vi.fn();
  const driver = new QueueDriveService({ attempt, onWindowAvailable: () => () => {}, onSessionIdle: () => () => {}, logInfo, logWarn: vi.fn(), logError: vi.fn() });
  const drive = () => driver.drive(sessionId, '/workspace', 'send-now');
  const control = () => performTurnInterruption({
    sessionId, mode: 'stop', provider: null, isCurrentProvider: () => true, guard,
    retireInbox: async () => {}, sweep: async () => { await store.sweepExecutingForSession(sessionId); }, settle: async () => {},
    drive, invalidateDrive: (expected) => driver.invalidate(sessionId, expected), logError: vi.fn(), timeouts: { stageMs: 20 },
  });
  return { db, store, sessionId, text, guard, send, driver, attempt, logInfo, releaseClaims, drive, control, entered: entered.promise,
    release: () => gate.resolve(),
    parkRetryWrite: () => { pauseRetryWrite = true; return retryWriteEntered.promise; },
    releaseRetryWrite: () => retryWrite.resolve(),
    close: async () => { driver.dispose(); gate.resolve(); retryWrite.resolve(); await flush(); await db.close(); fs.rmSync(dir, { recursive: true }); },
  };
}

it.each(['drive-read', 'window-read', 'claim-read'] as const)('replaces a never-settling %s and ignores its late return', async phase => {
  const f = await fixture(phase);
  try {
    const old = f.drive();
    await f.entered;
    f.driver.invalidate(f.sessionId);
    await expect(old).resolves.toMatchObject({ kind: 'deferred' });
    await expect(f.drive()).resolves.toMatchObject({ kind: 'dispatched' });
    await flush();
    expect(await f.store.get('head')).toMatchObject({ status: 'completed', prompt: f.text });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.guard.has(f.sessionId)).toBe(false);
    const logCount = f.logInfo.mock.calls.length;
    f.release();
    await flush();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.logInfo).toHaveBeenCalledTimes(logCount);
    expect(f.guard.has(f.sessionId)).toBe(false);
    const rows = await f.db.query<{ content: string }>('SELECT content FROM ai_agent_messages WHERE direction = $1', ['input']);
    expect(rows.rows.map(row => row.content)).toEqual([f.text]);
  } finally { await f.close(); }
});

it('a second stalled recovery drive still permits a later Stop to retry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const signals: AbortSignal[] = [];
  const driver = new QueueDriveService({
    attempt: async ({ signal }) => {
      signals.push(signal);
      if (signals.length <= 2) return new Promise<DriveOutcome>(() => {});
      return { kind: 'nothing-pending' };
    },
    onWindowAvailable: () => () => {}, onSessionIdle: () => () => {}, logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
  });
  const sessionId = 'two-stalled-generations';
  const control = () => performTurnInterruption({
    sessionId, mode: 'stop', provider: null, isCurrentProvider: () => true, guard: new Set(),
    retireInbox: async () => {}, sweep: async () => {}, settle: async () => {},
    drive: () => driver.drive(sessionId, '/ws', 'send-now'), invalidateDrive: () => driver.invalidate(sessionId),
    logError: vi.fn(), timeouts: { stageMs: 20 },
  });
  try {
    const first = control();
    await vi.advanceTimersByTimeAsync(40);
    expect((await first).success).toBe(false);
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(isTurnAdmissionBlocked(sessionId)).toBe(false);
    expect((await control()).success).toBe(true);
    expect(signals).toHaveLength(3);
  } finally { driver.dispose(); }
});

it.each(['claim-write', 'start-write'] as const)('quarantines an unknown %s until exact rollback then replacement', async phase => {
  const f = await fixture(phase);
  try {
    const old = f.drive();
    await f.entered;
    f.driver.invalidate(f.sessionId);
    await old;
    expect(f.guard.has(f.sessionId)).toBe(true);
    await expect(f.drive()).resolves.toMatchObject({ kind: 'deferred', reason: 'session-busy' });
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.store.get('head'))?.status).toBe('executing');
    expect((await f.store.get('tail'))?.status).toBe('pending');
    f.release();
    await flush();
    expect((await f.store.get('head'))?.status).toBe('pending');
    expect(f.guard.has(f.sessionId)).toBe(false);
    await expect(f.drive()).resolves.toMatchObject({ kind: 'dispatched' });
    await flush();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.releaseClaims).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it('Stop recovers its timed-out never-settling drive without waiting for the old read', async () => {
  const f = await fixture('claim-read');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const stopping = f.control();
    await f.entered;
    await vi.advanceTimersByTimeAsync(20);
    expect((await stopping).success).toBe(false);
    await flush();
    expect(f.send).toHaveBeenCalledOnce();
    expect((await f.store.get('head'))?.status).toBe('completed');
    expect(isTurnAdmissionBlocked(f.sessionId)).toBe(false);
  } finally { await f.close(); }
});

it('invalidation after provider entry preserves delivery and completion authority', async () => {
  const f = await fixture('provider');
  try {
    await f.drive();
    await f.entered;
    f.driver.invalidate(f.sessionId);
    await expect(f.drive()).resolves.toMatchObject({ kind: 'deferred' });
    expect(f.releaseClaims).not.toHaveBeenCalled();
    f.release();
    await flush();
    expect((await f.store.get('head'))?.status).toBe('completed');
    expect(f.send).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it('a newer Stop owns an unknown write created by the old recovery retry', async () => {
  const f = await fixture('claim-read');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const first = f.control();
    await f.entered;
    const retryWrite = f.parkRetryWrite();
    await vi.advanceTimersByTimeAsync(20);
    expect((await first).success).toBe(false);
    await retryWrite;
    const newer = f.control();
    await vi.advanceTimersByTimeAsync(20);
    expect((await newer).success).toBe(false);
    expect(isTurnAdmissionBlocked(f.sessionId)).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.store.get('head'))?.status).toBe('executing');
    f.releaseRetryWrite();
    await flush();
    await flush();
    expect((await f.store.get('head'))?.status).toBe('completed');
    expect(f.send).toHaveBeenCalledOnce();
    expect(isTurnAdmissionBlocked(f.sessionId)).toBe(false);
    // The first generation's still-parked read remains harmless.
    f.release();
    await flush();
    expect(f.send).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it('a retired read cannot release the replacement claim lease', async () => {
  const f = await fixture('claim-read');
  try {
    const old = f.drive();
    await f.entered;
    f.driver.invalidate(f.sessionId);
    await old;
    const replacement = f.guard.beginClaim(f.sessionId)!;
    f.release();
    await flush();
    expect(f.guard.has(f.sessionId)).toBe(true);
    expect(f.guard.beginClaim(f.sessionId)).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
    f.guard.endClaim(f.sessionId, replacement);
    await expect(f.drive()).resolves.toMatchObject({ kind: 'dispatched' });
    await flush();
    expect(f.send).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it.each(['claim-write', 'start-write'] as const)('a timed-out Stop waits for %s then retries without late delivery', async phase => {
  const f = await fixture(phase);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const stopping = f.control();
    await f.entered;
    await vi.advanceTimersByTimeAsync(20);
    expect((await stopping).success).toBe(false);
    expect(isTurnAdmissionBlocked(f.sessionId)).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
    await f.drive();
    expect((await f.store.get('tail'))?.status).toBe('pending');
    f.release();
    await flush();
    await flush();
    expect(f.send).toHaveBeenCalledOnce();
    expect((await f.store.get('head'))?.status).toBe('completed');
    expect(isTurnAdmissionBlocked(f.sessionId)).toBe(false);
    expect(f.releaseClaims).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it('late old outcomes cannot disarm a replacement retry or clear its in-flight identity', async () => {
  const old = deferred<DriveOutcome>();
  const replacement = deferred<DriveOutcome>();
  let calls = 0;
  const timers = { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() };
  const service = new QueueDriveService({
    attempt: async () => ++calls === 1 ? old.promise : replacement.promise,
    timers, onWindowAvailable: () => () => {}, onSessionIdle: () => () => {}, logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
  });
  try {
    const first = service.drive('identity', '/ws', 'send-now');
    await flush();
    service.invalidate('identity');
    await first;
    const second = service.drive('identity', '/ws', 'send-now');
    await flush();
    // A late timeout belonging to the retired client must not abort this one.
    service.invalidate('identity', first);
    old.resolve({ kind: 'nothing-pending' });
    await flush();
    expect(service.drive('identity', '/ws', 'renderer-trigger')).toBe(second);
    replacement.resolve({ kind: 'deferred', reason: 'no-window' });
    await second;
    expect(timers.setTimeout).toHaveBeenCalledOnce();
    expect(timers.clearTimeout).not.toHaveBeenCalled();
  } finally { service.dispose(); }
});
