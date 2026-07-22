import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import {
  mkdtemp, readFile, readdir, rm, utimes, writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createInterface } from 'readline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';
import {
  createHostControlMutationCoordinator,
  hostControlMutationCoordinator,
  resolveHostControlOperationNamespace,
  type HostControlStoreIdentity,
} from '../HostControlMutationCoordinator';

const MAX_SEQUENCE = 999_999_999_999;
const MAX_EPOCH = 99_999_999;
const SHARED_PROCESS_IDENTITY_KEY = Symbol.for(
  'nimbalyst.host-control-mutation-coordinator.current-process-identity.v1',
);
const pendingChildren = new Set<ChildProcessWithoutNullStreams>();

function resetSharedProcessIdentity(): void {
  delete (globalThis as unknown as Record<PropertyKey, unknown>)[SHARED_PROCESS_IDENTITY_KEY];
}

function boundedBarrier(name: string, timeoutMs = 2_000) {
  let release!: () => void;
  let timer!: NodeJS.Timeout;
  const promise = new Promise<void>((resolvePromise, reject) => {
    release = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    timer = setTimeout(() => reject(new Error(`${name}_timeout`)), timeoutMs);
  });
  return { promise, release };
}

function checksum(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fakeCoordinator(pid: number, processIdentity: string, live = new Map<number, string>()) {
  live.set(pid, processIdentity);
  return createHostControlMutationCoordinator({
    acquireTimeoutMs: 750,
    retryMs: 2,
    recoveryGraceMs: 0,
    pid,
    processIdentity,
    isProcessAlive: (candidate) => live.has(candidate),
    getProcessIdentity: async (candidate) => live.get(candidate) ?? null,
  });
}

async function makeIdentity(prefix: string): Promise<{ root: string; identity: HostControlStoreIdentity }> {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  return {
    root,
    identity: { storeId: `${prefix}-store`, authorityRoot: join(root, 'authority') },
  };
}

async function nextLine(child: ChildProcessWithoutNullStreams, name: string): Promise<string> {
  const lines = createInterface({ input: child.stdout });
  try {
    return await Promise.race([
      new Promise<string>((resolvePromise) => lines.once('line', resolvePromise)),
      new Promise<string>((_, reject) => setTimeout(
        () => reject(new Error(`${name}_timeout`)), 2_000,
      )),
    ]);
  } finally {
    lines.close();
  }
}

async function drainChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    pendingChildren.delete(child);
    return;
  }
  if (child.exitCode === null && child.signalCode === null) child.stdin.end('release\n');
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())),
    new Promise<void>((resolvePromise) => setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      resolvePromise();
    }, 2_000)),
  ]);
  pendingChildren.delete(child);
}

afterEach(async () => {
  await Promise.all([...pendingChildren].map(drainChild));
  resetSharedProcessIdentity();
  vi.restoreAllMocks();
});

describe('HostControlMutationCoordinator durable authority journal', () => {
  it('starts the acquisition deadline after a delayed positive current-process identity prerequisite', async () => {
    const { root, identity } = await makeIdentity('nim364-identity-prerequisite');
    let clock = 10_000;
    resetSharedProcessIdentity();
    const getProcessIdentity = vi.fn(async () => {
      clock += 5_000;
      return 'boot:current-process';
    });
    const coordinator = createHostControlMutationCoordinator({
      acquireTimeoutMs: 50,
      retryMs: 1,
      pid: process.pid,
      getProcessIdentity,
      now: () => clock,
    });
    try {
      await expect(coordinator.withOperationLock(
        identity,
        'delayed-identity',
        async () => 'entered',
      )).resolves.toBe('entered');
      expect(getProcessIdentity).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shares one positive current-process identity across coordinator module reloads', async () => {
    const { root, identity } = await makeIdentity('nim364-shared-identity');
    resetSharedProcessIdentity();
    const getProcessIdentity = vi.fn(async () => 'boot:shared-current-process');
    try {
      vi.resetModules();
      const firstModule = await import('../HostControlMutationCoordinator');
      vi.resetModules();
      const secondModule = await import('../HostControlMutationCoordinator');
      const first = firstModule.createHostControlMutationCoordinator({
        pid: process.pid,
        getProcessIdentity,
      });
      const second = secondModule.createHostControlMutationCoordinator({
        pid: process.pid,
        getProcessIdentity,
      });
      await Promise.all([
        first.withOperationLock(identity, 'shared-identity-a', async () => undefined),
        second.withOperationLock(identity, 'shared-identity-b', async () => undefined),
      ]);
      expect(getProcessIdentity).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not cache an unavailable current-process identity or publish authority records', async () => {
    const { root, identity } = await makeIdentity('nim364-unavailable-identity');
    resetSharedProcessIdentity();
    const getProcessIdentity = vi.fn(async () => null);
    const coordinator = createHostControlMutationCoordinator({
      pid: process.pid,
      getProcessIdentity,
    });
    try {
      await expect(coordinator.withOperationLock(
        identity,
        'unavailable-identity',
        async () => undefined,
      )).rejects.toThrow('host_control_mutation_owner_identity_unavailable');
      await expect(coordinator.withOperationLock(
        identity,
        'unavailable-identity',
        async () => undefined,
      )).rejects.toThrow('host_control_mutation_owner_identity_unavailable');
      expect(getProcessIdentity).toHaveBeenCalledTimes(2);
      const namespace = await resolveHostControlOperationNamespace(identity, 'unavailable-identity');
      expect(await readdir(namespace.directory)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a slow foreign-owner liveness lookup inside the acquisition deadline', async () => {
    const { root, identity } = await makeIdentity('nim364-foreign-identity-deadline');
    const releasePaused = boundedBarrier('foreign_identity_release_paused');
    const releaseResume = boundedBarrier('foreign_identity_release_resume');
    let clock = 20_000;
    let ownerPromise: Promise<void> | undefined;
    const owner = createHostControlMutationCoordinator({
      pid: 701,
      processIdentity: 'boot:owner-701',
      isProcessAlive: () => true,
      getProcessIdentity: async () => 'boot:owner-701',
      now: () => clock,
      beforeReleasePublished: async () => {
        releasePaused.release();
        await releaseResume.promise;
      },
    });
    const contender = createHostControlMutationCoordinator({
      acquireTimeoutMs: 50,
      retryMs: 1,
      pid: 702,
      processIdentity: 'boot:owner-702',
      isProcessAlive: (pid) => pid === 701 || pid === 702,
      getProcessIdentity: async (pid) => {
        if (pid === 701) clock += 50;
        return `boot:owner-${pid}`;
      },
      now: () => clock,
    });
    try {
      ownerPromise = owner.withOperationLock(identity, 'foreign-owner', async () => undefined);
      await releasePaused.promise;
      await expect(contender.withOperationLock(
        identity,
        'foreign-owner',
        async () => 'must-not-enter',
      )).rejects.toThrow('host_control_mutation_lock_timeout');
    } finally {
      releaseResume.release();
      await Promise.allSettled(ownerPromise ? [ownerPromise] : []);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes independently loaded modules by canonical store and operation identity', async () => {
    const { root, identity } = await makeIdentity('nim364-module-isolates');
    const entered = boundedBarrier('first_module_entered');
    const resume = boundedBarrier('first_module_resume');
    const secondContended = boundedBarrier('second_module_contended');
    let firstPromise: Promise<void> | undefined;
    let secondPromise: Promise<void> | undefined;
    try {
      vi.resetModules();
      const firstModule = await import('../HostControlMutationCoordinator');
      vi.resetModules();
      const secondModule = await import('../HostControlMutationCoordinator');
      const live = new Map([[101, 'boot:start-101'], [102, 'boot:start-102']]);
      const first = firstModule.createHostControlMutationCoordinator({
        pid: 101, processIdentity: live.get(101), retryMs: 2,
        isProcessAlive: (pid) => live.has(pid),
        getProcessIdentity: async (pid) => live.get(pid) ?? null,
      });
      const second = secondModule.createHostControlMutationCoordinator({
        pid: 102, processIdentity: live.get(102), retryMs: 2,
        isProcessAlive: (pid) => live.has(pid),
        getProcessIdentity: async (pid) => live.get(pid) ?? null,
        onContention: () => secondContended.release(),
      });
      const order: string[] = [];
      firstPromise = first.withOperationLock(identity, 'same-operation', async () => {
        order.push('first-enter');
        entered.release();
        await resume.promise;
        order.push('first-exit');
      });
      await entered.promise;
      const aliasedIdentity = {
        ...identity,
        authorityRoot: join(identity.authorityRoot, '..', 'authority'),
      };
      secondPromise = second.withOperationLock(aliasedIdentity, 'same-operation', async () => {
        order.push('second-enter');
      });
      await secondContended.promise;
      expect(order).toEqual(['first-enter']);
      resume.release();
      secondContended.release();
      await Promise.all([firstPromise, secondPromise]);
      expect(order).toEqual(['first-enter', 'first-exit', 'second-enter']);
    } finally {
      resume.release();
      secondContended.release();
      await Promise.allSettled([firstPromise, secondPromise].filter(Boolean) as Promise<void>[]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the real persisted SQLite identity across child processes with different TEMP values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nim364-production-child-'));
    const db = new SQLiteDatabase({
      dbDir: join(root, 'database'),
      schemaDir: resolve(__dirname, '../../database/sqlite/schemas'),
      slowQueryThresholdMs: 1_000,
      sampleRate: 0,
    });
    let parentPromise: Promise<void> | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    const originalTemp = process.env.TEMP;
    const originalTmp = process.env.TMP;
    try {
      await db.initialize();
      const adapter = createSQLiteStoreAdapter(db);
      const identityRow = await adapter.query<{ store_id: string; authority_root: string }>(
        'SELECT store_id, authority_root FROM host_control_store_identity WHERE singleton = 1',
      );
      const identity = {
        storeId: identityRow.rows[0].store_id,
        authorityRoot: identityRow.rows[0].authority_root,
      };
      const childTemp = join(root, 'child-temp');
      const parentTemp = join(root, 'parent-temp');
      process.env.TEMP = parentTemp;
      process.env.TMP = parentTemp;
      const modulePath = resolve(__dirname, '../HostControlMutationCoordinator.ts');
      const script = `
        require('ts-node/register/transpile-only');
        const Database = require('better-sqlite3');
        const { hostControlMutationCoordinator } = require(process.argv[1]);
        const database = new Database(process.argv[2], { readonly: true });
        const row = database.prepare(
          'SELECT store_id, authority_root FROM host_control_store_identity WHERE singleton = 1'
        ).get();
        const identity = { storeId: row.store_id, authorityRoot: row.authority_root };
        hostControlMutationCoordinator.withOperationLock(identity, process.argv[3], async () => {
          process.stdout.write('entered\\n');
          await new Promise(resolve => process.stdin.once('data', resolve));
        }).then(() => process.exit(0), error => {
          process.stderr.write(String(error && error.stack || error));
          process.exit(1);
        });
      `;
      child = spawn(process.execPath, [
        '-e', script, modulePath, db.getRawHandle()!.name, 'production-store-op',
      ], {
        cwd: resolve(__dirname, '../../../../../..'),
        env: {
          ...process.env,
          TEMP: childTemp,
          TMP: childTemp,
          TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: 'commonjs', moduleResolution: 'node' }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      pendingChildren.add(child);
      await expect(nextLine(child, 'production_child_enter')).resolves.toBe('entered');
      let parentEntered = false;
      parentPromise = hostControlMutationCoordinator.withOperationLock(
        identity,
        'production-store-op',
        async () => { parentEntered = true; },
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(parentEntered).toBe(false);
      child.stdin.write('release\n');
      await drainChild(child);
      await parentPromise;
      expect(parentEntered).toBe(true);
    } finally {
      if (child) await drainChild(child);
      await Promise.allSettled(parentPromise ? [parentPromise] : []);
      if (originalTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = originalTemp;
      if (originalTmp === undefined) delete process.env.TMP;
      else process.env.TMP = originalTmp;
      await db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds the canonical namespace to store identity as well as the operation key', async () => {
    const { root, identity } = await makeIdentity('nim364-store-partition');
    const firstEntered = boundedBarrier('store_partition_first_entered');
    const firstResume = boundedBarrier('store_partition_first_resume');
    const live = new Map<number, string>();
    const first = fakeCoordinator(151, 'boot:start-151', live);
    const second = fakeCoordinator(152, 'boot:start-152', live);
    let firstPromise: Promise<void> | undefined;
    try {
      firstPromise = first.withOperationLock(identity, 'same-operation', async () => {
        firstEntered.release();
        await firstResume.promise;
      });
      await firstEntered.promise;
      await expect(second.withOperationLock(
        { ...identity, storeId: `${identity.storeId}-different` },
        'same-operation',
        async () => 'independent-store',
      )).resolves.toBe('independent-store');
    } finally {
      firstResume.release();
      await Promise.allSettled(firstPromise ? [firstPromise] : []);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not expose a canonical owner while a complete private claim is paused before publication', async () => {
    const { root, identity } = await makeIdentity('nim364-private-publication');
    const prepared = boundedBarrier('private_claim_prepared');
    const resume = boundedBarrier('private_claim_resume');
    const live = new Map<number, string>();
    const first = createHostControlMutationCoordinator({
      pid: 201, processIdentity: 'boot:start-201', retryMs: 2,
      isProcessAlive: (pid) => live.has(pid),
      getProcessIdentity: async (pid) => live.get(pid) ?? null,
      afterClaimPrepared: async () => { prepared.release(); await resume.promise; },
    });
    live.set(201, 'boot:start-201');
    const second = fakeCoordinator(202, 'boot:start-202', live);
    const order: string[] = [];
    let firstPromise: Promise<void> | undefined;
    let secondPromise: Promise<void> | undefined;
    try {
      firstPromise = first.withOperationLock(identity, 'publish-operation', async () => { order.push('first'); });
      await prepared.promise;
      secondPromise = second.withOperationLock(identity, 'publish-operation', async () => { order.push('second'); });
      await secondPromise;
      expect(order).toEqual(['second']);
      resume.release();
      await firstPromise;
      expect(order).toEqual(['second', 'first']);
    } finally {
      resume.release();
      await Promise.allSettled([firstPromise, secondPromise].filter(Boolean) as Promise<void>[]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers dead malformed history, rolls an exhausted sequence epoch, and keeps history bounded', async () => {
    const { root, identity } = await makeIdentity('nim364-bounded-history');
    const coordinator = fakeCoordinator(301, 'boot:start-301');
    try {
      await coordinator.withOperationLock(identity, 'history-operation', async () => undefined);
      const namespace = await resolveHostControlOperationNamespace(identity, 'history-operation');
      let names = await readdir(namespace.directory);
      const claimOne = names.find((name) => name.endsWith('.000000000001.claim'))!;
      const malformedName = claimOne.replace('000000000001.claim', '000000000002.claim');
      const malformedPath = join(namespace.directory, malformedName);
      await writeFile(malformedPath, '{', 'utf8');
      await utimes(malformedPath, new Date(0), new Date(0));
      await coordinator.withOperationLock(identity, 'history-operation', async () => undefined);

      names = await readdir(namespace.directory);
      const epochName = names.find((name) => name.startsWith('epoch-'))!;
      const epoch = JSON.parse(await readFile(join(namespace.directory, epochName), 'utf8'));
      const checkpointUnsigned = {
        version: 2,
        epochGeneration: epoch.generation,
        epochToken: epoch.token,
        throughSequence: MAX_SEQUENCE,
        storeDigest: namespace.storeDigest,
        operationDigest: namespace.operationDigest,
      };
      const prefix = claimOne.slice(0, claimOne.indexOf('.000000000001.claim'));
      await writeFile(
        join(namespace.directory, `${prefix}.checkpoint-999999999999-forced.json`),
        JSON.stringify({ ...checkpointUnsigned, checksum: checksum(checkpointUnsigned) }),
        'utf8',
      );
      await coordinator.withOperationLock(identity, 'history-operation', async () => undefined);
      names = await readdir(namespace.directory);
      expect(names.some((name) => name.startsWith('epoch-00000002-'))).toBe(true);
      expect(names.some((name) => name.includes('1000000000000'))).toBe(false);

      for (let index = 0; index < 40; index += 1) {
        await coordinator.withOperationLock(identity, 'history-operation', async () => undefined);
      }
      names = await readdir(namespace.directory);
      const currentEpochFiles = names.filter((name) => name.startsWith('e00000002-'));
      expect(currentEpochFiles.length).toBeLessThanOrEqual(4);

      await coordinator.withOperationLock(identity, 'exhausted-operation', async () => undefined);
      const exhausted = await resolveHostControlOperationNamespace(identity, 'exhausted-operation');
      const maxToken = 'forced-max-epoch';
      const maxEpochUnsigned = {
        version: 2,
        generation: MAX_EPOCH,
        token: maxToken,
        storeDigest: exhausted.storeDigest,
        operationDigest: exhausted.operationDigest,
      };
      await writeFile(
        join(exhausted.directory, `epoch-99999999-${maxToken}.json`),
        JSON.stringify({ ...maxEpochUnsigned, checksum: checksum(maxEpochUnsigned) }),
      );
      const maxPrefix = `e99999999-${createHash('sha256').update(maxToken).digest('hex').slice(0, 24)}`;
      const maxCheckpointUnsigned = {
        version: 2,
        epochGeneration: MAX_EPOCH,
        epochToken: maxToken,
        throughSequence: MAX_SEQUENCE,
        storeDigest: exhausted.storeDigest,
        operationDigest: exhausted.operationDigest,
      };
      await writeFile(
        join(exhausted.directory, `${maxPrefix}.checkpoint-999999999999-forced.json`),
        JSON.stringify({ ...maxCheckpointUnsigned, checksum: checksum(maxCheckpointUnsigned) }),
      );
      await expect(coordinator.withOperationLock(
        identity, 'exhausted-operation', async () => undefined,
      )).rejects.toThrow('host_control_mutation_epoch_exhausted');
      expect((await readdir(exhausted.directory)).some(
        (name) => name.includes('1000000000000'),
      )).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for a malformed live or indeterminate owner and detects PID reuse', async () => {
    const { root, identity } = await makeIdentity('nim364-malformed-live');
    const live = new Map([[401, 'boot:start-old'], [402, 'boot:start-new']]);
    const coordinator = fakeCoordinator(402, 'boot:start-new', live);
    try {
      await coordinator.withOperationLock(identity, 'malformed-operation', async () => undefined);
      const namespace = await resolveHostControlOperationNamespace(identity, 'malformed-operation');
      const names = await readdir(namespace.directory);
      const claimOne = names.find((name) => name.endsWith('.000000000001.claim'))!;
      const malformedPath = join(
        namespace.directory,
        claimOne.replace('000000000001.claim', '000000000002.claim'),
      );
      await writeFile(malformedPath, JSON.stringify({
        pid: 401,
        processIdentity: 'boot:start-old',
        operationDigest: 'wrong-digest',
      }));
      await expect(coordinator.withOperationLock(
        identity, 'malformed-operation', async () => undefined,
      )).rejects.toThrow('host_control_mutation_lock_indeterminate');

      live.set(401, 'boot:start-reused');
      await utimes(malformedPath, new Date(0), new Date(0));
      await expect(coordinator.withOperationLock(
        identity, 'malformed-operation', async () => 'reclaimed',
      )).resolves.toBe('reclaimed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows exactly one concurrent reclaimer and a stale release cannot replace its successor', async () => {
    const { root, identity } = await makeIdentity('nim364-concurrent-reclaim');
    const live = new Map([[501, 'boot:start-501'], [502, 'boot:start-502'], [503, 'boot:start-503']]);
    const owner = fakeCoordinator(501, 'boot:start-501', live);
    const releasePaused = boundedBarrier('stale_release_paused');
    const releaseResume = boundedBarrier('stale_release_resume');
    const staleOwner = createHostControlMutationCoordinator({
      pid: 501, processIdentity: 'boot:start-501', retryMs: 2,
      isProcessAlive: (pid) => live.has(pid),
      getProcessIdentity: async (pid) => live.get(pid) ?? null,
      beforeReleasePublished: async () => { releasePaused.release(); await releaseResume.promise; },
    });
    let stalePromise: Promise<void> | undefined;
    let contenders: Promise<void>[] = [];
    let active = 0;
    let maximum = 0;
    try {
      // Establish the namespace before the decisive stale-release schedule.
      await owner.withOperationLock(identity, 'reclaim-operation', async () => undefined);
      stalePromise = staleOwner.withOperationLock(identity, 'reclaim-operation', async () => undefined);
      await releasePaused.promise;
      live.delete(501);
      const run = (pid: number) => fakeCoordinator(pid, `boot:start-${pid}`, live)
        .withOperationLock(identity, 'reclaim-operation', async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
          active -= 1;
        });
      contenders = [run(502), run(503)];
      await Promise.all(contenders);
      releaseResume.release();
      await stalePromise;
      expect(maximum).toBe(1);
      await expect(fakeCoordinator(504, 'boot:start-504', live).withOperationLock(
        identity, 'reclaim-operation', async () => 'successor',
      )).resolves.toBe('successor');
    } finally {
      releaseResume.release();
      await Promise.allSettled([stalePromise, ...contenders].filter(Boolean) as Promise<void>[]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
