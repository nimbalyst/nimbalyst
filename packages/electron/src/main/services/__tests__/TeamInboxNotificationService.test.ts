import type { InboxDelivery } from "@nimbalyst/collab-protocol";
import type { TeamInboxMaterializedDelivery } from "@nimbalyst/runtime/sync";
import { describe, expect, it, vi } from "vitest";
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import {
  TeamInboxNotificationService,
  type TeamInboxNativeNotification,
} from "../TeamInboxNotificationService";

function delivery(
  overrides: Partial<InboxDelivery> = {}
): TeamInboxMaterializedDelivery {
  return {
    id: "delivery-1",
    teamMemberId: asTeamMemberId("member-viewer"),
    orgId: "org-a",
    orgName: "Acme",
    source: {
      orgId: "org-a",
      sourceKind: "roomMessage",
      sourceId: "conversation-general",
      commentId: "message-1",
    },
    reason: "mention",
    actor: {
      kind: "user",
      userId: "member-sender",
      onBehalfOfUserId: "member-sender",
    },
    preview: {
      snippet: "Hello from the team",
    },
    createdAt: 100,
    hasUnreadActivity: false,
    ...overrides,
  };
}

function setup(
  options: {
    supported?: boolean;
    enabled?: boolean;
    focusedConversationId?: string | null;
  } = {}
) {
  const shown: TeamInboxNativeNotification[] = [];
  const openConversation = vi.fn();
  const openInbox = vi.fn();
  const openInboxSource = vi.fn(async () => true);
  const service = new TeamInboxNotificationService({
    notificationsEnabled: () => options.enabled ?? true,
    notificationsSupported: () => options.supported ?? true,
    isConversationFocused: (orgId, conversationId) =>
      orgId === "org-a" && conversationId === options.focusedConversationId,
    showNativeNotification: (notification) => {
      shown.push(notification);
    },
    openConversation,
    openInbox,
    openInboxSource,
    resolveConversationTitle: vi.fn(async () => "General"),
    resolveMemberLabel: vi.fn(async () => "Sarah"),
  });
  return { service, shown, openConversation, openInbox, openInboxSource };
}

describe("TeamInboxNotificationService", () => {
  it.each([
    "dm",
    "mention",
    "reply",
    "assignment",
    "agentMention",
    "follow",
  ] as const)("mirrors accepted %s deliveries", async (reason) => {
    const { service, shown } = setup();
    await service.notify(delivery({ reason }));
    expect(shown).toHaveLength(1);
  });

  it("dedupes canonical delivery identity and skips the current user’s own activity", async () => {
    const { service, shown } = setup();
    await service.notify(delivery());
    await service.notify(delivery());
    await service.notify(
      delivery({
        id: "delivery-own",
        actor: {
          kind: "user",
          userId: "member-viewer",
          onBehalfOfUserId: "member-viewer",
        },
      })
    );

    expect(shown).toHaveLength(1);
  });

  it("suppresses only the focused window displaying the exact room or DM", async () => {
    const exact = setup({ focusedConversationId: "conversation-general" });
    await exact.service.notify(delivery());
    expect(exact.shown).toHaveLength(0);

    const anotherConversation = setup({
      focusedConversationId: "conversation-random",
    });
    await anotherConversation.service.notify(delivery());
    expect(anotherConversation.shown).toHaveLength(1);

    const anotherWindowSurface = setup({ focusedConversationId: null });
    await anotherWindowSurface.service.notify(delivery());
    expect(anotherWindowSurface.shown).toHaveLength(1);
  });

  it("uses bounded content and safe sender/source fallbacks", async () => {
    const resolved = setup();
    await resolved.service.notify(
      delivery({
        preview: { snippet: "x".repeat(400) },
      })
    );
    expect(resolved.shown[0]).toMatchObject({
      title: "Acme · General",
    });
    expect(resolved.shown[0].body).toBe(`Sarah: ${"x".repeat(240)}`);

    const fallbackShown: TeamInboxNativeNotification[] = [];
    const fallback = new TeamInboxNotificationService({
      notificationsEnabled: () => true,
      notificationsSupported: () => true,
      isConversationFocused: () => false,
      showNativeNotification: (notification) => {
        fallbackShown.push(notification);
      },
      openConversation: vi.fn(),
      openInbox: vi.fn(),
      openInboxSource: vi.fn(async () => false),
      resolveConversationTitle: vi.fn(async () => {
        throw new Error("directory unavailable");
      }),
      resolveMemberLabel: vi.fn(async () => null),
    });
    await fallback.notify(
      delivery({
        id: "delivery-fallback",
        actor: undefined,
        preview: undefined,
      })
    );
    expect(fallbackShown[0]).toMatchObject({
      title: "Acme · Room",
      body: "A teammate: New activity",
    });
  });

  it("removes Nimbalyst mention link syntax and member IDs from the bounded preview", async () => {
    const { service, shown } = setup();
    await service.notify(
      delivery({
        preview: {
          snippet:
            "First Test Message [@Karl Wirth](nimbalyst://user/member-live-e802cec4-f2d7-42ba-a30c-7d7179143ad7)",
        },
      })
    );

    expect(shown[0].body).toBe("Sarah: First Test Message @Karl Wirth");
    expect(shown[0].body).not.toContain("nimbalyst://");
    expect(shown[0].body).not.toContain("member-live-");
  });

  it("routes room clicks to the organization conversation and other sources through Inbox deep links", async () => {
    const room = setup();
    await room.service.notify(delivery());
    room.shown[0].onClick();
    expect(room.openConversation).toHaveBeenCalledWith(
      "org-a",
      "conversation-general"
    );
    expect(room.openInboxSource).not.toHaveBeenCalled();

    const tracker = setup();
    await tracker.service.notify(
      delivery({
        id: "delivery-tracker",
        source: {
          orgId: "org-a",
          resourceKind: "tracker",
          resourceId: "tracker-1",
          sourceEventId: "activity-1",
          eventClass: "assignment",
        },
      })
    );
    tracker.shown[0].onClick();
    expect(tracker.openConversation).not.toHaveBeenCalled();
    expect(tracker.openInboxSource).toHaveBeenCalledWith(
      "nimbalyst://tracker/tracker-1?orgId=org-a&commentId=activity-1"
    );

    const document = setup();
    await document.service.notify(
      delivery({
        id: "delivery-document",
        source: {
          orgId: "org-a",
          resourceKind: "document",
          resourceId: "document-1",
          sourceEventId: "activity-2",
          eventClass: "mention",
        },
      })
    );
    document.shown[0].onClick();
    expect(document.openInboxSource).toHaveBeenCalledWith(
      "nimbalyst://doc/document-1?orgId=org-a&commentId=activity-2"
    );
  });

  it("notifies a feedback request and lands it on the Inbox in both source shapes", async () => {
    // Both shapes reach the same delivery: the request as a comment source, and
    // the request as an activity resource. Neither has a deep link yet, and
    // before `feedbackRequest` existed as a source kind one produced no title
    // and the other opened an unrelated tracker item.
    const asSource = setup();
    await asSource.service.notify(
      delivery({
        id: "delivery-feedback-source",
        source: {
          orgId: "org-a",
          sourceKind: "feedbackRequest",
          sourceId: "request-1",
          commentId: "ask-1",
        },
        preview: undefined,
      })
    );
    expect(asSource.shown).toHaveLength(1);
    expect(asSource.shown[0].title).toBe("Acme · Feedback request");
    asSource.shown[0].onClick();
    expect(asSource.openInbox).toHaveBeenCalledWith("org-a");
    expect(asSource.openInboxSource).not.toHaveBeenCalled();
    expect(asSource.openConversation).not.toHaveBeenCalled();

    const asActivity = setup();
    await asActivity.service.notify(
      delivery({
        id: "delivery-feedback-activity",
        source: {
          orgId: "org-a",
          resourceKind: "feedbackRequest",
          resourceId: "request-2",
          sourceEventId: "activity-3",
          eventClass: "created",
        },
        preview: undefined,
      })
    );
    expect(asActivity.shown).toHaveLength(1);
    expect(asActivity.shown[0].title).toBe("Acme · Feedback request");
    asActivity.shown[0].onClick();
    expect(asActivity.openInbox).toHaveBeenCalledWith("org-a");
    expect(asActivity.openInboxSource).not.toHaveBeenCalled();
  });

  it("fails safely when native notifications are disabled or unsupported", async () => {
    const disabled = setup({ enabled: false });
    const unsupported = setup({ supported: false });
    await disabled.service.notify(delivery());
    await unsupported.service.notify(delivery());
    expect(disabled.shown).toHaveLength(0);
    expect(unsupported.shown).toHaveLength(0);
  });
});
