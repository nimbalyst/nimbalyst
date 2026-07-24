/**
 * FakeTrackerServer
 *
 * In-memory replica of `TeamTrackerRoom`'s relevant behavior, used by the
 * runtime integration tests. Mirrors the wire protocol from
 * `../trackerProtocol.ts` closely enough that the engine cannot tell it
 * is talking to a fake.
 *
 * Phase 2's `trackerRoom.integration.test.ts` is the contract test for
 * the real DO. This file is the contract test for the client engine
 * sitting opposite an obedient server -- no wrangler / no Cloudflare /
 * no D1 / no SQLite.
 *
 * Supported messages:
 *   - trackerSync          -> trackerSyncResponse (single-page; no hasMore)
 *   - trackerMutation      -> trackerMutationAck (+ broadcast trackerDelta
 *                             to everyone else)
 *   - trackerSetConfig     -> trackerConfigBroadcast (all connections,
 *                             including originator)
 *   - trackerPing          -> trackerPong
 *
 * Intentionally simplified:
 *   - No issue-key prefix uniqueness check.
 *   - No rotation lock / key-epoch enforcement (tests that need that
 *     enable `keyEpoch` checking explicitly).
 *   - No hibernation / TTL.
 */

import type {
  EncryptedTrackerItemEnvelope,
  SyncId,
  TrackerClientMessage,
  TrackerServerMessage,
  TrackerMutationAckMessage,
  TrackerMutationRejectCode,
  TrackerRoomConfig,
  TrackerDeltaMessage,
  TrackerSyncResponseMessage,
  EncryptedTrackerSchemaEnvelope,
  TrackerSchemaSyncResponseMessage,
  TrackerSchemaDeltaMessage,
  TrackerSchemaMutationAckMessage,
  EncryptedTrackerNavigationEnvelope,
  TrackerNavigationSyncResponseMessage,
  TrackerNavigationDeltaMessage,
  TrackerNavigationMutationAckMessage,
  EncryptedTrackerSavedViewEnvelope,
  TrackerSavedViewSyncResponseMessage,
  TrackerSavedViewDeltaMessage,
  TrackerSavedViewMutationAckMessage,
} from '../trackerProtocol';

// ============================================================================
// Fake WebSocket pair
// ============================================================================

type Listener<T extends string> = T extends 'message'
  ? (event: MessageEvent) => void
  : (event: Event) => void;

/**
 * Minimal WebSocket-shaped object. Implements just the surface the engine
 * uses: `readyState`, `addEventListener`, `removeEventListener`, `send`,
 * `close`.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSING = FakeWebSocket.CLOSING;
  readonly CLOSED = FakeWebSocket.CLOSED;

  readyState: number = FakeWebSocket.CONNECTING;

  private readonly messageListeners = new Set<Listener<'message'>>();
  private readonly openListeners = new Set<Listener<'open'>>();
  private readonly closeListeners = new Set<Listener<'close'>>();
  private readonly errorListeners = new Set<Listener<'error'>>();

  /** Wired by FakeTrackerRoom when this socket joins a room. */
  onSendFromClient: ((data: string) => void) | null = null;
  onCloseFromClient: (() => void) | null = null;

  // EventTarget-ish surface
  addEventListener(type: 'open' | 'message' | 'close' | 'error', cb: (event: Event | MessageEvent) => void): void {
    switch (type) {
      case 'open':
        this.openListeners.add(cb as Listener<'open'>);
        break;
      case 'message':
        this.messageListeners.add(cb as Listener<'message'>);
        break;
      case 'close':
        this.closeListeners.add(cb as Listener<'close'>);
        break;
      case 'error':
        this.errorListeners.add(cb as Listener<'error'>);
        break;
    }
  }

  removeEventListener(type: 'open' | 'message' | 'close' | 'error', cb: (event: Event | MessageEvent) => void): void {
    switch (type) {
      case 'open':
        this.openListeners.delete(cb as Listener<'open'>);
        break;
      case 'message':
        this.messageListeners.delete(cb as Listener<'message'>);
        break;
      case 'close':
        this.closeListeners.delete(cb as Listener<'close'>);
        break;
      case 'error':
        this.errorListeners.delete(cb as Listener<'error'>);
        break;
    }
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('FakeWebSocket: send called while not OPEN');
    }
    this.onSendFromClient?.(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onCloseFromClient?.();
    for (const cb of this.closeListeners) {
      cb(new Event('close'));
    }
  }

  // Called by the room to deliver a server message to this client.
  deliver(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) return;
    const event = new MessageEvent('message', { data });
    for (const cb of this.messageListeners) {
      cb(event);
    }
  }

  // Called by the room to flip the socket open after the handshake.
  openNow(): void {
    if (this.readyState === FakeWebSocket.OPEN) return;
    this.readyState = FakeWebSocket.OPEN;
    for (const cb of this.openListeners) {
      cb(new Event('open'));
    }
  }
}

// ============================================================================
// FakeTrackerRoom (in-memory DO replica)
// ============================================================================

interface StoredItem {
  itemId: string;
  syncId: SyncId;
  encryptedPayload: string | null;
  iv: string | null;
  updatedAt: number;
  deletedAt: number | null;
  orgKeyFingerprint: string | null;
  issueNumber: number | null;
  issueKey: string | null;
}

interface StoredSchema {
  schemaType: string;
  syncId: SyncId;
  encryptedPayload: string | null;
  iv: string | null;
  updatedAt: number;
  deletedAt: number | null;
  orgKeyFingerprint: string | null;
}

interface StoredNavigation {
  entryId: string;
  syncId: SyncId;
  encryptedPayload: string | null;
  iv: string | null;
  updatedAt: number;
  deletedAt: number | null;
  orgKeyFingerprint: string | null;
}

interface StoredSavedView {
  viewId: string;
  syncId: SyncId;
  encryptedPayload: string | null;
  iv: string | null;
  updatedAt: number;
  deletedAt: number | null;
  orgKeyFingerprint: string | null;
}

export interface FakeTrackerRoomOptions {
  /** Initial config; defaults to issueKeyPrefix='NIM'. */
  config?: TrackerRoomConfig;

  /**
   * If set, mutations carrying a different fingerprint get rejected
   * with `staleKeyEpoch`. Lets tests drive the rotation-mid-flight path.
   */
  currentFingerprint?: string | null;

  /**
   * If true, every mutation gets rejected with `forbidden`. Lets tests
   * drive the rejection / rollback path.
   */
  rejectAll?: boolean;
}

/**
 * In-memory tracker room. One instance per (orgId, teamProjectId).
 *
 * The router (see `createFakeServer`) is the manager. Tests usually just
 * call `createFakeServer().connect(...)` to get a `FakeWebSocket` they
 * can hand to a `TrackerSyncEngine`.
 */
export class FakeTrackerRoom {
  private readonly items = new Map<string, StoredItem>();
  private readonly schemas = new Map<string, StoredSchema>();
  private readonly navigation = new Map<string, StoredNavigation>();
  private readonly savedViews = new Map<string, StoredSavedView>();
  private readonly connections = new Set<FakeWebSocket>();
  private syncId: SyncId = 0;
  private schemaSyncId: SyncId = 0;
  private navigationSyncId: SyncId = 0;
  private savedViewSyncId: SyncId = 0;
  private nextIssueNumber = 1;
  private config: TrackerRoomConfig;
  private currentFingerprint: string | null;
  private rejectAll: boolean;

  /** Mutation log for test assertions. */
  readonly receivedMutations: Array<{ itemId: string; clientMutationId: string }> = [];
  readonly receivedSchemaMutations: Array<{ schemaType: string; clientMutationId: string }> = [];
  readonly receivedNavigationMutations: Array<{ entryId: string; clientMutationId: string }> = [];
  readonly receivedSavedViewMutations: Array<{ viewId: string; clientMutationId: string }> = [];

  constructor(options: FakeTrackerRoomOptions = {}) {
    this.config = options.config ?? { issueKeyPrefix: 'NIM' };
    this.currentFingerprint = options.currentFingerprint ?? null;
    this.rejectAll = options.rejectAll ?? false;
  }

  /** Tweak the rotation gate at runtime. */
  setCurrentFingerprint(fingerprint: string | null): void {
    this.currentFingerprint = fingerprint;
  }

  /** Stop rejecting (used after the "first attempt fails, retry succeeds" tests). */
  setRejectAll(value: boolean): void {
    this.rejectAll = value;
  }

  /**
   * Wipe the room's stored items (simulates a server-side data-loss event,
   * or the rotation flow where the changelog is truncated). The internal
   * `syncId` counter is preserved -- a wiped room with `syncId=N` will
   * answer a `sinceSyncId=N` bootstrap with an empty batch and the client
   * should treat that as "caught up" without dropping local state.
   */
  wipeItems(): void {
    this.items.clear();
  }

  /**
   * Inject a precomputed envelope directly into the store (no mutation,
   * no broadcast). Lets tests construct decrypt-failure scenarios where
   * the room contains a row encrypted under a key the client doesn't have.
   */
  injectStoredEnvelope(envelope: EncryptedTrackerItemEnvelope): void {
    const now = Date.now();
    this.syncId = Math.max(this.syncId, envelope.syncId);
    this.items.set(envelope.itemId, {
      itemId: envelope.itemId,
      syncId: envelope.syncId,
      encryptedPayload: envelope.encryptedPayload,
      iv: envelope.iv ?? null,
      updatedAt: envelope.updatedAt ?? now,
      deletedAt: envelope.deletedAt ?? null,
      orgKeyFingerprint: envelope.orgKeyFingerprint ?? null,
      issueNumber: envelope.issueNumber ?? null,
      issueKey: envelope.issueKey ?? null,
    });
  }

  /**
   * Wire up a fake socket from a client. Returns the socket so the test
   * can pass it to `TrackerSyncEngine` via `createWebSocket`.
   */
  acceptConnection(ws: FakeWebSocket): void {
    this.connections.add(ws);
    ws.onSendFromClient = (data) => this.handleClientMessage(ws, data);
    ws.onCloseFromClient = () => this.connections.delete(ws);
    // Flip open in a microtask so the engine can attach its listeners
    // before the open event fires.
    queueMicrotask(() => ws.openNow());
  }

  // --------------------------------------------------------------------------
  // Message handling
  // --------------------------------------------------------------------------

  private handleClientMessage(ws: FakeWebSocket, data: string): void {
    let msg: TrackerClientMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'trackerSync':
        this.handleSync(ws, msg.sinceSyncId);
        break;
      case 'trackerMutation':
        this.handleMutation(ws, msg);
        break;
      case 'trackerSchemaSync':
        this.handleSchemaSync(ws, msg.sinceSyncId);
        break;
      case 'trackerSchemaMutation':
        this.handleSchemaMutation(ws, msg);
        break;
      case 'trackerSavedViewSync':
        this.handleSavedViewSync(ws, msg.sinceSyncId);
        break;
      case 'trackerSavedViewMutation':
        this.handleSavedViewMutation(ws, msg);
        break;
      case 'trackerNavigationSync':
        this.handleNavigationSync(ws, msg.sinceSyncId);
        break;
      case 'trackerNavigationMutation':
        this.handleNavigationMutation(ws, msg);
        break;
      case 'trackerSetConfig':
        this.handleSetConfig(msg.key, msg.value);
        break;
      case 'trackerPing':
        this.deliver(ws, { type: 'trackerPong' });
        break;
    }
  }

  private handleSync(ws: FakeWebSocket, sinceSyncId: SyncId): void {
    const items: EncryptedTrackerItemEnvelope[] = [...this.items.values()]
      .filter(row => row.syncId > sinceSyncId)
      .sort((a, b) => a.syncId - b.syncId)
      .map(toEnvelope);

    const response: TrackerSyncResponseMessage = {
      type: 'trackerSyncResponse',
      items,
      cursorSyncId: items.length > 0 ? items[items.length - 1].syncId : sinceSyncId,
      hasMore: false,
    };
    if (sinceSyncId === 0) {
      response.config = this.config;
    }
    this.deliver(ws, response);
  }

  private handleMutation(
    ws: FakeWebSocket,
    msg: Extract<TrackerClientMessage, { type: 'trackerMutation' }>,
  ): void {
    this.receivedMutations.push({ itemId: msg.itemId, clientMutationId: msg.clientMutationId });

    if (this.rejectAll) {
      this.sendReject(ws, msg.clientMutationId, 'forbidden', 'rejectAll=true');
      return;
    }

    // Stale-key-epoch enforcement (when enabled by the test).
    if (
      this.currentFingerprint !== null &&
      msg.encryptedPayload !== null &&
      msg.orgKeyFingerprint !== this.currentFingerprint
    ) {
      this.sendReject(
        ws,
        msg.clientMutationId,
        'staleKeyEpoch',
        `Expected ${this.currentFingerprint}, got ${msg.orgKeyFingerprint ?? '(none)'}`,
      );
      return;
    }

    const isDelete = msg.encryptedPayload === null;
    const now = Date.now();
    this.syncId++;
    const newSyncId = this.syncId;

    const existing = this.items.get(msg.itemId);
    let issueNumber = existing?.issueNumber ?? null;
    let issueKey = existing?.issueKey ?? null;
    if (!isDelete && issueNumber === null) {
      issueNumber = this.nextIssueNumber++;
      issueKey = `${this.config.issueKeyPrefix}-${issueNumber}`;
    }

    const stored: StoredItem = {
      itemId: msg.itemId,
      syncId: newSyncId,
      encryptedPayload: isDelete ? null : msg.encryptedPayload,
      iv: isDelete ? null : (msg.iv ?? null),
      updatedAt: now,
      deletedAt: isDelete ? now : null,
      orgKeyFingerprint: isDelete ? null : (msg.orgKeyFingerprint ?? null),
      issueNumber,
      issueKey,
    };
    this.items.set(msg.itemId, stored);

    const envelope = toEnvelope(stored);

    const ack: TrackerMutationAckMessage = {
      type: 'trackerMutationAck',
      clientMutationId: msg.clientMutationId,
      accepted: true,
      syncId: newSyncId,
      item: envelope,
    };
    if (issueNumber !== null) ack.issueNumber = issueNumber;
    if (issueKey !== null) ack.issueKey = issueKey;
    this.deliver(ws, ack);

    // Broadcast delta to other connections.
    const delta: TrackerDeltaMessage = { type: 'trackerDelta', item: envelope };
    for (const peer of this.connections) {
      if (peer === ws) continue;
      this.deliver(peer, delta);
    }
  }

  private handleSchemaSync(ws: FakeWebSocket, sinceSyncId: SyncId): void {
    const schemas: EncryptedTrackerSchemaEnvelope[] = [...this.schemas.values()]
      .filter(row => row.syncId > sinceSyncId)
      .sort((a, b) => a.syncId - b.syncId)
      .map(toSchemaEnvelope);

    const response: TrackerSchemaSyncResponseMessage = {
      type: 'trackerSchemaSyncResponse',
      schemas,
      cursorSyncId: schemas.length > 0 ? schemas[schemas.length - 1].syncId : sinceSyncId,
      hasMore: false,
    };
    this.deliver(ws, response);
  }

  private handleSchemaMutation(
    ws: FakeWebSocket,
    msg: Extract<TrackerClientMessage, { type: 'trackerSchemaMutation' }>,
  ): void {
    this.receivedSchemaMutations.push({
      schemaType: msg.schemaType,
      clientMutationId: msg.clientMutationId,
    });

    if (this.rejectAll) {
      this.sendSchemaReject(ws, msg.clientMutationId, 'forbidden', 'rejectAll=true');
      return;
    }

    if (
      this.currentFingerprint !== null &&
      msg.encryptedPayload !== null &&
      msg.orgKeyFingerprint !== this.currentFingerprint
    ) {
      this.sendSchemaReject(
        ws,
        msg.clientMutationId,
        'staleKeyEpoch',
        `Expected ${this.currentFingerprint}, got ${msg.orgKeyFingerprint ?? '(none)'}`,
      );
      return;
    }

    const isDelete = msg.encryptedPayload === null;
    const now = Date.now();
    this.schemaSyncId++;
    const newSyncId = this.schemaSyncId;

    const stored: StoredSchema = {
      schemaType: msg.schemaType,
      syncId: newSyncId,
      encryptedPayload: isDelete ? null : msg.encryptedPayload,
      iv: isDelete ? null : (msg.iv ?? null),
      updatedAt: now,
      deletedAt: isDelete ? now : null,
      orgKeyFingerprint: isDelete ? null : (msg.orgKeyFingerprint ?? null),
    };
    this.schemas.set(msg.schemaType, stored);

    const envelope = toSchemaEnvelope(stored);
    const ack: TrackerSchemaMutationAckMessage = {
      type: 'trackerSchemaMutationAck',
      clientMutationId: msg.clientMutationId,
      accepted: true,
      syncId: newSyncId,
      schema: envelope,
    };
    this.deliver(ws, ack);

    const delta: TrackerSchemaDeltaMessage = { type: 'trackerSchemaDelta', schema: envelope };
    for (const peer of this.connections) {
      if (peer === ws) continue;
      this.deliver(peer, delta);
    }
  }

  private handleSavedViewSync(ws: FakeWebSocket, sinceSyncId: SyncId): void {
    const views = [...this.savedViews.values()]
      .filter((row) => row.syncId > sinceSyncId)
      .sort((a, b) => a.syncId - b.syncId)
      .map(toSavedViewEnvelope);
    const response: TrackerSavedViewSyncResponseMessage = {
      type: 'trackerSavedViewSyncResponse',
      views,
      cursorSyncId: views.at(-1)?.syncId ?? sinceSyncId,
      hasMore: false,
    };
    this.deliver(ws, response);
  }

  private handleSavedViewMutation(
    ws: FakeWebSocket,
    msg: Extract<TrackerClientMessage, { type: 'trackerSavedViewMutation' }>,
  ): void {
    this.receivedSavedViewMutations.push({
      viewId: msg.viewId,
      clientMutationId: msg.clientMutationId,
    });
    if (this.rejectAll) {
      const reject: TrackerSavedViewMutationAckMessage = {
        type: 'trackerSavedViewMutationAck',
        clientMutationId: msg.clientMutationId,
        accepted: false,
        error: { code: 'forbidden', message: 'rejectAll=true' },
      };
      this.deliver(ws, reject);
      return;
    }
    const isDelete = msg.encryptedPayload === null;
    const stored: StoredSavedView = {
      viewId: msg.viewId,
      syncId: ++this.savedViewSyncId,
      encryptedPayload: msg.encryptedPayload,
      iv: isDelete ? null : (msg.iv ?? null),
      updatedAt: Date.now(),
      deletedAt: isDelete ? Date.now() : null,
      orgKeyFingerprint: isDelete ? null : msg.orgKeyFingerprint,
    };
    this.savedViews.set(msg.viewId, stored);
    const envelope = toSavedViewEnvelope(stored);
    const ack: TrackerSavedViewMutationAckMessage = {
      type: 'trackerSavedViewMutationAck',
      clientMutationId: msg.clientMutationId,
      accepted: true,
      syncId: stored.syncId,
      view: envelope,
    };
    this.deliver(ws, ack);
    const delta: TrackerSavedViewDeltaMessage = { type: 'trackerSavedViewDelta', view: envelope };
    for (const peer of this.connections) {
      if (peer !== ws) this.deliver(peer, delta);
    }
  }

  private handleNavigationSync(ws: FakeWebSocket, sinceSyncId: SyncId): void {
    const entries = [...this.navigation.values()]
      .filter((row) => row.syncId > sinceSyncId)
      .sort((a, b) => a.syncId - b.syncId)
      .map(toNavigationEnvelope);
    const response: TrackerNavigationSyncResponseMessage = {
      type: 'trackerNavigationSyncResponse',
      entries,
      cursorSyncId: entries.at(-1)?.syncId ?? sinceSyncId,
      hasMore: false,
    };
    this.deliver(ws, response);
  }

  private handleNavigationMutation(
    ws: FakeWebSocket,
    msg: Extract<TrackerClientMessage, { type: 'trackerNavigationMutation' }>,
  ): void {
    this.receivedNavigationMutations.push({
      entryId: msg.entryId,
      clientMutationId: msg.clientMutationId,
    });
    if (this.rejectAll) {
      const reject: TrackerNavigationMutationAckMessage = {
        type: 'trackerNavigationMutationAck',
        clientMutationId: msg.clientMutationId,
        accepted: false,
        error: { code: 'forbidden', message: 'rejectAll=true' },
      };
      this.deliver(ws, reject);
      return;
    }
    const isDelete = msg.encryptedPayload === null;
    const stored: StoredNavigation = {
      entryId: msg.entryId,
      syncId: ++this.navigationSyncId,
      encryptedPayload: msg.encryptedPayload,
      iv: isDelete ? null : (msg.iv ?? null),
      updatedAt: Date.now(),
      deletedAt: isDelete ? Date.now() : null,
      orgKeyFingerprint: isDelete ? null : msg.orgKeyFingerprint,
    };
    this.navigation.set(msg.entryId, stored);
    const envelope = toNavigationEnvelope(stored);
    const ack: TrackerNavigationMutationAckMessage = {
      type: 'trackerNavigationMutationAck',
      clientMutationId: msg.clientMutationId,
      accepted: true,
      syncId: stored.syncId,
      entry: envelope,
    };
    this.deliver(ws, ack);
    const delta: TrackerNavigationDeltaMessage = { type: 'trackerNavigationDelta', entry: envelope };
    for (const peer of this.connections) {
      if (peer !== ws) this.deliver(peer, delta);
    }
  }

  private handleSetConfig(key: 'issueKeyPrefix', value: string): void {
    if (key === 'issueKeyPrefix') {
      this.config = { ...this.config, issueKeyPrefix: value };
      const broadcast = { type: 'trackerConfigBroadcast', config: this.config } as const;
      for (const peer of this.connections) {
        this.deliver(peer, broadcast);
      }
    }
  }

  private sendReject(
    ws: FakeWebSocket,
    clientMutationId: string,
    code: TrackerMutationRejectCode,
    message: string,
  ): void {
    const ack: TrackerMutationAckMessage = {
      type: 'trackerMutationAck',
      clientMutationId,
      accepted: false,
      error: { code, message },
    };
    this.deliver(ws, ack);
  }

  private sendSchemaReject(
    ws: FakeWebSocket,
    clientMutationId: string,
    code: TrackerMutationRejectCode,
    message: string,
  ): void {
    const ack: TrackerSchemaMutationAckMessage = {
      type: 'trackerSchemaMutationAck',
      clientMutationId,
      accepted: false,
      error: { code, message },
    };
    this.deliver(ws, ack);
  }

  private deliver(ws: FakeWebSocket, msg: TrackerServerMessage): void {
    ws.deliver(JSON.stringify(msg));
  }

  /** Read the stored items (for assertions). */
  getStoredItems(): EncryptedTrackerItemEnvelope[] {
    return [...this.items.values()].map(toEnvelope);
  }

  getStoredSchemas(): EncryptedTrackerSchemaEnvelope[] {
    return [...this.schemas.values()].map(toSchemaEnvelope);
  }

  getStoredSavedViews(): EncryptedTrackerSavedViewEnvelope[] {
    return [...this.savedViews.values()].map(toSavedViewEnvelope);
  }

  getStoredNavigation(): EncryptedTrackerNavigationEnvelope[] {
    return [...this.navigation.values()].map(toNavigationEnvelope);
  }
}

function toEnvelope(stored: StoredItem): EncryptedTrackerItemEnvelope {
  const env: EncryptedTrackerItemEnvelope = {
    itemId: stored.itemId,
    syncId: stored.syncId,
    encryptedPayload: stored.encryptedPayload,
    updatedAt: stored.updatedAt,
    deletedAt: stored.deletedAt,
    orgKeyFingerprint: stored.orgKeyFingerprint,
  };
  if (stored.iv !== null && stored.encryptedPayload !== null) env.iv = stored.iv;
  if (stored.issueNumber !== null) env.issueNumber = stored.issueNumber;
  if (stored.issueKey !== null) env.issueKey = stored.issueKey;
  return env;
}

function toSchemaEnvelope(stored: StoredSchema): EncryptedTrackerSchemaEnvelope {
  const env: EncryptedTrackerSchemaEnvelope = {
    schemaType: stored.schemaType,
    syncId: stored.syncId,
    encryptedPayload: stored.encryptedPayload,
    updatedAt: stored.updatedAt,
    deletedAt: stored.deletedAt,
    orgKeyFingerprint: stored.orgKeyFingerprint,
  };
  if (stored.iv !== null && stored.encryptedPayload !== null) env.iv = stored.iv;
  return env;
}

function toSavedViewEnvelope(stored: StoredSavedView): EncryptedTrackerSavedViewEnvelope {
  const env: EncryptedTrackerSavedViewEnvelope = {
    viewId: stored.viewId,
    syncId: stored.syncId,
    encryptedPayload: stored.encryptedPayload,
    updatedAt: stored.updatedAt,
    deletedAt: stored.deletedAt,
    orgKeyFingerprint: stored.orgKeyFingerprint,
  };
  if (stored.iv !== null && stored.encryptedPayload !== null) env.iv = stored.iv;
  return env;
}

function toNavigationEnvelope(stored: StoredNavigation): EncryptedTrackerNavigationEnvelope {
  const env: EncryptedTrackerNavigationEnvelope = {
    entryId: stored.entryId,
    syncId: stored.syncId,
    encryptedPayload: stored.encryptedPayload,
    updatedAt: stored.updatedAt,
    deletedAt: stored.deletedAt,
    orgKeyFingerprint: stored.orgKeyFingerprint,
  };
  if (stored.iv !== null && stored.encryptedPayload !== null) env.iv = stored.iv;
  return env;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a fake server bound to a single room. Tests usually want one
 * room shared by N clients, so this helper returns a `connect()` that
 * mints a fresh `FakeWebSocket` and joins the room.
 */
export function createFakeServer(options: FakeTrackerRoomOptions = {}): {
  room: FakeTrackerRoom;
  /** Returns a WebSocket-shaped object the engine can use directly. */
  connect: () => WebSocket;
} {
  const room = new FakeTrackerRoom(options);
  return {
    room,
    connect: () => {
      const ws = new FakeWebSocket();
      room.acceptConnection(ws);
      return ws as unknown as WebSocket;
    },
  };
}
