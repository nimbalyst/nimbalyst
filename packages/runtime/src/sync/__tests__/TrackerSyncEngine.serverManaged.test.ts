/**
 * Epic H2 — client-side server-managed key custody for TrackerSyncEngine.
 *
 * In server-managed mode the engine holds NO encryption key: it sends item and
 * schema payloads as PLAINTEXT (no iv, `orgKeyFingerprint` null) and decodes
 * incoming payloads as plaintext JSON. The real server encrypts at rest with
 * the team DEK (proven by the wrangler integration tests in nimbalyst-collab).
 *
 * Here the FakeTrackerRoom is a dumb relay, so a keyless writer and a keyless
 * reader round-trip plaintext through it — the client-side proof that a client
 * with no org key can read/write team data, impossible under legacy ECDH.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TrackerSyncEngine, type TrackerSyncEngineConfig } from '../TrackerSyncEngine';
import { InMemoryTrackerPersistence } from '../trackerPersistence';
import type { TrackerItemPayload } from '../trackerProtocol';
import { createFakeServer, type FakeTrackerRoom } from './fakeTrackerServer';

function basePayload(itemId: string, overrides: Partial<TrackerItemPayload> = {}): TrackerItemPayload {
  return {
    itemId,
    primaryType: 'task',
    archived: false,
    bodyVersion: 0,
    fields: { title: `Item ${itemId}`, status: 'to-do' },
    labels: {},
    comments: [],
    system: {},
    ...overrides,
  };
}

interface BuiltEngine {
  engine: TrackerSyncEngine;
  persistence: InMemoryTrackerPersistence;
  config: TrackerSyncEngineConfig;
}

/** Build a server-managed engine — note: NO encryptionKey, NO fingerprint. */
function buildServerManagedEngine(opts: {
  room: FakeTrackerRoom;
  serverConnect: () => WebSocket;
}): BuiltEngine {
  const persistence = new InMemoryTrackerPersistence();
  const config: TrackerSyncEngineConfig = {
    serverUrl: 'ws://fake',
    orgId: 'test-org',
    teamProjectId: 'tracker-sm-project',
    userId: `user-${Math.random().toString(36).slice(2, 8)}`,
    keyCustody: 'server-managed',
    orgKeyFingerprint: null,
    persistence,
    getJwt: async () => 'fake-jwt',
    createWebSocket: () => opts.serverConnect(),
  };
  const engine = new TrackerSyncEngine(config);
  return { engine, persistence, config };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('TrackerSyncEngine server-managed (in-memory)', () => {
  let server: ReturnType<typeof createFakeServer>;

  beforeEach(() => {
    server = createFakeServer();
  });

  it('a keyless writer sends plaintext and a keyless reader sees it', async () => {
    const a = buildServerManagedEngine({ room: server.room, serverConnect: server.connect });
    const b = buildServerManagedEngine({ room: server.room, serverConnect: server.connect });

    const appliedOnB: string[] = [];
    b.config.onItemApplied = (item) => { appliedOnB.push(item.itemId); };

    await a.engine.connect();
    await b.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected' && b.engine.getStatus() === 'connected');

    await a.engine.upsertItem(basePayload('sm-1', { fields: { title: 'Server Managed', status: 'in-progress' } }));
    await waitUntil(() => appliedOnB.includes('sm-1'));

    // The reader projected the payload without any key.
    const localB = b.persistence.items.get('sm-1');
    expect(localB?.payload?.fields.title).toBe('Server Managed');

    // The wire payload the relay stored is PLAINTEXT JSON with no iv (the client
    // performed no encryption — the real server would encrypt this at rest).
    const stored = server.room.getStoredItems().find(i => i.itemId === 'sm-1');
    expect(stored?.iv).toBeUndefined();
    expect(stored?.orgKeyFingerprint ?? null).toBeNull();
    expect(stored?.encryptedPayload).toBeTruthy();
    const parsed = JSON.parse(stored!.encryptedPayload!);
    expect(parsed.fields.title).toBe('Server Managed');

    a.engine.destroy();
    b.engine.destroy();
  });

  it('round-trips a delete (tombstone) in server-managed mode', async () => {
    const a = buildServerManagedEngine({ room: server.room, serverConnect: server.connect });
    const b = buildServerManagedEngine({ room: server.room, serverConnect: server.connect });

    const tombstonedOnB: string[] = [];
    b.config.onItemApplied = (item) => { if (item.isTombstone) tombstonedOnB.push(item.itemId); };

    await a.engine.connect();
    await b.engine.connect();
    await waitUntil(() => a.engine.getStatus() === 'connected' && b.engine.getStatus() === 'connected');

    await a.engine.upsertItem(basePayload('sm-del', { fields: { title: 'temp', status: 'to-do' } }));
    await waitUntil(() => b.persistence.items.has('sm-del'));

    await a.engine.deleteItem('sm-del');
    await waitUntil(() => tombstonedOnB.includes('sm-del'));

    a.engine.destroy();
    b.engine.destroy();
  });
});
