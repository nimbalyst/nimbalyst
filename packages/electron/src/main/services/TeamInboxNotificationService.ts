import {
  MAX_INBOX_PREVIEW_SNIPPET_CHARS,
  type ActivityRef,
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
  /**
   * Open the organization's Inbox with no source in mind. The destination for
   * a delivery whose source has no route of its own yet.
   */
  openInbox: (orgId: string) => void;
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
  | { kind: "inboxSource"; url: string }
  /**
   * The delivery is real and worth a banner, but its source has no route yet.
   * Clicking lands on the organization's Inbox, where the row is, instead of
   * suppressing the notification or opening an unrelated resource.
   */
  | { kind: "inbox"; orgId: string };

const SOURCE_FALLBACKS: Record<CommentRef["sourceKind"], string> = {
  roomMessage: "Room",
  dmMessage: "Direct message",
  documentDiscussion: "Document discussion",
  trackerComment: "Tracker",
  documentInlineComment: "Document",
  feedbackRequest: "Feedback request",
};

/**
 * Deep-link host per activity resource kind. `null` means the resource has no
 * route of its own yet and the banner falls back to the Inbox — a fact about
 * the app rather than about the delivery. A ternary here used to send every
 * non-document kind to the tracker route.
 */
const ACTIVITY_DEEP_LINK_HOSTS: Record<
  ActivityRef["resourceKind"],
  string | null
> = {
  tracker: "tracker",
  document: "doc",
  feedbackRequest: null,
};

const ACTIVITY_FALLBACKS: Record<ActivityRef["resourceKind"], string> = {
  tracker: "Tracker",
  document: "Document",
  feedbackRequest: "Feedback request",
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

/**
 * Where a comment-backed delivery goes when clicked.
 *
 * A switch rather than a chain of ifs with a `return null` tail: a source kind
 * added to the protocol now fails to compile here, where the decision belongs,
 * instead of silently falling out of the bottom as an unroutable delivery.
 */
function commentRefRoute(source: CommentRef, orgId: string): DeliveryRoute | null {
  switch (source.sourceKind) {
    case "roomMessage":
    case "dmMessage":
      return source.sourceId
        ? { kind: "conversation", orgId, conversationId: source.sourceId }
        : null;
    case "trackerComment": {
      if (!source.sourceId) return null;
      const url = new URL(
        `nimbalyst://tracker/${encodeURIComponent(source.sourceId)}`
      );
      url.searchParams.set("orgId", orgId);
      if (source.commentId) url.searchParams.set("commentId", source.commentId);
      return { kind: "inboxSource", url: url.toString() };
    }
    case "documentDiscussion":
    case "documentInlineComment": {
      if (!source.sourceId) return null;
      const url = new URL(
        `nimbalyst://doc/${encodeURIComponent(source.sourceId)}`
      );
      url.searchParams.set("orgId", orgId);
      if (source.threadId) url.searchParams.set("threadId", source.threadId);
      if (source.commentId) url.searchParams.set("commentId", source.commentId);
      return { kind: "inboxSource", url: url.toString() };
    }
    case "feedbackRequest":
      // Someone is waiting on an answer from this person, so the banner is
      // worth showing even though the respond surface owns no deep-link route
      // yet. It lands on the Inbox rather than on a link that resolves to
      // nothing.
      return { kind: "inbox", orgId };
    default: {
      const _exhaust: never = source.sourceKind;
      void _exhaust;
      return null;
    }
  }
}

function routeForDelivery(
  delivery: TeamInboxMaterializedDelivery
): DeliveryRoute | null {
  const source = delivery.source;
  if (!source) return null;
  if (source.orgId !== delivery.orgId) return null;

  if ("sourceKind" in source) {
    return commentRefRoute(source, delivery.orgId);
  }

  if (!source.resourceId) return null;
  const host = ACTIVITY_DEEP_LINK_HOSTS[source.resourceKind];
  if (!host) return { kind: "inbox", orgId: delivery.orgId };
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
  return ACTIVITY_FALLBACKS[source.resourceKind];
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
      delivery.actor.onBehalfOfUserId === delivery.teamMemberId
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
          if (route.kind === "inbox") {
            this.dependencies.openInbox(route.orgId);
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
