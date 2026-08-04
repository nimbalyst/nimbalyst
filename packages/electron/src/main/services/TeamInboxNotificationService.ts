import {
  MAX_INBOX_PREVIEW_SNIPPET_CHARS,
  type CommentRef,
} from "@nimbalyst/collab-protocol";
import type { TeamInboxMaterializedDelivery } from "@nimbalyst/runtime/sync";

export interface TeamInboxNativeNotification {
  title: string;
  body: string;
  onClick: () => void;
}

export interface TeamInboxNotificationDependencies {
  notificationsEnabled: () => boolean;
  notificationsSupported: () => boolean;
  isConversationFocused: (orgId: string, conversationId: string) => boolean;
  showNativeNotification: (notification: TeamInboxNativeNotification) => void;
  openConversation: (orgId: string, conversationId: string) => void;
  openInboxSource: (url: string) => Promise<boolean>;
  resolveConversationTitle: (
    orgId: string,
    conversationId: string
  ) => Promise<string | null>;
  resolveMemberLabel: (
    orgId: string,
    memberId: string
  ) => Promise<string | null>;
}

type DeliveryRoute =
  | { kind: "conversation"; orgId: string; conversationId: string }
  | { kind: "inboxSource"; url: string };

const SOURCE_FALLBACKS: Record<CommentRef["sourceKind"], string> = {
  roomMessage: "Room",
  dmMessage: "Direct message",
  documentDiscussion: "Document discussion",
  trackerComment: "Tracker",
  documentInlineComment: "Document",
};
const MAX_NOTIFICATION_SANITIZER_INPUT_CHARS =
  MAX_INBOX_PREVIEW_SNIPPET_CHARS * 8;
const NIMBALYST_MARKDOWN_LINK_PATTERN =
  /\[([^\]\r\n]*)\]\(\s*nimbalyst:\/\/[^)\r\n]*(?:\)|$)/giu;
const MARKDOWN_LINK_PATTERN = /\[([^\]\r\n]*)\]\([^)\r\n]*(?:\)|$)/gu;
const BARE_NIMBALYST_URL_PATTERN = /nimbalyst:\/\/[^\s)\]]*/giu;

function cleanLabel(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function boundedSnippet(value: string | null | undefined): string {
  // Notification previews are plain text. Bound the work before parsing, then
  // discard link targets so member IDs and deep links cannot reach OS banners.
  const boundedInput = value?.slice(0, MAX_NOTIFICATION_SANITIZER_INPUT_CHARS);
  const sanitized = boundedInput
    ?.replace(NIMBALYST_MARKDOWN_LINK_PATTERN, "$1")
    .replace(MARKDOWN_LINK_PATTERN, "$1")
    .replace(BARE_NIMBALYST_URL_PATTERN, "");
  const cleaned = cleanLabel(sanitized) ?? "New activity";
  return cleaned.slice(0, MAX_INBOX_PREVIEW_SNIPPET_CHARS);
}

function routeForDelivery(
  delivery: TeamInboxMaterializedDelivery
): DeliveryRoute | null {
  const source = delivery.source;
  if (!source) return null;
  if (source.orgId !== delivery.orgId) return null;

  if ("sourceKind" in source) {
    if (
      (source.sourceKind === "roomMessage" ||
        source.sourceKind === "dmMessage") &&
      source.sourceId
    ) {
      return {
        kind: "conversation",
        orgId: delivery.orgId,
        conversationId: source.sourceId,
      };
    }
    if (!source.sourceId) return null;
    if (source.sourceKind === "trackerComment") {
      const url = new URL(
        `nimbalyst://tracker/${encodeURIComponent(source.sourceId)}`
      );
      url.searchParams.set("orgId", delivery.orgId);
      if (source.commentId) url.searchParams.set("commentId", source.commentId);
      return { kind: "inboxSource", url: url.toString() };
    }
    if (
      source.sourceKind === "documentDiscussion" ||
      source.sourceKind === "documentInlineComment"
    ) {
      const url = new URL(
        `nimbalyst://doc/${encodeURIComponent(source.sourceId)}`
      );
      url.searchParams.set("orgId", delivery.orgId);
      if (source.threadId) url.searchParams.set("threadId", source.threadId);
      if (source.commentId) url.searchParams.set("commentId", source.commentId);
      return { kind: "inboxSource", url: url.toString() };
    }
    return null;
  }

  if (!source.resourceId) return null;
  const host = source.resourceKind === "document" ? "doc" : "tracker";
  const url = new URL(
    `nimbalyst://${host}/${encodeURIComponent(source.resourceId)}`
  );
  url.searchParams.set("orgId", delivery.orgId);
  if (source.sourceEventId) {
    url.searchParams.set("commentId", source.sourceEventId);
  }
  return { kind: "inboxSource", url: url.toString() };
}

function sourceFallback(delivery: TeamInboxMaterializedDelivery): string {
  const source = delivery.source;
  if (!source) return "Inbox";
  if ("sourceKind" in source) return SOURCE_FALLBACKS[source.sourceKind];
  return source.resourceKind === "tracker" ? "Tracker" : "Document";
}

/**
 * Turns the main process's live-only Inbox event into a native notification.
 *
 * The service owns a second canonical-identity guard so duplicated broadcasts
 * cannot notify even if a future transport observer accidentally forwards one.
 */
export class TeamInboxNotificationService {
  private readonly seenDeliveryIds = new Set<string>();

  constructor(
    private readonly dependencies: TeamInboxNotificationDependencies
  ) {}

  async notify(delivery: TeamInboxMaterializedDelivery): Promise<void> {
    const canonicalId = `${delivery.orgId}:${delivery.id}`;
    if (this.seenDeliveryIds.has(canonicalId)) return;
    this.seenDeliveryIds.add(canonicalId);

    let canNotify = false;
    try {
      canNotify =
        this.dependencies.notificationsEnabled() &&
        this.dependencies.notificationsSupported();
    } catch {
      return;
    }
    if (!canNotify || delivery.dismissedAt || delivery.unavailable) {
      return;
    }
    if (
      delivery.actor?.onBehalfOfUserId &&
      delivery.actor.onBehalfOfUserId === delivery.recipientUserId
    ) {
      return;
    }

    const route = routeForDelivery(delivery);
    if (!route) return;
    if (
      route.kind === "conversation" &&
      this.dependencies.isConversationFocused(route.orgId, route.conversationId)
    ) {
      return;
    }

    const actorMemberId =
      delivery.actor?.userId ?? delivery.actor?.onBehalfOfUserId;
    const [resolvedSourceTitle, resolvedMemberLabel] = await Promise.all([
      route.kind === "conversation"
        ? this.dependencies
            .resolveConversationTitle(route.orgId, route.conversationId)
            .catch(() => null)
        : Promise.resolve(null),
      actorMemberId
        ? this.dependencies
            .resolveMemberLabel(delivery.orgId, actorMemberId)
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    const sourceTitle =
      cleanLabel(delivery.preview?.sourceTitle) ??
      cleanLabel(resolvedSourceTitle) ??
      sourceFallback(delivery);
    const sender =
      cleanLabel(delivery.preview?.actorLabel) ??
      cleanLabel(delivery.actor?.sessionName) ??
      cleanLabel(resolvedMemberLabel) ??
      "A teammate";
    const orgName = cleanLabel(delivery.orgName) ?? "Nimbalyst Teams";
    const body = `${sender}: ${boundedSnippet(delivery.preview?.snippet)}`;

    if (
      route.kind === "conversation" &&
      this.dependencies.isConversationFocused(route.orgId, route.conversationId)
    ) {
      return;
    }

    try {
      this.dependencies.showNativeNotification({
        title: `${orgName} · ${sourceTitle}`,
        body,
        onClick: () => {
          if (route.kind === "conversation") {
            this.dependencies.openConversation(
              route.orgId,
              route.conversationId
            );
            return;
          }
          void this.dependencies.openInboxSource(route.url).catch(() => false);
        },
      });
    } catch {
      // Native notification construction/showing is best-effort. The Inbox row
      // remains canonical and visible even when the OS rejects the banner.
    }
  }
}
