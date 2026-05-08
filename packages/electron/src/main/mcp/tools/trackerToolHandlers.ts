import * as path from 'path';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import { getCurrentIdentity } from '../../services/TrackerIdentityService';
import {
  deleteWorkspaceTrackerSchema,
  getAllTrackerSchemas,
  getTrackerRoleField,
  isBuiltinTrackerSchema,
  upsertWorkspaceTrackerSchema,
} from '../../services/TrackerSchemaService';
import {
  getEffectiveTrackerSyncPolicy,
  getInitialTrackerSyncStatus,
  shouldSyncTrackerPolicy,
} from '../../services/TrackerPolicyService';
import { isTrackerSyncActive, syncTrackerItem } from '../../services/TrackerSyncManager';
import { getWorkspaceState } from '../../utils/store';
import { getVisibleTrackerLinkedSessions, shouldPersistTrackerLinkedSessions } from '../../../shared/trackerSessionLinks';

type McpToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
};

function getTrackerDisplayRef(item: { issueKey?: string; id: string }): string {
  return item.issueKey || item.id;
}

async function resolveTrackerRowByReference(
  db: { query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }> },
  reference: string,
  workspacePath?: string,
): Promise<any | null> {
  const params: any[] = [reference];
  const workspaceClause = workspacePath ? ` AND workspace = $2` : '';
  if (workspacePath) params.push(workspacePath);

  const result = await db.query<any>(
    `SELECT *
     FROM tracker_items
     WHERE (id = $1 OR issue_key = $1)${workspaceClause}
     ORDER BY updated DESC
     LIMIT 1`,
    params
  );

  return result.rows[0] || null;
}

function buildTrackerSchemaValidationError(
  toolName: 'tracker_create' | 'tracker_update',
  type: string,
  errors: Array<{ field: string; message: string }>,
): McpToolResult {
  const summaryLines = [
    `${toolName} rejected by tracker schema '${type}':`,
    ...errors.map((error) => `- ${error.field}: ${error.message}`),
  ];

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          structured: {
            action: 'validationFailed' as const,
            tool: toolName,
            type,
            errors,
          },
          summary: summaryLines.join('\n'),
        }),
      },
    ],
    isError: true,
  };
}

/**
 * Determine whether a tracker item's body content lives in a Y.Doc rather than
 * in the PGLite `content` column.
 *
 * Why this matters: for team-synced native tracker items, the renderer's
 * TrackerItemDetail panel mounts a CollabLexicalProvider for
 * `tracker-content/{itemId}`, and the live Y.Doc becomes the source of truth.
 * The PGLite `content` column is only a snapshot rewritten on every save from
 * the Y.Doc state. An MCP write straight into PGLite would be silently
 * clobbered the next time anyone (or anything) saves the editor, because the
 * renderer never sees the MCP edit -- it reads from Y.Doc. See NIM-436.
 *
 * Conditions for "body is collaborative":
 *  1. Item is native (no document_path) -- only natives use Y.Doc bodies.
 *     Inline / frontmatter / file-backed items keep their body in the
 *     source file and never touch Y.Doc.
 *  2. Tracker type's sync policy is shared / hybrid.
 *  3. Tracker sync is active for the workspace -- proxy for "this user has
 *     a team connected for this workspace". When sync is inactive there is
 *     no team plumbing in this process and the renderer would also fall
 *     back to the local-PGLite editor (see TrackerItemDetail.contentMode),
 *     so direct PGLite writes are safe.
 */
function isTrackerItemBodyCollaborative(
  workspacePath: string | undefined,
  trackerType: string,
  source: string | null,
  documentPath: string | null,
  modelSyncMode: string | undefined,
): boolean {
  if (!workspacePath) return false;
  // Native = no source file. Inline/frontmatter/import/file items have no Y.Doc body.
  const isNative = (source === 'native' || source == null) && !documentPath;
  if (!isNative) return false;
  const policy = getEffectiveTrackerSyncPolicy(workspacePath, trackerType, modelSyncMode);
  if (!shouldSyncTrackerPolicy(policy)) return false;
  return isTrackerSyncActive(workspacePath);
}

/** Append an activity entry to a tracker item's data.activity array */
function appendActivity(
  data: Record<string, any>,
  authorIdentity: any,
  action: string,
  details?: { field?: string; oldValue?: string; newValue?: string }
): void {
  const activity = data.activity || [];
  activity.push({
    id: `activity_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    authorIdentity,
    action,
    field: details?.field,
    oldValue: details?.oldValue,
    newValue: details?.newValue,
    timestamp: Date.now(),
  });
  // Keep activity log bounded (last 100 entries)
  if (activity.length > 100) {
    data.activity = activity.slice(-100);
  } else {
    data.activity = activity;
  }
}

/**
 * Create a bidirectional link between a tracker item and an AI session.
 * - Adds sessionId to tracker item's data.linkedSessions[]
 * - Adds trackerId to session's metadata.linkedTrackerItemIds[]
 * Returns true if any link was actually created (vs already existing).
 */
export async function createBidirectionalLink(
  trackerId: string,
  sessionId: string,
): Promise<boolean> {
  const { getDatabase } = await import("../../database/initialize");
  const db = getDatabase();
  let changed = false;

  // 1. Add session to tracker item's linkedSessions only for local trackers.
  const trackerResult = await db.query<any>(
    `SELECT workspace, type, sync_status, data FROM tracker_items WHERE id = $1`,
    [trackerId]
  );
  if (trackerResult.rows.length > 0) {
    const row = trackerResult.rows[0];
    const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data || {};
    if (shouldPersistTrackerLinkedSessions(row)) {
      const linkedSessions: string[] = Array.isArray(data.linkedSessions) ? data.linkedSessions : [];
      if (!linkedSessions.includes(sessionId)) {
        linkedSessions.push(sessionId);
        data.linkedSessions = linkedSessions;
        await db.query(
          `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
          [JSON.stringify(data), trackerId]
        );
        changed = true;
      }
    } else if (data.linkedSessions !== undefined) {
      delete data.linkedSessions;
      await db.query(
        `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
        [JSON.stringify(data), trackerId]
      );
      changed = true;
    }
  }

  // 2. Add tracker item ID to session's metadata.linkedTrackerItemIds
  const sessionResult = await db.query<any>(
    `SELECT metadata FROM ai_sessions WHERE id = $1`,
    [sessionId]
  );
  if (sessionResult.rows.length > 0) {
    const metadata = sessionResult.rows[0].metadata ?? {};
    const linkedTrackerItemIds: string[] = metadata.linkedTrackerItemIds || [];
    if (!linkedTrackerItemIds.includes(trackerId)) {
      linkedTrackerItemIds.push(trackerId);
      await db.query(
        `UPDATE ai_sessions SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ linkedTrackerItemIds }), sessionId]
      );
      changed = true;
    }
  }

  return changed;
}

/**
 * Remove a bidirectional link between a tracker item and an AI session.
 * - Removes sessionId from tracker item's data.linkedSessions[]
 * - Removes trackerId from session's metadata.linkedTrackerItemIds[]
 * Returns true if any link was actually removed.
 */
export async function removeBidirectionalLink(
  trackerId: string,
  sessionId: string,
): Promise<boolean> {
  const { getDatabase } = await import("../../database/initialize");
  const db = getDatabase();
  let changed = false;

  // 1. Remove session from tracker item's linkedSessions only for local trackers.
  const trackerResult = await db.query<any>(
    `SELECT workspace, type, sync_status, data FROM tracker_items WHERE id = $1`,
    [trackerId]
  );
  if (trackerResult.rows.length > 0) {
    const row = trackerResult.rows[0];
    const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data || {};
    if (shouldPersistTrackerLinkedSessions(row)) {
      const linkedSessions: string[] = Array.isArray(data.linkedSessions) ? data.linkedSessions : [];
      const nextLinkedSessions = linkedSessions.filter((linkedSessionId) => linkedSessionId !== sessionId);
      if (nextLinkedSessions.length !== linkedSessions.length) {
        if (nextLinkedSessions.length > 0) {
          data.linkedSessions = nextLinkedSessions;
        } else {
          delete data.linkedSessions;
        }
        await db.query(
          `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
          [JSON.stringify(data), trackerId]
        );
        changed = true;
      }
    } else if (data.linkedSessions !== undefined) {
      delete data.linkedSessions;
      await db.query(
        `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
        [JSON.stringify(data), trackerId]
      );
      changed = true;
    }
  }

  // 2. Remove tracker item ID from session's metadata.linkedTrackerItemIds
  const sessionResult = await db.query<any>(
    `SELECT metadata FROM ai_sessions WHERE id = $1`,
    [sessionId]
  );
  if (sessionResult.rows.length > 0) {
    const metadata = sessionResult.rows[0].metadata ?? {};
    const linkedTrackerItemIds: string[] = Array.isArray(metadata.linkedTrackerItemIds)
      ? metadata.linkedTrackerItemIds
      : [];
    const nextLinkedTrackerItemIds = linkedTrackerItemIds.filter((linkedTrackerId) => linkedTrackerId !== trackerId);
    if (nextLinkedTrackerItemIds.length !== linkedTrackerItemIds.length) {
      const nextMetadata =
        nextLinkedTrackerItemIds.length > 0 ? { linkedTrackerItemIds: nextLinkedTrackerItemIds } : {};
      await db.query(
        `UPDATE ai_sessions
         SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'linkedTrackerItemIds') || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify(nextMetadata), sessionId]
      );
      changed = true;
    }
  }

  return changed;
}

/** Convert a raw DB row to a TrackerItem for the renderer */
function rowToTrackerItem(row: any): any {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data || {};
  // type_tags comes from the DB column; fall back to [type] for backward compat
  const typeTags: string[] = row.type_tags && row.type_tags.length > 0
    ? row.type_tags
    : [row.type];
  const result: any = {
    id: row.id,
    issueNumber: row.issue_number ?? undefined,
    issueKey: row.issue_key ?? undefined,
    type: row.type,
    typeTags,
    title: data.title || row.title,
    description: data.description || undefined,
    status: data.status || row.status,
    priority: data.priority || undefined,
    owner: data.owner || undefined,
    module: row.document_path || undefined,
    lineNumber: row.line_number || undefined,
    workspace: row.workspace,
    tags: data.tags || undefined,
    created: data.created || row.created || undefined,
    updated: data.updated || row.updated || undefined,
    dueDate: data.dueDate || undefined,
    lastIndexed: new Date(row.last_indexed),
    content: row.content != null ? row.content : undefined,
    archived: row.archived ?? false,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : undefined,
    source: row.source || (row.document_path ? 'inline' : 'native'),
    sourceRef: row.source_ref || undefined,
    // Identity fields
    authorIdentity: data.authorIdentity || undefined,
    lastModifiedBy: data.lastModifiedBy || undefined,
    createdByAgent: data.createdByAgent || false,
    assigneeEmail: data.assigneeEmail || undefined,
    reporterEmail: data.reporterEmail || undefined,
    // Deprecated but kept for backward compat
    assigneeId: data.assigneeId || undefined,
    reporterId: data.reporterId || undefined,
    labels: data.labels || undefined,
    linkedSessions: (() => {
      const linkedSessions = getVisibleTrackerLinkedSessions(row, data.linkedSessions);
      return linkedSessions.length > 0 ? linkedSessions : undefined;
    })(),
    linkedCommitSha: data.linkedCommitSha || undefined,
    linkedCommits: data.linkedCommits || undefined,
    documentId: data.documentId || undefined,
    syncStatus: row.sync_status || 'local',
    fieldUpdatedAt: data._fieldUpdatedAt || undefined,
  };
  // Pass through all extra JSONB data fields (activity, comments, kanbanSortOrder, etc.)
  // as customFields so they survive the TrackerItem -> TrackerRecord conversion.
  // Uses the result object's own keys as the "known" set -- no hardcoded list.
  const resultKeys = new Set(Object.keys(result));
  const extra: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && !resultKeys.has(k)) extra[k] = v;
  }
  if (Object.keys(extra).length > 0) result.customFields = extra;
  return result;
}

async function countLinkedSessionsFromSessionMetadata(
  db: { query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }> },
  trackerId: string,
): Promise<number> {
  const result = await db.query<any>(`SELECT metadata FROM ai_sessions WHERE metadata IS NOT NULL`);
  let count = 0;
  for (const row of result.rows) {
    const metadata =
      typeof row.metadata === 'string'
        ? JSON.parse(row.metadata)
        : row.metadata || {};
    const linkedTrackerItemIds: string[] = Array.isArray(metadata.linkedTrackerItemIds)
      ? metadata.linkedTrackerItemIds
      : [];
    if (linkedTrackerItemIds.includes(trackerId)) count += 1;
  }
  return count;
}

function buildTrackerSchemaFromArgs(args: any): any {
  if (args?.schema && typeof args.schema === 'object' && !Array.isArray(args.schema)) {
    return args.schema;
  }

  const { fileName: _fileName, ...rest } = args ?? {};
  return rest;
}

/**
 * Send a TrackerItemChangeEvent on the correct IPC channel to the window whose
 * workspace owns the tracker item. Scoping to a single window prevents items
 * from leaking into other projects that happen to be open. `findWindowByWorkspace`
 * is worktree-aware, so worktree rows are routed to the parent project window.
 * Uses the same channel and event shape that trackerSyncListeners.ts expects.
 */
async function notifyTrackerItemAdded(_workspacePath: string | undefined, itemId: string): Promise<void> {
  const { getDatabase } = await import("../../database/initialize");
  const db = getDatabase();
  const result = await db.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [itemId]);
  if (result.rows.length === 0) return;
  const item = rowToTrackerItem(result.rows[0]);

  if (!item.workspace) return;
  const { findWindowByWorkspace } = await import("../../window/WindowManager");
  const win = findWindowByWorkspace(item.workspace);
  if (win && !win.isDestroyed()) {
    win.webContents.send("document-service:tracker-items-changed", {
      added: [item],
      updated: [],
      removed: [],
      timestamp: new Date(),
    });
  }
}

async function notifyTrackerItemUpdated(_workspacePath: string | undefined, itemId: string): Promise<void> {
  const { getDatabase } = await import("../../database/initialize");
  const db = getDatabase();
  const result = await db.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [itemId]);
  if (result.rows.length === 0) return;
  const item = rowToTrackerItem(result.rows[0]);

  if (!item.workspace) return;
  const { findWindowByWorkspace } = await import("../../window/WindowManager");
  const win = findWindowByWorkspace(item.workspace);
  if (win && !win.isDestroyed()) {
    win.webContents.send("document-service:tracker-items-changed", {
      added: [],
      updated: [item],
      removed: [],
      timestamp: new Date(),
    });
  }
}

/** Broadcast session metadata update to all windows */
async function notifySessionLinkedTrackerChanged(sessionId: string, linkedTrackerItemIds: string[]): Promise<void> {
  const { BrowserWindow } = await import("electron");
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send("session-linked-tracker-changed", { sessionId, linkedTrackerItemIds });
    }
  }
}

export const trackerToolSchemas = [
  {
    name: "tracker_list",
    description:
      "List tracker items (bugs, tasks, plans, ideas, decisions, etc.) with optional filtering. Returns a summary of each item. Use this to see what work items exist.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          description:
            "Filter by primary item type (e.g., 'bug', 'task', 'plan', 'idea', 'decision', 'feature')",
        },
        typeTag: {
          type: "string",
          description:
            "Filter by type tag (matches primary type or additional tags). Use this to find all items tagged with a type regardless of primary.",
        },
        status: {
          type: "string",
          description:
            "Filter by status (e.g., 'to-do', 'in-progress', 'done')",
        },
        priority: {
          type: "string",
          description:
            "Filter by priority (e.g., 'low', 'medium', 'high', 'critical')",
        },
        owner: {
          type: "string",
          description: "Filter by owner",
        },
        archived: {
          type: "boolean",
          description: "Include archived items (default: false)",
        },
        search: {
          type: "string",
          description: "Search title and description text",
        },
        limit: {
          type: "number",
          description: "Maximum number of items to return (default: 50)",
        },
        where: {
          type: "array",
          description: "Field-level filters for querying on any schema-defined field. Each entry is { field, op, value }. Supported ops: '=', '!=', 'contains', 'in'.",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: "Field name in the tracker data (e.g., 'severity', 'component')" },
              op: { type: "string", description: "Operator: '=', '!=', 'contains', 'in'" },
              value: { description: "Value to compare against" },
            },
            required: ["field", "op", "value"],
          },
        },
      },
    },
  },
  {
    name: "tracker_get",
    description:
      "Get a single tracker item with its full content (as markdown). Use this to read the detailed body of a bug, plan, task, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The tracker item ID or issue key (e.g. NIM-123)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "tracker_create",
    description:
      "Create a new tracker item (bug, task, plan, idea, decision, or any custom type).\n\nBy default, the new item is NOT linked to the current session. Pass linkSession: true to link it, or call tracker_link_session afterward.\n\nIMPORTANT: Never set status to 'done' or 'completed'. Use 'in-review' or 'in-progress' instead. Only the user can mark items as done.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          description:
            "Item type (e.g., 'bug', 'task', 'plan', 'idea', 'decision')",
        },
        title: {
          type: "string",
          description: "Item title",
        },
        description: {
          type: "string",
          description:
            "Plain text or markdown description (stored as rich content)",
        },
        status: {
          type: "string",
          description: "Status (default: 'to-do')",
        },
        priority: {
          type: "string",
          description:
            "Priority level (e.g., 'low', 'medium', 'high', 'critical')",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization",
        },
        owner: {
          type: "string",
          description: "Owner of the item",
        },
        dueDate: {
          type: "string",
          description: "Due date (ISO format or YYYY-MM-DD)",
        },
        progress: {
          type: "number",
          description: "Progress percentage (0-100)",
        },
        assigneeEmail: {
          type: "string",
          description: "Assignee email address (stable cross-org identifier)",
        },
        reporterEmail: {
          type: "string",
          description: "Reporter email address (stable cross-org identifier)",
        },
        assigneeId: {
          type: "string",
          description: "Assignee org member ID",
        },
        reporterId: {
          type: "string",
          description: "Reporter org member ID",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels for categorization",
        },
        linkedCommitSha: {
          type: "string",
          description: "Linked git commit SHA",
        },
        typeTags: {
          type: "array",
          items: { type: "string" },
          description: "Additional type tags beyond the primary type (e.g., ['feature', 'task'] for an item that is both)",
        },
        fields: {
          type: "object",
          description: "Generic field bag for setting any schema-defined field. Values here override fixed arguments above. Use this for custom fields or when you want to set fields by their schema name.",
        },
        linkSession: {
          type: "boolean",
          description: "If true, link the current AI session to the newly created item. Defaults to false -- creation does NOT auto-link the session.",
        },
      },
      required: ["type", "title"],
    },
  },
  {
    name: "tracker_update",
    description:
      "Update an existing tracker item's metadata or content. Can change title, status, priority, tags, description, owner, dueDate, progress, assigneeId, reporterId, labels, linkedCommitSha, or archive state.\n\nIMPORTANT: Never set status to 'done' or 'completed' without explicit user approval. Use 'in-review' when work is finished and awaiting review. Only the user decides when work is actually done.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The tracker item ID or issue key to update",
        },
        title: {
          type: "string",
          description: "New title",
        },
        status: {
          type: "string",
          description: "New status",
        },
        priority: {
          type: "string",
          description: "New priority",
        },
        description: {
          type: "string",
          description: "New description content (replaces existing content)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "New tags (replaces existing tags)",
        },
        archived: {
          type: "boolean",
          description: "Set archive state",
        },
        owner: {
          type: "string",
          description: "New owner",
        },
        dueDate: {
          type: "string",
          description: "New due date (ISO format or YYYY-MM-DD)",
        },
        progress: {
          type: "number",
          description: "New progress percentage (0-100)",
        },
        assigneeEmail: {
          type: "string",
          description: "New assignee email address (stable cross-org identifier)",
        },
        reporterEmail: {
          type: "string",
          description: "New reporter email address (stable cross-org identifier)",
        },
        assigneeId: {
          type: "string",
          description: "New assignee org member ID",
        },
        reporterId: {
          type: "string",
          description: "New reporter org member ID",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "New labels (replaces existing labels)",
        },
        linkedCommitSha: {
          type: "string",
          description: "Linked git commit SHA",
        },
        typeTags: {
          type: "array",
          items: { type: "string" },
          description: "Set type tags (replaces existing type tags). Primary type is always included.",
        },
        fields: {
          type: "object",
          description: "Generic field bag for updating any schema-defined field. Values here override fixed arguments above.",
        },
        unsetFields: {
          type: "array",
          items: { type: "string" },
          description: "Field names to remove from the item. Use this to clear custom fields.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "tracker_list_types",
    description:
      "List available tracker types and their schemas. Returns built-in and custom tracker types unless filtered.",
    inputSchema: {
      type: "object" as const,
      properties: {
        includeBuiltin: {
          type: "boolean",
          description: "Include built-in tracker types (default: true).",
        },
        includeCustom: {
          type: "boolean",
          description: "Include custom workspace tracker types (default: true).",
        },
        search: {
          type: "string",
          description: "Optional case-insensitive search over type names and display names.",
        },
      },
    },
  },
  {
    name: "tracker_define_type",
    description:
      "Define or update a custom tracker type schema in the current workspace. The schema is persisted to .nimbalyst/trackers and becomes available in the tracker UI and MCP validation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        schema: {
          type: "object",
          description: "Full tracker type schema object to persist.",
        },
        fileName: {
          type: "string",
          description: "Optional YAML filename to use within .nimbalyst/trackers.",
        },
      },
      required: ["schema"],
    },
  },
  {
    name: "tracker_delete_type",
    description:
      "Delete a custom tracker type schema from the current workspace. Built-in types cannot be deleted.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          description: "The tracker type key to delete.",
        },
      },
      required: ["type"],
    },
  },
  {
    name: "tracker_link_session",
    description:
      "Link an AI session to a tracker item. This creates a bidirectional reference between the session and the work item.\n\nBy default the link targets the current AI session. Pass sessionId to link a different session (e.g., a session id surfaced from tracker_get or tracker_list).",
    inputSchema: {
      type: "object" as const,
      properties: {
        trackerId: {
          type: "string",
          description: "The tracker item ID or issue key to link",
        },
        sessionId: {
          type: "string",
          description: "Optional. The AI session ID to link to the tracker item. Defaults to the current session if omitted.",
        },
      },
      required: ["trackerId"],
    },
  },
  {
    name: "tracker_unlink_session",
    description:
      "Unlink an AI session from a tracker item. This removes the bidirectional reference from both the session and the work item.\n\nBy default the unlink targets the current AI session. Pass sessionId to unlink a different session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        trackerId: {
          type: "string",
          description: "The tracker item ID or issue key to unlink",
        },
        sessionId: {
          type: "string",
          description: "Optional. The AI session ID to unlink from the tracker item. Defaults to the current session if omitted.",
        },
      },
      required: ["trackerId"],
    },
  },
  {
    name: "tracker_link_file",
    description:
      "Link a file (plan, doc, etc.) to the current AI session. Use this when working on a plan file or any document that isn't a database tracker item. The file path is stored on the session for bidirectional navigation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filePath: {
          type: "string",
          description: "The file path (relative to workspace) to link to this session",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "tracker_add_comment",
    description:
      "Add a comment to a tracker item. Comments support markdown.",
    inputSchema: {
      type: "object" as const,
      properties: {
        trackerId: {
          type: "string",
          description: "The tracker item ID or issue key to comment on",
        },
        body: {
          type: "string",
          description: "Comment body (supports markdown)",
        },
      },
      required: ["trackerId", "body"],
    },
  },
];

export async function handleTrackerList(
  args: any,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  try {
    const { getDatabase } = await import("../../database/initialize");
    const db = getDatabase();

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    // Always scope to workspace
    if (workspacePath) {
      conditions.push(`workspace = $${paramIdx++}`);
      params.push(workspacePath);
    }

    // Filter by archived state (default: exclude archived)
    if (args.archived) {
      conditions.push(`archived = TRUE`);
    } else {
      conditions.push(`(archived = FALSE OR archived IS NULL)`);
    }

    // Filter by primary type
    if (args.type) {
      conditions.push(`type = $${paramIdx++}`);
      params.push(args.type);
    }

    // Filter by type tag (matches any tag in the array, not just primary)
    if (args.typeTag) {
      conditions.push(`$${paramIdx++} = ANY(type_tags)`);
      params.push(args.typeTag);
    }

    // Resolve role-based field names for filters.
    // When a type is specified, use the schema to find the actual field name.
    // When no type is specified, fall back to conventional names.
    const resolveFieldForFilter = (
      role: Parameters<typeof getTrackerRoleField>[1],
      fallback: string,
    ): string => {
      if (args.type) {
        return getTrackerRoleField(args.type, role) ?? fallback;
      }
      return fallback;
    };

    // Filter by owner/assignee (resolved via schema role)
    if (args.owner) {
      const ownerField = resolveFieldForFilter('assignee', 'owner');
      conditions.push(`data->>'${ownerField}' = $${paramIdx++}`);
      params.push(args.owner);
    }

    // Filter by status (resolved via schema role)
    if (args.status) {
      const statusField = resolveFieldForFilter('workflowStatus', 'status');
      conditions.push(`data->>'${statusField}' = $${paramIdx++}`);
      params.push(args.status);
    }

    // Filter by priority (resolved via schema role)
    if (args.priority) {
      const priorityField = resolveFieldForFilter('priority', 'priority');
      conditions.push(`data->>'${priorityField}' = $${paramIdx++}`);
      params.push(args.priority);
    }

    // Generic field-level where filters
    if (args.where && Array.isArray(args.where)) {
      for (const clause of args.where) {
        if (!clause.field || !clause.op) continue;
        const fieldPath = `data->>'${clause.field.replace(/'/g, "''")}'`;
        switch (clause.op) {
          case '=':
            conditions.push(`${fieldPath} = $${paramIdx++}`);
            params.push(String(clause.value));
            break;
          case '!=':
            conditions.push(`(${fieldPath} IS NULL OR ${fieldPath} != $${paramIdx++})`);
            params.push(String(clause.value));
            break;
          case 'contains':
            conditions.push(`${fieldPath} ILIKE $${paramIdx++}`);
            params.push(`%${clause.value}%`);
            break;
          case 'in':
            if (Array.isArray(clause.value) && clause.value.length > 0) {
              const placeholders = clause.value.map(() => `$${paramIdx++}`).join(', ');
              conditions.push(`${fieldPath} IN (${placeholders})`);
              params.push(...clause.value.map(String));
            }
            break;
        }
      }
    }

    // Search title and description
    if (args.search) {
      conditions.push(
        `(data->>'title' ILIKE $${paramIdx} OR data->>'description' ILIKE $${paramIdx} OR issue_key ILIKE $${paramIdx} OR CAST(issue_number AS TEXT) ILIKE $${paramIdx})`
      );
      params.push(`%${args.search}%`);
      paramIdx++;
    }

    const limit = Math.min(args.limit || 50, 250);
    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

    const result = await db.query<any>(
      `SELECT id, issue_number, issue_key, type, type_tags, data, archived, source, source_ref, updated, sync_status
       FROM tracker_items
       ${whereClause}
       ORDER BY updated DESC
       LIMIT ${limit}`,
      params
    );

    const items = result.rows.map((row: any) => {
      const data =
        typeof row.data === "string"
          ? JSON.parse(row.data)
          : row.data || {};
      const typeTags: string[] = row.type_tags && row.type_tags.length > 0
        ? row.type_tags
        : [row.type];
      return {
        id: row.id,
        issueNumber: row.issue_number ?? undefined,
        issueKey: row.issue_key ?? undefined,
        type: row.type,
        typeTags,
        title: data.title || "",
        status: data.status || "",
        priority: data.priority || "",
        tags: data.tags || [],
        archived: row.archived ?? false,
        source: row.source || "native",
        syncStatus: row.sync_status || "local",
        updated: row.updated,
      };
    });

    const summary = items
      .map(
        (item: any) =>
          `- [${item.type}] ${item.title} (${item.status || "no status"}, ${item.priority || "no priority"}, ${item.syncStatus}) [ref: ${item.issueKey || item.id}]`
      )
      .join("\n");

    const filters: Record<string, string> = {};
    if (args.type) filters.type = args.type;
    if (args.typeTag) filters.typeTag = args.typeTag;
    if (args.status) filters.status = args.status;
    if (args.priority) filters.priority = args.priority;
    if (args.owner) filters.owner = args.owner;
    if (args.search) filters.search = args.search;

    const structured = {
      action: "listed" as const,
      filters,
      count: items.length,
      items: items.map((item: any) => ({
        id: item.id,
        issueNumber: item.issueNumber,
        issueKey: item.issueKey,
        type: item.type,
        typeTags: item.typeTags,
        title: item.title,
        status: item.status,
        priority: item.priority,
      })),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured,
            summary: items.length > 0
              ? `Found ${items.length} tracker item(s):\n\n${summary}`
              : "No tracker items found matching the filters.",
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    console.error("[MCP Server] tracker_list failed:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error listing tracker items: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleTrackerListTypes(
  args: any,
): Promise<McpToolResult> {
  try {
    const includeBuiltin = args?.includeBuiltin !== false;
    const includeCustom = args?.includeCustom !== false;
    const search = typeof args?.search === 'string' ? args.search.trim().toLowerCase() : '';

    const items = getAllTrackerSchemas()
      .filter((model) => {
        const builtin = isBuiltinTrackerSchema(model.type);
        if (builtin && !includeBuiltin) return false;
        if (!builtin && !includeCustom) return false;
        if (!search) return true;
        return model.type.toLowerCase().includes(search)
          || model.displayName.toLowerCase().includes(search)
          || model.displayNamePlural.toLowerCase().includes(search);
      })
      .sort((a, b) => a.type.localeCompare(b.type));

    const structured = {
      action: "listed-types" as const,
      count: items.length,
      items: items.map((model) => ({
        ...model,
        builtin: isBuiltinTrackerSchema(model.type),
      })),
    };

    const summary = items.length > 0
      ? items.map((model) => {
          const builtin = isBuiltinTrackerSchema(model.type) ? 'builtin' : 'custom';
          return `- ${model.type} (${builtin}, ${model.fields.length} fields)`;
        }).join('\n')
      : 'No tracker types found matching the filters.';

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured,
            summary,
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error listing tracker types: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleTrackerDefineType(
  args: any,
  workspacePath: string | undefined,
): Promise<McpToolResult> {
  try {
    if (!workspacePath) {
      return {
        content: [{ type: "text", text: "Error: No workspace path available. Cannot define tracker type." }],
        isError: true,
      };
    }

    const schema = buildTrackerSchemaFromArgs(args);
    if (typeof schema.type === 'string' && isBuiltinTrackerSchema(schema.type)) {
      return {
        content: [
          {
            type: "text",
            text: `Cannot redefine built-in tracker type '${schema.type}'. Use a new custom type instead.`,
          },
        ],
        isError: true,
      };
    }
    const { model, filePath } = await upsertWorkspaceTrackerSchema(workspacePath, schema, {
      fileName: args?.fileName,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured: {
              action: "defined-type" as const,
              type: model.type,
              model,
              fileName: path.basename(filePath),
            },
            summary: `Defined tracker type '${model.type}' in .nimbalyst/trackers/${path.basename(filePath)}.`,
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error defining tracker type: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleTrackerDeleteType(
  args: any,
  workspacePath: string | undefined,
): Promise<McpToolResult> {
  try {
    if (!workspacePath) {
      return {
        content: [{ type: "text", text: "Error: No workspace path available. Cannot delete tracker type." }],
        isError: true,
      };
    }

    if (typeof args.type !== 'string' || args.type.trim().length === 0) {
      return {
        content: [{ type: "text", text: "Error: tracker_delete_type requires a tracker type." }],
        isError: true,
      };
    }

    if (isBuiltinTrackerSchema(args.type)) {
      return {
        content: [{ type: "text", text: `Cannot delete built-in tracker type '${args.type}'.` }],
        isError: true,
      };
    }

    const { getDatabase } = await import("../../database/initialize");
    const db = getDatabase();
    const usage = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count
       FROM tracker_items
       WHERE workspace = $1
         AND (type = $2 OR $2 = ANY(type_tags))`,
      [workspacePath, args.type]
    );
    const count = Number(usage.rows[0]?.count ?? 0);
    if (count > 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `Cannot delete tracker type '${args.type}': ${count} tracker item` +
              `${count === 1 ? '' : 's'} still reference this type.`,
          },
        ],
        isError: true,
      };
    }

    const result = await deleteWorkspaceTrackerSchema(workspacePath, args.type);
    if (!result.deleted) {
      return {
        content: [
          {
            type: "text",
            text: `Custom tracker schema not found for type '${args.type}'.`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured: {
              action: "deleted-type" as const,
              type: args.type,
              fileName: result.filePath ? path.basename(result.filePath) : undefined,
            },
            summary:
              `Deleted tracker type '${args.type}' from .nimbalyst/trackers/` +
              `${result.filePath ? path.basename(result.filePath) : ''}.`,
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error deleting tracker type: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleTrackerGet(
  args: any,
  workspacePath?: string,
): Promise<McpToolResult> {
  try {
    const { getDatabase } = await import("../../database/initialize");
    const db = getDatabase();

    const row = await resolveTrackerRowByReference(db, args.id, workspacePath);
    if (!row) {
      return {
        content: [
          {
            type: "text",
            text: `Tracker item not found: ${args.id}`,
          },
        ],
        isError: true,
      };
    }

    const data =
      typeof row.data === "string"
        ? JSON.parse(row.data)
        : row.data || {};

    // Build a readable representation
    const lines: string[] = [];
    lines.push(`# ${data.title || "Untitled"}`);
    lines.push("");
    lines.push(`**Type**: ${row.type}`);
    if (row.issue_key) lines.push(`**Issue Key**: ${row.issue_key}`);
    if (data.status) lines.push(`**Status**: ${data.status}`);
    if (data.priority) lines.push(`**Priority**: ${data.priority}`);
    if (data.tags?.length)
      lines.push(`**Tags**: ${data.tags.join(", ")}`);
    if (data.owner) lines.push(`**Owner**: ${data.owner}`);
    if (data.dueDate) lines.push(`**Due Date**: ${data.dueDate}`);
    if (data.progress !== undefined) lines.push(`**Progress**: ${data.progress}%`);
    if (data.assigneeId) lines.push(`**Assignee**: ${data.assigneeId}`);
    if (data.reporterId) lines.push(`**Reporter**: ${data.reporterId}`);
    if (data.labels?.length) lines.push(`**Labels**: ${data.labels.join(", ")}`);
    if (data.linkedCommitSha) lines.push(`**Linked Commit**: ${data.linkedCommitSha}`);
    if (row.sync_status) lines.push(`**Sync Status**: ${row.sync_status}`);
    if (row.archived) lines.push(`**Archived**: yes`);
    if (row.source && row.source !== "native")
      lines.push(
        `**Source**: ${row.source}${row.source_ref ? ` (${row.source_ref})` : ""}`
      );
    if (data.linkedSessions?.length)
      lines.push(
        `**Linked Sessions**: ${data.linkedSessions.join(", ")}`
      );
    lines.push(`**ID**: ${row.id}`);
    lines.push(`**Updated**: ${row.updated}`);
    lines.push("");

    // Include content as markdown
    if (row.content) {
      const content =
        typeof row.content === "string"
          ? row.content
          : JSON.stringify(row.content);
      lines.push("---");
      lines.push("");
      lines.push(content);
    } else if (data.description) {
      lines.push("---");
      lines.push("");
      lines.push(data.description);
    }

    const typeTags: string[] = row.type_tags && row.type_tags.length > 0
      ? row.type_tags
      : [row.type];

    const structured = {
      action: "retrieved" as const,
      item: {
        id: row.id,
        issueNumber: row.issue_number ?? undefined,
        issueKey: row.issue_key ?? undefined,
        type: row.type,
        typeTags,
        title: data.title || "Untitled",
        status: data.status || undefined,
        priority: data.priority || undefined,
        tags: data.tags || [],
        owner: data.owner || undefined,
        dueDate: data.dueDate || undefined,
      },
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured,
            summary: lines.join("\n"),
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    console.error("[MCP Server] tracker_get failed:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error getting tracker item: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleTrackerCreate(
  args: any,
  workspacePath: string | undefined,
  sessionId?: string | undefined
): Promise<McpToolResult> {
  try {
    const { getDatabase } = await import("../../database/initialize");
    const db = getDatabase();

    if (!workspacePath) {
      return {
        content: [
          {
            type: "text",
            text: "Error: No workspace path available. Cannot create tracker item.",
          },
        ],
        isError: true,
      };
    }

    // Check if this type allows creation
    const model = globalRegistry.get(args.type);
    if (model && model.creatable === false) {
      return {
        content: [
          {
            type: "text",
            text: `Cannot create items of type '${args.type}' via tracker_create. ${args.type === 'automation' ? 'Use the automations.create tool instead.' : 'This type is read-only.'}`,
          },
        ],
        isError: true,
      };
    }

    // Resolve current user identity for authorship
    // getCurrentIdentity imported statically at top of file
    const authorIdentity = getCurrentIdentity(workspacePath);
    const syncPolicy = workspacePath
      ? getEffectiveTrackerSyncPolicy(workspacePath, args.type, model?.sync?.mode)
      : { mode: 'local' as const, scope: 'project' as const };
    const syncStatus = getInitialTrackerSyncStatus(syncPolicy);

    const id = `${args.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Resolve field names via schema roles so that fixed MCP args
    // (title, status, priority, etc.) are placed at the correct field name
    // for the target schema. E.g., a schema with roles: { title: 'name' }
    // will store args.title in data.name.
    const rf = (role: string, fallback: string) => getTrackerRoleField(args.type, role as any) ?? fallback;
    const titleField = rf('title', 'title');
    const statusField = rf('workflowStatus', 'status');
    const priorityField = rf('priority', 'priority');

    const data: Record<string, any> = {
      [titleField]: args.title,
      [statusField]: args.status || "to-do",
      [priorityField]: args.priority || "medium",
      created: new Date().toISOString().split("T")[0],
      authorIdentity,
      createdByAgent: true,
    };
    if (Array.isArray(args.tags) && args.tags.length) data[rf('tags', 'tags')] = args.tags;
    if (args.description) data.description = args.description.replace(/\\n/g, '\n');
    if (args.owner) data[rf('assignee', 'owner')] = args.owner;
    if (args.dueDate) data[rf('dueDate', 'dueDate')] = args.dueDate;
    if (args.progress !== undefined) data[rf('progress', 'progress')] = args.progress;
    if (args.assigneeEmail) {
      // Write to both the assignee role field and the explicit assigneeEmail field
      // so the "Mine" filter (which checks the assignee role) can find it
      if (!args.owner) data[rf('assignee', 'owner')] = args.assigneeEmail;
      data.assigneeEmail = args.assigneeEmail;
    }
    if (args.reporterEmail) data[rf('reporter', 'reporterEmail')] = args.reporterEmail;
    if (args.labels?.length) data.labels = args.labels;
    if (args.linkedCommitSha) data.linkedCommitSha = args.linkedCommitSha;

    // Merge generic fields bag (overrides role-resolved args above)
    if (args.fields && typeof args.fields === 'object') {
      for (const [key, value] of Object.entries(args.fields)) {
        if (value !== undefined) {
          data[key] = value;
        }
      }
    }

    const validationResult = globalRegistry.validate(args.type, data);
    if (!validationResult.valid) {
      return buildTrackerSchemaValidationError('tracker_create', args.type, validationResult.errors);
    }

    // Record creation activity
    appendActivity(data, authorIdentity, 'created');

    // Build type_tags: always includes primary type + any additional tags
    const typeTags: string[] = [args.type];
    if (args.typeTags?.length) {
      for (const tag of args.typeTags) {
        if (!typeTags.includes(tag)) typeTags.push(tag);
      }
    }

    // Normalize literal \n sequences to real newlines (MCP tool args may contain escaped sequences)
    const descriptionText = args.description
      ? args.description.replace(/\\n/g, '\n')
      : null;
    const contentJson = descriptionText
      ? JSON.stringify(descriptionText)
      : null;

    await db.query(
      `INSERT INTO tracker_items (
        id, type, type_tags, data, workspace, document_path, line_number,
        created, updated, last_indexed, sync_status,
        content, archived, source, source_ref
      ) VALUES ($1, $2, $3, $4, $5, '', NULL, NOW(), NOW(), NOW(), $6, $7, FALSE, 'native', NULL)`,
      [id, args.type, typeTags, JSON.stringify(data), workspacePath, syncStatus, contentJson]
    );

    let createdRow = await resolveTrackerRowByReference(db, id, workspacePath);
    let createdItem = createdRow ? rowToTrackerItem(createdRow) : null;

    if (
      createdItem &&
      workspacePath &&
      shouldSyncTrackerPolicy(syncPolicy) &&
      isTrackerSyncActive(workspacePath)
    ) {
      try {
        await syncTrackerItem(createdItem);
        createdRow = await resolveTrackerRowByReference(db, id, workspacePath);
        createdItem = createdRow ? rowToTrackerItem(createdRow) : createdItem;
      } catch (syncError) {
        console.error('[MCP Server] tracker_create sync failed:', syncError);
      }
    }

    // Allocate a local issue key if sync didn't assign one
    if (createdRow && !createdRow.issue_key) {
      try {
        const prefix = workspacePath
          ? (getWorkspaceState(workspacePath).issueKeyPrefix || 'NIM')
          : 'NIM';
        const maxResult = await db.query<{ max_num: number | null }>(
          `SELECT MAX(issue_number) as max_num FROM tracker_items WHERE workspace = $1`,
          [workspacePath || '']
        );
        const nextNum = (maxResult.rows[0]?.max_num ?? 0) + 1;
        const issueKey = `${prefix}-${nextNum}`;
        await db.query(
          `UPDATE tracker_items SET issue_number = $1, issue_key = $2 WHERE id = $3`,
          [nextNum, issueKey, id]
        );
        createdRow = await resolveTrackerRowByReference(db, id, workspacePath);
        createdItem = createdRow ? rowToTrackerItem(createdRow) : createdItem;
      } catch (issueKeyError) {
        console.error('[MCP Server] Local issue key allocation failed:', issueKeyError);
      }
    }

    // Link the current session only when explicitly requested.
    // Why: auto-linking on every create polluted sessions with unrelated tracker
    // items (the agent often creates a tracker item as a side effect, not as the
    // session's subject). Linking is now opt-in via args.linkSession; agents that
    // really do want a link can pass linkSession: true or call tracker_link_session.
    if (sessionId && args.linkSession === true) {
      await createBidirectionalLink(id, sessionId);
      const sessionResult = await db.query<any>(
        `SELECT metadata FROM ai_sessions WHERE id = $1`,
        [sessionId]
      );
      const linkedIds = sessionResult.rows[0]?.metadata?.linkedTrackerItemIds || [];
      await notifySessionLinkedTrackerChanged(sessionId, linkedIds);
    }

    // Notify renderer of the new item (correct channel + event format)
    await notifyTrackerItemAdded(workspacePath, id);

    const structured = {
      action: "created" as const,
      item: {
        id,
        issueNumber: createdItem?.issueNumber,
        issueKey: createdItem?.issueKey,
        type: args.type,
        typeTags,
        title: data[titleField],
        status: data[statusField],
        priority: data[priorityField],
        tags: data.tags || [],
      },
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured,
            summary: `Created tracker item:\n- **Type**: ${args.type}\n- **Title**: ${data[titleField]}\n- **Status**: ${data[statusField]}\n- **Ref**: ${getTrackerDisplayRef(createdItem || { id })}\n- **ID**: ${id}`,
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    console.error("[MCP Server] tracker_create failed:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error creating tracker item: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleTrackerUpdate(
  args: any,
  workspacePath: string | undefined,
  sessionId?: string | undefined
): Promise<McpToolResult> {
  try {
    const { getDatabase } = await import("../../database/initialize");
    const db = getDatabase();

    // Read existing item
    const row = await resolveTrackerRowByReference(db, args.id, workspacePath);
    if (!row) {
      return {
        content: [
          {
            type: "text",
            text: `Tracker item not found: ${args.id}`,
          },
        ],
        isError: true,
      };
    }

    const data =
      typeof row.data === "string"
        ? JSON.parse(row.data)
        : row.data || {};

    // Stamp lastModifiedBy with current identity
    // getCurrentIdentity imported statically at top of file
    data.lastModifiedBy = getCurrentIdentity(workspacePath);

    // For collaborative tracker items the rich body lives in a Yjs document
    // (`tracker-content/{itemId}` collab room), not in PGLite. Writing the
    // description straight into PGLite would silently lose the edit when the
    // renderer's next debounced save serialises the unchanged Y.Doc back over
    // it (NIM-436). Refuse the description write and surface a structured
    // skip so the caller can decide what to do (e.g., post a comment, or ask
    // the user to make the body edit interactively). All other field updates
    // (status, priority, etc.) still flow through normally because they sync
    // via the tracker JSONB / field-level LWW path, not Y.Doc.
    const itemModel = globalRegistry.get(row.type);
    const bodyIsCollab = isTrackerItemBodyCollaborative(
      workspacePath,
      row.type,
      row.source ?? null,
      row.document_path ?? null,
      itemModel?.sync?.mode,
    );
    let descriptionSkipped: { reason: string } | null = null;
    if (bodyIsCollab && args.description !== undefined) {
      descriptionSkipped = {
        reason:
          "This tracker item's body lives in a collaborative Y.Doc, not the local database. " +
          "Writing the description through MCP would be silently overwritten by the next " +
          "renderer save. Skip-applied; use tracker_add_comment, or have the user edit the " +
          "body in the tracker detail panel instead.",
      };
      delete args.description;
    }

    // Resolve role-based field names for the item's type
    const rf = (role: string, fallback: string) => getTrackerRoleField(row.type, role as any) ?? fallback;

    // Map fixed MCP args to role-resolved field names, then merge into data
    const roleMap: Array<[string, string, string]> = [
      // [argName, role, fallbackFieldName]
      ['title', 'title', 'title'],
      ['status', 'workflowStatus', 'status'],
      ['priority', 'priority', 'priority'],
      ['tags', 'tags', 'tags'],
      ['owner', 'assignee', 'owner'],
      ['dueDate', 'dueDate', 'dueDate'],
      ['progress', 'progress', 'progress'],
      ['reporterEmail', 'reporter', 'reporterEmail'],
    ];

    const changes: Record<string, { from: any; to: any }> = {};

    if (args.tags !== undefined && !Array.isArray(args.tags)) {
      args.tags = [];
    }

    for (const [argName, role, fallback] of roleMap) {
      if (args[argName] !== undefined) {
        const fieldName = rf(role, fallback);
        const oldVal = data[fieldName];
        changes[fieldName] = { from: oldVal, to: args[argName] };
        data[fieldName] = args[argName];
      }
    }

    // assigneeEmail: write to both the assignee role field and the explicit field
    if (args.assigneeEmail !== undefined) {
      data.assigneeEmail = args.assigneeEmail;
      if (args.owner === undefined) {
        const ownerField = rf('assignee', 'owner');
        changes[ownerField] = { from: data[ownerField], to: args.assigneeEmail };
        data[ownerField] = args.assigneeEmail;
      }
    }

    // Non-role fields (system metadata)
    if (args.description !== undefined) {
      const normalizedDesc = args.description.replace(/\\n/g, '\n');
      changes.description = { from: data.description, to: normalizedDesc };
      data.description = normalizedDesc;
    }
    if (args.labels !== undefined) { data.labels = args.labels; }
    if (args.linkedCommitSha !== undefined) { data.linkedCommitSha = args.linkedCommitSha; }

    // Archived is a top-level DB column, not a JSONB field
    if (args.archived !== undefined) {
      changes.archived = { from: row.archived ?? false, to: args.archived };
    }

    // Merge generic fields bag (overrides role-resolved args above)
    if (args.fields && typeof args.fields === 'object') {
      for (const [key, value] of Object.entries(args.fields)) {
        if (value === undefined) continue;
        // Same Y.Doc-vs-PGLite hazard as args.description above: a generic
        // `fields.description` write on a collab item would create a divergent
        // JSONB snapshot that the renderer never picks up. Skip it here so
        // there is no path -- explicit arg or generic bag -- that bypasses
        // the collab body authority.
        if (bodyIsCollab && key === 'description') {
          if (!descriptionSkipped) {
            descriptionSkipped = {
              reason:
                "This tracker item's body lives in a collaborative Y.Doc, not the local database. " +
                "Writing the description through MCP would be silently overwritten by the next " +
                "renderer save. Skip-applied; use tracker_add_comment, or have the user edit the " +
                "body in the tracker detail panel instead.",
            };
          }
          continue;
        }
        const oldVal = data[key];
        if (oldVal !== value) {
          changes[key] = { from: oldVal, to: value };
        }
        data[key] = value;
      }
    }

    // Remove fields specified in unsetFields
    if (args.unsetFields && Array.isArray(args.unsetFields)) {
      for (const key of args.unsetFields) {
        if (data[key] !== undefined) {
          changes[key] = { from: data[key], to: undefined };
          delete data[key];
        }
      }
    }

    const validationResult = globalRegistry.validate(row.type, data);
    if (!validationResult.valid) {
      return buildTrackerSchemaValidationError('tracker_update', row.type, validationResult.errors);
    }

    // Record activity for each changed field
    const modifierIdentity = getCurrentIdentity(workspacePath);
    for (const [field, change] of Object.entries(changes)) {
      const action = field === 'status' ? 'status_changed'
        : field === 'archived' ? 'archived'
        : 'updated';
      appendActivity(data, modifierIdentity, action, {
        field,
        oldValue: change.from != null ? String(change.from) : undefined,
        newValue: change.to != null ? String(change.to) : undefined,
      });
    }

    // Update type_tags if provided
    if (args.typeTags !== undefined) {
      // Ensure primary type is always in the array
      const newTypeTags: string[] = [row.type];
      for (const tag of args.typeTags) {
        if (!newTypeTags.includes(tag)) newTypeTags.push(tag);
      }
      await db.query(
        `UPDATE tracker_items SET type_tags = $1 WHERE id = $2`,
        [newTypeTags, row.id]
      );
    }

    // Update data field
    await db.query(
      `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
      [JSON.stringify(data), row.id]
    );

    // Update content if description changed
    if (args.description !== undefined) {
      const normalizedContent = args.description.replace(/\\n/g, '\n');
      const contentJson = JSON.stringify(normalizedContent);
      await db.query(
        `UPDATE tracker_items SET content = $1 WHERE id = $2`,
        [contentJson, row.id]
      );
    }

    // Handle archive state -- use document service for file writeback
    if (args.archived !== undefined) {
      const { documentServices } = await import("../../window/WindowManager");
      const docService = workspacePath ? documentServices.get(workspacePath) : undefined;
      if (docService) {
        await docService.archiveTrackerItem(row.id, args.archived);
      } else {
        // Fallback: DB-only update if no document service available
        await db.query(
          `UPDATE tracker_items SET archived = $1, archived_at = $2 WHERE id = $3`,
          [
            args.archived,
            args.archived ? new Date().toISOString() : null,
            row.id,
          ]
        );
      }
    }

    // Auto-link session to the updated tracker item
    if (sessionId) {
      const linked = await createBidirectionalLink(row.id, sessionId);
      if (linked) {
        const sessionResult = await db.query<any>(
          `SELECT metadata FROM ai_sessions WHERE id = $1`,
          [sessionId]
        );
        const linkedIds = sessionResult.rows[0]?.metadata?.linkedTrackerItemIds || [];
        await notifySessionLinkedTrackerChanged(sessionId, linkedIds);
      }
    }

    // Notify renderer (correct channel + event format)
    await notifyTrackerItemUpdated(workspacePath, row.id);

    const refreshedRow = await resolveTrackerRowByReference(db, row.id, workspacePath);
    const effectiveWorkspacePath = refreshedRow?.workspace || workspacePath;
    if (refreshedRow && effectiveWorkspacePath) {
      const updateModel = globalRegistry.get(refreshedRow.type);
      const syncPolicy = getEffectiveTrackerSyncPolicy(effectiveWorkspacePath, refreshedRow.type, updateModel?.sync?.mode);
      if (shouldSyncTrackerPolicy(syncPolicy)) {
        if (isTrackerSyncActive(effectiveWorkspacePath)) {
          try {
            await syncTrackerItem(rowToTrackerItem(refreshedRow));
          } catch (syncError) {
            console.error('[MCP Server] tracker_update sync failed:', syncError);
          }
        } else {
          await db.query(
            `UPDATE tracker_items SET sync_status = 'pending' WHERE id = $1`,
            [row.id]
          );
        }
      }
    }
    const postSyncRow = await resolveTrackerRowByReference(db, row.id, workspacePath);

    const updateSummaryParts: string[] = [];
    if (args.title !== undefined) updateSummaryParts.push(`- **Title**: ${args.title}`);
    if (args.status !== undefined) updateSummaryParts.push(`- **Status**: ${args.status}`);
    if (args.priority !== undefined) updateSummaryParts.push(`- **Priority**: ${args.priority}`);
    if (args.archived !== undefined) updateSummaryParts.push(`- **Archived**: ${args.archived}`);
    if (args.tags !== undefined) updateSummaryParts.push(`- **Tags**: ${args.tags.join(", ")}`);

    // Re-read type_tags after potential update
    const updatedRow = await db.query<any>(
      `SELECT type_tags FROM tracker_items WHERE id = $1`,
      [row.id]
    );
    const currentTypeTags: string[] = updatedRow.rows[0]?.type_tags?.length > 0
      ? updatedRow.rows[0].type_tags
      : [row.type];

    const structured: Record<string, any> = {
      action: "updated" as const,
      id: row.id,
      issueNumber: postSyncRow?.issue_number ?? refreshedRow?.issue_number ?? row.issue_number ?? undefined,
      issueKey: postSyncRow?.issue_key ?? refreshedRow?.issue_key ?? row.issue_key ?? undefined,
      type: row.type,
      typeTags: currentTypeTags,
      title: data[rf('title', 'title')],
      changes,
    };
    if (descriptionSkipped) {
      structured.skippedFields = { description: descriptionSkipped.reason };
    }

    const summaryLines = [
      `Updated tracker item ${getTrackerDisplayRef({ id: row.id, issueKey: postSyncRow?.issue_key ?? refreshedRow?.issue_key ?? row.issue_key ?? undefined })}:`,
      ...updateSummaryParts,
    ];
    if (descriptionSkipped) {
      summaryLines.push(`- **Description**: NOT applied -- ${descriptionSkipped.reason}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured,
            summary: summaryLines.join("\n"),
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    console.error("[MCP Server] tracker_update failed:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error updating tracker item: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleTrackerLinkSession(
  args: any,
  sessionId: string | undefined,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  try {
    // Prefer an explicit target sessionId from the caller; fall back to the
    // ambient AI session this tool is being invoked from.
    // Why: agents often need to link a tracker item to a session other than
    // the current one (e.g., a session surfaced by tracker_get). The IPC layer
    // already supports this; the MCP tool needs to expose it.
    const targetSessionId =
      typeof args.sessionId === "string" && args.sessionId.length > 0
        ? args.sessionId
        : sessionId;

    if (!targetSessionId) {
      return {
        content: [
          {
            type: "text",
            text: "Error: No session ID available. Pass sessionId or invoke this tool during an active AI session.",
          },
        ],
        isError: true,
      };
    }

    const { getDatabase } = await import("../../database/initialize");
    const db = getDatabase();

    // Verify tracker item exists
    const existing = await resolveTrackerRowByReference(db, args.trackerId, workspacePath);
    if (!existing) {
      return {
        content: [
          {
            type: "text",
            text: `Tracker item not found: ${args.trackerId}`,
          },
        ],
        isError: true,
      };
    }

    // When the caller specified an explicit sessionId, verify it exists so we
    // fail loudly instead of silently no-op'ing the session-side write.
    if (typeof args.sessionId === "string" && args.sessionId.length > 0) {
      const sessionExists = await db.query<any>(
        `SELECT 1 FROM ai_sessions WHERE id = $1`,
        [targetSessionId]
      );
      if (sessionExists.rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Session not found: ${targetSessionId}`,
            },
          ],
          isError: true,
        };
      }
    }

    // Create bidirectional link
    await createBidirectionalLink(existing.id, targetSessionId);

    // Get updated counts for the response
    const trackerResult = await db.query<any>(
      `SELECT data FROM tracker_items WHERE id = $1`,
      [existing.id]
    );
    const trackerData = typeof trackerResult.rows[0]?.data === "string"
      ? JSON.parse(trackerResult.rows[0].data)
      : trackerResult.rows[0]?.data || {};
    const linkedSessions: string[] = trackerData.linkedSessions || [];

    // Notify renderer of both changes (correct channel + event format)
    await notifyTrackerItemUpdated(workspacePath, existing.id);
    const sessionResult = await db.query<any>(
      `SELECT metadata FROM ai_sessions WHERE id = $1`,
      [targetSessionId]
    );
    const linkedIds = sessionResult.rows[0]?.metadata?.linkedTrackerItemIds || [];
    await notifySessionLinkedTrackerChanged(targetSessionId, linkedIds);

    const structured = {
      action: "linked" as const,
      trackerId: existing.id,
      issueNumber: existing.issue_number ?? undefined,
      issueKey: existing.issue_key ?? undefined,
      type: existing.type || "",
      title: trackerData.title || "",
      linkedCount: linkedSessions.length,
      sessionId: targetSessionId,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured,
            summary: `Linked session ${targetSessionId} to tracker item ${getTrackerDisplayRef({ id: existing.id, issueKey: existing.issue_key ?? undefined })}. Total linked sessions: ${linkedSessions.length}`,
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    console.error(
      "[MCP Server] tracker_link_session failed:",
      error
    );
    return {
      content: [
        {
          type: "text",
          text: `Error linking session: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleTrackerUnlinkSession(
  args: any,
  sessionId: string | undefined,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  try {
    const targetSessionId =
      typeof args.sessionId === "string" && args.sessionId.length > 0
        ? args.sessionId
        : sessionId;

    if (!targetSessionId) {
      return {
        content: [
          {
            type: "text",
            text: "Error: No session ID available. Pass sessionId or invoke this tool during an active AI session.",
          },
        ],
        isError: true,
      };
    }

    const { getDatabase } = await import("../../database/initialize");
    const db = getDatabase();

    const existing = await resolveTrackerRowByReference(db, args.trackerId, workspacePath);
    if (!existing) {
      return {
        content: [
          {
            type: "text",
            text: `Tracker item not found: ${args.trackerId}`,
          },
        ],
        isError: true,
      };
    }

    const removed = await removeBidirectionalLink(existing.id, targetSessionId);

    const trackerResult = await db.query<any>(
      `SELECT data FROM tracker_items WHERE id = $1`,
      [existing.id]
    );
    const trackerData = typeof trackerResult.rows[0]?.data === "string"
      ? JSON.parse(trackerResult.rows[0].data)
      : trackerResult.rows[0]?.data || {};
    const linkedSessions: string[] = trackerData.linkedSessions || [];

    await notifyTrackerItemUpdated(workspacePath, existing.id);
    const sessionResult = await db.query<any>(
      `SELECT metadata FROM ai_sessions WHERE id = $1`,
      [targetSessionId]
    );
    if (sessionResult.rows.length > 0) {
      const linkedIds = sessionResult.rows[0]?.metadata?.linkedTrackerItemIds || [];
      await notifySessionLinkedTrackerChanged(targetSessionId, linkedIds);
    }

    const structured = {
      action: "unlinked" as const,
      trackerId: existing.id,
      issueNumber: existing.issue_number ?? undefined,
      issueKey: existing.issue_key ?? undefined,
      type: existing.type || "",
      title: trackerData.title || "",
      linkedCount: linkedSessions.length,
      sessionId: targetSessionId,
      removed,
    };

    const displayRef = getTrackerDisplayRef({ id: existing.id, issueKey: existing.issue_key ?? undefined });
    const summary = removed
      ? `Unlinked session ${targetSessionId} from tracker item ${displayRef}. Total linked sessions: ${linkedSessions.length}`
      : `Session ${targetSessionId} was not linked to tracker item ${displayRef}. Total linked sessions: ${linkedSessions.length}`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured,
            summary,
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    console.error(
      "[MCP Server] tracker_unlink_session failed:",
      error
    );
    return {
      content: [
        {
          type: "text",
          text: `Error unlinking session: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleTrackerLinkFile(
  args: any,
  sessionId: string | undefined,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  try {
    if (!sessionId) {
      return {
        content: [
          {
            type: "text",
            text: "Error: No session ID available. This tool is only available during an active AI session.",
          },
        ],
        isError: true,
      };
    }

    const { getDatabase } = await import("../../database/initialize");
    const db = getDatabase();

    // Use "file:" prefix to distinguish from tracker item IDs
    const fileRef = `file:${args.filePath}`;

    // Add file reference to session's metadata.linkedTrackerItemIds
    const sessionResult = await db.query<any>(
      `SELECT metadata FROM ai_sessions WHERE id = $1`,
      [sessionId]
    );
    if (sessionResult.rows.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Session not found: ${sessionId}`,
          },
        ],
        isError: true,
      };
    }

    const metadata = sessionResult.rows[0].metadata ?? {};
    const linkedTrackerItemIds: string[] = metadata.linkedTrackerItemIds || [];
    if (!linkedTrackerItemIds.includes(fileRef)) {
      linkedTrackerItemIds.push(fileRef);
      await db.query(
        `UPDATE ai_sessions SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ linkedTrackerItemIds }), sessionId]
      );
    }

    // Notify renderer
    await notifySessionLinkedTrackerChanged(sessionId, linkedTrackerItemIds);

    const structured = {
      action: "linked_file" as const,
      filePath: args.filePath,
      linkedCount: linkedTrackerItemIds.length,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured,
            summary: `Linked file "${args.filePath}" to this session. Total linked items: ${linkedTrackerItemIds.length}`,
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    console.error("[MCP Server] tracker_link_file failed:", error);
    return {
      content: [
        {
          type: "text",
          text: `Error linking file: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export async function handleTrackerAddComment(
  args: any,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  try {
    const { getDatabase } = await import("../../database/initialize");
    const db = getDatabase();

    // Read existing item
    const row = await resolveTrackerRowByReference(db, args.trackerId, workspacePath);
    if (!row) {
      return {
        content: [{ type: "text", text: `Tracker item not found: ${args.trackerId}` }],
        isError: true,
      };
    }

    const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data || {};

    // Resolve current identity for the comment
    // getCurrentIdentity imported statically at top of file
    const authorIdentity = getCurrentIdentity(workspacePath);

    // Add comment to the comments array
    const comments = data.comments || [];
    const commentId = `comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const newComment = {
      id: commentId,
      authorIdentity,
      body: args.body,
      createdAt: Date.now(),
      updatedAt: null,
      deleted: false,
    };
    comments.push(newComment);
    data.comments = comments;

    // Also stamp lastModifiedBy and record activity
    data.lastModifiedBy = authorIdentity;
    appendActivity(data, authorIdentity, 'commented');

    // Stamp field-level LWW timestamp for sync conflict resolution
    const fieldUpdatedAt = data._fieldUpdatedAt || {};
    fieldUpdatedAt.comments = Date.now();
    data._fieldUpdatedAt = fieldUpdatedAt;

    await db.query(
      `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
      [JSON.stringify(data), row.id]
    );

    // Notify renderer
    await notifyTrackerItemUpdated(workspacePath, row.id);

    // Trigger sync
    try {
      if (workspacePath) {
        const syncPolicy = getEffectiveTrackerSyncPolicy(workspacePath, row.type);
        if (shouldSyncTrackerPolicy(syncPolicy)) {
          if (isTrackerSyncActive(workspacePath)) {
            const refreshed = await db.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [row.id]);
            if (refreshed.rows.length > 0) {
              await syncTrackerItem(rowToTrackerItem(refreshed.rows[0]));
            }
          } else {
            await db.query(`UPDATE tracker_items SET sync_status = 'pending' WHERE id = $1`, [row.id]);
          }
        }
      }
    } catch (syncErr) {
      console.error('[MCP Server] tracker_add_comment sync failed:', syncErr);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured: {
              action: "commented" as const,
              trackerId: row.id,
              issueNumber: row.issue_number ?? undefined,
              issueKey: row.issue_key ?? undefined,
              commentId,
              author: authorIdentity.displayName,
            },
            summary: `Added comment to ${getTrackerDisplayRef({ id: row.id, issueKey: row.issue_key ?? undefined })} by ${authorIdentity.displayName}`,
          }),
        },
      ],
      isError: false,
    };
  } catch (error) {
    console.error("[MCP Server] tracker_add_comment failed:", error);
    return {
      content: [{ type: "text", text: `Error adding comment: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}
