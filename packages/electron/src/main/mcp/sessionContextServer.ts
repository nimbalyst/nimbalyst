/**
 * Session-context tool surface (`get_session_summary`, `get_workstream_*`,
 * `list_recent_sessions`, `schedule_wakeup`, `update_session_board`).
 *
 * MCP consolidation: these tools are served by the unified internal MCP HTTP
 * server's `/mcp/host` endpoint (`nimbalyst-host`). This module exports only the
 * tool schemas + an endpoint-agnostic dispatch fn; the standalone HTTP server it
 * used to run was retired in Phase 7.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import {
  AISessionsRepository,
  SessionFilesRepository,
} from "@nimbalyst/runtime";
import type { SessionMeta } from "@nimbalyst/runtime";
import { assertNoReservedAttentionSupervisorMetadataMutation } from "../services/AttentionSupervisorAuthorization";
import {
  SessionVisibilityControlService,
  canonicalizeSessionWorkspacePath,
  toSessionVisibilityErrorPayload,
} from "../services/SessionVisibilityControlService";

// ─── Utilities ──────────────────────────────────────────────────────

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Strip workspace path prefix from file paths to save context window space.
 * "/Users/person/sources/nimbalyst/packages/foo.ts" -> "packages/foo.ts"
 */
function stripWorkspacePath(filePath: string, workspacePath: string): string {
  if (workspacePath && filePath.startsWith(workspacePath)) {
    const relative = filePath.slice(workspacePath.length);
    return relative.startsWith("/") ? relative.slice(1) : relative;
  }
  return filePath;
}

function sessionMatchesWorkspace(
  session: { workspacePath?: string } | null,
  workspacePath: string,
): boolean {
  if (!session?.workspacePath || !workspacePath) return false;
  return canonicalizeSessionWorkspacePath(session.workspacePath) ===
    canonicalizeSessionWorkspacePath(workspacePath);
}

async function loadAuthorizedReadTarget(
  targetSessionId: string,
  actorSessionId: string,
  workspacePath: string,
) {
  const actor = await AISessionsRepository.get(actorSessionId);
  if (!sessionMatchesWorkspace(actor, workspacePath)) return null;
  const target = targetSessionId === actorSessionId
    ? actor
    : await AISessionsRepository.get(targetSessionId);
  return sessionMatchesWorkspace(target, workspacePath) ? target : null;
}

// ─── Last-assistant-response aggregation ────────────────────────────

/**
 * Minimal DB surface for the assistant-response aggregator. Keeps the helper
 * testable without dragging the full PGLite/SQLite adapter into the test
 * harness.
 */
export interface MessageRowDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Assemble the most recent assistant response for a session.
 *
 * Chunked providers (claude-code streaming, codex `agent_message_delta`s)
 * split one assistant turn across many rows. The naive
 * `ORDER BY id DESC LIMIT 1` returns the trailing fragment of the final
 * delta, not the assembled reply. We instead take every assistant row whose
 * id is greater than the most recent user-row id, in ascending order, and
 * join their `searchable_text` values.
 *
 * Returns null when the session has no assistant content yet. Output is
 * capped at 2000 chars to match the existing tool-output contract.
 */
export async function fetchLastAssistantResponse(
  db: MessageRowDb,
  sessionId: string,
  maxLen: number = 2000,
): Promise<string | null> {
  const { rows: lastUserRows } = await db.query<{ id: number }>(
    `SELECT id FROM ai_agent_messages
     WHERE session_id = $1 AND message_kind = 'user'
     ORDER BY id DESC
     LIMIT 1`,
    [sessionId]
  );
  const lastUserId = lastUserRows.length > 0 ? lastUserRows[0].id : 0;
  const { rows: assistantRows } = await db.query<{ searchable_text: string | null }>(
    `SELECT searchable_text FROM ai_agent_messages
     WHERE session_id = $1 AND message_kind = 'assistant'
       AND searchable_text IS NOT NULL
       AND id > $2
     ORDER BY id ASC`,
    [sessionId, lastUserId]
  );
  const assembled = assistantRows
    .map((row) => row.searchable_text ?? "")
    .filter((t) => t.length > 0)
    .join("\n");
  if (assembled.length === 0) return null;
  return assembled.slice(0, maxLen);
}

// ─── Tool handlers ──────────────────────────────────────────────────

async function handleGetSessionSummary(
  targetSessionId: string | undefined,
  currentSessionId: string,
  workspaceId: string
): Promise<string> {
  const sessionId = targetSessionId || currentSessionId;

  const session = await loadAuthorizedReadTarget(
    sessionId,
    currentSessionId,
    workspaceId,
  );
  if (!session) {
    return "Error: TARGET_NOT_FOUND";
  }

  // Phase 3 of canonical-transcript-deprecation: ai_transcript_events is
  // going away. The session-context MCP queries now read ai_agent_messages
  // directly via the message_kind column populated at write time.
  const { getDatabase } = await import("../database/initialize");
  const db = getDatabase();
  const { rows: userRows } = await db.query<any>(
    `SELECT searchable_text FROM ai_agent_messages
     WHERE session_id = $1 AND message_kind = 'user'
       AND searchable_text IS NOT NULL
     ORDER BY id ASC`,
    [sessionId]
  );
  const userPrompts = userRows.map((row: any) => row.searchable_text || "").filter((t: string) => t.length > 0);

  const lastResponse = await fetchLastAssistantResponse(db, sessionId);

  let editedFiles: string[] = [];
  try {
    const fileLinks = await SessionFilesRepository.getFilesBySession(
      sessionId,
      "edited"
    );
    editedFiles = fileLinks.map((f: any) => f.filePath);
  } catch {
    // File tracking might not be available for all sessions
  }

  const lines: string[] = [];
  lines.push(
    `Session: "${session.title || "Untitled"}" (${sessionId})`
  );
  lines.push(
    `Provider: ${session.provider}${session.model ? ` | Model: ${session.model}` : ""}`
  );
  lines.push(
    `Created: ${formatDate(session.createdAt)} | Last active: ${formatDate(session.updatedAt)}`
  );
  lines.push(`Pinned: ${session.isPinned === true ? "yes" : "no"}`);

  if (session.parentSessionId) {
    const parent = await AISessionsRepository.get(session.parentSessionId);
    if (sessionMatchesWorkspace(parent, workspaceId)) {
      lines.push(`Workstream: "${parent!.title || "Untitled"}" (${parent!.id})`);
    } else {
      lines.push("Workstream: none");
    }
  } else {
    lines.push("Workstream: none");
  }

  const metadata = session.metadata as Record<string, unknown> | undefined;
  const phase = metadata?.phase as string | undefined;
  const tags = metadata?.tags as string[] | undefined;
  if (phase) {
    lines.push(`Phase: ${phase}`);
  }
  if (tags && tags.length > 0) {
    lines.push(`Tags: ${tags.map(t => `#${t}`).join(", ")}`);
  }

  lines.push("");

  if (userPrompts.length > 0) {
    lines.push(`User prompts (${userPrompts.length} turns):`);
    for (let i = 0; i < userPrompts.length; i++) {
      const prompt = userPrompts[i];
      lines.push(`${i + 1}. "${prompt}"`);
    }
  } else {
    lines.push("No user prompts found.");
  }

  if (lastResponse) {
    lines.push("");
    lines.push("Last agent response (truncated):");
    lines.push(`"${lastResponse}"`);
  }

  if (editedFiles.length > 0) {
    lines.push("");
    lines.push(`Files edited (${editedFiles.length}):`);
    for (const file of editedFiles) {
      lines.push(`- ${stripWorkspacePath(file, workspaceId)}`);
    }
  }

  return lines.join("\n");
}

async function handleGetWorkstreamOverview(
  workstreamId: string | undefined,
  currentSessionId: string,
  workspaceId: string
): Promise<string> {
  const actor = await loadAuthorizedReadTarget(
    currentSessionId,
    currentSessionId,
    workspaceId,
  );
  if (!actor) return "Error: TARGET_NOT_FOUND";
  let parentId = workstreamId;

  if (!parentId) {
    parentId = actor.parentSessionId ?? undefined;
    if (!parentId) {
      return "This session is not part of a workstream (no parent session). Use get_session_summary to view the current session.";
    }
  }

  const parent = await loadAuthorizedReadTarget(parentId, currentSessionId, workspaceId);
  if (!parent) {
    return "Error: TARGET_NOT_FOUND";
  }

  const { database } = await import("../database/PGLiteDatabaseWorker");
  const { rows } = await database.query<any>(
    `SELECT s.id, s.title, s.provider, s.model, s.session_type, s.created_at, s.updated_at
     FROM ai_sessions s
     WHERE s.parent_session_id = $1 AND s.workspace_id = $2
     ORDER BY s.created_at ASC`,
    [parentId, workspaceId]
  );

  if (rows.length === 0) {
    return `Workstream: "${parent.title || "Untitled"}" (${parentId})\nNo child sessions found.`;
  }

  const childIds = rows.map((r: any) => r.id);
  let allFileLinks: Array<{ sessionId: string; filePath: string }> = [];
  try {
    const links = await SessionFilesRepository.getFilesBySessionMany(
      childIds,
      "edited"
    );
    allFileLinks = links.map((l) => ({
      sessionId: l.sessionId,
      filePath: l.filePath,
    }));
  } catch {
    // File tracking might not be available
  }

  const filesBySession = new Map<string, string[]>();
  for (const link of allFileLinks) {
    const existing = filesBySession.get(link.sessionId) || [];
    existing.push(link.filePath);
    filesBySession.set(link.sessionId, existing);
  }

  const lines: string[] = [];
  lines.push(
    `Workstream: "${parent.title || "Untitled"}" (${parentId})`
  );
  lines.push(`Sessions (${rows.length}):`);
  lines.push("");

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const updatedAt =
      row.updated_at instanceof Date
        ? row.updated_at.getTime()
        : new Date(row.updated_at).getTime();
    const sessionFiles = filesBySession.get(row.id) || [];
    const isCurrentSession = row.id === currentSessionId;

    lines.push(
      `${i + 1}. "${row.title || "Untitled"}" (${row.id}) - last active ${formatRelativeTime(updatedAt)}${isCurrentSession ? " [CURRENT]" : ""}`
    );

    if (sessionFiles.length > 0) {
      const shown = sessionFiles.slice(0, 3).map(f => stripWorkspacePath(f, workspaceId));
      const more = sessionFiles.length - shown.length;
      lines.push(
        `   Files: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`
      );
    }
  }

  const allUniqueFiles = new Set<string>();
  for (const link of allFileLinks) {
    allUniqueFiles.add(link.filePath);
  }

  if (allUniqueFiles.size > 0) {
    lines.push("");
    lines.push(
      `All files edited across workstream (${allUniqueFiles.size} unique):`
    );
    for (const file of allUniqueFiles) {
      lines.push(`- ${stripWorkspacePath(file, workspaceId)}`);
    }
  }

  return lines.join("\n");
}

async function handleListRecentSessions(
  query: string | undefined,
  limit: number,
  offset: number,
  workspaceId: string,
  currentSessionId: string,
  includeArchived: boolean,
  searchField: "title" | "content" | "both" = "both"
): Promise<string> {
  const actor = await loadAuthorizedReadTarget(
    currentSessionId,
    currentSessionId,
    workspaceId,
  );
  if (!actor) return "Error: TARGET_NOT_FOUND";
  let sessions: SessionMeta[];

  const options = { includeArchived };
  const trimmedQuery = query?.trim() ?? "";
  if (trimmedQuery.length > 0) {
    if (searchField === "title") {
      // Title-only: list everything in the workspace, then case-insensitive
      // substring match on title. Avoids the FTS path which also matches
      // conversation content. See #83.
      const all = await AISessionsRepository.list(workspaceId, options);
      const needle = trimmedQuery.toLowerCase();
      sessions = all.filter((s) =>
        (s.title ?? "").toLowerCase().includes(needle)
      );
    } else {
      sessions = await AISessionsRepository.search(workspaceId, trimmedQuery, options);
    }
  } else {
    sessions = await AISessionsRepository.list(workspaceId, options);
  }

  const leafSessions = sessions.filter(
    (s) => s.sessionType !== "workstream"
  );
  const limited = leafSessions.slice(offset, offset + limit);

  if (limited.length === 0) {
    if (trimmedQuery.length > 0) {
      const scope = searchField === "title" ? " in titles" : "";
      return `No sessions found matching "${trimmedQuery}"${scope}`;
    }
    return "No sessions found in this workspace.";
  }

  const parentIds = new Set<string>();
  for (const s of limited) {
    if (s.parentSessionId) {
      parentIds.add(s.parentSessionId);
    }
  }

  const parentTitles = new Map<string, string>();
  if (parentIds.size > 0) {
    try {
      const parents = await AISessionsRepository.getMany(
        Array.from(parentIds)
      );
      for (const p of parents) {
        if (sessionMatchesWorkspace(p, workspaceId)) {
          parentTitles.set(p.id, p.title || "Untitled");
        }
      }
    } catch {
      // Continue without parent titles
    }
  }

  const sessionIds = limited.map((s) => s.id);

  // Fetch running status from database (idle, running, error, interrupted)
  let statusMap = new Map<string, string>();
  if (sessionIds.length > 0) {
    try {
      const { getDatabase } = await import("../database/initialize");
      const db = getDatabase();
      const { rows: statusRows } = await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM ai_sessions WHERE id = ANY($1)`,
        [sessionIds]
      );
      for (const row of statusRows) {
        statusMap.set(row.id, row.status);
      }
    } catch {
      // Non-critical -- continue without status
    }
  }

  const lines: string[] = [];
  const matchScope =
    trimmedQuery.length > 0
      ? `matching "${trimmedQuery}"${searchField === "title" ? " in titles" : ""}`
      : "total";
  const totalLabel = matchScope;
  const offsetLabel = offset > 0 ? `, offset ${offset}` : "";
  lines.push(
    `Recent sessions (showing ${limited.length} of ${leafSessions.length} ${totalLabel}${offsetLabel}):`
  );
  lines.push("");

  for (let i = 0; i < limited.length; i++) {
    const s = limited[i];
    const isCurrentSession = s.id === currentSessionId;
    const status = statusMap.get(s.id) || "idle";

    let line = `${i + 1}. "${s.title}" (${s.id}) - ${formatRelativeTime(s.updatedAt)}`;
    if (status === "running") {
      line += " [RUNNING]";
    } else if (status === "error") {
      line += " [ERROR]";
    } else if (status === "interrupted") {
      line += " [INTERRUPTED]";
    }
    if (s.isArchived) {
      line += " [ARCHIVED]";
    }
    if (isCurrentSession) {
      line += " [CURRENT]";
    }
    lines.push(line);

    const meta: string[] = [];
    meta.push(`Provider: ${s.provider}`);
    meta.push(`Pinned: ${s.isPinned === true ? "yes" : "no"}`);
    if (s.sessionType && s.sessionType !== "session") {
      meta.push(`Type: ${s.sessionType}`);
    }
    if (s.parentSessionId) {
      const parentTitle = parentTitles.get(s.parentSessionId);
      if (parentTitle) {
        meta.push(`Workstream: "${parentTitle}" (${s.parentSessionId})`);
      } else {
        meta.push(`Workstream: ${s.parentSessionId} (title unavailable)`);
      }
    } else {
      meta.push("Workstream: none");
    }
    if (s.phase) {
      meta.push(`Phase: ${s.phase}`);
    }
    if (s.tags && s.tags.length > 0) {
      meta.push(`Tags: ${s.tags.map(t => `#${t}`).join(", ")}`);
    }
    lines.push(`   ${meta.join(" | ")}`);
  }

  return lines.join("\n");
}

async function handleGetWorkstreamEditedFiles(
  groupBySession: boolean,
  currentSessionId: string,
  workspaceId: string
): Promise<string> {
  const currentSession = await loadAuthorizedReadTarget(
    currentSessionId,
    currentSessionId,
    workspaceId,
  );
  if (!currentSession) {
    return "Error: TARGET_NOT_FOUND";
  }

  const parentId = currentSession.parentSessionId;
  if (!parentId) {
    const files = await SessionFilesRepository.getFilesBySession(
      currentSessionId,
      "edited"
    );
    if (files.length === 0) {
      return "No files have been edited in this session. This session is not part of a workstream.";
    }
    return `This session is not part of a workstream. Files edited in current session (${files.length}):\n${files.map((f) => `- ${stripWorkspacePath(f.filePath, workspaceId)}`).join("\n")}`;
  }

  const { database } = await import("../database/PGLiteDatabaseWorker");
  const { rows } = await database.query<any>(
    `SELECT id, title FROM ai_sessions WHERE parent_session_id = $1 AND workspace_id = $2 ORDER BY created_at ASC`,
    [parentId, workspaceId]
  );

  if (rows.length === 0) {
    return "No child sessions found in this workstream.";
  }

  const childIds = rows.map((r: any) => r.id);
  const allLinks = await SessionFilesRepository.getFilesBySessionMany(
    childIds,
    "edited"
  );

  if (allLinks.length === 0) {
    return "No files have been edited across the workstream.";
  }

  if (groupBySession) {
    const titleMap = new Map<string, string>();
    for (const row of rows) {
      titleMap.set(row.id, row.title || "Untitled");
    }

    const grouped = new Map<string, string[]>();
    for (const link of allLinks) {
      const existing = grouped.get(link.sessionId) || [];
      existing.push(link.filePath);
      grouped.set(link.sessionId, existing);
    }

    const uniqueFiles = new Set(allLinks.map((l) => l.filePath));

    const lines: string[] = [];
    lines.push("Files edited across workstream by session:");
    lines.push("");

    for (const [sessionId, files] of grouped) {
      const title = titleMap.get(sessionId) || "Untitled";
      lines.push(`Session: "${title}" (${sessionId})`);
      for (const file of files) {
        lines.push(`- ${stripWorkspacePath(file, workspaceId)}`);
      }
      lines.push("");
    }

    lines.push(
      `Total: ${uniqueFiles.size} unique files across ${grouped.size} sessions`
    );
    return lines.join("\n");
  } else {
    const uniqueFiles = new Set(allLinks.map((l) => l.filePath));
    const lines: string[] = [];
    lines.push(
      `Files edited across workstream (${allLinks.length} total, ${uniqueFiles.size} unique):`
    );
    for (const file of uniqueFiles) {
      lines.push(`- ${stripWorkspacePath(file, workspaceId)}`);
    }
    return lines.join("\n");
  }
}

async function handleScheduleWakeup(args: {
  sessionId: string;
  workspaceId: string;
  delaySeconds: number;
  prompt: string;
  reason: string;
}): Promise<string> {
  const { sessionId, workspaceId, delaySeconds, prompt, reason } = args;

  const session = await AISessionsRepository.get(sessionId);
  if (!session) {
    return `Error: Session ${sessionId} not found`;
  }

  const { getSessionWakeupsStore } = await import('../services/RepositoryManager');
  const { SessionWakeupScheduler } = await import('../services/SessionWakeupScheduler');

  const id = `wakeup-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const fireAt = new Date(Date.now() + delaySeconds * 1000);

  const row = await getSessionWakeupsStore().create({
    id,
    sessionId,
    workspaceId,
    prompt,
    reason,
    fireAt,
  });

  SessionWakeupScheduler.getInstance().onCreated(row);

  // Broadcast to renderers so the UI updates immediately
  const { BrowserWindow } = await import('electron');
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('wakeup:changed', row);
    }
  }

  return JSON.stringify({
    wakeupId: row.id,
    fireAt: row.fireAt,
    fireAtIso: new Date(row.fireAt).toISOString(),
    sessionId: row.sessionId,
    reason: row.reason,
  }, null, 2);
}

// ─── MCP server creation ────────────────────────────────────────────

// ─── Shared tool surface (also folded into the unified MCP server) ──
//
// MCP consolidation Phase 5: these session-context tools are served BOTH by
// this standalone server (legacy, until Phase 7 retires the port) AND by the
// unified internal HTTP server's `/mcp/host` endpoint (`nimbalyst-host`).

/** Tool schemas exposed by the session-context surface. */
export const SESSION_CONTEXT_TOOL_SCHEMAS = [
  {
    name: "session_set_pinned",
    description:
      "Set a session's pinned visibility state in the caller's current workspace. Idempotent; returns authoritative before/after state and an audit receipt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: 200 },
        pinned: { type: "boolean" },
      },
      required: ["sessionId", "pinned"],
    },
  },
  {
    name: "session_set_workstream",
    description:
      "Move an ordinary session into an existing workstream container in the caller's current workspace, or remove membership with null. Never creates a workstream or changes workspace/worktree binding.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: 200 },
        workstreamId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
      },
      required: ["sessionId", "workstreamId"],
    },
  },
  {
    name: "session_rename",
    description:
      "Set the exact target session's display name in the caller's current workspace. Does not rename a worktree, workstream parent, blitz parent, repository, or branch.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1, maxLength: 200 },
        name: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["sessionId", "name"],
    },
  },
  {
    name: "get_session_summary",
    description:
      "Get a compact summary of an AI session including its title, user prompts, last agent response, and files edited. Use this to understand what happened in a specific session. If no sessionId is provided, summarizes the current session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description:
            "ID of the session to summarize. If omitted, summarizes the current session. Use list_recent_sessions to find session IDs.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_workstream_overview",
    description:
      "Get an overview of the current workstream (parent session with child sessions). Shows all child sessions with their titles, message counts, and files edited. Use this to understand the broader context when working in a workstream.",
    inputSchema: {
      type: "object",
      properties: {
        workstreamId: {
          type: "string",
          description:
            "ID of the workstream parent session. If omitted, uses the current session's parent workstream.",
        },
      },
      required: [],
    },
  },
  {
    name: "list_recent_sessions",
    description:
      "List recent AI sessions in the current workspace. Optionally search by title or content. Use this when the user references a previous session or asks about past work (e.g., 'implement the plan from our session about X'). By default, archived sessions are excluded -- pass includeArchived: true to search across archived sessions as well. To find a session by name when the search term appears frequently in conversations, pass searchField: 'title' to restrict matching to session titles only.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional search string to filter sessions by title or content.",
        },
        searchField: {
          type: "string",
          enum: ["title", "content", "both"],
          description:
            "Where to look for the query. 'title' matches only session titles (case-insensitive substring). 'content' and 'both' match titles and conversation content via full-text search. Defaults to 'both'. Ignored if query is empty.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of results (default 10, max 250).",
        },
        offset: {
          type: "number",
          description:
            "Number of sessions to skip before returning results (default 0). Use with limit for pagination.",
        },
        includeArchived: {
          type: "boolean",
          description:
            "If true, include archived sessions in the results. Defaults to false. Archived sessions are marked with [ARCHIVED] in the output.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_workstream_edited_files",
    description:
      "Get all files edited across all sessions in the current workstream. Useful for understanding the full scope of changes or preparing a commit that spans multiple sessions.",
    inputSchema: {
      type: "object",
      properties: {
        groupBySession: {
          type: "boolean",
          description:
            "If true, group files by session with titles. If false (default), return a flat deduplicated list.",
        },
      },
      required: [],
    },
  },
  {
    name: "schedule_wakeup",
    description:
      "Schedule the current session to be re-invoked with a prompt after a delay. " +
      "Persists across Nimbalyst restarts but only fires while Nimbalyst is running. " +
      "If the workspace window is closed when the wakeup fires, it waits until the workspace opens. " +
      "Replaces any existing pending wakeup for this session (one wakeup per session at a time).",
    inputSchema: {
      type: "object",
      properties: {
        delaySeconds: {
          type: "number",
          description:
            "Seconds from now until the wakeup fires. Min 60, max 604800 (7 days).",
        },
        prompt: {
          type: "string",
          description:
            "The prompt to send to the session when the wakeup fires.",
        },
        reason: {
          type: "string",
          description:
            "One short sentence explaining why this wakeup was scheduled. Shown to the user in the sessions UI.",
        },
      },
      required: ["delaySeconds", "prompt", "reason"],
    },
  },
  {
    name: "update_session_board",
    description:
      "Update a session's kanban board metadata (phase and/or tags). Phase controls which column the session appears in on the Sessions Board. Tags are free-form strings for categorization. Either field can be provided independently.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description:
            "ID of the session to update. Use list_recent_sessions to find session IDs.",
        },
        phase: {
          type: ["string", "null"],
          enum: [
            "backlog",
            "planning",
            "implementing",
            "validating",
            "complete",
            null,
          ],
          description:
            "The phase to set. Use null to remove the session from the board. Omit to leave unchanged.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of tag strings. Pass an empty array to clear tags. Omit to leave unchanged.",
        },
      },
      required: ["sessionId"],
    },
  },
];

export const SESSION_VISIBILITY_TOOL_NAMES = [
  'session_set_pinned',
  'session_set_workstream',
  'session_rename',
] as const;

const SESSION_VISIBILITY_TOOL_NAME_SET = new Set<string>(SESSION_VISIBILITY_TOOL_NAMES);

/** OpenAI function-calling schemas for extension-agent hosts. The host must
 * still supply its own bound principal/workspace to the dispatcher below. */
export function getSessionVisibilityOpenAITools() {
  return SESSION_CONTEXT_TOOL_SCHEMAS
    .filter((tool) => SESSION_VISIBILITY_TOOL_NAME_SET.has(tool.name))
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
}

export interface HostBoundSessionVisibilityAuthority {
  actorSessionId: string;
  workspacePath: string;
}

export function deriveHostBoundSessionVisibilityAuthority(
  actorSessionId: string | undefined,
  boundState: { workspacePath?: string } | null | undefined,
  _untrustedWorkspacePath?: string,
): Readonly<HostBoundSessionVisibilityAuthority> | null {
  if (!actorSessionId || !boundState?.workspacePath) return null;
  return Object.freeze({
    actorSessionId,
    // Preserve the host/database spelling for operational lookups. The
    // service computes a separate normalized identity for equality checks.
    workspacePath: boundState.workspacePath.trim(),
  });
}

/** Extension/broker-safe visibility dispatcher. Backend tool arguments cannot
 * replace the host-bound actor or canonical workspace. */
export async function dispatchHostBoundSessionVisibilityTool(
  name: string,
  args: Record<string, any> | undefined,
  authority: Readonly<Partial<HostBoundSessionVisibilityAuthority>> | null | undefined,
) {
  const toolName = name.replace(/^mcp__nimbalyst-[a-z-]+__/, '');
  if (!SESSION_VISIBILITY_TOOL_NAME_SET.has(toolName)) {
    throw new Error(`Unknown session visibility tool: ${name}`);
  }
  return dispatchVisibilityControl(
    toolName as typeof SESSION_VISIBILITY_TOOL_NAMES[number],
    args,
    typeof authority?.actorSessionId === 'string' ? authority.actorSessionId : '',
    typeof authority?.workspacePath === 'string' && authority.workspacePath.trim()
      ? authority.workspacePath.trim()
      : '',
  );
}

async function dispatchVisibilityControl(
  toolName: "session_set_pinned" | "session_set_workstream" | "session_rename",
  args: Record<string, any> | undefined,
  actorSessionId: string,
  workspacePath: string,
): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
  const service = SessionVisibilityControlService.getInstance();
  const allowedKeys = toolName === 'session_set_pinned'
    ? new Set(['sessionId', 'pinned'])
    : toolName === 'session_set_workstream'
      ? new Set(['sessionId', 'workstreamId'])
      : new Set(['sessionId', 'name']);
  const requestArgumentsValid = Boolean(
    args &&
    typeof args === 'object' &&
    !Array.isArray(args) &&
    Object.keys(args).every((key) => allowedKeys.has(key)),
  );
  const context = {
    actorSessionId,
    workspacePath,
    source: 'mcp-host' as const,
    correlationId: `mcp-${randomUUID()}`,
    requestArgumentsValid,
  };
  try {
    const receipt = toolName === 'session_set_pinned'
      ? await service.setPinned(context, args?.sessionId, args?.pinned)
      : toolName === 'session_set_workstream'
        ? await service.setWorkstream(context, args?.sessionId, args?.workstreamId)
        : await service.rename(context, args?.sessionId, args?.name);
    return {
      content: [{ type: 'text', text: JSON.stringify(receipt) }],
      isError: false,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: JSON.stringify(toSessionVisibilityErrorPayload(error)) }],
      isError: true,
    };
  }
}

/**
 * Dispatch a session-context tool call and return the MCP `{content, isError}`
 * shape. `name` may carry the `mcp__nimbalyst-session-context__` (or `-host`)
 * prefix; it is stripped. Preserves the `schedule_wakeup` /
 * `update_session_board` IPC side effects (they live in the handlers below).
 */
export async function dispatchSessionContextTool(
  name: string,
  args: Record<string, any> | undefined,
  aiSessionId: string,
  workspaceId: string,
): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
  const toolName = name.replace(/^mcp__nimbalyst-[a-z-]+__/, "");

  try {
    switch (toolName) {
      case "session_set_pinned":
      case "session_set_workstream":
      case "session_rename":
        return dispatchVisibilityControl(toolName, args, aiSessionId, workspaceId);

      case "get_session_summary": {
        const result = await handleGetSessionSummary(
          args?.sessionId as string | undefined,
          aiSessionId,
          workspaceId
        );
        return {
          content: [{ type: "text", text: result }],
          isError: result.startsWith("Error:"),
        };
      }

      case "get_workstream_overview": {
        const result = await handleGetWorkstreamOverview(
          args?.workstreamId as string | undefined,
          aiSessionId,
          workspaceId
        );
        return {
          content: [{ type: "text", text: result }],
          isError: result.startsWith("Error:"),
        };
      }

      case "list_recent_sessions": {
        const limit = Math.min(
          Math.max((args?.limit as number) || 10, 1),
          250
        );
        const offset = Math.max((args?.offset as number) || 0, 0);
        const includeArchived = Boolean(args?.includeArchived);
        const rawSearchField = args?.searchField as string | undefined;
        const searchField: "title" | "content" | "both" =
          rawSearchField === "title" || rawSearchField === "content"
            ? rawSearchField
            : "both";
        const result = await handleListRecentSessions(
          args?.query as string | undefined,
          limit,
          offset,
          workspaceId,
          aiSessionId,
          includeArchived,
          searchField
        );
        return {
          content: [{ type: "text", text: result }],
          isError: result.startsWith("Error:"),
        };
      }

      case "get_workstream_edited_files": {
        const result = await handleGetWorkstreamEditedFiles(
          (args?.groupBySession as boolean) || false,
          aiSessionId,
          workspaceId
        );
        return {
          content: [{ type: "text", text: result }],
          isError: result.startsWith("Error:"),
        };
      }

      case "schedule_wakeup": {
        const delaySeconds = args?.delaySeconds as number | undefined;
        const prompt = args?.prompt as string | undefined;
        const reason = args?.reason as string | undefined;

        if (typeof delaySeconds !== 'number' || !Number.isFinite(delaySeconds)) {
          return {
            content: [{ type: "text", text: "Error: delaySeconds is required and must be a number" }],
            isError: true,
          };
        }
        if (delaySeconds < 60 || delaySeconds > 604800) {
          return {
            content: [{ type: "text", text: `Error: delaySeconds must be between 60 and 604800 (7 days). Got ${delaySeconds}.` }],
            isError: true,
          };
        }
        if (typeof prompt !== 'string' || prompt.trim().length === 0) {
          return {
            content: [{ type: "text", text: "Error: prompt is required and must be a non-empty string" }],
            isError: true,
          };
        }
        if (typeof reason !== 'string' || reason.trim().length === 0) {
          return {
            content: [{ type: "text", text: "Error: reason is required and must be a non-empty string" }],
            isError: true,
          };
        }

        const result = await handleScheduleWakeup({
          sessionId: aiSessionId,
          workspaceId,
          delaySeconds,
          prompt: prompt.trim(),
          reason: reason.trim(),
        });
        return {
          content: [{ type: "text", text: result }],
          isError: result.startsWith("Error:"),
        };
      }

      case "update_session_board": {
        assertNoReservedAttentionSupervisorMetadataMutation(args, 'MCP update_session_board');
        const sessionId = args?.sessionId as string;
        const phase = args?.phase as string | null | undefined;
        const tags = args?.tags as string[] | undefined;

        if (!sessionId) {
          return {
            content: [{ type: "text", text: "Error: sessionId is required" }],
            isError: true,
          };
        }

        if (phase === undefined && tags === undefined) {
          return {
            content: [{ type: "text", text: "Error: at least one of phase or tags must be provided" }],
            isError: true,
          };
        }

        const validPhases = ["backlog", "planning", "implementing", "validating", "complete"];
        if (phase !== undefined && phase !== null && !validPhases.includes(phase)) {
          return {
            content: [{ type: "text", text: `Error: Invalid phase "${phase}". Valid phases: ${validPhases.join(", ")}` }],
            isError: true,
          };
        }

        if (tags !== undefined && !Array.isArray(tags)) {
          return {
            content: [{ type: "text", text: "Error: tags must be an array of strings" }],
            isError: true,
          };
        }

        // Build metadata update with only provided fields
        const metadataUpdate: Record<string, unknown> = {};
        if (phase !== undefined) metadataUpdate.phase = phase ?? undefined;
        if (tags !== undefined) metadataUpdate.tags = tags;

        await AISessionsRepository.updateMetadata(sessionId, {
          metadata: metadataUpdate,
        });

        // Notify renderer windows so kanban board updates in real time
        const rendererUpdate: Record<string, unknown> = {};
        if (phase !== undefined) rendererUpdate.phase = phase;
        if (tags !== undefined) rendererUpdate.tags = tags;

        const { BrowserWindow } = await import("electron");
        BrowserWindow.getAllWindows().forEach((window) => {
          if (!window.isDestroyed()) {
            window.webContents.send("sessions:session-updated", sessionId, rendererUpdate);
          }
        });

        const session = await AISessionsRepository.get(sessionId);
        const title = session?.title || sessionId;
        const parts: string[] = [];
        if (phase !== undefined) {
          parts.push(phase ? `phase="${phase}"` : "removed from board");
        }
        if (tags !== undefined) {
          parts.push(tags.length > 0 ? `tags=[${tags.join(", ")}]` : "tags cleared");
        }
        return {
          content: [{ type: "text", text: `Updated "${title}": ${parts.join(", ")}` }],
          isError: false,
        };
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${name}`
        );
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    console.error(`[Session Context MCP] Tool ${toolName} failed:`, error);
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
}
