import { BrowserWindow } from "electron";
import type {
  ConversationAppendInput,
  ConversationTarget,
} from "@nimbalyst/runtime";

import { getConversationService } from "../services/ConversationService";
import { safeHandle } from "../utils/ipcRegistry";

type ListRequest = ConversationTarget & {
  cursor?: string;
  pageSize?: number;
};

type AppendRequest = ConversationTarget & {
  input: ConversationAppendInput;
};

export function registerConversationHandlers(): void {
  const service = getConversationService();
  service.subscribe((payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("conversation:sync-event", payload);
      }
    }
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
