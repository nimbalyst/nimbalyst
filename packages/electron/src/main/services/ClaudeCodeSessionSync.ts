/** Compatibility entry points for callers of the former Claude-only importer. */
import type { SessionStore } from "@nimbalyst/runtime/ai/adapters/sessionStore";
import type { AgentMessagesStore } from "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository";
import type { SessionMetadata } from "./ClaudeCodeSessionScanner";
import { getExternalSessionService } from "./externalSessions/ExternalSessionService";
import { logger } from "../utils/logger";
export { importedClaudeCodeModel } from "./externalSessions/claudeCodeImportCodec";
const log = logger.aiSession;
export interface SyncStatus {
  sessionId: string;
  status: "new" | "up-to-date" | "needs-update";
  dbMessageCount: number;
  fileMessageCount: number;
}
export interface SyncResult {
  sessionId: string;
  success: boolean;
  error?: string;
  messagesAdded: number;
}

export async function checkSyncStatus(
  sessionStore: SessionStore,
  messagesStore: AgentMessagesStore,
  metadata: SessionMetadata
): Promise<SyncStatus> {
  try {
    const existingSession = sessionStore.findByProviderSessionId
      ? await sessionStore.findByProviderSessionId(
          "claude-code",
          metadata.sessionId,
          metadata.workspacePath
        )
      : await sessionStore.get(metadata.sessionId);

    log.debug(
      `Checking sync status for session ${metadata.sessionId}: ${
        existingSession ? "found in DB" : "not in DB"
      }`
    );

    if (!existingSession) {
      return {
        sessionId: metadata.sessionId,
        status: "new",
        dbMessageCount: 0,
        fileMessageCount: metadata.messageCount,
      };
    }

    // Get message count from database
    const messages = await messagesStore.list(existingSession.id);
    const dbMessageCount = messages.length;

    // Compare per-session timestamps rather than entry counts. The 2.1.x JSONL
    // emits non-conversational entries (attachments, queue-operations, etc.)
    // that we deliberately skip during sync, so message counts will not match
    // between DB and file even when fully up-to-date.
    const fileUpdatedAt = metadata.updatedAt;
    const dbUpdatedAt = existingSession.updatedAt ?? 0;
    const TOLERANCE_MS = 1000;

    if (fileUpdatedAt <= dbUpdatedAt + TOLERANCE_MS) {
      return {
        sessionId: metadata.sessionId,
        status: "up-to-date",
        dbMessageCount,
        fileMessageCount: metadata.messageCount,
      };
    }

    return {
      sessionId: metadata.sessionId,
      status: "needs-update",
      dbMessageCount,
      fileMessageCount: metadata.messageCount,
    };
  } catch (error) {
    log.error(`Failed to check sync status for ${metadata.sessionId}:`, error);
    throw error;
  }
}

/** Store arguments remain for compatibility; all imports use the process-wide
 * serialized writer, durable cursor and canonical delivery path. */
export async function syncSession(
  _sessionStore: SessionStore,
  _messagesStore: AgentMessagesStore,
  metadata: SessionMetadata
): Promise<SyncResult> {
  try {
    const [result] = await getExternalSessionService().sync(
      [
        {
          providerId: "claude-code",
          sessionId: metadata.sessionId,
          workspacePath: metadata.workspacePath,
        },
      ],
      metadata.workspacePath
    );
    return (
      result ?? {
        sessionId: metadata.sessionId,
        success: false,
        messagesAdded: 0,
        error: "External session not found",
      }
    );
  } catch (error) {
    return {
      sessionId: metadata.sessionId,
      success: false,
      messagesAdded: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function syncSessions(
  sessionStore: SessionStore,
  messagesStore: AgentMessagesStore,
  sessions: SessionMetadata[],
  progressCallback?: (current: number, total: number, sessionId: string) => void
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];

    if (progressCallback) {
      progressCallback(i + 1, sessions.length, session.sessionId);
    }

    const result = await syncSession(sessionStore, messagesStore, session);
    results.push(result);
  }

  return results;
}
