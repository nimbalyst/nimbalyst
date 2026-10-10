// @vitest-environment node
/**
 * NIM-7336: one shared plan outgrew the 256 KiB item limit. Every reconnect
 * then left a ~600 KB outbox row the room could never accept, until loading
 * the outbox exceeded the database's response limit and every later connect
 * skipped the schema, navigation and saved-view pushes.
 */
import { describe, expect, it } from 'vitest';
import { asTeamJwt, asTeamMemberId, MAX_TRACKER_ITEM_PAYLOAD_BYTES } from '@nimbalyst/collab-protocol';
import { TrackerSyncEngine, type TrackerSyncEngineConfig } from '../TrackerSyncEngine';
import { InMemoryTrackerPersistence } from '../trackerPersistence';
import { encodeTrackerPayloadPlaintext, TrackerPayloadTooLargeError } from '../trackerEnvelopeCodec';
import { createFakeServer } from './fakeTrackerServer';
import type { TrackerActivity, TrackerItemPayload } from '../trackerProtocol';

function payload(itemId: string, overrides: Partial<TrackerItemPayload> = {}): TrackerItemPayload {
  return {
    itemId,
    primaryType: 'plan',
    archived: false,
    bodyVersion: 0,
    fields: { title: itemId, status: 'to-do' },
    labels: {},
    comments: [],
    system: {},
    ...overrides,
  };
}

/** Activity shaped like NIM-2648's: whole descriptions on both sides of each edit. */
function bloatedActivity(count: number, valueChars: number): TrackerActivity[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `activity_${index}`,
    authorIdentity: { email: 'a@example.com', displayName: 'A', gitName: null, gitEmail: null },
    action: 'updated',
    field: 'description',
    oldValue: 'o'.repeat(valueChars),
    newValue: 'n'.repeat(valueChars),
    timestamp: index + 1,
  }));
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function buildEngine(persistence: InMemoryTrackerPersistence, connect?: () => WebSocket) {
  const config: TrackerSyncEngineConfig = {
    serverUrl: 'ws://fake',
    orgId: 'org',
    teamProjectId: 'project',
    teamMemberId: asTeamMemberId('member'),
    persistence,
    getJwt: async () => asTeamJwt('jwt'),
    createWebSocket: () => {
      if (!connect) throw new Error('offline');
      return connect();
    },
  };
  return { engine: new TrackerSyncEngine(config), config };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('oversized tracker items (NIM-7336)', () => {
  it('trims activity on the wire until the item fits, newest entries kept', () => {
    const item = payload('plan-1', { activity: bloatedActivity(37, 8_000) });
    expect(bytes(JSON.stringify(item))).toBeGreaterThan(MAX_TRACKER_ITEM_PAYLOAD_BYTES);

    const encoded = encodeTrackerPayloadPlaintext(item);
    const sent = JSON.parse(encoded) as TrackerItemPayload;

    expect(bytes(encoded)).toBeLessThanOrEqual(MAX_TRACKER_ITEM_PAYLOAD_BYTES);
    expect(sent.activity?.at(-1)?.id).toBe('activity_36');
    expect(item.activity).toHaveLength(37);
    expect(item.activity?.[0].oldValue).toHaveLength(8_000);
  });

  it('refuses an item that is too large without activity, and writes nothing locally', async () => {
    const persistence = new InMemoryTrackerPersistence();
    const { engine } = buildEngine(persistence);
    const huge = payload('plan-2', {
      fields: { title: 'Huge', description: 'd'.repeat(MAX_TRACKER_ITEM_PAYLOAD_BYTES + 1) },
    });

    await expect(engine.upsertItem(huge)).rejects.toBeInstanceOf(TrackerPayloadTooLargeError);
    await expect(engine.upsertItem(huge, { persistedEnqueue: true })).rejects.toBeInstanceOf(TrackerPayloadTooLargeError);
    expect(persistence.transactions.size).toBe(0);
    expect(persistence.items.has('plan-2')).toBe(false);
    engine.destroy();
  });

  it('still pushes schemas, navigation and saved views when loading the outbox fails', async () => {
    const server = createFakeServer();
    const persistence = new InMemoryTrackerPersistence();
    const calls: string[] = [];
    persistence.consolidatePendingUpdates = async () => { calls.push('consolidate'); return 0; };
    const getMaxSyncId = persistence.getMaxSyncId.bind(persistence);
    persistence.getMaxSyncId = async () => { calls.push('bootstrap'); return getMaxSyncId(); };
    persistence.loadPendingTransactions = async () => {
      calls.push('load');
      throw new Error('Query result is too large to return');
    };
    const { engine, config } = buildEngine(persistence, server.connect);
    const errors: unknown[] = [];
    config.onBootstrapError = (err) => { errors.push(err); };
    config.schemaSync = {
      listUnsynced: async () => [{ type: 'epic', model: JSON.stringify({ type: 'epic', fields: [] }), deleted: false }],
      applyRemote: async () => {},
    };
    config.navigationSync = {
      getMaxSyncId: async () => 0,
      listUnsynced: async () => [{ entryId: 'folder:a', payload: JSON.stringify({ entryId: 'folder:a', kind: 'folder' }), deleted: false }],
      applyRemote: async () => {},
    };
    config.savedViewSync = {
      getMaxSyncId: async () => 0,
      listUnsynced: async () => [{ viewId: 'view-a', payload: JSON.stringify({ id: 'view-a' }), deleted: false }],
      applyRemote: async () => {},
    };

    await engine.connect();
    await waitUntil(() =>
      server.room.receivedSchemaMutations.length > 0
      && server.room.receivedNavigationMutations.length > 0
      && server.room.receivedSavedViewMutations.length > 0);

    expect(String(errors[0])).toContain('too large');
    // Consolidation reads local rows as the newest local state, so it runs
    // before the bootstrap can overwrite them.
    expect(calls.slice(0, 2)).toEqual(['consolidate', 'bootstrap']);
    expect(calls).toContain('load');
    engine.destroy();
  });
});
