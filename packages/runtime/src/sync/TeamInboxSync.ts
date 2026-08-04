import type {
  ActivityRef,
  Actor,
  ConversationSubscription,
  InboxDelivery,
  InboxUnavailableDelivery,
  InboxWatermark,
  InboxWireDelivery,
  PresenceDesiredStatus,
  TeamPresenceMember,
  TeamInboxClientMessage,
  TeamInboxServerMessage,
} from '@nimbalyst/collab-protocol';
import { teamInboxRoomId } from '@nimbalyst/collab-protocol';

import type { TeamJwt, TeamMemberId } from '../auth/jwtScopes';
import { appendSyncClientParams } from './syncClientInfo';

export const DEFAULT_TEAM_INBOX_CONNECT_CONCURRENCY = 4;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CUSTODY_ERROR_CODES = new Set([
  'ORG_SERVER_MANAGED_DEK_REQUIRED',
  'ORG_SERVER_MANAGED_DEK_MISSING',
]);
const PROTOCOL_REJECTION_CODES = new Set(['unknownInboxMessage']);

export interface TeamInboxOrgDescriptor {
  orgId: string;
  orgName: string;
  teamMemberId: TeamMemberId;
}

/** Protocol wire types, re-exported under the names this module has always used. */
export type TeamInboxWatermark = InboxWatermark;
export type TeamInboxUnavailableDelivery = InboxUnavailableDelivery;
export type TeamInboxWireDelivery = InboxWireDelivery;
export type { PresenceDesiredStatus, TeamPresenceMember };

export interface TeamInboxMaterializedDelivery {
  id: string;
  recipientUserId: string;
  orgId: string;
  orgName: string;
  createdAt: number;
  readAt?: number;
  dismissedAt?: number;
  unavailable?: true;
  source?: InboxDelivery['source'];
  reason?: InboxDelivery['reason'];
  /**
   * Structured author of the source event. Optional for the same reason it is
   * optional on the protocol delivery: the server does not populate it yet.
   */
  actor?: Actor;
  preview?: InboxDelivery['preview'];
  subscription?: ConversationSubscription['state'];
  hasUnreadActivity: boolean;
}

export type TeamInboxOrgConnectionStatus =
  | 'connecting'
  | 'ready'
  | 'offline'
  | 'messagingUnavailable';

export interface TeamInboxOrganizationState {
  orgId: string;
  orgName: string;
  status: TeamInboxOrgConnectionStatus;
  errorCode?: string;
  errorMessage?: string;
}

export interface TeamInboxSnapshot {
  status:
    | 'loading'
    | 'ready'
    | 'offlineWithCache'
    | 'offlineWithoutCache'
    | 'reconnecting';
  deliveries: TeamInboxMaterializedDelivery[];
  organizations: TeamInboxOrganizationState[];
  presence?: Record<string, Record<string, TeamPresenceMember>>;
  lastSyncedAt?: number;
}

export type TeamInboxOrgEvent =
  | { type: 'connecting' }
  | {
      type: 'sync';
      deliveries: TeamInboxWireDelivery[];
      watermarks: TeamInboxWatermark[];
      subscriptions: ConversationSubscription[];
    }
  | { type: 'delivery'; delivery: TeamInboxWireDelivery }
  | {
      type: 'watermark';
      conversationId: string;
      sequence: number;
      updatedAt: number;
    }
  | {
      type: 'subscription';
      subscription: ConversationSubscription;
    }
  | {
      type: 'presenceRoster';
      members: TeamPresenceMember[];
    }
  | {
      type: 'presenceDelta';
      member: TeamPresenceMember;
    }
  | {
      type: 'markRead';
      deliveryIds: string[];
      readAt: number;
      unreadCount: number;
    }
  | {
      type: 'dismiss';
      deliveryIds: string[];
      dismissedAt: number;
      unreadCount: number;
    }
  | { type: 'disconnected' }
  | { type: 'error'; code: string; message: string };

export interface TeamInboxOrgClientLike {
  readonly org: TeamInboxOrgDescriptor;
  connect(): Promise<void>;
  markRead(deliveryIds: string[]): Promise<void>;
  dismiss(deliveryIds: string[]): Promise<void>;
  setPresenceStatus?(status: PresenceDesiredStatus): void;
  subscribe(listener: (event: TeamInboxOrgEvent) => void): () => void;
  destroy(): void;
}

export interface TeamInboxOrgClientConfig {
  serverUrl: string;
  org: TeamInboxOrgDescriptor;
  getTeamJwt: () => Promise<TeamJwt>;
  createWebSocket?: (url: string) => WebSocket;
  heartbeatIntervalMs?: number;
  getPresenceStatus?: () => PresenceDesiredStatus;
  now?: () => number;
}

function isCustodyError(code: string): boolean {
  return CUSTODY_ERROR_CODES.has(code);
}

function toWebSocketBase(serverUrl: string): string {
  return serverUrl
    .replace(/^https:/, 'wss:')
    .replace(/^http:/, 'ws:')
    .replace(/\/+$/, '');
}

export class TeamInboxOrgClient implements TeamInboxOrgClientLike {
  readonly org: TeamInboxOrgDescriptor;

  private readonly config: TeamInboxOrgClientConfig;
  private readonly listeners = new Set<(event: TeamInboxOrgEvent) => void>();
  private ws: WebSocket | null = null;
  private destroyed = false;
  private custodyBlocked = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingMessages: TeamInboxClientMessage[] = [];

  constructor(config: TeamInboxOrgClientConfig) {
    this.config = config;
    this.org = config.org;
  }

  async connect(): Promise<void> {
    if (this.destroyed) throw new Error('Team inbox client has been destroyed');
    if (this.ws || this.custodyBlocked) return;

    this.emit({ type: 'connecting' });
    try {
      const jwt = await this.config.getTeamJwt();
      if (this.destroyed || this.custodyBlocked) return;
      const roomId = teamInboxRoomId(this.org.orgId, this.org.teamMemberId);
      const url = appendSyncClientParams(
        `${toWebSocketBase(this.config.serverUrl)}/sync/${roomId}` +
          `?token=${encodeURIComponent(jwt)}`,
      );
      const ws = this.config.createWebSocket
        ? this.config.createWebSocket(url)
        : new WebSocket(url);
      this.ws = ws;

      ws.addEventListener('open', () => {
        if (this.ws !== ws) return;
        this.reconnectAttempt = 0;
        const syncRequest: TeamInboxClientMessage = { type: 'inboxSyncRequest' };
        ws.send(JSON.stringify(syncRequest));
        this.startHeartbeat();
        const pending = this.pendingMessages;
        this.pendingMessages = [];
        for (const message of pending) {
          ws.send(JSON.stringify(message));
        }
      });
      ws.addEventListener('message', (event) => {
        if (this.ws !== ws) return;
        this.handleMessage(event.data);
      });
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.stopHeartbeat();
        this.emit({ type: 'disconnected' });
        this.scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        if (this.ws !== ws) return;
        ws.close();
      });
    } catch (error) {
      this.emit({
        type: 'error',
        code: 'TEAM_INBOX_CONNECTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
    }
  }

  subscribe(listener: (event: TeamInboxOrgEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async markRead(deliveryIds: string[]): Promise<void> {
    this.sendOrQueue({ type: 'markInboxRead', deliveryIds });
  }

  async dismiss(deliveryIds: string[]): Promise<void> {
    this.sendOrQueue({ type: 'dismissInbox', deliveryIds });
  }

  setPresenceStatus(status: PresenceDesiredStatus): void {
    this.sendOrQueue({
      type: 'presenceStatusSet',
      status,
      sentAt: this.config.now?.() ?? Date.now(),
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.pendingMessages = [];
    this.listeners.clear();
  }

  private handleMessage(raw: unknown): void {
    try {
      const message = JSON.parse(
        typeof raw === 'string' ? raw : String(raw),
      ) as TeamInboxServerMessage;
      switch (message.type) {
        case 'inboxSyncResponse':
          this.emit({
            type: 'sync',
            deliveries: message.deliveries ?? [],
            watermarks: message.watermarks ?? [],
            subscriptions: message.subscriptions ?? [],
          });
          return;
        case 'inboxDeliveryBroadcast':
          // console.log('[TeamInboxSync] inboxDeliveryBroadcast received:', {
          //   org: this.config.org.orgId,
          //   hasDelivery: !!message.delivery,
          //   id: message.delivery?.id,
          // });
          if (message.delivery) {
            this.emit({ type: 'delivery', delivery: message.delivery });
          }
          return;
        case 'conversationAdvancedBroadcast':
          this.emit({
            type: 'watermark',
            conversationId: String(message.conversationId ?? ''),
            sequence: Number(message.sequence ?? 0),
            updatedAt: Number(message.updatedAt ?? Date.now()),
          });
          return;
        case 'conversationSubscriptionBroadcast':
          if (message.subscription) {
            this.emit({
              type: 'subscription',
              subscription: message.subscription,
            });
          }
          return;
        case 'presenceRoster':
          this.emit({
            type: 'presenceRoster',
            members: message.members ?? [],
          });
          return;
        case 'presenceDelta':
          if (message.member) {
            this.emit({ type: 'presenceDelta', member: message.member });
          }
          return;
        case 'markInboxReadResponse':
          this.emit({
            type: 'markRead',
            deliveryIds: message.deliveryIds ?? [],
            readAt: Number(message.readAt ?? Date.now()),
            unreadCount: Number(message.unreadCount ?? 0),
          });
          return;
        case 'dismissInboxResponse':
          this.emit({
            type: 'dismiss',
            deliveryIds: message.deliveryIds ?? [],
            dismissedAt: Number(message.dismissedAt ?? Date.now()),
            unreadCount: Number(message.unreadCount ?? 0),
          });
          return;
        case 'inboxError': {
          const code = String(message.code ?? 'TEAM_INBOX_ERROR');
          const errorMessage = String(
            message.message ?? 'Organization inbox error',
          );
          this.emit({ type: 'error', code, message: errorMessage });
          if (isCustodyError(code)) {
            this.custodyBlocked = true;
            const ws = this.ws;
            this.ws = null;
            ws?.close();
          } else if (PROTOCOL_REJECTION_CODES.has(code)) {
            this.ws?.close();
          }
          return;
        }
        default:
          return;
      }
    } catch (error) {
      this.emit({
        type: 'error',
        code: 'TEAM_INBOX_PROTOCOL_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
      this.ws?.close();
    }
  }

  private sendOrQueue(message: TeamInboxClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingMessages.push(message);
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.sendPresenceHeartbeat();
    const interval = Math.max(
      1_000,
      this.config.heartbeatIntervalMs ?? 30_000,
    );
    this.heartbeatTimer = setInterval(() => {
      this.sendPresenceHeartbeat();
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendPresenceHeartbeat(): void {
    this.sendOrQueue({
      type: 'presenceHeartbeat',
      status: this.config.getPresenceStatus?.() ?? 'online',
      sentAt: this.config.now?.() ?? Date.now(),
    });
  }

  private emit(event: TeamInboxOrgEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private scheduleReconnect(): void {
    if (
      this.destroyed
      || this.custodyBlocked
      || this.reconnectTimer
    ) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}

interface OrgMaterializedState {
  descriptor: TeamInboxOrgDescriptor;
  status: TeamInboxOrgConnectionStatus;
  errorCode?: string;
  errorMessage?: string;
  deliveries: Map<string, TeamInboxWireDelivery>;
  watermarks: Map<string, TeamInboxWatermark>;
  subscriptions: Map<string, ConversationSubscription>;
  readReceipts: Map<string, number>;
  presence: Map<string, TeamPresenceMember>;
}

export interface TeamInboxFanInConfig {
  createClient: (org: TeamInboxOrgDescriptor) => TeamInboxOrgClientLike;
  connectConcurrency?: number;
  now?: () => number;
  /**
   * Fires only for a newly accepted realtime delivery broadcast. Initial sync,
   * reconnect hydration, and duplicate broadcasts never reach this callback.
   */
  onDelivery?: (delivery: TeamInboxMaterializedDelivery) => void;
}

export class TeamInboxFanIn {
  private readonly config: TeamInboxFanInConfig;
  private readonly clients = new Map<string, TeamInboxOrgClientLike>();
  private readonly cleanups = new Map<string, () => void>();
  private readonly orgStates = new Map<string, OrgMaterializedState>();
  private readonly listeners = new Set<() => void>();
  private snapshot: TeamInboxSnapshot = {
    status: 'loading',
    deliveries: [],
    organizations: [],
  };
  private lastSyncedAt: number | undefined;
  private destroyed = false;

  constructor(config: TeamInboxFanInConfig) {
    this.config = config;
  }

  async start(organizations: TeamInboxOrgDescriptor[]): Promise<void> {
    this.destroyClients();
    this.destroyed = false;
    for (const descriptor of organizations) {
      this.orgStates.set(descriptor.orgId, {
        descriptor,
        status: 'connecting',
        deliveries: new Map(),
        watermarks: new Map(),
        subscriptions: new Map(),
        readReceipts: new Map(),
        presence: new Map(),
      });
      const client = this.config.createClient(descriptor);
      this.clients.set(descriptor.orgId, client);
      this.cleanups.set(
        descriptor.orgId,
        client.subscribe((event) => {
          this.applyEvent(descriptor.orgId, event);
        }),
      );
    }
    this.rebuildSnapshot();

    const pending = [...organizations];
    const concurrency = Math.max(
      1,
      Math.floor(
        this.config.connectConcurrency
        ?? DEFAULT_TEAM_INBOX_CONNECT_CONCURRENCY,
      ),
    );
    const workers = Array.from(
      { length: Math.min(concurrency, pending.length) },
      async () => {
        while (!this.destroyed) {
          const descriptor = pending.shift();
          if (!descriptor) return;
          const client = this.clients.get(descriptor.orgId);
          if (!client) continue;
          try {
            await client.connect();
          } catch (error) {
            this.applyEvent(descriptor.orgId, {
              type: 'error',
              code: 'TEAM_INBOX_CONNECTION_FAILED',
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
    );
    await Promise.all(workers);
  }

  getSnapshot = (): TeamInboxSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async markRead(deliveryIds: string[]): Promise<void> {
    const grouped = this.groupDeliveryIdsByOrg(deliveryIds);
    await Promise.all(
      [...grouped].map(async ([orgId, ids]) => {
        const client = this.clients.get(orgId);
        if (!client) throw new Error(`No inbox room for organization ${orgId}`);
        await client.markRead(ids);
      }),
    );
  }

  async dismiss(deliveryId: string): Promise<void> {
    const orgId = this.findDeliveryOrg(deliveryId);
    if (!orgId) throw new Error(`Unknown inbox delivery ${deliveryId}`);
    const client = this.clients.get(orgId);
    if (!client) throw new Error(`No inbox room for organization ${orgId}`);
    await client.dismiss([deliveryId]);
  }

  destroy(): void {
    this.destroyed = true;
    this.destroyClients();
    this.orgStates.clear();
    this.rebuildSnapshot();
    this.listeners.clear();
  }

  private applyEvent(orgId: string, event: TeamInboxOrgEvent): void {
    const state = this.orgStates.get(orgId);
    if (!state) return;
    let newDelivery: TeamInboxWireDelivery | null = null;

    switch (event.type) {
      case 'connecting':
        state.status = 'connecting';
        break;
      case 'sync':
        state.status = 'ready';
        state.errorCode = undefined;
        state.errorMessage = undefined;
        state.deliveries = new Map(
          event.deliveries.map((item) => [item.id, item]),
        );
        state.watermarks = new Map(
          event.watermarks.map((item) => [item.conversationId, item]),
        );
        state.subscriptions = new Map(
          event.subscriptions.map((item) => [item.conversationId, item]),
        );
        this.inferReceiptsFromReadDeliveries(state);
        this.lastSyncedAt = this.config.now?.() ?? Date.now();
        break;
      case 'delivery':
        // console.log('[TeamInboxFanIn] delivery event applied:', {
        //   orgId,
        //   id: event.delivery.id,
        //   alreadyKnown: state.deliveries.has(event.delivery.id),
        // });
        if (!state.deliveries.has(event.delivery.id)) {
          newDelivery = event.delivery;
        }
        state.deliveries.set(event.delivery.id, event.delivery);
        break;
      case 'watermark': {
        const current = state.watermarks.get(event.conversationId);
        if (!current || event.sequence > current.sequence) {
          state.watermarks.set(event.conversationId, {
            conversationId: event.conversationId,
            sequence: event.sequence,
            updatedAt: event.updatedAt,
          });
        }
        break;
      }
      case 'subscription':
        state.subscriptions.set(
          event.subscription.conversationId,
          event.subscription,
        );
        break;
      case 'presenceRoster':
        state.presence = new Map(
          event.members.map((member) => [member.teamMemberId, member]),
        );
        break;
      case 'presenceDelta':
        state.presence.set(event.member.teamMemberId, event.member);
        break;
      case 'markRead':
        this.applyMarkRead(state, event.deliveryIds, event.readAt);
        break;
      case 'dismiss':
        for (const id of event.deliveryIds) {
          const current = state.deliveries.get(id);
          if (current) {
            state.deliveries.set(id, {
              ...current,
              dismissedAt: current.dismissedAt ?? event.dismissedAt,
            });
          }
        }
        break;
      case 'disconnected':
        if (state.status !== 'messagingUnavailable') state.status = 'offline';
        break;
      case 'error':
        state.errorCode = event.code;
        state.errorMessage = event.message;
        state.status = isCustodyError(event.code)
          ? 'messagingUnavailable'
          : 'offline';
        break;
    }
    this.rebuildSnapshot();
    if (newDelivery) {
      try {
        this.config.onDelivery?.(materializeDelivery(state, newDelivery));
      } catch {
        // Notification-style observers are best-effort and must never break
        // canonical Inbox materialization.
      }
    }
  }

  private inferReceiptsFromReadDeliveries(state: OrgMaterializedState): void {
    for (const delivery of state.deliveries.values()) {
      if (!delivery.readAt || !('source' in delivery)) continue;
      const conversationId = conversationIdForSource(delivery.source);
      if (!conversationId) continue;
      const watermark = state.watermarks.get(conversationId);
      if (watermark && watermark.updatedAt <= delivery.readAt) {
        state.readReceipts.set(conversationId, watermark.sequence);
      }
    }
  }

  private applyMarkRead(
    state: OrgMaterializedState,
    deliveryIds: string[],
    readAt: number,
  ): void {
    const ids = deliveryIds.length > 0
      ? deliveryIds
      : [...state.deliveries.keys()];
    for (const id of ids) {
      const current = state.deliveries.get(id);
      if (!current) continue;
      state.deliveries.set(id, {
        ...current,
        readAt: current.readAt ?? readAt,
      });
      if ('source' in current) {
        const conversationId = conversationIdForSource(current.source);
        const watermark = conversationId
          ? state.watermarks.get(conversationId)
          : undefined;
        if (conversationId && watermark) {
          state.readReceipts.set(conversationId, watermark.sequence);
        }
      }
    }
  }

  private rebuildSnapshot(): void {
    const organizations = [...this.orgStates.values()].map((state) => ({
      orgId: state.descriptor.orgId,
      orgName: state.descriptor.orgName,
      status: state.status,
      ...(state.errorCode ? { errorCode: state.errorCode } : {}),
      ...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
    }));
    const deliveries = [...this.orgStates.values()]
      .flatMap((state) => [...state.deliveries.values()].map((delivery) =>
        materializeDelivery(state, delivery)))
      .sort((left, right) =>
        right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    const presence = Object.fromEntries(
      [...this.orgStates.values()].map((state) => [
        state.descriptor.orgId,
        Object.fromEntries(state.presence),
      ]),
    );
    const readyCount = organizations.filter(
      (org) => org.status === 'ready',
    ).length;
    const connectingCount = organizations.filter(
      (org) => org.status === 'connecting',
    ).length;
    const offlineCount = organizations.filter(
      (org) => org.status === 'offline',
    ).length;
    let status: TeamInboxSnapshot['status'];
    if (readyCount > 0 || organizations.every(
      (org) => org.status === 'messagingUnavailable',
    )) {
      status = 'ready';
    } else if (connectingCount > 0) {
      status = deliveries.length > 0 ? 'reconnecting' : 'loading';
    } else if (offlineCount > 0) {
      status = deliveries.length > 0
        ? 'offlineWithCache'
        : 'offlineWithoutCache';
    } else {
      status = 'ready';
    }

    this.snapshot = {
      status,
      deliveries,
      organizations,
      presence,
      ...(this.lastSyncedAt ? { lastSyncedAt: this.lastSyncedAt } : {}),
    };
    for (const listener of this.listeners) listener();
  }

  private groupDeliveryIdsByOrg(
    deliveryIds: string[],
  ): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const id of deliveryIds) {
      const orgId = this.findDeliveryOrg(id);
      if (!orgId) throw new Error(`Unknown inbox delivery ${id}`);
      const ids = grouped.get(orgId) ?? [];
      ids.push(id);
      grouped.set(orgId, ids);
    }
    return grouped;
  }

  private findDeliveryOrg(deliveryId: string): string | null {
    for (const [orgId, state] of this.orgStates) {
      if (state.deliveries.has(deliveryId)) return orgId;
    }
    return null;
  }

  private destroyClients(): void {
    for (const cleanup of this.cleanups.values()) cleanup();
    this.cleanups.clear();
    for (const client of this.clients.values()) client.destroy();
    this.clients.clear();
    this.orgStates.clear();
  }

  setPresenceStatus(status: PresenceDesiredStatus): void {
    for (const client of this.clients.values()) {
      client.setPresenceStatus?.(status);
    }
  }
}

function conversationIdForSource(
  source: InboxDelivery['source'],
): string | null {
  return 'sourceId' in source ? source.sourceId : null;
}

function materializeDelivery(
  state: OrgMaterializedState,
  delivery: TeamInboxWireDelivery,
): TeamInboxMaterializedDelivery {
  if ('unavailable' in delivery) {
    return {
      ...delivery,
      orgName: state.descriptor.orgName,
      hasUnreadActivity: false,
    };
  }
  const conversationId = conversationIdForSource(delivery.source);
  const subscription = conversationId
    ? state.subscriptions.get(conversationId)
    : undefined;
  const watermark = conversationId
    ? state.watermarks.get(conversationId)
    : undefined;
  const receipt = conversationId
    ? state.readReceipts.get(conversationId) ?? 0
    : 0;
  return {
    ...delivery,
    orgName: state.descriptor.orgName,
    subscription: subscription?.state,
    hasUnreadActivity:
      subscription?.state === 'following'
      && !!watermark
      && watermark.sequence > receipt,
  };
}

export function isActivityRef(
  source: InboxDelivery['source'],
): source is ActivityRef {
  return 'resourceKind' in source;
}
