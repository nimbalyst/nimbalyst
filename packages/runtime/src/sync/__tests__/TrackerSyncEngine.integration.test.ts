// @vitest-environment node
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
 *   5. `linkedSessions` stripped at the upload boundary.
 *
 * Phase 2's `trackerRoom.integration.test.ts` is the contract test for
 * the real DO -- this file is the contract test for the client engine
 * sitting opposite an obedient server. Both pass = the protocol is sound.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';
import {
  TrackerSyncEngine,
  type TrackerSyncEngineConfig,
} from '../TrackerSyncEngine';
import { InMemoryTrackerPersistence } from '../trackerPersistence';
import { encodeTrackerPayloadPlaintext } from '../TrackerEnvelopeCrypto';
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
  encryptionKey?: CryptoKey;
  initializeIssueKeyPrefix?: string;
}): Promise<BuiltEngine> {
  const persistence = new InMemoryTrackerPersistence();
  const config: TrackerSyncEngineConfig = {
    serverUrl: 'ws://fake',
    orgId: 'test-org',
    teamProjectId: 'tracker-test-project',
    teamMemberId: asTeamMemberId(`user-${Math.random().toString(36).slice(2, 8)}`),
    persistence,
    initializeIssueKeyPrefix: opts.initializeIssueKeyPrefix,
    getJwt: async () => asTeamJwt('fake-jwt'),
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
      listUnsynced: async () => [],
      applyRemote: async (def) => { bApplied.push(def); },
    };

    await b.engine.connect();
    await waitUntil(() => b.engine.getStatus() === 'connected');

    let aPending = [{ type: 'epic', model, deleted: false }];
    const aApplied: Array<{ type: string; model: string | null; syncId: number }> = [];
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    a.config.schemaSync = {
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

  it('completes schema bootstrap before applying the first item batch', async () => {
    const server = createFakeServer();
    const model = schemaModelJson('epic');

    let pendingSchemas = [{ type: 'epic', model, deleted: false }];
    const publisher = await buildEngine({
      room: server.room,
      serverConnect: server.connect,
      encryptionKey: key,
    });
    publisher.config.schemaSync = {
      listUnsynced: async () => pendingSchemas,
      applyRemote: async (def) => {
        pendingSchemas = pendingSchemas.filter(row => row.type !== def.type);
      },
    };

    await publisher.engine.connect();
    await waitUntil(() => server.room.getStoredSchemas().length === 1);
    await publisher.engine.upsertItem(basePayload('epic-1', { primaryType: 'epic' }));
    await waitUntil(() => server.room.getStoredItems().length === 1);

    const applicationOrder: string[] = [];
    const subscriber = await buildEngine({
      room: server.room,
      serverConnect: server.connect,
      encryptionKey: key,
    });
    subscriber.config.schemaSync = {
      listUnsynced: async () => [],
      applyRemote: async () => { applicationOrder.push('schema'); },
    };
    subscriber.config.onItemApplied = () => { applicationOrder.push('item'); };

    await subscriber.engine.connect();
    await waitUntil(() => subscriber.engine.getStatus() === 'connected');

    expect(applicationOrder).toEqual(['schema', 'item']);

    publisher.engine.destroy();
    subscriber.engine.destroy();
  });

  it('still loads items when the schema lane never answers', async () => {
    const server = createFakeServer();
    const publisher = await buildEngine({
      room: server.room,
      serverConnect: server.connect,
      encryptionKey: key,
    });
    await publisher.engine.connect();
    await waitUntil(() => publisher.engine.getStatus() === 'connected');
    await publisher.engine.upsertItem(basePayload('deaf-schema-1'));
    await waitUntil(() => server.room.getStoredItems().length === 1);

    // A server too old to implement `trackerSchemaSync` never answers it. The
    // schema lane runs first, so an unbounded wait there would strand the item
    // bootstrap behind it and leave this client with an empty tracker.
    const subscriber = await buildEngine({
      room: server.room,
      encryptionKey: key,
      serverConnect: () => {
        const ws = server.connect();
        const relay = ws as unknown as { onSendFromClient: ((data: string) => void) | null };
        const forward = relay.onSendFromClient;
        relay.onSendFromClient = (data) => {
          if ((JSON.parse(data) as { type: string }).type === 'trackerSchemaSync') return;
          forward?.(data);
        };
        return ws;
      },
    });
    subscriber.config.schemaBootstrapTimeoutMs = 50;
    subscriber.config.schemaSync = {
      listUnsynced: async () => [],
      applyRemote: async () => {},
    };

    await subscriber.engine.connect();
    await waitUntil(() => subscriber.engine.getStatus() === 'connected', 2000);
    expect(subscriber.persistence.items.has('deaf-schema-1')).toBe(true);

    publisher.engine.destroy();
    subscriber.engine.destroy();
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

  it('returns a legible correlated rejection when the server says a prefix is taken', async () => {
    const server = createFakeServer({ rejectConfigPrefix: 'TAKEN' });
    const a = await buildEngine({ room: server.room, serverConnect: server.connect, encryptionKey: key });
    const diagnostics: string[] = [];
    a.config.onServerError = error => diagnostics.push(error.message);

    await a.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected');
    const result = await a.engine.setIssueKeyPrefix('TAKEN');

    expect(result).toMatchObject({
      success: false,
      code: 'issueKeyPrefixTaken',
      conflictingProjectName: 'Other Project',
      suggestedPrefix: 'FREE',
    });
    expect(result.message).toContain('already used by project "Other Project"');
    expect(diagnostics).toEqual([result.message]);
    expect(a.engine.getStatus()).toBe('connected');
    a.engine.destroy();
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
  // Phase 7: Recovery scenarios (per D10 + audit-doc Q7)
  //
  // Scenarios in which a client interacts with a tracker room in an unusual
  // state. Phase 7 of the rewrite gates the PR on these contracts: a sync
  // change that breaks any of them blocks the PR.
  //   1. New room (no prior state) -- fresh client + fresh DO.
  //   3. Empty-room recovery -- server has zero items, client has local
  //      state; client treats response as "caught up" without dropping
  //      local state.
  //
  // Scenarios 2 and 4 covered the retired client-managed lane (decrypt
  // failure under a key we don't have, and `staleKeyEpoch` rekey) and went
  // away with it: the server now decrypts the rows it owns.
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
  });
});
