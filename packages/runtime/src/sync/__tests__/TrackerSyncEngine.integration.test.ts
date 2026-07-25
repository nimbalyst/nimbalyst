/**
 * TrackerSyncEngine integration tests.
 *
 * Phase 3 of the rewrite specified in
 * `design/Collaboration/tracker-sync-redesign.md`. These tests run two
 * `TrackerSyncEngine` instances against an in-memory `FakeTrackerRoom`
 * (see `./fakeTrackerServer.ts`) and assert the protocol contracts spec'd
 * in D10:
 *
 *   1. Bootstrap + delta convergence.
 *   2. Optimistic apply + rollback on rejection.
 *   3. Transaction queue lifecycle (created -> queued -> executing -> ack).
 *   4. Offline enqueue + reconnect replay.
 *   5. Key rotation mid-flight (re-encrypt on `staleKeyEpoch`).
 *   6. `linkedSessions` stripped at the upload boundary.
 *
 * Phase 2's `trackerRoom.integration.test.ts` is the contract test for
 * the real DO -- this file is the contract test for the client engine
 * sitting opposite an obedient server. Both pass = the protocol is sound.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TrackerSyncEngine,
  type TrackerSyncEngineConfig,
  type TrackerKeyMaterial,
} from '../TrackerSyncEngine';
import { InMemoryTrackerPersistence } from '../trackerPersistence';
import { encryptTrackerPayload, fingerprintTrackerKey } from '../TrackerEnvelopeCrypto';
import { createFakeServer, type FakeTrackerRoom } from './fakeTrackerServer';
import type { EncryptedTrackerItemEnvelope, TrackerItemPayload } from '../trackerProtocol';

// ============================================================================
// Helpers
// ============================================================================

async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  ) as Promise<CryptoKey>;
}

function basePayload(itemId: string, overrides: Partial<TrackerItemPayload> = {}): TrackerItemPayload {
  return {
    itemId,
    primaryType: 'bug',
    archived: false,
    bodyVersion: 0,
    fields: { title: `Item ${itemId}`, status: 'to-do' },
    labels: {},
    comments: [],
    system: {},
    ...overrides,
  };
}

function schemaModelJson(type = 'epic'): string {
  return JSON.stringify({
    type,
    displayName: 'Epic',
    description: 'Large cross-project initiative',
    fields: [
      { name: 'title', type: 'text', required: true },
      {
        name: 'status',
        type: 'select',
        options: [
          { value: 'planned', label: 'Planned' },
          { value: 'active', label: 'Active' },
        ],
      },
    ],
    roles: {
      title: 'title',
      status: 'status',
    },
  });
}

interface BuiltEngine {
  engine: TrackerSyncEngine;
  persistence: InMemoryTrackerPersistence;
  config: TrackerSyncEngineConfig;
}

async function buildEngine(opts: {
  room: FakeTrackerRoom;
  serverConnect: () => WebSocket;
  encryptionKey: CryptoKey;
  refreshKey?: () => Promise<TrackerKeyMaterial | null>;
  initializeIssueKeyPrefix?: string;
}): Promise<BuiltEngine> {
  const fingerprint = await fingerprintTrackerKey(opts.encryptionKey);
  const persistence = new InMemoryTrackerPersistence();
  const config: TrackerSyncEngineConfig = {
    serverUrl: 'ws://fake',
    orgId: 'test-org',
    teamProjectId: 'tracker-test-project',
    userId: `user-${Math.random().toString(36).slice(2, 8)}`,
    encryptionKey: opts.encryptionKey,
    orgKeyFingerprint: fingerprint,
    persistence,
    initializeIssueKeyPrefix: opts.initializeIssueKeyPrefix,
    getJwt: async () => 'fake-jwt',
    refreshKey: opts.refreshKey,
    createWebSocket: () => opts.serverConnect(),
  };
  const engine = new TrackerSyncEngine(config);
  return { engine, persistence, config };
}

/**
 * Wait until `predicate` returns truthy, polling at 5ms intervals. The
 * engine drives most flows through microtasks, so even 100ms should be
 * generous; tests fail with a clear timeout if a wire message gets
 * dropped.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil timed out');
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

// ============================================================================
// First test: two-client delta + queue ack lifecycle
// ============================================================================

describe('TrackerSyncEngine (in-memory)', () => {
  let key: CryptoKey;

  beforeEach(async () => {
    key = await generateKey();
  });

  it('round-trips an upsert: clientA enqueues, server acks, clientB sees the delta', async () => {
    const server = createFakeServer();

    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const b = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });

    const appliedOnA: string[] = [];
    a.config.onItemApplied = (item) => { appliedOnA.push(item.itemId); };
    const appliedOnB: string[] = [];
    b.config.onItemApplied = (item) => { appliedOnB.push(item.itemId); };

    await a.engine.connect();
    await b.engine.connect();
    // Wait for both to finish bootstrap (sync_id watermark == 0 initial).
    await waitUntil(() => a.engine.getStatus() === 'connected' && b.engine.getStatus() === 'connected');

    // Client A upserts an item.
    const payload = basePayload('round-trip-1', {
      fields: { title: 'Round trip', status: 'in-progress' },
    });
    const { clientMutationId } = await a.engine.upsertItem(payload);

    // Wait for both the local projection (after ack) and B's delta to land.
    await waitUntil(() => appliedOnB.includes('round-trip-1'));

    // Local projection on A holds the decrypted payload.
    const localA = a.persistence.items.get('round-trip-1');
    expect(localA?.payload?.fields.title).toBe('Round trip');
    expect(localA?.envelope.syncId).toBeGreaterThan(0);
    expect(localA?.envelope.issueKey).toBe('NIM-1');

    // B got the same item via broadcast.
    const localB = b.persistence.items.get('round-trip-1');
    expect(localB?.payload?.fields.title).toBe('Round trip');
    expect(localB?.envelope.syncId).toBe(localA?.envelope.syncId);

    // Queue row was deleted after the ack.
    expect(a.persistence.transactions.has(clientMutationId)).toBe(false);

    a.engine.destroy();
    b.engine.destroy();
  });

  it('syncs custom tracker schemas through outbox, live delta, and late bootstrap', async () => {
    const server = createFakeServer();
    const model = schemaModelJson('epic');

    const b = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const bApplied: Array<{ type: string; model: string | null; syncId: number }> = [];
    b.config.schemaSync = {
      getMaxSyncId: async () => 0,
      listUnsynced: async () => [],
      applyRemote: async (def) => { bApplied.push(def); },
    };

    await b.engine.connect();
    await waitUntil(() => b.engine.getStatus() === 'connected');

    let aPending = [{ type: 'epic', model, deleted: false }];
    const aApplied: Array<{ type: string; model: string | null; syncId: number }> = [];
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    a.config.schemaSync = {
      getMaxSyncId: async () => 0,
      listUnsynced: async () => aPending,
      applyRemote: async (def) => {
        aApplied.push(def);
        aPending = aPending.filter(row => row.type !== def.type);
      },
    };

    await a.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected');
    await waitUntil(() => bApplied.some(def => def.type === 'epic' && def.model === model));

    expect(server.room.receivedSchemaMutations.map(m => m.schemaType)).toEqual(['epic']);
    expect(aApplied[0]).toMatchObject({ type: 'epic', model });
    expect(aPending).toHaveLength(0);
    expect(bApplied[0]).toMatchObject({ type: 'epic', model });
    expect(bApplied[0].syncId).toBeGreaterThan(0);

    const c = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const cApplied: Array<{ type: string; model: string | null; syncId: number }> = [];
    c.config.schemaSync = {
      getMaxSyncId: async () => 0,
      listUnsynced: async () => [],
      applyRemote: async (def) => { cApplied.push(def); },
    };

    await c.engine.connect();
    await waitUntil(() => c.engine.getStatus() === 'connected');
    await waitUntil(() => cApplied.some(def => def.type === 'epic' && def.model === model));

    expect(cApplied[0].syncId).toBe(bApplied[0].syncId);

    a.engine.destroy();
    b.engine.destroy();
    c.engine.destroy();
  });

  it('syncs tracker folders and type placements through outbox, live delta, and bootstrap', async () => {
    const server = createFakeServer();
    const folder = JSON.stringify({
      entryId: 'folder:delivery',
      kind: 'folder',
      folderId: 'delivery',
      name: 'Delivery',
      sortKey: 'a0',
    });

    const b = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const bApplied: Array<{ entryId: string; payload: string | null; syncId: number }> = [];
    b.config.navigationSync = {
      getMaxSyncId: async () => 0,
      listUnsynced: async () => [],
      applyRemote: async (def) => { bApplied.push(def); },
    };
    await b.engine.connect();
    await waitUntil(() => b.engine.getStatus() === 'connected');

    let pending = [{ entryId: 'folder:delivery', payload: folder, deleted: false }];
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    a.config.navigationSync = {
      getMaxSyncId: async () => 0,
      listUnsynced: async () => pending,
      applyRemote: async (def) => {
        pending = pending.filter((entry) => entry.entryId !== def.entryId);
      },
    };
    await a.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected');
    await waitUntil(() => bApplied.some((entry) => entry.entryId === 'folder:delivery'));
    expect(JSON.parse(bApplied[0].payload!)).toMatchObject({ name: 'Delivery' });

    const placement = JSON.stringify({
      entryId: 'type:task',
      kind: 'type-placement',
      trackerType: 'task',
      folderId: 'delivery',
      sortKey: 'a0',
    });
    pending = [{ entryId: 'type:task', payload: placement, deleted: false }];
    await a.engine.flushNavigation();
    await waitUntil(() => bApplied.some((entry) => entry.entryId === 'type:task'));

    const c = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const cApplied: Array<{ entryId: string; payload: string | null; syncId: number }> = [];
    c.config.navigationSync = {
      getMaxSyncId: async () => 0,
      listUnsynced: async () => [],
      applyRemote: async (def) => { cApplied.push(def); },
    };
    await c.engine.connect();
    await waitUntil(() => c.engine.getStatus() === 'connected');
    await waitUntil(() => cApplied.length === 2);
    expect(cApplied.map((entry) => entry.entryId)).toEqual(['folder:delivery', 'type:task']);
    expect(server.room.receivedNavigationMutations.map((entry) => entry.entryId)).toEqual([
      'folder:delivery',
      'type:task',
    ]);

    a.engine.destroy();
    b.engine.destroy();
    c.engine.destroy();
  });

  it('syncs team-shared saved views through outbox, live delta, and bootstrap', async () => {
    const server = createFakeServer();
    const sprintView = JSON.stringify({
      id: 'view-sprint-7',
      name: 'Sprint 7 -- open bugs',
      definition: { selectedType: 'bug', viewMode: 'grid' },
    });

    // A peer that is already connected receives the view as a live delta.
    const b = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const bApplied: Array<{ viewId: string; payload: string | null; syncId: number }> = [];
    b.config.savedViewSync = {
      getMaxSyncId: async () => 0,
      listUnsynced: async () => [],
      applyRemote: async (def) => { bApplied.push(def); },
    };
    await b.engine.connect();
    await waitUntil(() => b.engine.getStatus() === 'connected');

    let pending: Array<{ viewId: string; payload: string | null; deleted: boolean }> =
      [{ viewId: 'view-sprint-7', payload: sprintView, deleted: false }];
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    a.config.savedViewSync = {
      getMaxSyncId: async () => 0,
      listUnsynced: async () => pending,
      applyRemote: async (def) => {
        pending = pending.filter((view) => view.viewId !== def.viewId);
      },
    };
    await a.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected');
    await waitUntil(() => bApplied.some((view) => view.viewId === 'view-sprint-7'));
    expect(JSON.parse(bApplied[0].payload!)).toMatchObject({ name: 'Sprint 7 -- open bugs' });

    // Unsharing a view travels as a tombstone, not a payload.
    pending = [{ viewId: 'view-sprint-7', payload: null, deleted: true }];
    await a.engine.flushSavedViews();
    await waitUntil(() => bApplied.length === 2);
    expect(bApplied[1]).toMatchObject({ viewId: 'view-sprint-7', payload: null });

    // A fresh client bootstraps the whole lane from syncId 0.
    const c = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const cApplied: Array<{ viewId: string; payload: string | null; syncId: number }> = [];
    c.config.savedViewSync = {
      getMaxSyncId: async () => 0,
      listUnsynced: async () => [],
      applyRemote: async (def) => { cApplied.push(def); },
    };
    await c.engine.connect();
    await waitUntil(() => c.engine.getStatus() === 'connected');
    await waitUntil(() => cApplied.length >= 1);
    expect(cApplied.at(-1)).toMatchObject({ viewId: 'view-sprint-7', payload: null });

    expect(server.room.receivedSavedViewMutations.map((v) => v.viewId)).toEqual([
      'view-sprint-7',
      'view-sprint-7',
    ]);

    // The server never sees the view's contents.
    const stored = server.room.getStoredSavedViews();
    expect(stored[0].encryptedPayload).toBeNull();

    a.engine.destroy();
    b.engine.destroy();
    c.engine.destroy();
  });

  // ==========================================================================
  // Stripping linked sessions at upload boundary
  // ==========================================================================

  it('strips linkedSessions from the payload before encryption', async () => {
    const server = createFakeServer();
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const b = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    await a.engine.connect();
    await b.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected' && b.engine.getStatus() === 'connected');

    // Upload an item whose payload's `fields.linkedSessions` carries
    // sensitive local-only IDs. The engine should strip them before
    // encryption; client B (and the server's stored row, post-decrypt)
    // must NOT see them.
    const payload = basePayload('strip-1', {
      fields: {
        title: 'Strip me',
        linkedSessions: ['session-secret-1', 'session-secret-2'],
        status: 'to-do',
      },
    });
    await a.engine.upsertItem(payload);
    await waitUntil(() => b.persistence.items.has('strip-1'));

    const localB = b.persistence.items.get('strip-1');
    expect(localB?.payload?.fields.title).toBe('Strip me');
    expect((localB?.payload?.fields as Record<string, unknown>).linkedSessions).toBeUndefined();

    a.engine.destroy();
    b.engine.destroy();
  });

  // ==========================================================================
  // Transaction lifecycle: rejection rolls back the projection
  // ==========================================================================

  it('rolls back optimistic apply when the server rejects', async () => {
    const server = createFakeServer({ rejectAll: true });
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const rejections: Array<{ clientMutationId: string; code: string }> = [];
    a.config.onRejection = (r) => {
      rejections.push({ clientMutationId: r.clientMutationId, code: r.rejection.code });
    };

    await a.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected');

    const { clientMutationId } = await a.engine.upsertItem(basePayload('rejected-1'));
    await waitUntil(() => rejections.length > 0);

    // The optimistic projection is gone (rolled back to "no row").
    expect(a.persistence.items.has('rejected-1')).toBe(false);
    // The transaction row stays around so the UI can show the failure.
    const txn = a.persistence.transactions.get(clientMutationId);
    expect(txn).toBeDefined();
    expect(txn?.lastRejection?.code).toBe('forbidden');
    expect(rejections[0].code).toBe('forbidden');

    a.engine.destroy();
  });

  // ==========================================================================
  // Tombstone: delete propagates with payload=null
  // ==========================================================================

  it('propagates a delete as a tombstone with deletedAt set on the peer', async () => {
    const server = createFakeServer();
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const b = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    await a.engine.connect();
    await b.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected' && b.engine.getStatus() === 'connected');

    await a.engine.upsertItem(basePayload('doomed'));
    await waitUntil(() => b.persistence.items.has('doomed'));
    await a.engine.deleteItem('doomed');
    await waitUntil(() => {
      const row = b.persistence.items.get('doomed');
      return row?.envelope.encryptedPayload === null;
    });

    const tomb = b.persistence.items.get('doomed');
    expect(tomb?.envelope.encryptedPayload).toBeNull();
    expect(tomb?.envelope.deletedAt).not.toBeNull();
    expect(tomb?.payload).toBeNull();

    a.engine.destroy();
    b.engine.destroy();
  });

  // ==========================================================================
  // Labels CRDT: concurrent adds from two peers both survive after convergence
  // ==========================================================================

  it('union-merges concurrent label additions (add-wins set)', async () => {
    const server = createFakeServer();
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const b = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    await a.engine.connect();
    await b.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected' && b.engine.getStatus() === 'connected');

    // Bootstrap an item on both peers.
    await a.engine.upsertItem(basePayload('labels-1', { fields: { title: 'Labels CRDT', status: 'to-do' } }));
    await waitUntil(() => b.persistence.items.has('labels-1'));

    // Client A adds label "bug" with its own entry id. Producers in the
    // real host adapter ship the FULL current labels map (a CRDT state) so
    // peers can union it with theirs; mirror that here.
    await a.engine.upsertItem(basePayload('labels-1', {
      fields: { title: 'Labels CRDT', status: 'to-do' },
      labels: { 'a-bug': { id: 'a-bug', value: 'bug' } },
    }));
    await waitUntil(() => {
      const row = b.persistence.items.get('labels-1');
      return !!row?.payload?.labels && Object.keys(row.payload.labels).includes('a-bug');
    });

    // Client B concurrently adds label "urgent". B's producer ships its
    // current local map ({ a-bug } after the prior merge) plus the new
    // entry, so the server-side row and downstream peers can converge to
    // the union. This mirrors `trackerItemToPayload` reading
    // `item.labelsMap` from PGLite before each upload.
    const bExisting = b.persistence.items.get('labels-1')?.payload?.labels ?? {};
    await b.engine.upsertItem(basePayload('labels-1', {
      fields: { title: 'Labels CRDT', status: 'to-do' },
      labels: { ...bExisting, 'b-urgent': { id: 'b-urgent', value: 'urgent' } },
    }));
    await waitUntil(() => {
      const row = a.persistence.items.get('labels-1');
      const keys = row?.payload?.labels ? Object.keys(row.payload.labels) : [];
      return keys.includes('a-bug') && keys.includes('b-urgent');
    });

    const localA = a.persistence.items.get('labels-1');
    const localB = b.persistence.items.get('labels-1');
    // After convergence both clients hold both entries with their original
    // per-element ids and no tombstones.
    expect(localA?.payload?.labels?.['a-bug']?.value).toBe('bug');
    expect(localA?.payload?.labels?.['b-urgent']?.value).toBe('urgent');
    expect(localA?.payload?.labels?.['a-bug']?.tombstone).toBeUndefined();
    expect(localA?.payload?.labels?.['b-urgent']?.tombstone).toBeUndefined();
    expect(localB?.payload?.labels?.['a-bug']?.value).toBe('bug');
    expect(localB?.payload?.labels?.['b-urgent']?.value).toBe('urgent');

    a.engine.destroy();
    b.engine.destroy();
  });

  // ==========================================================================
  // Key rotation mid-flight: staleKeyEpoch -> refreshKey -> re-send -> ack
  // ==========================================================================

  it('handles staleKeyEpoch by calling refreshKey and re-sending under the new key', async () => {
    // Server starts requiring fingerprint = sha256(oldKey).
    const oldKey = await generateKey();
    const oldFingerprint = await fingerprintTrackerKey(oldKey);
    const server = createFakeServer({ currentFingerprint: oldFingerprint });

    // Imagine the client has the WRONG key cached (the org actually
    // rotated, but the client doesn't know yet). When the mutation gets
    // rejected, refreshKey() returns the actual current key/fingerprint
    // and the server starts accepting writes encrypted under it.
    const wrongKey = await generateKey();
    const refreshKey = vi.fn(async (): Promise<TrackerKeyMaterial> => {
      // The host adapter would simulate "the admin rotated and we now
      // hold the correct key". Update the server's expectation too so the
      // retry succeeds.
      const fresh = await generateKey();
      const freshFingerprint = await fingerprintTrackerKey(fresh);
      server.room.setCurrentFingerprint(freshFingerprint);
      return { encryptionKey: fresh, orgKeyFingerprint: freshFingerprint };
    });

    const a = await buildEngine({
      room: server.room,
      serverConnect: server.connect,
      encryptionKey: wrongKey,
      refreshKey,
    });
    await a.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected');

    const { clientMutationId } = await a.engine.upsertItem(basePayload('rotate-1'));
    // Wait for the re-sent ack to land (transaction row deleted).
    await waitUntil(() => !a.persistence.transactions.has(clientMutationId), 1000);

    expect(refreshKey).toHaveBeenCalledOnce();
    // The mutation went out twice -- first rejected, then accepted under
    // the fresh key.
    expect(server.room.receivedMutations.filter(m => m.itemId === 'rotate-1').length).toBe(2);

    a.engine.destroy();
  });

  // ==========================================================================
  // Bootstrap stale-key detection: a fresh connect refreshes the key when
  // the server's envelopes carry a fingerprint we don't have.
  // ==========================================================================

  it('refreshes the encryption key on connect when bootstrap envelopes carry a mismatched fingerprint', async () => {
    // ClientA writes an item under keyA; the server stores it with
    // fingerprint(keyA) in plaintext envelope metadata.
    const keyA = await generateKey();
    const fingerprintA = await fingerprintTrackerKey(keyA);
    const server = createFakeServer({ currentFingerprint: fingerprintA });

    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: keyA });
    await a.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected');
    await a.engine.upsertItem(basePayload('stale-1', { fields: { title: 'after rotation' } }));
    await waitUntil(() => server.room.getStoredItems().some(i => i.itemId === 'stale-1'));

    // ClientB shows up with the WRONG key (e.g. the org rotated while B
    // was offline; B's local envelope cache still holds the prior epoch).
    // Bootstrap should detect the fingerprint mismatch and call refreshKey
    // before applying the batch -- otherwise every envelope decrypt fails
    // and B sees an empty board.
    const wrongKey = await generateKey();
    const refreshKey = vi.fn(async (): Promise<TrackerKeyMaterial> => {
      return { encryptionKey: keyA, orgKeyFingerprint: fingerprintA };
    });
    const b = await buildEngine({
      room: server.room,
      serverConnect: server.connect,
      encryptionKey: wrongKey,
      refreshKey,
    });
    await b.engine.connect();
    await waitUntil(() => b.engine.getStatus() === 'connected');
    await waitUntil(() => b.persistence.items.has('stale-1'));

    expect(refreshKey).toHaveBeenCalledOnce();
    const projected = b.persistence.items.get('stale-1');
    expect(projected?.payload?.fields.title).toBe('after rotation');

    a.engine.destroy();
    b.engine.destroy();
  });

  // ==========================================================================
  // Bootstrap watermark: a late-joining client only catches the delta past
  // its known syncId
  // ==========================================================================

  it('bootstraps from sinceSyncId and includes only items the client has not seen', async () => {
    const server = createFakeServer();
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    await a.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected');

    // Write three items. Each gets a fresh sync_id.
    await a.engine.upsertItem(basePayload('A'));
    await a.engine.upsertItem(basePayload('B'));
    await a.engine.upsertItem(basePayload('C'));
    await waitUntil(() => a.persistence.items.size === 3);

    // A second client claims to already know up to syncId=2 -- the
    // bootstrap should only deliver C (syncId=3). Simulate by seeding
    // persistence with two pre-known items at sync_id 1 and 2 before
    // connect.
    const b = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    b.persistence.items.set('A', {
      envelope: { itemId: 'A', syncId: 1, encryptedPayload: null, updatedAt: 0, deletedAt: null, orgKeyFingerprint: null },
      payload: null,
    });
    b.persistence.items.set('B', {
      envelope: { itemId: 'B', syncId: 2, encryptedPayload: null, updatedAt: 0, deletedAt: null, orgKeyFingerprint: null },
      payload: null,
    });

    await b.engine.connect();
    await waitUntil(() => b.engine.getStatus() === 'connected');
    // C arrived through bootstrap with the real (decrypted) payload.
    expect(b.persistence.items.get('C')?.payload?.fields.title).toBe('Item C');
    // A and B were not re-delivered (still the placeholder we seeded).
    expect(b.persistence.items.get('A')?.envelope.encryptedPayload).toBeNull();

    a.engine.destroy();
    b.engine.destroy();
  });

  // ==========================================================================
  // Offline enqueue + reconnect replay
  // ==========================================================================

  it('replays pending transactions after reconnect', async () => {
    const server = createFakeServer();

    // Build engine A but do NOT connect yet. Enqueue a mutation; it lands
    // in persistence with state=queued. Then connect and assert it drains.
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });

    const { clientMutationId } = await a.engine.upsertItem(basePayload('offline-1'));
    // Disconnected -> the transaction stays in `queued`; nothing was sent.
    expect(a.persistence.transactions.get(clientMutationId)?.state).toBe('queued');
    expect(server.room.receivedMutations.length).toBe(0);

    await a.engine.connect();
    await waitUntil(() => !a.persistence.transactions.has(clientMutationId), 1000);

    // The server received it during replay.
    expect(server.room.receivedMutations.find(m => m.clientMutationId === clientMutationId)).toBeDefined();
    expect(server.room.getStoredItems().find(i => i.itemId === 'offline-1')).toBeDefined();

    a.engine.destroy();
  });

  // ==========================================================================
  // Config broadcast: setIssueKeyPrefix reaches all peers
  // ==========================================================================

  it('broadcasts a config change to all connections', async () => {
    const server = createFakeServer();
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const b = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const aSeen: string[] = [];
    const bSeen: string[] = [];
    a.config.onConfigChange = (c) => aSeen.push(c.issueKeyPrefix);
    b.config.onConfigChange = (c) => bSeen.push(c.issueKeyPrefix);

    await a.engine.connect();
    await b.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected' && b.engine.getStatus() === 'connected');

    // Initial config from bootstrap.
    expect(aSeen).toContain('NIM');
    expect(bSeen).toContain('NIM');

    a.engine.setIssueKeyPrefix('PROJ');
    await waitUntil(() => aSeen.includes('PROJ') && bSeen.includes('PROJ'));

    a.engine.destroy();
    b.engine.destroy();
  });

  it('initializes an empty room with the project-derived issue prefix', async () => {
    const server = createFakeServer();
    const a = await buildEngine({
      room: server.room,
      serverConnect: server.connect,
      encryptionKey: key,
      initializeIssueKeyPrefix: 'STR',
    });
    const seen: string[] = [];
    a.config.onConfigChange = (config) => seen.push(config.issueKeyPrefix);

    await a.engine.connect();
    await waitUntil(() => seen.includes('STR'));
    await a.engine.upsertItem(basePayload('first-derived'));
    await waitUntil(() => server.room.getStoredItems().length === 1);

    expect(server.room.getStoredItems()[0]?.issueKey).toBe('STR-1');
    a.engine.destroy();
  });

  it('does not replace the prefix of a room that already has items', async () => {
    const server = createFakeServer();
    const seed = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    await seed.engine.connect();
    await seed.engine.upsertItem(basePayload('existing'));
    await waitUntil(() => server.room.getStoredItems().length === 1);
    seed.engine.destroy();

    const next = await buildEngine({
      room: server.room,
      serverConnect: server.connect,
      encryptionKey: key,
      initializeIssueKeyPrefix: 'STR',
    });
    const seen: string[] = [];
    next.config.onConfigChange = (config) => seen.push(config.issueKeyPrefix);
    await next.engine.connect();
    await waitUntil(() => next.engine.getStatus() === 'connected');

    expect(seen).toContain('NIM');
    expect(seen).not.toContain('STR');
    next.engine.destroy();
  });

  // ==========================================================================
  // Concurrent writes: distinct sync_ids; both items reach both clients
  // ==========================================================================

  it('serializes concurrent writes into distinct sync_ids', async () => {
    const server = createFakeServer();
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const b = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    await a.engine.connect();
    await b.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected' && b.engine.getStatus() === 'connected');

    // Both clients fire near-simultaneously.
    await Promise.all([
      a.engine.upsertItem(basePayload('concur-A')),
      b.engine.upsertItem(basePayload('concur-B')),
    ]);
    await waitUntil(() =>
      a.persistence.items.has('concur-A') &&
      a.persistence.items.has('concur-B') &&
      b.persistence.items.has('concur-A') &&
      b.persistence.items.has('concur-B'),
    );

    const syncIds = [
      a.persistence.items.get('concur-A')!.envelope.syncId,
      a.persistence.items.get('concur-B')!.envelope.syncId,
    ];
    expect(syncIds[0]).not.toBe(syncIds[1]);

    a.engine.destroy();
    b.engine.destroy();
  });

  // ==========================================================================
  // bodyVersion propagates through the metadata sync (phase 4b)
  // ==========================================================================

  it('propagates bodyVersion bumps from clientA to clientB through the metadata sync', async () => {
    const server = createFakeServer();
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const b = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    await a.engine.connect();
    await b.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected' && b.engine.getStatus() === 'connected');

    // First write at bodyVersion=1 (the renderer save path bumps from 0
    // to 1 on the first edit).
    await a.engine.upsertItem(basePayload('bv-1', { bodyVersion: 1 }));
    await waitUntil(() => b.persistence.items.get('bv-1')?.payload?.bodyVersion === 1);

    // Second write bumps to 2; B should see the bumped pointer.
    await a.engine.upsertItem(basePayload('bv-1', { bodyVersion: 2 }));
    await waitUntil(() => b.persistence.items.get('bv-1')?.payload?.bodyVersion === 2);

    a.engine.destroy();
    b.engine.destroy();
  });

  // ==========================================================================
  // persistedEnqueue: apply and enqueue happen via the atomic helper
  // ==========================================================================

  it('uses applyAndEnqueueAtomically when persistedEnqueue is requested', async () => {
    const server = createFakeServer();
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const spy = vi.spyOn(a.persistence, 'applyAndEnqueueAtomically');

    await a.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected');

    await a.engine.upsertItem(basePayload('pe-1'), { persistedEnqueue: true });
    expect(spy).toHaveBeenCalledOnce();

    a.engine.destroy();
  });

  // ==========================================================================
  // Phase 7: Recovery / rekey scenarios (per D10 + audit-doc Q7)
  //
  // Four scenarios in which a client interacts with a tracker room in an
  // unusual state. Phase 7 of the rewrite gates the PR on these contracts:
  // a sync change that breaks any of them blocks the PR.
  //   1. New room (no prior state) -- fresh client + fresh DO.
  //   2. Decrypt-failure recovery -- some envelopes encrypted under a key
  //      we don't have; rest of bootstrap completes.
  //   3. Empty-room recovery -- server has zero items, client has local
  //      state; client treats response as "caught up" without dropping
  //      local state.
  //   4. Key rotation locked / no fresh key yet -- `staleKeyEpoch`
  //      rejection with `refreshKey` returning null falls through to a
  //      normal rejection and rolls back the optimistic apply.
  // ==========================================================================

  describe('Phase 7: recovery scenarios', () => {
    // ------------------------------------------------------------------------
    // Scenario 1: New room (no prior state)
    // ------------------------------------------------------------------------
    it('Scenario 1 (new room): bootstrap on a fresh DO returns empty and the first mutation succeeds', async () => {
      const server = createFakeServer();
      const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });

      const applied: string[] = [];
      a.config.onItemApplied = (item) => { applied.push(item.itemId); };

      await a.engine.connect();
      await waitUntil(() => a.engine.getStatus() === 'connected');

      // Bootstrap is empty: nothing was applied; nothing is in persistence.
      expect(applied).toHaveLength(0);
      expect(a.persistence.items.size).toBe(0);

      // First mutation against the new room: succeeds with a fresh issueKey
      // and syncId starts at 1. Wait for the ack (not just the optimistic
      // apply) -- the optimistic envelope carries syncId=0 until the server
      // assigns the real one.
      await a.engine.upsertItem(basePayload('newroom-1', { fields: { title: 'first item' } }));
      await waitUntil(() => (a.persistence.items.get('newroom-1')?.envelope.syncId ?? 0) > 0);

      const row = a.persistence.items.get('newroom-1');
      expect(row?.envelope.syncId).toBe(1);
      expect(row?.envelope.issueKey).toBe('NIM-1');
      expect(row?.payload?.fields.title).toBe('first item');

      a.engine.destroy();
    });

    // ------------------------------------------------------------------------
    // Scenario 2a: Decrypt-failure recovery (partial)
    //
    // The room holds a mix of envelopes encrypted under keyA and keyB. The
    // client only has keyA. The unreadable items must be skipped (not
    // fatal), and the readable items must project normally. The bootstrap
    // detects the fingerprint mismatch and calls `refreshKey`; the harness
    // here returns the SAME (wrong) key, simulating "admin hasn't shared
    // the new envelope yet". The engine still finishes bootstrap with
    // partial visibility rather than empty.
    // ------------------------------------------------------------------------
    it('Scenario 2 (decrypt-failure): unreadable envelopes are skipped while readable ones project', async () => {
      const keyA = await generateKey();
      const keyB = await generateKey();
      const fingerprintA = await fingerprintTrackerKey(keyA);
      const fingerprintB = await fingerprintTrackerKey(keyB);

      // Build the server with no key gating (we directly inject envelopes,
      // so the per-write fingerprint check would block us).
      const server = createFakeServer();

      // Inject one envelope encrypted under keyA at syncId=1, and one
      // under keyB at syncId=2.
      const payloadA = basePayload('readable-A', { fields: { title: 'I am readable' } });
      const encA = await encryptTrackerPayload(payloadA, keyA, 'readable-A');
      const envA: EncryptedTrackerItemEnvelope = {
        itemId: 'readable-A',
        syncId: 1,
        encryptedPayload: encA.encryptedPayload,
        iv: encA.iv,
        updatedAt: Date.now(),
        deletedAt: null,
        orgKeyFingerprint: fingerprintA,
        issueNumber: 1,
        issueKey: 'NIM-1',
      };
      server.room.injectStoredEnvelope(envA);

      const payloadB = basePayload('opaque-B', { fields: { title: 'I am opaque to clientA' } });
      const encB = await encryptTrackerPayload(payloadB, keyB, 'opaque-B');
      const envB: EncryptedTrackerItemEnvelope = {
        itemId: 'opaque-B',
        syncId: 2,
        encryptedPayload: encB.encryptedPayload,
        iv: encB.iv,
        updatedAt: Date.now(),
        deletedAt: null,
        orgKeyFingerprint: fingerprintB,
        issueNumber: 2,
        issueKey: 'NIM-2',
      };
      server.room.injectStoredEnvelope(envB);

      // refreshKey returns the SAME key we already have. The bootstrap's
      // staleness heuristic will try once and get nothing better; the
      // envelope encrypted under keyB stays unreadable. The bootstrap MUST
      // complete anyway and the readable envelope must project.
      const refreshKey = vi.fn(async (): Promise<TrackerKeyMaterial> => ({
        encryptionKey: keyA,
        orgKeyFingerprint: fingerprintA,
      }));

      const client = await buildEngine({
        room: server.room,
        serverConnect: server.connect,
        encryptionKey: keyA,
        refreshKey,
      });

      await client.engine.connect();
      await waitUntil(() => client.engine.getStatus() === 'connected');

      // The readable item projects with its plaintext payload.
      const readable = client.persistence.items.get('readable-A');
      expect(readable?.payload?.fields.title).toBe('I am readable');

      // The opaque item has its plaintext payload absent (`null`), but the
      // envelope was still recorded with its sync_id so future bootstraps
      // don't re-fetch it. Implementation detail: per applyEnvelope in
      // TrackerSyncEngine.ts, a row where decryption fails is NOT written
      // to persistence (`return false`). We assert the absent-payload
      // contract here -- the item is invisible to the user, no crash.
      expect(client.persistence.items.has('opaque-B')).toBe(false);

      // refreshKey was attempted -- the bootstrap-staleness check fires
      // when at least one envelope's fingerprint doesn't match ours.
      expect(refreshKey).toHaveBeenCalled();

      client.engine.destroy();
    });

    // ------------------------------------------------------------------------
    // Scenario 3: Empty-room recovery (server wiped, client has local state)
    //
    // The server's room was wiped (e.g. after a key rotation truncated the
    // changelog). The client reconnects with a non-zero `sinceSyncId`
    // because its own persistence still records that high-water mark.
    // The server responds with an empty batch. The engine MUST NOT delete
    // the client's local rows -- recovery via re-upload is a separate
    // affirmative-consent flow (per audit-doc Q7.2). Local state survives.
    // ------------------------------------------------------------------------
    it('Scenario 3 (empty-room recovery): empty bootstrap response preserves local state', async () => {
      // Build a room with two items, sync them to clientA's persistence,
      // then wipe the server and connect clientB carrying clientA's data.
      const server = createFakeServer();
      const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
      await a.engine.connect();
      await waitUntil(() => a.engine.getStatus() === 'connected');

      await a.engine.upsertItem(basePayload('survives-1', { fields: { title: 'A' } }));
      await a.engine.upsertItem(basePayload('survives-2', { fields: { title: 'B' } }));
      // Wait for both items' acks (envelope.syncId > 0 indicates the
      // server's confirmed projection has been written). Without this the
      // cloned persistence may carry one un-acked envelope with syncId=0.
      await waitUntil(() =>
        (a.persistence.items.get('survives-1')?.envelope.syncId ?? 0) > 0 &&
        (a.persistence.items.get('survives-2')?.envelope.syncId ?? 0) > 0,
      );

      const survivingSyncIds = [
        a.persistence.items.get('survives-1')!.envelope.syncId,
        a.persistence.items.get('survives-2')!.envelope.syncId,
      ];
      const maxSyncId = Math.max(...survivingSyncIds);

      a.engine.destroy();

      // Server wipes its row set (but the internal sync_id counter stays
      // where it was -- a more realistic "rotation-truncated-changelog"
      // shape).
      server.room.wipeItems();
      expect(server.room.getStoredItems()).toHaveLength(0);

      // Clone clientA's persistence into clientB so clientB starts with a
      // populated local cache and a non-zero high-water mark.
      const b = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
      for (const [itemId, row] of a.persistence.items) {
        b.persistence.items.set(itemId, row);
      }
      expect(await b.persistence.getMaxSyncId()).toBe(maxSyncId);

      // Track tombstones the engine might erroneously emit; assert none fire.
      const tombstoneEvents: string[] = [];
      b.config.onItemApplied = (item) => {
        if (item.isTombstone) tombstoneEvents.push(item.itemId);
      };

      await b.engine.connect();
      await waitUntil(() => b.engine.getStatus() === 'connected');

      // Local state survives the empty bootstrap; the engine did not
      // delete clientB's rows on its own.
      expect(b.persistence.items.has('survives-1')).toBe(true);
      expect(b.persistence.items.has('survives-2')).toBe(true);
      expect(b.persistence.items.get('survives-1')?.payload?.fields.title).toBe('A');
      expect(b.persistence.items.get('survives-2')?.payload?.fields.title).toBe('B');
      // No tombstones were synthesized client-side from "the server didn't
      // tell me about these items".
      expect(tombstoneEvents).toHaveLength(0);

      b.engine.destroy();
    });

    // ------------------------------------------------------------------------
    // Scenario 4: Key rotation locked / no fresh key yet
    //
    // The server rejects a mutation with `staleKeyEpoch` (rotation
    // happened) but `refreshKey` returns `null` (admin hasn't shared the
    // new envelope, or the rotation is mid-flight and the new key isn't
    // available yet). The engine MUST fall through to a normal rejection:
    // roll back the optimistic apply, fire `onRejection`, and leave the
    // transaction row in `failed` state with `lastRejection` populated so
    // the UI can surface the failure to the user.
    // ------------------------------------------------------------------------
    it('Scenario 4 (rotation locked, no fresh key): staleKeyEpoch + refreshKey -> null rolls back the mutation', async () => {
      const serverKey = await generateKey();
      const serverFingerprint = await fingerprintTrackerKey(serverKey);
      const server = createFakeServer({ currentFingerprint: serverFingerprint });

      // Client holds the WRONG key. refreshKey is wired but returns null,
      // simulating "admin hasn't re-shared the envelope yet".
      const clientWrongKey = await generateKey();
      const refreshKey = vi.fn(async (): Promise<TrackerKeyMaterial | null> => null);

      const client = await buildEngine({
        room: server.room,
        serverConnect: server.connect,
        encryptionKey: clientWrongKey,
        refreshKey,
      });

      const rejections: Array<{ clientMutationId: string; code: string }> = [];
      client.config.onRejection = (r) => {
        rejections.push({ clientMutationId: r.clientMutationId, code: r.rejection.code });
      };

      await client.engine.connect();
      await waitUntil(() => client.engine.getStatus() === 'connected');

      const { clientMutationId } = await client.engine.upsertItem(
        basePayload('locked-out-1', { fields: { title: 'should roll back' } }),
      );

      // Wait for the rejection path to land.
      await waitUntil(() => rejections.length > 0);

      // refreshKey was attempted exactly once before the engine gave up.
      expect(refreshKey).toHaveBeenCalledOnce();

      // The rejection surfaces with staleKeyEpoch (matches the server's
      // reason) -- the engine does not mask the underlying code.
      expect(rejections[0].code).toBe('staleKeyEpoch');
      expect(rejections[0].clientMutationId).toBe(clientMutationId);

      // The optimistic projection was rolled back (no row for the new
      // item) and the transaction row stays around with `lastRejection`
      // populated for UI surfacing.
      expect(client.persistence.items.has('locked-out-1')).toBe(false);
      const txn = client.persistence.transactions.get(clientMutationId);
      expect(txn).toBeDefined();
      expect(txn?.lastRejection?.code).toBe('staleKeyEpoch');

      client.engine.destroy();
    });
  });
});
