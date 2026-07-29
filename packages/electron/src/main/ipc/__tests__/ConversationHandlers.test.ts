import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type SyncPayload = {
    orgId: string;
    conversationId: string;
    event: { type: "connected" };
  };
  type Handler = (
    event: unknown,
    request: Record<string, unknown>
  ) => Promise<unknown>;

  let subscription: ((payload: SyncPayload) => void) | null = null;
  const handlers = new Map<string, Handler>();
  const send = vi.fn();
  const list = vi.fn(
    async (
      target: Record<string, unknown>,
      _cursor?: string,
      _pageSize?: number
    ) => {
      subscription?.({
        ...target,
        event: { type: "connected" },
      } as SyncPayload);
      return { events: [] };
    }
  );
  const service = {
    subscribe: vi.fn((listener: (payload: SyncPayload) => void) => {
      subscription = listener;
      return vi.fn();
    }),
    list,
    append: vi.fn(),
  };

  return {
    handlers,
    list,
    send,
    service,
  };
});

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: mocks.send },
      },
    ],
  },
}));

vi.mock("../../services/ConversationService", () => ({
  getConversationService: () => mocks.service,
}));

vi.mock("../../utils/ipcRegistry", () => ({
  safeHandle: vi.fn((channel: string, handler: unknown) => {
    mocks.handlers.set(channel, handler as never);
  }),
}));

import { registerConversationHandlers } from "../ConversationHandlers";

describe("ConversationHandlers", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.list.mockClear();
    mocks.send.mockClear();
    registerConversationHandlers();
  });

  it("broadcasts only the conversation target and sync event", async () => {
    const handler = mocks.handlers.get("conversation:list");
    expect(handler).toBeDefined();

    await handler?.(
      {},
      {
        orgId: "org-a",
        conversationId: "conversation-a",
        cursor: "42",
        pageSize: 25,
      }
    );

    expect(mocks.list).toHaveBeenCalledWith(
      {
        orgId: "org-a",
        conversationId: "conversation-a",
      },
      "42",
      25
    );
    expect(mocks.send).toHaveBeenCalledWith("conversation:sync-event", {
      orgId: "org-a",
      conversationId: "conversation-a",
      event: { type: "connected" },
    });
  });
});
