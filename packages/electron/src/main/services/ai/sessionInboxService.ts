import { database } from "../../database/PGLiteDatabaseWorker";
import { publishQueuedPromptClaim } from "./queuedPromptClaimEvents";
import { getSessionStateManager } from "@nimbalyst/runtime/ai/server/SessionStateManager";
import { SessionInbox } from "./sessionInbox";

export const sessionInbox = new SessionInbox(
  database,
  (sessionId, promptId) => {
    publishQueuedPromptClaim({ sessionId, promptId });
  },
  (sessionId) =>
    getSessionStateManager().getSessionState(sessionId)?.status === "running"
);
