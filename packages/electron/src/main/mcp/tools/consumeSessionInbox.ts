import { AISessionsRepository } from "@nimbalyst/runtime/storage/repositories/AISessionsRepository";
import { getSessionStateManager } from "@nimbalyst/runtime/ai/server/SessionStateManager";
import { sessionInbox } from "../../services/ai/sessionInboxService";
import { extractCodexTurnMetadataFromRequest } from "./codexToolCallResolver";

export async function handleConsumeSessionInbox(
  sessionId: string | undefined,
  request: {
    params: {
      arguments?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    };
  }
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const args = request.params.arguments ?? {};
  if (
    !sessionId ||
    Object.keys(args).length !== 1 ||
    typeof args.checkpointId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(args.checkpointId)
  )
    throw new Error(
      "consume_session_inbox requires only a checkpointId (1-100 letters, digits, underscores or hyphens) and is bound to the calling session"
    );
  const session = await AISessionsRepository.get(sessionId);
  const state = getSessionStateManager().getSessionState(sessionId);
  if (!session?.workspacePath || state?.status !== "running")
    throw new Error(
      "Inbox consumption requires a running turn; finish interactive input first"
    );
  const native = extractCodexTurnMetadataFromRequest(request);
  const toolUseId = request.params._meta?.["claudecode/toolUseId"];
  if (!native?.turnId && typeof toolUseId !== "string")
    throw new Error("This provider has no verifiable inbox tool invocation");
  const text = await sessionInbox.consume(sessionId, session.workspacePath, {
    checkpointId: args.checkpointId,
    toolUseId: typeof toolUseId === "string" ? toolUseId : undefined,
    nativeTurnId: native?.turnId,
    nativeThreadId: native?.threadId,
  });
  return { content: [{ type: "text", text }] };
}
