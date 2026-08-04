import type {
  Actor,
  CommentDeliveryHints,
  ConversationAppendAckMessage,
  ConversationClientMessage,
  ConversationEvent,
  ConversationHistoryResponseMessage,
  ConversationServerMessage,
  ConversationSubscription,
  ConversationSubscriptionAckMessage,
} from '@nimbalyst/collab-protocol';
import { conversationRoomId } from '@nimbalyst/collab-protocol';

import type { TeamJwt } from '../auth/jwtScopes';
import { appendSyncClientParams } from './syncClientInfo';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface ConversationTarget {
  orgId: string;
  conversationId: string;
}

export interface ConversationHistoryPage {
  events: ConversationEvent[];
  nextCursor?: string;
}

export interface ConversationAppendInput {
  clientMutationId: string;
  actor: Actor;
  operation: ConversationEvent['operation'];
  targetMessageId?: string;
  payload?: ConversationEvent['payload'];
  deliveryHints?: CommentDeliveryHints;
  createdAt?: number;
}

export type ConversationSyncEvent =
  | { type: 'connecting' }
  | { type: 'connected' }
  | { type: 'event'; event: ConversationEvent }
  | { type: 'disconnected' }
  | { type: 'error'; code: string; message: string };

export interface ConversationSyncConfig {
  serverUrl: string;
  target: ConversationTarget;
  getTeamJwt: () => Promise<TeamJwt>;
  createWebSocket?: (url: string) => WebSocket;
}

/** The server messages that answer a request, as opposed to broadcasts. */
type ConversationResponseMessage =
  | ConversationHistoryResponseMessage
  | ConversationAppendAckMessage
  | ConversationSubscriptionAckMessage;

type PendingRequest = {
  message: ConversationClientMessage;
  expectedType: ConversationResponseMessage['type'];
  resolve: (message: ConversationResponseMessage) => void;
  reject: (error: Error) => void;
  sent: boolean;
};

function toWebSocketBase(serverUrl: string): string {
  return serverUrl
    .replace(/^https:/, 'wss:')
    .replace(/^http:/, 'ws:')
    .replace(/\/+$/, '');
}

function parseCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const sequence = Number(cursor);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`Invalid conversation cursor: ${cursor}`);
  }
  return sequence;
}

export class ConversationSyncError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConversationSyncError';
    this.code = code;
  }
}

/**
 * Team-JWT WebSocket transport for one ConversationRoom.
 *
 * Requests are serialized because the server's protocol errors are deliberately
 * small and do not carry a request id. Realtime event broadcasts remain
 * independent and can arrive before the append acknowledgement for the sender.
 */
export class ConversationSync {
  readonly target: ConversationTarget;

  private readonly config: ConversationSyncConfig;
  private readonly listeners = new Set<(event: ConversationSyncEvent) => void>();
  private readonly requests: PendingRequest[] = [];
  private ws: WebSocket | null = null;
  private activeRequest: PendingRequest | null = null;
  private destroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ConversationSyncConfig) {
    this.config = config;
    this.target = config.target;
  }

  async connect(): Promise<void> {
    if (this.destroyed) throw new Error('Conversation sync has been destroyed');
    if (this.ws) return;

    this.emit({ type: 'connecting' });
    try {
      const jwt = await this.config.getTeamJwt();
      if (this.destroyed || this.ws) return;
      const roomId = conversationRoomId(
        this.target.orgId,
        this.target.conversationId,
      );
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
        this.emit({ type: 'connected' });
        this.pumpRequests();
      });
      ws.addEventListener('message', (event) => {
        if (this.ws !== ws) return;
        this.handleMessage(event.data);
      });
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.rejectRequests(
          new ConversationSyncError(
            'CONVERSATION_CONNECTION_CLOSED',
            'Conversation connection closed before the request completed',
          ),
        );
        this.emit({ type: 'disconnected' });
        this.scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        if (this.ws !== ws) return;
        ws.close();
      });
    } catch (error) {
      const normalized = error instanceof Error
        ? error
        : new Error(String(error));
      this.emit({
        type: 'error',
        code: 'CONVERSATION_CONNECTION_FAILED',
        message: normalized.message,
      });
      this.rejectRequests(normalized);
      this.scheduleReconnect();
      throw normalized;
    }
  }

  subscribe(listener: (event: ConversationSyncEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async list(
    cursor?: string,
    pageSize?: number,
  ): Promise<ConversationHistoryPage> {
    const beforeSequence = parseCursor(cursor);
    const response = await this.request<ConversationHistoryResponseMessage>({
      type: 'conversationHistory',
      ...(beforeSequence !== undefined ? { beforeSequence } : {}),
      ...(pageSize !== undefined ? { pageSize } : {}),
    }, 'conversationHistoryResponse');
    return {
      events: response.events ?? [],
      ...(response.nextCursor !== undefined
        ? { nextCursor: String(response.nextCursor) }
        : {}),
    };
  }

  async append(input: ConversationAppendInput): Promise<ConversationEvent> {
    const response = await this.request<ConversationAppendAckMessage>({
      type: 'conversationAppend',
      event: {
        clientMutationId: input.clientMutationId,
        actor: input.actor,
        operation: input.operation,
        targetMessageId: input.targetMessageId,
        payload: input.payload,
        createdAt: input.createdAt,
      },
      deliveryHints: input.deliveryHints,
    }, 'conversationAppendAck');
    const event = response.event as ConversationEvent | undefined;
    if (!event) {
      throw new ConversationSyncError(
        'CONVERSATION_PROTOCOL_ERROR',
        'Conversation append acknowledgement contained no event',
      );
    }
    return event;
  }

  async setSubscription(
    state: ConversationSubscription['state'],
    notificationLevel: ConversationSubscription['notificationLevel'],
  ): Promise<ConversationSubscription> {
    const response = await this.request<ConversationSubscriptionAckMessage>({
      type: 'conversationSubscriptionSet',
      state,
      notificationLevel,
    }, 'conversationSubscriptionAck');
    const subscription = response.subscription as
      | ConversationSubscription
      | undefined;
    if (!subscription) {
      throw new ConversationSyncError(
        'CONVERSATION_PROTOCOL_ERROR',
        'Conversation subscription acknowledgement contained no subscription',
      );
    }
    return subscription;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.rejectRequests(
      new ConversationSyncError(
        'CONVERSATION_DESTROYED',
        'Conversation sync was destroyed',
      ),
    );
    this.listeners.clear();
  }

  private request<TResponse extends ConversationResponseMessage>(
    message: ConversationClientMessage,
    expectedType: TResponse['type'],
  ): Promise<TResponse> {
    if (this.destroyed) {
      return Promise.reject(new Error('Conversation sync has been destroyed'));
    }
    const result = new Promise<TResponse>((resolve, reject) => {
      this.requests.push({
        message,
        expectedType,
        resolve: resolve as (message: ConversationResponseMessage) => void,
        reject,
        sent: false,
      });
    });
    this.pumpRequests();
    return result;
  }

  private pumpRequests(): void {
    if (
      this.activeRequest
      || !this.ws
      || this.ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const request = this.requests[0];
    if (!request) return;
    this.activeRequest = request;
    request.sent = true;
    this.ws.send(JSON.stringify(request.message));
  }

  private handleMessage(raw: unknown): void {
    try {
      const message = JSON.parse(
        typeof raw === 'string' ? raw : String(raw),
      ) as ConversationServerMessage;
      if (message.type === 'conversationEvent') {
        // A broadcast without an event is nothing to apply, but it is still a
        // broadcast: it must never satisfy the in-flight request.
        if (message.event) this.emit({ type: 'event', event: message.event });
        return;
      }
      if (message.type === 'conversationError') {
        const error = new ConversationSyncError(
          String(message.code ?? 'CONVERSATION_ERROR'),
          String(message.message ?? 'Conversation request failed'),
        );
        this.emit({ type: 'error', code: error.code, message: error.message });
        this.finishActiveRequest(error);
        return;
      }
      const active = this.activeRequest;
      if (active && message.type === active.expectedType) {
        active.resolve(message);
        this.finishActiveRequest();
      }
    } catch (error) {
      const normalized = error instanceof Error
        ? error
        : new Error(String(error));
      this.emit({
        type: 'error',
        code: 'CONVERSATION_PROTOCOL_ERROR',
        message: normalized.message,
      });
      this.finishActiveRequest(normalized);
    }
  }

  private finishActiveRequest(error?: Error): void {
    const active = this.activeRequest;
    if (!active) return;
    if (error) active.reject(error);
    if (this.requests[0] === active) this.requests.shift();
    else {
      const index = this.requests.indexOf(active);
      if (index >= 0) this.requests.splice(index, 1);
    }
    this.activeRequest = null;
    this.pumpRequests();
  }

  private rejectRequests(error: Error): void {
    for (const request of this.requests) request.reject(error);
    this.requests.length = 0;
    this.activeRequest = null;
  }

  private emit(event: ConversationSyncEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, delay);
  }
}
