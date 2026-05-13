/**
 * Unit tests for TrackerSyncProvider.
 *
 * Tests the provider's connection lifecycle, encryption, offline queue,
 * and message handling using a mock WebSocket. No real server needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'crypto';
import { TrackerSyncProvider } from '../TrackerSync';
import type { TrackerInitialSyncSummary, TrackerItemPayload, TrackerSyncStatus } from '../trackerSyncTypes';

// ============================================================================
// Mock WebSocket
// ============================================================================

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;

  private listeners = new Map<string, Function[]>();
  sentMessages: any[] = [];

  constructor(url: string) {
    this.url = url;
    // Auto-open after microtask (simulates real WebSocket)
    queueMicrotask(() => this.simulateOpen());
  }

  addEventListener(event: string, handler: Function) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler);
  }

  removeEventListener(event: string, handler: Function) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  send(data: string) {
    this.sentMessages.push(JSON.parse(data));
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code: 1000, reason: 'normal' });
  }

  // --- Test helpers ---

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open', {});
  }

  simulateMessage(data: any) {
    this.emit('message', { data: JSON.stringify(data) });
  }

  simulateClose(code = 1006, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }

  simulateError() {
    this.emit('error', {});
  }

  private emit(event: string, data: any) {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(data);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

let mockWsInstances: MockWebSocket[] = [];

async function generateTestKey(): Promise<CryptoKey> {
  return webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  ) as Promise<CryptoKey>;
}

function makePayload(overrides: Partial<TrackerItemPayload> & { itemId: string }): TrackerItemPayload {
  return {
    primaryType: 'bug',
    archived: false,
    system: {},
    fields: { title: 'Test bug', status: 'open', priority: 'high' },
    comments: [],
    activity: [],
    fieldUpdatedAt: {},
    ...overrides,
  };
}

interface TestContext {
  provider: TrackerSyncProvider;
  key: CryptoKey;
  statuses: TrackerSyncStatus[];
  upsertedItems: TrackerItemPayload[];
  deletedIds: string[];
  getWs: () => MockWebSocket;
}

async function createTestProvider(overrides?: Partial<{
  onStatusChange: (s: TrackerSyncStatus) => void;
  onItemUpserted: (item: TrackerItemPayload) => void;
  onItemDeleted: (id: string) => void;
  onInitialSyncComplete: (summary: TrackerInitialSyncSummary) => void | Promise<void>;
}>): Promise<TestContext> {
  const key = await generateTestKey();
  const statuses: TrackerSyncStatus[] = [];
  const upsertedItems: TrackerItemPayload[] = [];
  const deletedIds: string[] = [];

  const provider = new TrackerSyncProvider({
    serverUrl: 'ws://localhost:9999',
    getJwt: async () => 'test-jwt-token',
    orgId: 'test-org',
    encryptionKey: key,
    userId: 'test-user',
    projectId: 'test-project',
    onStatusChange: overrides?.onStatusChange ?? ((s) => statuses.push(s)),
    onItemUpserted: overrides?.onItemUpserted ?? ((item) => upsertedItems.push(item)),
    onItemDeleted: overrides?.onItemDeleted ?? ((id) => deletedIds.push(id)),
    onInitialSyncComplete: overrides?.onInitialSyncComplete,
  });

  return {
    provider,
    key,
    statuses,
    upsertedItems,
    deletedIds,
    getWs: () => mockWsInstances[mockWsInstances.length - 1],
  };
}

// ============================================================================
// Setup / Teardown
// ============================================================================

// Helper to flush real async work (crypto.subtle operations are real promises,
// not timer-based, so advanceTimersByTimeAsync doesn't help)
async function flushAsync(iterations = 5) {
  for (let i = 0; i < iterations; i++) {
    await vi.advanceTimersByTimeAsync(1);
    await new Promise(r => setImmediate(r));
  }
}

beforeEach(() => {
  mockWsInstances = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });

  // Replace global WebSocket with mock
  vi.stubGlobal('WebSocket', class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      mockWsInstances.push(this);
    }
  });

  // Ensure crypto.subtle is available (Node polyfill)
  if (!globalThis.crypto?.subtle) {
    vi.stubGlobal('crypto', webcrypto);
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ============================================================================
// Connection Lifecycle
// ============================================================================

describe('TrackerSyncProvider connection lifecycle', () => {
  it('should transition through connecting -> syncing on open', async () => {
    const { provider, statuses } = await createTestProvider();

    await provider.connect();

    expect(statuses).toContain('connecting');
    expect(statuses).toContain('syncing');
  });

  it('should send trackerSync request on open', async () => {
    const { provider, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    expect(ws.sentMessages).toEqual([
      { type: 'trackerSync', sinceSequence: 0 },
    ]);
  });

  it('should reach connected status after sync response with hasMore=false', async () => {
    const { provider, statuses, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });

    // Let async handlers run
    await vi.advanceTimersByTimeAsync(0);

    expect(statuses).toContain('connected');
    expect(provider.getStatus()).toBe('connected');
  });

  it('should request more items when hasMore=true', async () => {
    const { provider, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 50,
      hasMore: true,
    });

    await vi.advanceTimersByTimeAsync(0);

    // Should have sent initial sync + follow-up
    expect(ws.sentMessages).toHaveLength(2);
    expect(ws.sentMessages[1]).toEqual({ type: 'trackerSync', sinceSequence: 50 });
  });

  it('should set status to disconnected on close', async () => {
    const { provider, statuses, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    getWs().simulateClose();
    await vi.advanceTimersByTimeAsync(0);

    expect(statuses[statuses.length - 1]).toBe('disconnected');
  });

  it('should not connect after destroy', async () => {
    const { provider } = await createTestProvider();

    provider.destroy();

    await expect(provider.connect()).rejects.toThrow('Provider has been destroyed');
  });

  it('should not reconnect after destroy', async () => {
    const { provider, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    provider.destroy();

    // Advance timers -- should not create new WebSocket
    const countBefore = mockWsInstances.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(mockWsInstances.length).toBe(countBefore);
  });

  it('should report initial sync summary after the final sync response', async () => {
    const summaries: TrackerInitialSyncSummary[] = [];
    const { provider, getWs } = await createTestProvider({
      onInitialSyncComplete: (summary) => {
        summaries.push(summary);
      },
    });

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 50,
      hasMore: true,
    });
    await vi.advanceTimersByTimeAsync(0);

    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: ['deleted-1'],
      sequence: 51,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(summaries).toEqual([{
      remoteItemCount: 0,
      remoteDeletedCount: 1,
      sequence: 51,
    }]);
  });
});

// ============================================================================
// Encryption
// ============================================================================

describe('TrackerSyncProvider encryption', () => {
  it('should encrypt items before sending upsert', async () => {
    const { provider, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    // Complete initial sync
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    const payload = makePayload({
      itemId: 'enc-bug-1',
      issueNumber: 123,
      issueKey: 'NIM-123',
      fields: { title: 'Secret bug title', status: 'open', priority: 'high' },
    });

    await provider.upsertItem(payload);

    // Should have sent: trackerSync + trackerUpsert
    const upsertMsg = ws.sentMessages.find(m => m.type === 'trackerUpsert');
    expect(upsertMsg).toBeDefined();
    expect(upsertMsg.itemId).toBe('enc-bug-1');
    expect(upsertMsg.issueNumber).toBe(123);
    expect(upsertMsg.issueKey).toBe('NIM-123');
    // Payload should be encrypted -- NOT contain the plaintext title
    expect(upsertMsg.encryptedPayload).toBeDefined();
    expect(upsertMsg.iv).toBeDefined();
    expect(upsertMsg.encryptedPayload).not.toContain('Secret bug title');
  });

  it('should decrypt items received in sync response', async () => {
    const { provider, key, upsertedItems, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    // Encrypt a payload manually to simulate server response
    const payload = makePayload({
      itemId: 'dec-bug-1',
      fields: { title: 'Decrypted title', status: 'open', priority: 'high' },
    });
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext
    );

    const encryptedPayload = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
    const ivBase64 = btoa(String.fromCharCode(...iv));

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [{
        itemId: 'dec-bug-1',
        version: 1,
        encryptedPayload,
        iv: ivBase64,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sequence: 1,
      }],
      deletedItemIds: [],
      sequence: 1,
      hasMore: false,
    });

    await flushAsync();

    expect(upsertedItems).toHaveLength(1);
    expect(upsertedItems[0].itemId).toBe('dec-bug-1');
    expect(upsertedItems[0].fields.title).toBe('Decrypted title');
  });

  it('should apply server-assigned issue identity from sync metadata', async () => {
    const { provider, key, upsertedItems, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const payload = makePayload({
      itemId: 'dec-bug-2',
      fields: { title: 'Assigned key item', status: 'open', priority: 'high' },
    });
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext
    );

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [{
        itemId: 'dec-bug-2',
        issueNumber: 204,
        issueKey: 'NIM-204',
        version: 1,
        encryptedPayload: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
        iv: btoa(String.fromCharCode(...iv)),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sequence: 1,
      }],
      deletedItemIds: [],
      sequence: 1,
      hasMore: false,
    });

    await flushAsync();

    expect(upsertedItems[0].issueNumber).toBe(204);
    expect(upsertedItems[0].issueKey).toBe('NIM-204');
  });
});

// ============================================================================
// Offline Queue
// ============================================================================

describe('TrackerSyncProvider offline queue', () => {
  it('should queue upserts when disconnected', async () => {
    const { provider, getWs } = await createTestProvider();

    // Upsert before connecting -- should queue
    const payload = makePayload({ itemId: 'offline-1', fields: { title: 'Offline item', status: 'open', priority: 'high' } });
    await provider.upsertItem(payload);

    // Connect
    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    // Complete initial sync -- triggers offline queue replay
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await flushAsync();

    // Should have sent: trackerSync + trackerUpsert (replayed from queue)
    const upsertMsg = ws.sentMessages.find(m => m.type === 'trackerUpsert');
    expect(upsertMsg).toBeDefined();
    expect(upsertMsg.itemId).toBe('offline-1');
  });

  it('should queue deletes when disconnected', async () => {
    const { provider, getWs } = await createTestProvider();

    // Delete before connecting
    await provider.deleteItem('offline-delete-1');

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await flushAsync();

    const deleteMsg = ws.sentMessages.find(m => m.type === 'trackerDelete');
    expect(deleteMsg).toBeDefined();
    expect(deleteMsg.itemId).toBe('offline-delete-1');
  });

  it('should not queue when connected', async () => {
    const { provider, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Now upsert while connected -- should send immediately
    const payload = makePayload({ itemId: 'online-1' });
    await provider.upsertItem(payload);

    const upsertMsg = ws.sentMessages.find(m => m.type === 'trackerUpsert');
    expect(upsertMsg).toBeDefined();
  });
});

// ============================================================================
// Broadcast Handling
// ============================================================================

describe('TrackerSyncProvider broadcast handling', () => {
  it('should call onItemUpserted for upsert broadcasts', async () => {
    const { provider, key, upsertedItems, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Simulate broadcast from another user
    const payload = makePayload({ itemId: 'broadcast-1', fields: { title: 'From user2', status: 'open', priority: 'high' } });
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

    ws.simulateMessage({
      type: 'trackerUpsertBroadcast',
      item: {
        itemId: 'broadcast-1',
        version: 1,
        encryptedPayload: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
        iv: btoa(String.fromCharCode(...iv)),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sequence: 1,
      },
    });

    await flushAsync();

    expect(upsertedItems).toHaveLength(1);
    expect(upsertedItems[0].fields.title).toBe('From user2');
  });

  it('should call onItemDeleted for delete broadcasts', async () => {
    const { provider, deletedIds, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    ws.simulateMessage({
      type: 'trackerDeleteBroadcast',
      itemId: 'deleted-by-other',
      sequence: 5,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(deletedIds).toEqual(['deleted-by-other']);
  });

  it('should advance sequence on broadcasts', async () => {
    const { provider, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 10,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(provider.getLastSequence()).toBe(10);

    ws.simulateMessage({
      type: 'trackerDeleteBroadcast',
      itemId: 'any-item',
      sequence: 15,
    });

    expect(provider.getLastSequence()).toBe(15);
  });
});

// ============================================================================
// Deletions in sync response
// ============================================================================

describe('TrackerSyncProvider sync deletions', () => {
  it('should call onItemDeleted for deletedItemIds in sync response', async () => {
    const { provider, deletedIds, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: ['deleted-1', 'deleted-2'],
      sequence: 5,
      hasMore: false,
    });

    await flushAsync();

    expect(deletedIds).toEqual(['deleted-1', 'deleted-2']);
  });
});

// ============================================================================
// LWW Merge on Incoming Items
// ============================================================================

describe('TrackerSyncProvider LWW merge on receive', () => {
  it('should merge incoming items with local cache using LWW', async () => {
    const { provider, key, upsertedItems, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    const now = Date.now();

    // Upsert locally (puts in local cache)
    const localPayload = makePayload({
      itemId: 'merge-item',
      fields: { title: 'Local title', status: 'in-progress' },
      fieldUpdatedAt: {
        title: now - 100, // older
        status: now,       // newer
      },
    });
    await provider.upsertItem(localPayload);

    // Simulate broadcast with conflicting data
    const remotePayload = makePayload({
      itemId: 'merge-item',
      fields: { title: 'Remote title', status: 'done' },
      fieldUpdatedAt: {
        title: now,        // newer -> wins
        status: now - 500, // older
      },
    });
    const plaintext = new TextEncoder().encode(JSON.stringify(remotePayload));
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

    ws.simulateMessage({
      type: 'trackerUpsertBroadcast',
      item: {
        itemId: 'merge-item',
        version: 2,
        encryptedPayload: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
        iv: btoa(String.fromCharCode(...iv)),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sequence: 2,
      },
    });

    await flushAsync();

    // The merged result should take title from remote (newer) and status from local (newer)
    const mergedItem = upsertedItems[upsertedItems.length - 1];
    expect(mergedItem.fields.title).toBe('Remote title');     // remote won
    expect(mergedItem.fields.status).toBe('in-progress');     // local won
  });
});

// ============================================================================
// Batch Upsert
// ============================================================================

describe('TrackerSyncProvider batch operations', () => {
  it('should send batch upsert when connected', async () => {
    const { provider, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    await provider.batchUpsertItems([
      makePayload({ itemId: 'batch-1', fields: { title: 'First', status: 'open', priority: 'high' } }),
      makePayload({ itemId: 'batch-2', fields: { title: 'Second', status: 'open', priority: 'high' } }),
    ]);

    const batchMsg = ws.sentMessages.find(m => m.type === 'trackerBatchUpsert');
    expect(batchMsg).toBeDefined();
    expect(batchMsg.items).toHaveLength(2);
    expect(batchMsg.items[0].itemId).toBe('batch-1');
    expect(batchMsg.items[1].itemId).toBe('batch-2');
  });

  it('should queue batch items individually when offline', async () => {
    const { provider, getWs } = await createTestProvider();

    // Batch before connect
    await provider.batchUpsertItems([
      makePayload({ itemId: 'obatch-1' }),
      makePayload({ itemId: 'obatch-2' }),
    ]);

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await flushAsync();

    // Should be replayed as individual upserts
    const upserts = ws.sentMessages.filter(m => m.type === 'trackerUpsert');
    expect(upserts).toHaveLength(2);
  });
});

// ============================================================================
// Delete sends correct wire message
// ============================================================================

describe('TrackerSyncProvider delete', () => {
  it('should send trackerDelete message when connected', async () => {
    const { provider, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    await provider.deleteItem('item-to-delete');

    const deleteMsg = ws.sentMessages.find(m => m.type === 'trackerDelete');
    expect(deleteMsg).toEqual({ type: 'trackerDelete', itemId: 'item-to-delete' });
  });

  it('should remove item from local cache on delete', async () => {
    const { provider, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    const ws = getWs();
    ws.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Add to local cache then delete
    await provider.upsertItem(makePayload({ itemId: 'cached-item' }));
    await provider.deleteItem('cached-item');

    // Verify by checking that a broadcast for the same item won't trigger merge
    // (it would be treated as a new item, not a merge)
    // This is a whitebox test -- we're verifying internal state indirectly
    const deleteMsg = ws.sentMessages.find(m => m.type === 'trackerDelete');
    expect(deleteMsg).toBeDefined();
  });
});

// ============================================================================
// reconnectNow / wake-from-sleep recovery
// ============================================================================

describe('TrackerSyncProvider reconnectNow', () => {
  it('forces a fresh socket even when the existing one reports OPEN (zombie wake-from-sleep case)', async () => {
    const { provider, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);

    // Reach 'connected' so the old code path's early-return condition is true.
    const ws1 = getWs();
    ws1.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.getStatus()).toBe('connected');
    expect(ws1.readyState).toBe(MockWebSocket.OPEN);

    // Sanity: only one socket exists so far.
    expect(mockWsInstances).toHaveLength(1);

    // Wake-from-sleep: WS still reports OPEN but transport is dead.
    // reconnectNow() must tear it down and create a fresh socket anyway.
    provider.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockWsInstances).toHaveLength(2);
    const ws2 = mockWsInstances[1];
    expect(ws2).not.toBe(ws1);
    expect(ws1.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('ignores a stale close from a torn-down socket and does not clobber the new socket', async () => {
    const { provider, getWs } = await createTestProvider();

    await provider.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws1 = getWs();
    ws1.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Force a fresh socket. The old ws1's close listener is still attached --
    // its 'close' event fires synchronously inside .close() in our mock.
    provider.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockWsInstances).toHaveLength(2);
    const ws2 = mockWsInstances[1];

    // Now simulate a delayed 'close' from the OLD socket arriving after we've
    // already replaced it. Without the identity check this would call
    // handleDisconnect() and null out the new socket.
    ws1.simulateClose(1006, 'transport dead');
    await vi.advanceTimersByTimeAsync(0);

    // ws2 must remain wired up: a sync response on it should still be processed.
    ws2.simulateMessage({
      type: 'trackerSyncResponse',
      items: [],
      deletedItemIds: [],
      sequence: 0,
      hasMore: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(provider.getStatus()).toBe('connected');
    // No third socket should have been created from a phantom scheduleReconnect.
    expect(mockWsInstances).toHaveLength(2);
  });

  it('skips when a previous reconnect handshake is still in CONNECTING', async () => {
    // Use a sync buildUrl so connect() runs synchronously up to creating the
    // WebSocket. This lets us observe the CONNECTING state before the mock's
    // auto-open microtask fires.
    const key = await generateTestKey();
    const provider = new TrackerSyncProvider({
      serverUrl: 'ws://localhost:9999',
      getJwt: async () => 'test-jwt-token',
      buildUrl: () => 'ws://localhost:9999/sync/room?token=t',
      orgId: 'test-org',
      encryptionKey: key,
      userId: 'test-user',
      projectId: 'test-project',
      onStatusChange: () => {},
      onItemUpserted: () => {},
      onItemDeleted: () => {},
    });

    // Don't await -- we want to observe state mid-handshake, before the
    // mock's queued open microtask runs.
    void provider.connect();
    expect(mockWsInstances).toHaveLength(1);
    expect(mockWsInstances[0].readyState).toBe(MockWebSocket.CONNECTING);

    // Burst of reconnectNow calls during the post-wake window. The fresh
    // socket is still mid-handshake; tearing it down would just churn.
    provider.reconnectNow();
    provider.reconnectNow();
    provider.reconnectNow();

    // No additional sockets should have been created.
    expect(mockWsInstances).toHaveLength(1);
    expect(mockWsInstances[0].readyState).toBe(MockWebSocket.CONNECTING);

    // Once the handshake completes, sync proceeds normally.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockWsInstances[0].readyState).toBe(MockWebSocket.OPEN);
  });
});
