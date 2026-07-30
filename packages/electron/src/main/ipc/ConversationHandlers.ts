import { BrowserWindow } from "electron";
import type {
  ConversationAppendInput,
  ConversationTarget,
} from "@nimbalyst/runtime";
import type {
  ConversationDescriptorUpdatedEvent,
  ConversationDirectoryAgentPostingRequest,
  ConversationDirectoryArchiveRequest,
  ConversationDirectoryChangedEvent,
  ConversationDirectoryCreateRequest,
  ConversationDirectoryListRequest,
  ConversationDirectoryMembershipRequest,
  ConversationDirectoryMembersRequest,
  ConversationDirectoryUpdateRequest,
  ConversationSetSubscriptionRequest,
} from "../../shared/conversationDirectory";

import {
  getConversationService,
  shutdownConversationService,
} from "../services/ConversationService";
import {
  archiveConversation,
  createConversation,
  listConversationMembers,
  listConversations,
  setAgentPosting,
  setConversationMembership,
  updateConversation,
} from "../services/TeamService";
import {
  clearCollabAssetSender,
  registerCollabAssetDocument,
  unregisterCollabAssetDocument,
} from "../protocols/collabAssetProtocol";
import { safeHandle } from "../utils/ipcRegistry";

type ListRequest = ConversationTarget & {
  cursor?: string;
  pageSize?: number;
};

type AppendRequest = ConversationTarget & {
  input: ConversationAppendInput;
};

let cleanupSubscription: (() => void) | null = null;

/**
 * WebContents that already carry a `destroyed` cleanup for their conversation
 * asset registrations. One listener per renderer, not one per conversation
 * opened in it.
 */
const senderDestroyedHooked = new Set<number>();

export function registerConversationHandlers(): void {
  if (cleanupSubscription) return;
  const service = getConversationService();
  cleanupSubscription = service.subscribe((payload) => {
    broadcast("conversation:sync-event", payload);
  });

  safeHandle("conversation:list", async (_event, request: ListRequest) => {
    assertTarget(request);
    return service.list(
      conversationTarget(request),
      request.cursor,
      request.pageSize
    );
  });
  safeHandle("conversation:append", async (_event, request: AppendRequest) => {
    assertTarget(request);
    if (!request.input?.clientMutationId) {
      throw new Error("conversation:append requires a clientMutationId");
    }
    return service.append(conversationTarget(request), request.input);
  });
  safeHandle(
    "conversation:set-subscription",
    async (_event, request: ConversationSetSubscriptionRequest) => {
      assertTarget(request);
      if (request.state !== "following" && request.state !== "muted") {
        throw new Error("conversation:set-subscription requires a valid state");
      }
      if (
        request.notificationLevel !== "all"
        && request.notificationLevel !== "mentions"
        && request.notificationLevel !== "none"
      ) {
        throw new Error(
          "conversation:set-subscription requires a valid notification level",
        );
      }
      return service.setSubscription(
        conversationTarget(request),
        request.state,
        request.notificationLevel,
      );
    },
  );

  safeHandle(
    "conversation:directory:list",
    async (_event, request: ConversationDirectoryListRequest) => {
      assertOrgId(request);
      return listConversations(request.orgId, {
        includeDirect: request.includeDirect,
        includeArchived: request.includeArchived,
      });
    },
  );
  safeHandle(
    "conversation:directory:list-members",
    async (_event, request: ConversationDirectoryMembersRequest) => {
      assertOrgId(request);
      assertConversationId(request);
      return listConversationMembers(request.orgId, request.conversationId);
    },
  );
  safeHandle(
    "conversation:directory:create",
    async (_event, request: ConversationDirectoryCreateRequest) => {
      assertOrgId(request);
      if (!request.input) {
        throw new Error("conversation:directory:create requires input");
      }
      const result = await createConversation(request.orgId, request.input);
      broadcastDirectoryChanged(request.orgId);
      return result;
    },
  );
  safeHandle(
    "conversation:directory:update",
    async (_event, request: ConversationDirectoryUpdateRequest) => {
      assertOrgId(request);
      assertConversationId(request);
      if (!request.input) {
        throw new Error("conversation:directory:update requires input");
      }
      const result = await updateConversation(
        request.orgId,
        request.conversationId,
        request.input,
      );
      broadcastDirectoryChanged(request.orgId);
      return result;
    },
  );
  safeHandle(
    "conversation:directory:archive",
    async (_event, request: ConversationDirectoryArchiveRequest) => {
      assertOrgId(request);
      assertConversationId(request);
      const result = await archiveConversation(
        request.orgId,
        request.conversationId,
      );
      broadcastDirectoryChanged(request.orgId);
      return result;
    },
  );
  safeHandle(
    "conversation:directory:set-membership",
    async (_event, request: ConversationDirectoryMembershipRequest) => {
      assertOrgId(request);
      assertConversationId(request);
      if (!request.userId) {
        throw new Error(
          "conversation:directory:set-membership requires userId",
        );
      }
      if (typeof request.active !== "boolean") {
        throw new Error(
          "conversation:directory:set-membership requires active",
        );
      }
      const result = await setConversationMembership(
        request.orgId,
        request.conversationId,
        request.userId,
        {
          active: request.active,
          role: request.role,
        },
      );
      broadcastDirectoryChanged(request.orgId);
      return result;
    },
  );
  safeHandle(
    "conversation:directory:set-agent-posting",
    async (_event, request: ConversationDirectoryAgentPostingRequest) => {
      assertOrgId(request);
      assertConversationId(request);
      if (typeof request.enabled !== "boolean") {
        throw new Error(
          "conversation:directory:set-agent-posting requires enabled",
        );
      }
      const result = await setAgentPosting(
        request.orgId,
        request.conversationId,
        request.enabled,
      );
      broadcastDirectoryChanged(request.orgId);
      return result;
    },
  );

  // Write-through for the team-sync `conversationDescriptorUpdated` broadcast,
  // matching `org:settings:apply`: the renderer holding the socket hands the
  // descriptor to main, which fans it out to every window — the organization
  // window has no team-sync socket of its own.
  safeHandle(
    "conversation:directory:apply-descriptor",
    async (_event, request: ConversationDescriptorUpdatedEvent) => {
      assertOrgId(request);
      if (!request.descriptor?.id) {
        throw new Error(
          "conversation:directory:apply-descriptor requires a descriptor",
        );
      }
      broadcast("conversation:descriptor-updated", {
        orgId: request.orgId,
        descriptor: request.descriptor,
      } satisfies ConversationDescriptorUpdatedEvent);
      return { success: true };
    },
  );

  /**
   * Authorize THIS renderer to upload and read this conversation's encrypted
   * attachments.
   *
   * Messaging attachments reuse the document asset pipeline with the
   * conversation id standing in for the document id, so they reuse its
   * authorization registry too: `document-sync:upload-asset` and the
   * `collab-asset://` protocol both consult it. Registration is refcounted per
   * sender, so opening the same conversation in two windows and closing one
   * does not revoke the other.
   *
   * The registry is the client-side gate only. Server-side reads remain
   * org-scoped (`canAccessContentRoom`), which is why a DM attachment is
   * readable by any org member who learns its asset id -- tracked in NIM-2267.
   */
  safeHandle(
    "conversation:register-assets",
    async (event, request: Partial<ConversationTarget>) => {
      assertTarget(request);
      const senderId = event.sender.id;
      registerCollabAssetDocument(
        request.orgId,
        request.conversationId,
        senderId,
      );
      if (!event.sender.isDestroyed() && !senderDestroyedHooked.has(senderId)) {
        senderDestroyedHooked.add(senderId);
        event.sender.once("destroyed", () => {
          senderDestroyedHooked.delete(senderId);
          clearCollabAssetSender(senderId);
        });
      }
      return { success: true };
    },
  );

  safeHandle(
    "conversation:unregister-assets",
    async (event, request: { conversationId?: string }) => {
      assertConversationId(request);
      unregisterCollabAssetDocument(request.conversationId, event.sender.id);
      return { success: true };
    },
  );
}

export function shutdownConversationHandlers(): void {
  cleanupSubscription?.();
  cleanupSubscription = null;
  shutdownConversationService();
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function broadcastDirectoryChanged(orgId: string): void {
  const payload: ConversationDirectoryChangedEvent = { orgId };
  broadcast("conversation:directory-changed", payload);
}

function conversationTarget(request: ConversationTarget): ConversationTarget {
  return {
    orgId: request.orgId,
    conversationId: request.conversationId,
  };
}

function assertTarget(
  value: Partial<ConversationTarget> | null | undefined
): asserts value is ConversationTarget {
  if (!value?.orgId || !value.conversationId) {
    throw new Error(
      "Conversation organization and conversation ids are required"
    );
  }
}

function assertOrgId(
  value: { orgId?: string } | null | undefined,
): asserts value is { orgId: string } {
  if (!value?.orgId) {
    throw new Error("Conversation organization id is required");
  }
}

function assertConversationId(
  value: { conversationId?: string } | null | undefined,
): asserts value is { conversationId: string } {
  if (!value?.conversationId) {
    throw new Error("Conversation id is required");
  }
}
