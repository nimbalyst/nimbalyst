// @vitest-environment node
/**
 * GitHub #1988: when the live SQLite worker died (ERR_WORKER_OUT_OF_MEMORY),
 * the proxy nulled it and never restarted it, so every database call failed
 * until the app restarted. These tests drive `SQLiteDatabaseProxy` against a
 * fake Worker to pin the recovery lifecycle and the transport outcome codes
 * the message queue depends on.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type Posted = { id: string; type: string; payload?: unknown };

const spawned: FakeWorker[] = [];
/** Per-request-type behavior for every fake worker. Default: reply success. */
let behavior: (w: FakeWorker, msg: Posted) => 'reply' | 'hang' | 'fail' = () => 'reply';

class FakeWorker extends EventEmitter {
  posted: Posted[] = [];
  exited = false;
  constructor(_path: string) {
    super();
    spawned.push(this);
  }
  postMessage(msg: Posted & { bridgeResponse?: boolean }): void {
    if (msg.bridgeResponse) return;
    this.posted.push(msg);
    const mode = behavior(this, msg);
    if (mode === 'hang') return;
    queueMicrotask(() => {
      if (this.exited) return;
      if (mode === 'fail') {
        this.emit('message', { id: msg.id, success: false, error: { message: `${msg.type} failed` } });
      } else {
        this.emit('message', { id: msg.id, success: true, data: { rows: [] } });
      }
    });
  }
  crash(code = 1): void {
    this.exited = true;
    this.emit('exit', code);
  }
  async terminate(): Promise<number> {
    if (!this.exited) this.crash(1);
    return 1;
  }
}

// The factory is hoisted above the class, so it defers to it at construction.
vi.mock('worker_threads', () => ({
  Worker: class {
    constructor(p: string) {
      return new FakeWorker(p);
    }
  },
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: () => {}, warn: () => {}, error: () => {} } },
}));
vi.mock('../../../utils/store', () => ({
  getDatabaseMaintenanceSettings: () => ({ backupCopiesKept: 3 }),
}));
vi.mock('../../../utils/appPaths', () => ({ getPackageRoot: () => os.tmpdir() }));

type ProxyModule = typeof import('../SQLiteDatabaseProxy');
let SQLiteDatabaseProxy: ProxyModule['SQLiteDatabaseProxy'];
let DB_REQUEST_NOT_SUBMITTED: string;
let DB_REQUEST_OUTCOME_UNKNOWN: string;
type Proxy = InstanceType<ProxyModule['SQLiteDatabaseProxy']>;

beforeAll(async () => {
  ({ SQLiteDatabaseProxy, DB_REQUEST_NOT_SUBMITTED, DB_REQUEST_OUTCOME_UNKNOWN } = await import(
    '../SQLiteDatabaseProxy'
  ));
});

let dbDir: string;

beforeEach(() => {
  spawned.length = 0;
  behavior = () => 'reply';
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-recovery-'));
  fs.writeFileSync(path.join(dbDir, 'nimbalyst.sqlite'), '');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

async function liveProxy(): Promise<Proxy> {
  const proxy = new SQLiteDatabaseProxy({ dbDir, schemaDir: dbDir });
  await proxy.initialize();
  expect(spawned).toHaveLength(1);
  return proxy;
}

const types = (w: FakeWorker) => w.posted.map((m) => m.type);

describe('SQLiteDatabaseProxy worker recovery', () => {
  it('respawns and re-inits the live worker after an unexpected exit, and holds new requests until it is ready', async () => {
    const proxy = await liveProxy();
    behavior = (_w, msg) => (msg.type === 'query' ? 'hang' : 'reply');
    const inFlight = proxy.query('INSERT INTO t VALUES (1)');
    await Promise.resolve();

    spawned[0].crash(1);
    await expect(inFlight).rejects.toMatchObject({ code: DB_REQUEST_OUTCOME_UNKNOWN });

    behavior = () => 'reply';
    const afterCrash = proxy.query('SELECT 1');
    await vi.advanceTimersByTimeAsync(300);

    await expect(afterCrash).resolves.toEqual({ rows: [] });
    expect(spawned).toHaveLength(2);
    expect(types(spawned[1])).toEqual(['init', 'query']);
    expect(proxy.isInitialized()).toBe(true);
  });

  it('ignores a late exit from the dead worker once its replacement is serving', async () => {
    const proxy = await liveProxy();
    spawned[0].crash(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(spawned).toHaveLength(2);

    behavior = (_w, msg) => (msg.type === 'query' ? 'hang' : 'reply');
    let settled = false;
    const onNew = proxy.query('SELECT 1').finally(() => { settled = true; });
    await Promise.resolve();
    spawned[0].emit('exit', 1);
    await Promise.resolve();
    expect(settled).toBe(false);

    spawned[1].crash(1);
    await expect(onNew).rejects.toMatchObject({ code: DB_REQUEST_OUTCOME_UNKNOWN });
  });

  it('does not respawn a migration-only worker that never opened the live store', async () => {
    const proxy = new SQLiteDatabaseProxy({ dbDir, schemaDir: dbDir });
    proxy.ensureWorkerSpawned();
    spawned[0].crash(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(spawned).toHaveLength(1);
    await expect(proxy.query('SELECT 1')).rejects.toMatchObject({ code: DB_REQUEST_NOT_SUBMITTED });
  });

  it('refuses to respawn when the live store file is gone, instead of creating an empty one', async () => {
    const proxy = await liveProxy();
    fs.rmSync(path.join(dbDir, 'nimbalyst.sqlite'));
    spawned[0].crash(1);
    const waiting = proxy.query('SELECT 1');
    const assertion = expect(waiting).rejects.toMatchObject({ code: DB_REQUEST_NOT_SUBMITTED });
    await vi.advanceTimersByTimeAsync(300);

    await assertion;
    expect(spawned).toHaveLength(1);
  });

  it('does not respawn after an explicit close that lands during the backoff delay', async () => {
    const proxy = await liveProxy();
    spawned[0].crash(1);
    await vi.advanceTimersByTimeAsync(50);
    await proxy.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(spawned).toHaveLength(1);
    expect(proxy.isInitialized()).toBe(false);
  });

  it('stops restarting after repeated crashes inside the crash window, then rate-limits explicit initialize', async () => {
    const proxy = await liveProxy();
    for (let i = 0; i < 5; i++) {
      spawned[spawned.length - 1].crash(1);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(spawned).toHaveLength(6);

    spawned[5].crash(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawned).toHaveLength(6);

    await expect(proxy.query('SELECT 1')).rejects.toMatchObject({ code: DB_REQUEST_NOT_SUBMITTED });
    await expect(proxy.initialize()).rejects.toMatchObject({ code: DB_REQUEST_NOT_SUBMITTED });
    expect(spawned).toHaveLength(6);

    await vi.advanceTimersByTimeAsync(31_000);
    await proxy.initialize();
    expect(spawned).toHaveLength(7);
    expect(proxy.isInitialized()).toBe(true);
  });

  it('retries initialization after a failed init instead of returning the cached failure', async () => {
    behavior = (_w, msg) => (msg.type === 'init' ? 'fail' : 'reply');
    const proxy = new SQLiteDatabaseProxy({ dbDir, schemaDir: dbDir });
    await expect(proxy.initialize()).rejects.toThrow(/init failed/);

    behavior = () => 'reply';
    await proxy.initialize();
    expect(proxy.isInitialized()).toBe(true);
    expect(types(spawned[0])).toEqual(['init', 'init']);
  });

  it('never posts a request after it was rejected as not-submitted while waiting for recovery', async () => {
    const proxy = new SQLiteDatabaseProxy({ dbDir, schemaDir: dbDir, requestTimeoutMs: 100 });
    await proxy.initialize();
    spawned[0].crash(1);
    const waiting = proxy.query('INSERT INTO t VALUES (1)');
    const assertion = expect(waiting).rejects.toMatchObject({ code: DB_REQUEST_NOT_SUBMITTED });
    // Times out while recovery is still in its 250ms backoff.
    await vi.advanceTimersByTimeAsync(150);
    await assertion;

    await vi.advanceTimersByTimeAsync(300);
    expect(spawned).toHaveLength(2);
    expect(types(spawned[1])).toEqual(['init']);
  });

  it('terminates a hung recovery init on close instead of waiting out its timeout', async () => {
    const proxy = await liveProxy();
    behavior = (w, msg) => (msg.type === 'init' && w !== spawned[0] ? 'hang' : 'reply');
    spawned[0].crash(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(spawned).toHaveLength(2);

    let closed = false;
    const closing = proxy.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(closed).toBe(true);
    await closing;
    expect(spawned[1].exited).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawned).toHaveLength(2);
  });
});
