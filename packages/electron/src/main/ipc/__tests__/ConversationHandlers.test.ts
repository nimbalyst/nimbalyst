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
  const unsubscribe = vi.fn();
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
      return unsubscribe;
    }),
    list,
    append: vi.fn(),
    setSubscription: vi.fn(async (
      target: Record<string, unknown>,
      state: string,
      notificationLevel: string,
    ) => ({
      conversationId: target.conversationId,
      userId: "member-a",
      state,
      reason: "explicit",
      notificationLevel,
    })),
  };
  const directory = {
    archiveConversation: vi.fn(async () => ({ descriptor: { id: "archived" } })),
    createConversation: vi.fn(async () => ({
      descriptor: { id: "created" },
      memberships: [],
    })),
    listConversationMembers: vi.fn(async () => ({ memberships: [] })),
    listConversations: vi.fn(async () => []),
    setAgentPosting: vi.fn(async () => ({ descriptor: { id: "posting" } })),
    setConversationMembership: vi.fn(async () => ({ memberships: [] })),
    updateConversation: vi.fn(async () => ({ descriptor: { id: "updated" } })),
  };

  const collabAssets = {
    registerCollabAssetDocument: vi.fn(),
    unregisterCollabAssetDocument: vi.fn(),
    clearCollabAssetSender: vi.fn(),
  };

  return {
    collabAssets,
    directory,
    handlers,
    list,
    send,
    service,
    unsubscribe,
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
  shutdownConversationService: vi.fn(),
}));

vi.mock("../../services/TeamService", () => mocks.directory);

vi.mock("../../protocols/collabAssetProtocol", () => mocks.collabAssets);

vi.mock("../../utils/ipcRegistry", () => ({
  safeHandle: vi.fn((channel: string, handler: unknown) => {
    mocks.handlers.set(channel, handler as never);
  }),
}));

import {
  registerConversationHandlers,
  shutdownConversationHandlers,
} from "../ConversationHandlers";

describe("ConversationHandlers", () => {
  beforeEach(() => {
    shutdownConversationHandlers();
    mocks.handlers.clear();
    mocks.list.mockClear();
    mocks.send.mockClear();
    mocks.service.subscribe.mockClear();
    mocks.unsubscribe.mockClear();
    for (const mock of Object.values(mocks.directory)) mock.mockClear();
    for (const mock of Object.values(mocks.collabAssets)) mock.mockClear();
    registerConversationHandlers();
  });

  it("installs the main-process sync subscription only once", () => {
    const subscriptionsBefore = mocks.service.subscribe.mock.calls.length;

    registerConversationHandlers();

    expect(mocks.service.subscribe).toHaveBeenCalledTimes(subscriptionsBefore);
  });

  it("releases the sync subscription during shutdown", () => {
    shutdownConversationHandlers();
    shutdownConversationHandlers();

    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
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

  it("registers the explicit org-scoped directory family", () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      "conversation:append",
      "conversation:directory:apply-descriptor",
      "conversation:directory:archive",
      "conversation:directory:create",
      "conversation:directory:list",
      "conversation:directory:list-members",
      "conversation:directory:set-agent-posting",
      "conversation:directory:set-membership",
      "conversation:directory:update",
      "conversation:list",
      "conversation:register-assets",
      "conversation:set-subscription",
      "conversation:unregister-assets",
    ]);
  });

  describe("conversation attachment authorization", () => {
    function sender(id: number) {
      const listeners = new Map<string, () => void>();
      return {
        sender: {
          id,
          isDestroyed: () => false,
          once: (name: string, listener: () => void) => {
            listeners.set(name, listener);
          },
        },
        destroy: () => listeners.get("destroyed")?.(),
      };
    }

    it("registers the conversation for the requesting window", async () => {
      const event = sender(7);

      await expect(
        mocks.handlers.get("conversation:register-assets")?.(event, {
          orgId: "org-a",
          conversationId: "conversation-a",
        })
      ).resolves.toEqual({ success: true });

      expect(mocks.collabAssets.registerCollabAssetDocument)
        .toHaveBeenCalledWith("org-a", "conversation-a", 7);
    });

    it("unregisters only the requesting window's entry", async () => {
      await mocks.handlers.get("conversation:unregister-assets")?.(
        sender(7),
        { conversationId: "conversation-a" }
      );

      expect(mocks.collabAssets.unregisterCollabAssetDocument)
        .toHaveBeenCalledWith("conversation-a", 7);
    });

    it("drops every registration when the window goes away", async () => {
      const event = sender(9);
      await mocks.handlers.get("conversation:register-assets")?.(event, {
        orgId: "org-a",
        conversationId: "conversation-a",
      });
      // Opening a second conversation in the same window must not stack a
      // second destroyed listener.
      await mocks.handlers.get("conversation:register-assets")?.(event, {
        orgId: "org-a",
        conversationId: "conversation-b",
      });

      event.destroy();

      expect(mocks.collabAssets.clearCollabAssetSender)
        .toHaveBeenCalledTimes(1);
      expect(mocks.collabAssets.clearCollabAssetSender)
        .toHaveBeenCalledWith(9);
    });

    it("refuses a registration that names no conversation", async () => {
      await expect(
        mocks.handlers.get("conversation:register-assets")?.(sender(7), {
          orgId: "org-a",
        })
      ).rejects.toThrow(/required/i);
      expect(mocks.collabAssets.registerCollabAssetDocument)
        .not.toHaveBeenCalled();
    });
  });

  it("fans a team-sync descriptor update out to the windows that hold no socket", async () => {
    const descriptor = {
      id: "design",
      orgId: "org-a",
      kind: "orgRoom",
      visibility: "public",
      title: "Design reviews",
      agentPostingEnabled: false,
      createdByUserId: "member-a",
      createdAt: 1,
    };

    await mocks.handlers.get("conversation:directory:apply-descriptor")?.({}, {
      orgId: "org-a",
      descriptor,
    });

    expect(mocks.send).toHaveBeenCalledWith("conversation:descriptor-updated", {
      orgId: "org-a",
      descriptor,
    });
    // A forward is not a mutation: nothing is re-sent to the team API.
    expect(mocks.directory.updateConversation).not.toHaveBeenCalled();

    await expect(
      mocks.handlers.get("conversation:directory:apply-descriptor")?.({}, {
        orgId: "org-a",
      }),
    ).rejects.toThrow("requires a descriptor");
  });

  it("routes subscription changes through the org-scoped conversation service", async () => {
    const result = await mocks.handlers.get("conversation:set-subscription")?.(
      {},
      {
        orgId: "org-a",
        conversationId: "conversation-a",
        state: "following",
        notificationLevel: "mentions",
      },
    );

    expect(mocks.service.setSubscription).toHaveBeenCalledWith(
      {
        orgId: "org-a",
        conversationId: "conversation-a",
      },
      "following",
      "mentions",
    );
    expect(result).toMatchObject({
      conversationId: "conversation-a",
      state: "following",
      notificationLevel: "mentions",
    });
  });

  it("routes directory mutations and broadcasts only the changed org", async () => {
    await mocks.handlers.get("conversation:directory:create")?.({}, {
      orgId: "org-a",
      input: {
        kind: "orgRoom",
        visibility: "public",
        title: "Design",
      },
    });
    await mocks.handlers.get("conversation:directory:archive")?.({}, {
      orgId: "org-a",
      conversationId: "design",
    });
    await mocks.handlers.get("conversation:directory:set-membership")?.({}, {
      orgId: "org-a",
      conversationId: "private-room",
      userId: "member-b",
      active: true,
      role: "roomAdmin",
    });
    await mocks.handlers.get("conversation:directory:set-agent-posting")?.({}, {
      orgId: "org-a",
      conversationId: "design",
      enabled: false,
    });
    await mocks.handlers.get("conversation:directory:update")?.({}, {
      orgId: "org-a",
      conversationId: "design",
      input: { title: "Design reviews", topic: null },
    });

    expect(mocks.directory.createConversation).toHaveBeenCalledWith(
      "org-a",
      expect.objectContaining({ title: "Design" }),
    );
    expect(mocks.directory.archiveConversation).toHaveBeenCalledWith(
      "org-a",
      "design",
    );
    expect(mocks.directory.setConversationMembership).toHaveBeenCalledWith(
      "org-a",
      "private-room",
      "member-b",
      { active: true, role: "roomAdmin" },
    );
    expect(mocks.directory.setAgentPosting).toHaveBeenCalledWith(
      "org-a",
      "design",
      false,
    );
    expect(mocks.directory.updateConversation).toHaveBeenCalledWith(
      "org-a",
      "design",
      { title: "Design reviews", topic: null },
    );
    expect(mocks.send).toHaveBeenCalledTimes(5);
    expect(mocks.send).toHaveBeenCalledWith(
      "conversation:directory-changed",
      { orgId: "org-a" },
    );
  });

  it("reads one conversation membership list without invalidating the directory", async () => {
    await mocks.handlers.get("conversation:directory:list-members")?.({}, {
      orgId: "org-a",
      conversationId: "private-room",
    });

    expect(mocks.directory.listConversationMembers).toHaveBeenCalledWith(
      "org-a",
      "private-room",
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("requires an explicit org for directory requests", async () => {
    const handler = mocks.handlers.get("conversation:directory:list");
    await expect(handler?.({}, {})).rejects.toThrow(
      "Conversation organization id is required",
    );
    expect(mocks.directory.listConversations).not.toHaveBeenCalled();
  });
});
