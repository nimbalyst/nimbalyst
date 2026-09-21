/**
 * IPC handlers for Claude Code session discovery and sync
 */

import * as path from "path";
import { logger } from "../utils/logger";
import { safeHandle, removeHandler } from "../utils/ipcRegistry";
import { getExternalSessionService } from "../services/externalSessions/ExternalSessionService";
import { AnalyticsService } from "../services/analytics/AnalyticsService";
import type {
  ExternalSessionProviderId,
  ExternalSessionSelection,
  ExternalSessionSyncResponse,
} from "../../shared/externalSessions";

function provider(value: unknown): ExternalSessionProviderId | undefined {
  if (value === undefined) return undefined;
  if (value !== "claude-code" && value !== "openai-codex")
    throw new Error("Unsupported external session provider");
  return value;
}
function workspace(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !path.isAbsolute(value))
    throw new Error("Invalid workspace path");
  return value;
}
function selections(value: unknown): ExternalSessionSelection[] {
  if (!Array.isArray(value) || !value.length || value.length > 256)
    throw new Error("Select between 1 and 256 sessions");
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).some(
        (key) => !["providerId", "sessionId", "workspacePath"].includes(key)
      )
    )
      throw new Error("Invalid external session selection");
    const providerId = provider(item.providerId);
    const workspacePath = workspace(item.workspacePath);
    if (
      !providerId ||
      !workspacePath ||
      typeof item.sessionId !== "string" ||
      !item.sessionId ||
      item.sessionId.length > 512
    )
      throw new Error("Invalid external session identity");
    return { providerId, sessionId: item.sessionId, workspacePath };
  });
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
async function sync(
  selected: ExternalSessionSelection[],
  workspacePath?: string
): Promise<ExternalSessionSyncResponse> {
  const results = await getExternalSessionService().sync(
    selected,
    workspacePath
  );
  const successCount = results.filter((result) => result.success).length;
  const failureCount = results.length - successCount;
  return {
    success: successCount > 0,
    results,
    successCount,
    failureCount,
    ...(successCount === 0
      ? { error: results[0]?.error ?? "No sessions found to sync" }
      : {}),
  };
}

/** Both UI generations share source resolution, ownership guards and the durable writer. */
export function initializeClaudeCodeSessionHandlers() {
  safeHandle(
    "external-sessions:scan",
    async (
      _event,
      args: { workspacePath?: unknown; providerId?: unknown } = {}
    ) => {
      try {
        return {
          success: true,
          sessions: await getExternalSessionService().scan(
            workspace(args.workspacePath),
            provider(args.providerId)
          ),
        };
      } catch (error) {
        return { success: false, sessions: [], error: errorText(error) };
      }
    }
  );
  safeHandle(
    "external-sessions:sync",
    async (
      _event,
      args: { sessions?: unknown; workspacePath?: unknown } = {}
    ) => {
      try {
        return await sync(
          selections(args.sessions),
          workspace(args.workspacePath)
        );
      } catch (error) {
        return {
          success: false,
          results: [],
          successCount: 0,
          failureCount: 0,
          error: errorText(error),
        };
      }
    }
  );
  safeHandle(
    "claude-code:scan-sessions",
    async (_event, args: { workspacePath?: unknown } = {}) => {
      try {
        return {
          success: true,
          sessions: await getExternalSessionService().scan(
            workspace(args.workspacePath),
            "claude-code"
          ),
        };
      } catch (error) {
        return { success: false, sessions: [], error: errorText(error) };
      }
    }
  );
  safeHandle(
    "claude-code:sync-sessions",
    async (
      _event,
      args: { sessionIds?: unknown; workspacePath?: unknown } = {}
    ) => {
      try {
        const workspacePath = workspace(args.workspacePath);
        if (
          !Array.isArray(args.sessionIds) ||
          !args.sessionIds.length ||
          args.sessionIds.length > 256 ||
          args.sessionIds.some((id) => typeof id !== "string")
        )
          throw new Error("Invalid session IDs");
        const ids = args.sessionIds as string[];
        const available = await getExternalSessionService().scan(
          workspacePath,
          "claude-code"
        );
        const selected = ids.map((id) => {
          const matches = available.filter(
            (session) => session.sessionId === id
          );
          if (matches.length !== 1)
            throw new Error(
              matches.length
                ? "Ambiguous external session identity"
                : "External session not found"
            );
          return {
            providerId: "claude-code" as const,
            sessionId: id,
            workspacePath: matches[0].workspacePath,
          };
        });
        const result = await sync(selected, workspacePath);
        AnalyticsService.getInstance().sendEvent(
          "claude_code_import_completed",
          {
            successCount: result.successCount,
            failureCount: result.failureCount,
            messagesAdded: result.results.reduce(
              (sum, item) => sum + item.messagesAdded,
              0
            ),
            sessionsRequested: ids.length,
          }
        );
        return result;
      } catch (error) {
        return {
          success: false,
          results: [],
          successCount: 0,
          failureCount: 0,
          error: errorText(error),
        };
      }
    }
  );
  logger.ipc.info("External session handlers initialized");
}
export function cleanupClaudeCodeSessionHandlers() {
  for (const channel of [
    "claude-code:scan-sessions",
    "claude-code:sync-sessions",
    "external-sessions:scan",
    "external-sessions:sync",
  ])
    removeHandler(channel);
}
