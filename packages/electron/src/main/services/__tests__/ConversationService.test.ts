import {
  asTeamJwt,
  type ConversationAppendInput,
  type ConversationHistoryPage,
  type ConversationSyncEvent,
  type ConversationTarget,
  type TeamJwt,
  ConversationSync,
} from "@nimbalyst/runtime";
import type { ConversationSubscription } from "@nimbalyst/collab-protocol";
import { describe, expect, it, vi } from "vitest";

import { ConversationService } from "../ConversationService";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(): void {}

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeConversationSync {
  readonly connect = vi.fn(async () => {
    await this.getTeamJwt();
  });
  readonly list = vi.fn(
    async (): Promise<ConversationHistoryPage> => ({ events: [] })
  );
  readonly append = vi.fn(async (input: ConversationAppendInput) => ({
    id: "event-1",
    conversationId: "conversation-a",
    sequence: 1,
    clientMutationId: input.clientMutationId,
    actor: input.actor,
    operation: input.operation,
    targetMessageId: input.targetMessageId,
    payload: input.payload,
    createdAt: 1,
    serverReceivedAt: 1,
  }));
  readonly setSubscription = vi.fn(
    async (
      state: ConversationSubscription["state"],
      notificationLevel: ConversationSubscription["notificationLevel"]
    ): Promise<ConversationSubscription> => ({
      conversationId: this.target.conversationId,
      userId: "member-a",
      state,
      reason: "explicit",
      notificationLevel,
    })
  );
  readonly destroy = vi.fn();
  private listener: ((event: ConversationSyncEvent) => void) | null = null;

  constructor(
    readonly target: ConversationTarget,
    readonly getTeamJwt: () => Promise<TeamJwt>
  ) {}

  subscribe(listener: (event: ConversationSyncEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
}

describe("ConversationService JWT selection", () => {
  it("resolves a conversation connection exclusively from its org-scoped team JWT", async () => {
    const getTeamJwt = vi.fn(async () => asTeamJwt("team-jwt"));
    const clients: FakeConversationSync[] = [];
    const service = new ConversationService({
      getTeamJwt,
      getServerUrl: () => "https://sync.example.test",
      createSync: (target, resolver) => {
        const client = new FakeConversationSync(target, resolver);
        clients.push(client);
        return client as never;
      },
    });

    await service.list({
      orgId: "org-a",
      conversationId: "conversation-a",
    });

    expect(getTeamJwt).toHaveBeenCalledWith("org-a");
    expect(clients[0].target).toEqual({
      orgId: "org-a",
      conversationId: "conversation-a",
    });
    service.destroy();
  });

  it("discards a client that closes before opening without scheduling reconnect", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const target = {
      orgId: "org-a",
      conversationId: "never-opened",
    };
    const service = new ConversationService({
      getTeamJwt: async () => asTeamJwt("team-jwt"),
      getServerUrl: () => "https://sync.example.test",
      createSync: (syncTarget, getTeamJwt) =>
        new ConversationSync({
          serverUrl: "https://sync.example.test",
          target: syncTarget,
          getTeamJwt,
          createWebSocket: () => {
            const socket = new FakeWebSocket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
        }),
    });

    try {
      const firstList = service.list(target);
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);

      sockets[0].close();
      await expect(firstList).rejects.toMatchObject({
        code: "CONVERSATION_CONNECTION_CLOSED",
      });

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(1);

      const secondList = service.list(target);
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);
      sockets[1].close();
      await expect(secondList).rejects.toMatchObject({
        code: "CONVERSATION_CONNECTION_CLOSED",
      });
    } finally {
      service.destroy();
      vi.useRealTimers();
    }
  });

  it("reconnects a client that successfully opened before disconnecting", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const target = {
      orgId: "org-a",
      conversationId: "opened-then-dropped",
    };
    const service = new ConversationService({
      getTeamJwt: async () => asTeamJwt("team-jwt"),
      getServerUrl: () => "https://sync.example.test",
      createSync: (syncTarget, getTeamJwt) =>
        new ConversationSync({
          serverUrl: "https://sync.example.test",
          target: syncTarget,
          getTeamJwt,
          createWebSocket: () => {
            const socket = new FakeWebSocket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
        }),
    });

    try {
      const list = service.list(target);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0].open();
      sockets[0].receive({
        type: "conversationHistoryResponse",
        events: [],
      });
      await expect(list).resolves.toEqual({ events: [] });

      sockets[0].close();
      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
    } finally {
      service.destroy();
      vi.useRealTimers();
    }
  });
});
