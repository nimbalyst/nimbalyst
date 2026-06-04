import * as path from 'path';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import type { TrackerItem } from '@nimbalyst/runtime';
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
import { applyHeadlessBodyMarkdown } from '../../services/MainBodyDocService';
import { getWorkspaceState } from '../../utils/store';
import { getVisibleTrackerLinkedSessions, shouldPersistTrackerLinkedSessions } from '../../../shared/trackerSessionLinks';
import {
  buildFullDocumentTrackerId,
  parseFullDocumentTrackerId,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterUtils';
import { normalizeLegacyLabelValues } from '@nimbalyst/runtime/sync';
import type { ElectronDocumentService } from '../../services/ElectronDocumentService';

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

  if (result.rows[0]) {
    return result.rows[0];
  }

  const parsed = parseFullDocumentTrackerId(reference);
  if (!parsed) {
    return null;
  }

  const frontmatterParams: any[] = [parsed.relativePath, parsed.trackerType];
  const frontmatterWorkspaceClause = workspacePath ? ` AND workspace = $3` : '';
  if (workspacePath) frontmatterParams.push(workspacePath);
  const frontmatterResult = await db.query<any>(
    `SELECT *
     FROM tracker_items
     WHERE source = 'frontmatter'
       AND source_ref = $1
       AND type = $2${frontmatterWorkspaceClause}
     ORDER BY updated DESC
     LIMIT 1`,
    frontmatterParams
  );

  return frontmatterResult.rows[0] || null;
}

async function getDocumentServiceForWorkspace(
  workspacePath: string | undefined,
): Promise<{
  docService: ElectronDocumentService | undefined;
  tempDocService: ElectronDocumentService | undefined;
}> {
  if (!workspacePath) {
    return { docService: undefined, tempDocService: undefined };
  }

  const { documentServices } = await import('../../window/WindowManager');
  return {
    docService: documentServices.get(workspacePath),
    tempDocService: undefined,
  };
}

async function resolveTrackerItemFromDocumentService(
  docService: ElectronDocumentService | undefined,
  reference: string,
): Promise<TrackerItem | null> {
  if (!docService) return null;

  const byId = await docService.getTrackerItemById(reference);
  if (byId) return byId;

  const allItems = await docService.listTrackerItems();
  return allItems.find((candidate) => candidate.issueKey === reference) || null;
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

// NIM-436 ("refuse description writes when body is collaborative") was removed
// as part of phase 1 of the tracker-sync rewrite
// (design/Collaboration/tracker-sync-redesign.md).
//
// Phase 5 status (tracker sync is now active via phase 3+4):
//   - Metadata mutations (status, priority, title, labels, etc.) flow through
//     `syncTrackerItem` -> `TrackerSyncEngine.upsertItem`, which optimistically
//     applies, enqueues, and ships the encrypted envelope to TrackerRoom.
//     Multiple calls for the same item generate independent client mutation
//     IDs; the server's per-item versioning collapses them to the latest.
//   - Body content (`description`) is written into the PGLite `content`
//     column as a plain-text snapshot. The active body Y.Doc in DocumentRoom
//     is NOT updated by this path -- a connected client editing the body via
//     Lexical/Y.Doc is the source of truth for the live body. MCP's
//     description write therefore lands in PGLite + the metadata layer's
//     `bodyVersion` bump (see ElectronDocumentService.updateTrackerItemContent)
//     and is visible to cold readers, but a warm Y.Doc body will continue to
//     reflect the Y.Doc state.
//   - The NIM-436 guard is intentionally absent: the cost-benefit landed in
//     favor of MCP being able to author descriptions in any sync mode, and
//     the BodyDocCache will eventually mediate writes through the Y.Doc.

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
  options?: { trackerRowId?: string },
): Promise<boolean> {
  const { getDatabase } = await import("../../database/initialize");
  const db = getDatabase();
  let changed = false;
  const trackerRowId = options?.trackerRowId || trackerId;

  // 1. Add session to tracker item's linkedSessions only for local trackers.
  const trackerResult = await db.query<any>(
    `SELECT workspace, type, sync_status, data FROM tracker_items WHERE id = $1`,
    [trackerRowId]
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
          [JSON.stringify(data), trackerRowId]
        );
        changed = true;
      }
    } else if (data.linkedSessions !== undefined) {
      delete data.linkedSessions;
      await db.query(
        `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
        [JSON.stringify(data), trackerRowId]
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
  options?: { trackerRowId?: string },
): Promise<boolean> {
  const { getDatabase } = await import("../../database/initialize");
  const db = getDatabase();
  let changed = false;
  const trackerRowId = options?.trackerRowId || trackerId;

  // 1. Remove session from tracker item's linkedSessions only for local trackers.
  const trackerResult = await db.query<any>(
    `SELECT workspace, type, sync_status, data FROM tracker_items WHERE id = $1`,
    [trackerRowId]
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
          [JSON.stringify(data), trackerRowId]
        );
        changed = true;
      }
    } else if (data.linkedSessions !== undefined) {
      delete data.linkedSessions;
      await db.query(
        `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
        [JSON.stringify(data), trackerRowId]
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

/**
 * Normalize the `type_tags` DB column into a string array.
 *
 * type_tags is TEXT[] in PGLite (returns string[]) but TEXT in SQLite (returns a
 * JSON-encoded string). Without this, a raw string flows downstream and breaks
 * `typeTags.filter` in the tracker tool widget. Falls back to `[fallbackType]` when
 * the column is empty, null, or unparseable.
 */
export function normalizeTypeTags(rawTypeTags: unknown, fallbackType: string): string[] {
  const parsed: string[] | undefined = Array.isArray(rawTypeTags)
    ? (rawTypeTags as string[])
    : typeof rawTypeTags === 'string'
      ? (() => {
          try {
            const value = JSON.parse(rawTypeTags);
            return Array.isArray(value) ? (value as string[]) : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined;
  return parsed && parsed.length > 0 ? parsed : [fallbackType];
}

/** Convert a raw DB row to a TrackerItem for the renderer */
export function rowToTrackerItem(row: any): any {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data || {};
  // type_tags comes from the DB column; fall back to [type] for backward compat.
  const typeTags: string[] = normalizeTypeTags(row.type_tags, row.type);
  const result: any = {
    id: row.source === 'frontmatter' && row.source_ref
      ? buildFullDocumentTrackerId(row.type, row.source_ref)
      : row.id,
    issueNumber: row.issue_number ?? undefined,
    issueKey: row.issue_key ?? undefined,
    type: row.type,
    typeTags,
    title: data.title || row.title,
    description: data.description || undefined,
    status: data.status || row.status,
    priority: data.priority || undefined,
    owner: data.owner || undefined,
    module: row.document_path || ((row.source === 'frontmatter' || row.source === 'import') ? row.source_ref : undefined),
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
    labels: normalizeLegacyLabelValues(data.labels),
    linkedSessions: (() => {
      const linkedSessions = getVisibleTrackerLinkedSessions(row, data.linkedSessions);
      return linkedSessions.length > 0 ? linkedSessions : undefined;
    })(),
    linkedCommitSha: data.linkedCommitSha || undefined,
    linkedCommits: data.linkedCommits || undefined,
    documentId: data.documentId || undefined,
    syncStatus: row.sync_status || 'local',
    // Body Y.Doc version pointer. Without this, syncTrackerItem ships
    // bodyVersion=0 through trackerItemToPayload, and applyRemoteItem's
    // `body_version = EXCLUDED.body_version` clobbers any local bump back
    // to 0. That breaks the join in getTrackerBodyCacheLatest (which
    // matches `c.body_version = t.body_version`) and the renderer's cold
    // paint comes back empty -- so the editor stays on "Loading content..."
    // BIGINT arrives as string|number depending on driver path; normalize.
    bodyVersion: row.body_version !== undefined && row.body_version !== null
      ? Number(row.body_version)
      : undefined,
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
        primaryType: {
          type: "string",
          description:
            "Replace the item's primary type (e.g. change a 'task' into a 'bug', or an 'idea' into a 'plan'). Must be a registered tracker type. Item history (comments, attachments, session links) is preserved. The primary type is also auto-merged into type_tags so it remains the canonical primary tag.",
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
    const limit = Math.min(args.limit || 50, 250);
    const { documentServices } = await import("../../window/WindowManager");
    let docService = workspacePath ? documentServices.get(workspacePath) : undefined;
    let tempDocService: { destroy?: () => void } | undefined;
    if (!docService && workspacePath) {
      const { ElectronDocumentService } = await import("../../services/ElectronDocumentService");
      docService = new ElectronDocumentService(workspacePath);
      tempDocService = docService;
    }
    const rawItems = docService ? await docService.listTrackerItems() : [];

    const getFieldValue = (item: TrackerItem, field: string): unknown => {
      const record = item as unknown as Record<string, unknown>;
      if (record[field] !== undefined) {
        return record[field];
      }
      return item.customFields?.[field];
    };

    const resolveFieldForFilter = (
      role: Parameters<typeof getTrackerRoleField>[1],
      fallback: string,
    ): string => {
      if (args.type) {
        return getTrackerRoleField(args.type, role) ?? fallback;
      }
      return fallback;
    };

    const items = rawItems
      .filter((item) => !workspacePath || item.workspace === workspacePath)
      .filter((item) => args.archived ? item.archived === true : item.archived !== true)
      .filter((item) => !args.type || item.type === args.type)
      .filter((item) => !args.typeTag || (item.typeTags || [item.type]).includes(args.typeTag))
      .filter((item) => {
        if (!args.owner) return true;
        const ownerField = resolveFieldForFilter('assignee', 'owner');
        return String(getFieldValue(item, ownerField) ?? '') === String(args.owner);
      })
      .filter((item) => {
        if (!args.status) return true;
        const statusField = resolveFieldForFilter('workflowStatus', 'status');
        return String(getFieldValue(item, statusField) ?? '').toLowerCase() === String(args.status).toLowerCase();
      })
      .filter((item) => {
        if (!args.priority) return true;
        const priorityField = resolveFieldForFilter('priority', 'priority');
        return String(getFieldValue(item, priorityField) ?? '').toLowerCase() === String(args.priority).toLowerCase();
      })
      .filter((item) => {
        if (!args.where || !Array.isArray(args.where)) return true;
        return args.where.every((clause: any) => {
          if (!clause?.field || !clause?.op) return true;
          const value = getFieldValue(item, clause.field);
          switch (clause.op) {
            case '=':
              return String(value ?? '') === String(clause.value);
            case '!=':
              return String(value ?? '') !== String(clause.value);
            case 'contains':
              return String(value ?? '').toLowerCase().includes(String(clause.value ?? '').toLowerCase());
            case 'in':
              return Array.isArray(clause.value) ? clause.value.map(String).includes(String(value ?? '')) : true;
            default:
              return true;
          }
        });
      })
      .filter((item) => {
        if (!args.search) return true;
        const haystack = [
          item.issueKey,
          String(item.issueNumber ?? ''),
          item.title,
          item.description,
          item.module,
          Array.isArray(item.tags) ? item.tags.join(' ') : '',
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(String(args.search).toLowerCase());
      })
      .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        issueNumber: item.issueNumber ?? undefined,
        issueKey: item.issueKey ?? undefined,
        type: item.type,
        typeTags: item.typeTags && item.typeTags.length > 0 ? item.typeTags : [item.type],
        title: item.title || '',
        status: item.status || '',
        priority: item.priority || '',
        tags: item.tags || [],
        archived: item.archived ?? false,
        source: item.source || 'native',
        syncStatus: item.syncStatus || 'local',
        updated: item.updated,
      }));
    tempDocService?.destroy?.();

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
    const { documentServices } = await import("../../window/WindowManager");
    let docService = workspacePath ? documentServices.get(workspacePath) : undefined;
    let tempDocService: { destroy?: () => void } | undefined;
    if (!docService && workspacePath) {
      const { ElectronDocumentService } = await import("../../services/ElectronDocumentService");
      docService = new ElectronDocumentService(workspacePath);
      tempDocService = docService;
    }

    let item: TrackerItem | null = null;
    if (docService) {
      item = await docService.getTrackerItemById(args.id);
      if (!item && args.id) {
        const all = await docService.listTrackerItems();
        item = all.find(candidate => candidate.issueKey === args.id) || null;
      }
    }

    if (!item) {
      tempDocService?.destroy?.();
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

    // Build a readable representation
    const lines: string[] = [];
    lines.push(`# ${item.title || "Untitled"}`);
    lines.push("");
    lines.push(`**Type**: ${item.type}`);
    if (item.issueKey) lines.push(`**Issue Key**: ${item.issueKey}`);
    if (item.status) lines.push(`**Status**: ${item.status}`);
    if (item.priority) lines.push(`**Priority**: ${item.priority}`);
    if (item.tags?.length)
      lines.push(`**Tags**: ${item.tags.join(", ")}`);
    if (item.owner) lines.push(`**Owner**: ${item.owner}`);
    if (item.dueDate) lines.push(`**Due Date**: ${item.dueDate}`);
    if (item.progress !== undefined) lines.push(`**Progress**: ${item.progress}%`);
    if (item.assigneeId) lines.push(`**Assignee**: ${item.assigneeId}`);
    if (item.reporterId) lines.push(`**Reporter**: ${item.reporterId}`);
    if (item.labels?.length) lines.push(`**Labels**: ${item.labels.join(", ")}`);
    if (item.linkedCommitSha) lines.push(`**Linked Commit**: ${item.linkedCommitSha}`);
    if (item.syncStatus) lines.push(`**Sync Status**: ${item.syncStatus}`);
    if (item.archived) lines.push(`**Archived**: yes`);
    if (item.source && item.source !== "native")
      lines.push(
        `**Source**: ${item.source}${item.sourceRef ? ` (${item.sourceRef})` : ""}`
      );
    if (item.linkedSessions?.length)
      lines.push(
        `**Linked Sessions**: ${item.linkedSessions.join(", ")}`
      );
    lines.push(`**ID**: ${item.id}`);
    lines.push(`**Updated**: ${item.updated}`);
    lines.push("");

    // Include content as markdown
    if (item.content) {
      const content =
        typeof item.content === "string"
          ? item.content
          : JSON.stringify(item.content);
      lines.push("---");
      lines.push("");
      lines.push(content);
    } else if (item.description) {
      lines.push("---");
      lines.push("");
      lines.push(item.description);
    }

    const structured = {
      action: "retrieved" as const,
      item: {
        id: item.id,
        issueNumber: item.issueNumber ?? undefined,
        issueKey: item.issueKey ?? undefined,
        type: item.type,
        typeTags: item.typeTags && item.typeTags.length > 0 ? item.typeTags : [item.type],
        title: item.title || "Untitled",
        status: item.status || undefined,
        priority: item.priority || undefined,
        tags: item.tags || [],
        owner: item.owner || undefined,
        dueDate: item.dueDate || undefined,
      },
    };
    tempDocService?.destroy?.();

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

    // Route the description through the canonical body path so it shows up
    // in the editor when the item is opened. The initial INSERT above sets
    // `content` for backward compatibility, but for shared trackers the
    // metadata-sync ack (`applyRemoteItem`) clobbers it to NULL because the
    // wire payload carries no body field. Without this block, `body_version`
    // stays at 0, `tracker_body_cache` is never populated, and the live
    // DocumentRoom Y.Doc is never seeded -- so the collaborative editor
    // mounts empty. This mirrors `ElectronDocumentService.updateTrackerItemContent`
    // inline so we do not depend on `documentServices` having an entry for
    // this workspace (which is empty after a main-process hot-reload until
    // the first window finishes wiring up).
    if (descriptionText) {
      try {
        const bodyContentJson = JSON.stringify(descriptionText);
        const bumpResult = await db.query<{ body_version: string | number | null }>(
          `UPDATE tracker_items
              SET content = $1,
                  body_version = COALESCE(body_version, 0) + 1,
                  updated = NOW()
            WHERE id = $2
            RETURNING body_version`,
          [bodyContentJson, id]
        );
        const newBodyVersion = Number(bumpResult.rows[0]?.body_version ?? 0);
        if (newBodyVersion > 0) {
          await db.query(
            `INSERT INTO tracker_body_cache (item_id, body_version, content, cached_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (item_id, body_version) DO NOTHING`,
            [id, newBodyVersion, bodyContentJson]
          );
        }

        // Re-sync metadata so peers learn the bodyVersion bump (cold readers
        // invalidate their cache and refetch from `tracker_body_cache`).
        if (shouldSyncTrackerPolicy(syncPolicy) && isTrackerSyncActive(workspacePath)) {
          createdRow = await resolveTrackerRowByReference(db, id, workspacePath);
          createdItem = createdRow ? rowToTrackerItem(createdRow) : createdItem;
          if (createdItem) {
            await syncTrackerItem(createdItem);
          }
        }

        // Seed the live DocumentRoom Y.Doc so the collaborative editor mounts
        // with content instead of waiting on a never-bootstrapped room. No-op
        // for local trackers (resolveConfig returns null without a team).
        await applyHeadlessBodyMarkdown(workspacePath, id, descriptionText);
      } catch (bodyError) {
        console.error('[MCP Server] tracker_create body write failed:', bodyError);
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
    const { docService, tempDocService } = await getDocumentServiceForWorkspace(workspacePath);

    try {
      let item = await resolveTrackerItemFromDocumentService(docService, args.id);
      let row = await resolveTrackerRowByReference(db, args.id, workspacePath);
      if (!item && row) {
        item = rowToTrackerItem(row);
      }
      if (!item) {
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

      const publicTrackerId = item.id;
      const isFileBacked = item.source === 'frontmatter' || item.source === 'import';
      if (isFileBacked && docService) {
        const projected = await docService.ensureTrackerProjection(publicTrackerId);
        if (projected) item = projected;
        row = await resolveTrackerRowByReference(db, publicTrackerId, workspacePath);
      } else if (!row) {
        row = await resolveTrackerRowByReference(db, publicTrackerId, workspacePath);
      }

      if (isFileBacked) {
        if (!docService) {
          return {
            content: [{ type: 'text', text: 'Error: No document service available for file-backed tracker update.' }],
            isError: true,
          };
        }
        if (args.primaryType !== undefined || args.typeTags !== undefined) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: tracker_update does not yet support changing primaryType or typeTags for file-backed tracker documents.',
              },
            ],
            isError: true,
          };
        }

        const rf = (role: string, fallback: string) => getTrackerRoleField(item.type, role as any) ?? fallback;
        const data = typeof row?.data === 'string' ? JSON.parse(row.data) : (row?.data || {});
        const titleField = rf('title', 'title');
        const statusField = rf('workflowStatus', 'status');
        const priorityField = rf('priority', 'priority');
        const tagsField = rf('tags', 'tags');
        const ownerField = rf('assignee', 'owner');
        const dueDateField = rf('dueDate', 'dueDate');
        const progressField = rf('progress', 'progress');
        const reporterField = rf('reporter', 'reporterEmail');

        if (item.title !== undefined) data[titleField] = item.title;
        if (item.status !== undefined) data[statusField] = item.status;
        if (item.priority !== undefined) data[priorityField] = item.priority;
        if (item.tags !== undefined) data[tagsField] = item.tags;
        if (item.owner !== undefined) data[ownerField] = item.owner;
        if (item.dueDate !== undefined) data[dueDateField] = item.dueDate;
        if (item.progress !== undefined) data[progressField] = item.progress;
        if (item.reporterEmail !== undefined) data[reporterField] = item.reporterEmail;
        if (item.labels !== undefined) data.labels = item.labels;
        if (item.linkedCommitSha !== undefined) data.linkedCommitSha = item.linkedCommitSha;
        if (item.assigneeEmail !== undefined) data.assigneeEmail = item.assigneeEmail;
        if (item.assigneeId !== undefined) data.assigneeId = item.assigneeId;
        if (item.reporterId !== undefined) data.reporterId = item.reporterId;
        if (item.customFields) {
          Object.assign(data, item.customFields);
        }
        data.lastModifiedBy = getCurrentIdentity(workspacePath);

        const changes: Record<string, { from: any; to: any }> = {};
        const fileUpdates: Record<string, any> = {};
        if (args.tags !== undefined && !Array.isArray(args.tags)) {
          args.tags = [];
        }

        const roleMap: Array<[string, string, string]> = [
          ['title', 'title', 'title'],
          ['status', 'workflowStatus', 'status'],
          ['priority', 'priority', 'priority'],
          ['tags', 'tags', 'tags'],
          ['owner', 'assignee', 'owner'],
          ['dueDate', 'dueDate', 'dueDate'],
          ['progress', 'progress', 'progress'],
          ['reporterEmail', 'reporter', 'reporterEmail'],
        ];

        for (const [argName, role, fallback] of roleMap) {
          if (args[argName] === undefined) continue;
          const fieldName = rf(role, fallback);
          changes[fieldName] = { from: data[fieldName], to: args[argName] };
          data[fieldName] = args[argName];
          fileUpdates[fieldName] = args[argName];
        }

        if (args.assigneeEmail !== undefined) {
          changes.assigneeEmail = { from: data.assigneeEmail, to: args.assigneeEmail };
          data.assigneeEmail = args.assigneeEmail;
          fileUpdates.assigneeEmail = args.assigneeEmail;
          if (args.owner === undefined) {
            changes[ownerField] = { from: data[ownerField], to: args.assigneeEmail };
            data[ownerField] = args.assigneeEmail;
            fileUpdates[ownerField] = args.assigneeEmail;
          }
        }
        if (args.assigneeId !== undefined) {
          changes.assigneeId = { from: data.assigneeId, to: args.assigneeId };
          data.assigneeId = args.assigneeId;
          fileUpdates.assigneeId = args.assigneeId;
        }
        if (args.reporterId !== undefined) {
          changes.reporterId = { from: data.reporterId, to: args.reporterId };
          data.reporterId = args.reporterId;
          fileUpdates.reporterId = args.reporterId;
        }
        if (args.description !== undefined) {
          const normalizedDesc = String(args.description).replace(/\\n/g, '\n');
          changes.description = { from: undefined, to: normalizedDesc };
          fileUpdates.description = normalizedDesc;
        }
        if (args.labels !== undefined) {
          changes.labels = { from: data.labels, to: args.labels };
          data.labels = args.labels;
          fileUpdates.labels = args.labels;
        }
        if (args.linkedCommitSha !== undefined) {
          changes.linkedCommitSha = { from: data.linkedCommitSha, to: args.linkedCommitSha };
          data.linkedCommitSha = args.linkedCommitSha;
          fileUpdates.linkedCommitSha = args.linkedCommitSha;
        }
        if (args.archived !== undefined) {
          changes.archived = { from: row?.archived ?? item.archived ?? false, to: args.archived };
        }

        if (args.fields && typeof args.fields === 'object') {
          for (const [key, value] of Object.entries(args.fields)) {
            if (value === undefined) continue;
            changes[key] = { from: data[key], to: value };
            data[key] = value;
            fileUpdates[key] = value;
          }
        }
        if (args.unsetFields && Array.isArray(args.unsetFields)) {
          for (const key of args.unsetFields) {
            if (data[key] === undefined) continue;
            changes[key] = { from: data[key], to: undefined };
            delete data[key];
            fileUpdates[key] = null;
          }
        }

        const validationResult = globalRegistry.validate(item.type, data);
        if (!validationResult.valid) {
          return buildTrackerSchemaValidationError('tracker_update', item.type, validationResult.errors);
        }

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

        if (Object.keys(fileUpdates).length > 0) {
          await docService.updateTrackerItemInFile(publicTrackerId, fileUpdates);
        }

        row = await resolveTrackerRowByReference(db, publicTrackerId, workspacePath);
        if (row) {
          await db.query(
            `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
            [JSON.stringify(data), row.id]
          );
        }

        if (args.archived !== undefined) {
          await docService.archiveTrackerItem(publicTrackerId, args.archived);
          row = await resolveTrackerRowByReference(db, publicTrackerId, workspacePath);
        }

        const refreshedItem =
          (await resolveTrackerItemFromDocumentService(docService, publicTrackerId)) || item;
        const storageRowId = row?.id || publicTrackerId;

        if (sessionId) {
          const linked = await createBidirectionalLink(publicTrackerId, sessionId, {
            trackerRowId: storageRowId,
          });
          if (linked) {
            const sessionResult = await db.query<any>(
              `SELECT metadata FROM ai_sessions WHERE id = $1`,
              [sessionId]
            );
            const linkedIds = sessionResult.rows[0]?.metadata?.linkedTrackerItemIds || [];
            await notifySessionLinkedTrackerChanged(sessionId, linkedIds);
          }
        }

        if (row) {
          await notifyTrackerItemUpdated(workspacePath, row.id);
        }

        if (row && workspacePath) {
          const updateModel = globalRegistry.get(refreshedItem.type);
          const syncPolicy = getEffectiveTrackerSyncPolicy(workspacePath, refreshedItem.type, updateModel?.sync?.mode);
          if (shouldSyncTrackerPolicy(syncPolicy)) {
            if (isTrackerSyncActive(workspacePath)) {
              try {
                await syncTrackerItem(refreshedItem);
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

        const updateSummaryParts: string[] = [];
        if (args.title !== undefined) updateSummaryParts.push(`- **Title**: ${args.title}`);
        if (args.status !== undefined) updateSummaryParts.push(`- **Status**: ${args.status}`);
        if (args.priority !== undefined) updateSummaryParts.push(`- **Priority**: ${args.priority}`);
        if (args.archived !== undefined) updateSummaryParts.push(`- **Archived**: ${args.archived}`);
        if (args.tags !== undefined) updateSummaryParts.push(`- **Tags**: ${args.tags.join(", ")}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                structured: {
                  action: "updated" as const,
                  id: refreshedItem.id,
                  issueNumber: refreshedItem.issueNumber ?? undefined,
                  issueKey: refreshedItem.issueKey ?? undefined,
                  type: refreshedItem.type,
                  typeTags: refreshedItem.typeTags && refreshedItem.typeTags.length > 0
                    ? refreshedItem.typeTags
                    : [refreshedItem.type],
                  title: refreshedItem.title || '',
                  changes,
                },
                summary: [
                  `Updated tracker item ${getTrackerDisplayRef({ id: refreshedItem.id, issueKey: refreshedItem.issueKey ?? undefined })}:`,
                  ...updateSummaryParts,
                ].join('\n'),
              }),
            },
          ],
          isError: false,
        };
      }

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
      data.lastModifiedBy = getCurrentIdentity(workspacePath);

      const rf = (role: string, fallback: string) => getTrackerRoleField(row.type, role as any) ?? fallback;
      const roleMap: Array<[string, string, string]> = [
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

      if (args.assigneeEmail !== undefined) {
        data.assigneeEmail = args.assigneeEmail;
        if (args.owner === undefined) {
          const ownerField = rf('assignee', 'owner');
          changes[ownerField] = { from: data[ownerField], to: args.assigneeEmail };
          data[ownerField] = args.assigneeEmail;
        }
      }
      if (args.description !== undefined) {
        const normalizedDesc = args.description.replace(/\\n/g, '\n');
        changes.description = { from: data.description, to: normalizedDesc };
        data.description = normalizedDesc;
      }
      if (args.labels !== undefined) { data.labels = args.labels; }
      if (args.linkedCommitSha !== undefined) { data.linkedCommitSha = args.linkedCommitSha; }
      if (args.archived !== undefined) {
        changes.archived = { from: row.archived ?? false, to: args.archived };
      }
      if (args.fields && typeof args.fields === 'object') {
        for (const [key, value] of Object.entries(args.fields)) {
          if (value === undefined) continue;
          const oldVal = data[key];
          if (oldVal !== value) {
            changes[key] = { from: oldVal, to: value };
          }
          data[key] = value;
        }
      }
      if (args.unsetFields && Array.isArray(args.unsetFields)) {
        for (const key of args.unsetFields) {
          if (data[key] !== undefined) {
            changes[key] = { from: data[key], to: undefined };
            delete data[key];
          }
        }
      }

      const oldType = row.type;
      let primaryTypeChanged = false;
      if (typeof args.primaryType === 'string' && args.primaryType !== row.type) {
        const newType = args.primaryType;
        if (!globalRegistry.has(newType)) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Error: unknown tracker type "${newType}". Use tracker_list to see registered types.`,
              },
            ],
          };
        }
        changes.type = { from: oldType, to: newType };
        row.type = newType;
        primaryTypeChanged = true;
      }

      const validationResult = globalRegistry.validate(row.type, data);
      if (!validationResult.valid) {
        return buildTrackerSchemaValidationError('tracker_update', row.type, validationResult.errors);
      }

      const modifierIdentity = getCurrentIdentity(workspacePath);
      for (const [field, change] of Object.entries(changes)) {
        const action = field === 'status' ? 'status_changed'
          : field === 'archived' ? 'archived'
          : field === 'type' ? 'type_changed'
          : 'updated';
        appendActivity(data, modifierIdentity, action, {
          field,
          oldValue: change.from != null ? String(change.from) : undefined,
          newValue: change.to != null ? String(change.to) : undefined,
        });
      }

      if (primaryTypeChanged) {
        await db.query(
          `UPDATE tracker_items SET type = $1 WHERE id = $2`,
          [row.type, row.id]
        );
      }

      if (args.typeTags !== undefined) {
        const newTypeTags: string[] = [row.type];
        for (const tag of args.typeTags) {
          if (!newTypeTags.includes(tag)) newTypeTags.push(tag);
        }
        await db.query(
          `UPDATE tracker_items SET type_tags = $1 WHERE id = $2`,
          [newTypeTags, row.id]
        );
      } else if (primaryTypeChanged) {
        const existingTags: string[] = normalizeTypeTags((row as any).type_tags, oldType);
        const preservedSecondary = existingTags.filter(
          (t) => t !== oldType && t !== row.type
        );
        const newTypeTags = [row.type, ...preservedSecondary];
        await db.query(
          `UPDATE tracker_items SET type_tags = $1 WHERE id = $2`,
          [newTypeTags, row.id]
        );
      }

      await db.query(
        `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
        [JSON.stringify(data), row.id]
      );

      if (args.description !== undefined) {
        const normalizedContent = args.description.replace(/\\n/g, '\n');
        const contentJson = JSON.stringify(normalizedContent);
        const bumpResult = await db.query<{ body_version: string | number | null }>(
          `UPDATE tracker_items
              SET content = $1,
                  body_version = COALESCE(body_version, 0) + 1
            WHERE id = $2
            RETURNING body_version`,
          [contentJson, row.id]
        );
        const newBodyVersion = Number(bumpResult.rows[0]?.body_version ?? 0);
        if (newBodyVersion > 0) {
          await db.query(
            `INSERT INTO tracker_body_cache (item_id, body_version, content, cached_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (item_id, body_version) DO NOTHING`,
            [row.id, newBodyVersion, contentJson]
          );
        }

        if (workspacePath) {
          try {
            await applyHeadlessBodyMarkdown(workspacePath, row.id, normalizedContent);
          } catch (bodyError) {
            console.error('[MCP Server] tracker_update body Y.Doc seed failed:', bodyError);
          }
        }
      }

      if (args.archived !== undefined) {
        if (docService) {
          await docService.archiveTrackerItem(row.id, args.archived);
        } else {
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

      if (sessionId) {
        const linked = await createBidirectionalLink(publicTrackerId, sessionId, {
          trackerRowId: row.id,
        });
        if (linked) {
          const sessionResult = await db.query<any>(
            `SELECT metadata FROM ai_sessions WHERE id = $1`,
            [sessionId]
          );
          const linkedIds = sessionResult.rows[0]?.metadata?.linkedTrackerItemIds || [];
          await notifySessionLinkedTrackerChanged(sessionId, linkedIds);
        }
      }

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

      const updatedRow = await db.query<any>(
        `SELECT type_tags FROM tracker_items WHERE id = $1`,
        [row.id]
      );
      const currentTypeTags: string[] = normalizeTypeTags(updatedRow.rows[0]?.type_tags, row.type);

      const structured: Record<string, any> = {
        action: "updated" as const,
        id: publicTrackerId,
        issueNumber: postSyncRow?.issue_number ?? refreshedRow?.issue_number ?? row.issue_number ?? undefined,
        issueKey: postSyncRow?.issue_key ?? refreshedRow?.issue_key ?? row.issue_key ?? undefined,
        type: row.type,
        typeTags: currentTypeTags,
        title: data[rf('title', 'title')],
        changes,
      };

      const summaryLines = [
        `Updated tracker item ${getTrackerDisplayRef({ id: publicTrackerId, issueKey: postSyncRow?.issue_key ?? refreshedRow?.issue_key ?? row.issue_key ?? undefined })}:`,
        ...updateSummaryParts,
      ];

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
    } finally {
      tempDocService?.destroy?.();
    }
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
    const { docService, tempDocService } = await getDocumentServiceForWorkspace(workspacePath);

    try {
      let item = await resolveTrackerItemFromDocumentService(docService, args.trackerId);
      if (item && (item.source === 'frontmatter' || item.source === 'import') && docService) {
        const projected = await docService.ensureTrackerProjection(item.id);
        if (projected) item = projected;
      }
      const existing = await resolveTrackerRowByReference(
        db,
        item?.id || args.trackerId,
        workspacePath,
      );
      if (!item && existing) {
        item = rowToTrackerItem(existing);
      }
      if (!item || !existing) {
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

      await createBidirectionalLink(item.id, targetSessionId, {
        trackerRowId: existing.id,
      });

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
      const linkedIds = sessionResult.rows[0]?.metadata?.linkedTrackerItemIds || [];
      await notifySessionLinkedTrackerChanged(targetSessionId, linkedIds);

      const structured = {
        action: "linked" as const,
        trackerId: item.id,
        issueNumber: item.issueNumber ?? existing.issue_number ?? undefined,
        issueKey: item.issueKey ?? existing.issue_key ?? undefined,
        type: item.type || existing.type || "",
        title: item.title || trackerData.title || "",
        linkedCount: linkedSessions.length,
        sessionId: targetSessionId,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              structured,
              summary: `Linked session ${targetSessionId} to tracker item ${getTrackerDisplayRef({ id: item.id, issueKey: item.issueKey ?? undefined })}. Total linked sessions: ${linkedSessions.length}`,
            }),
          },
        ],
        isError: false,
      };
    } finally {
      tempDocService?.destroy?.();
    }
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
    const { docService, tempDocService } = await getDocumentServiceForWorkspace(workspacePath);

    try {
      let item = await resolveTrackerItemFromDocumentService(docService, args.trackerId);
      if (item && (item.source === 'frontmatter' || item.source === 'import') && docService) {
        const projected = await docService.ensureTrackerProjection(item.id);
        if (projected) item = projected;
      }
      const existing = await resolveTrackerRowByReference(
        db,
        item?.id || args.trackerId,
        workspacePath,
      );
      if (!item && existing) {
        item = rowToTrackerItem(existing);
      }
      if (!item || !existing) {
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

      const removed = await removeBidirectionalLink(item.id, targetSessionId, {
        trackerRowId: existing.id,
      });

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
        trackerId: item.id,
        issueNumber: item.issueNumber ?? existing.issue_number ?? undefined,
        issueKey: item.issueKey ?? existing.issue_key ?? undefined,
        type: item.type || existing.type || "",
        title: item.title || trackerData.title || "",
        linkedCount: linkedSessions.length,
        sessionId: targetSessionId,
        removed,
      };

      const displayRef = getTrackerDisplayRef({ id: item.id, issueKey: item.issueKey ?? undefined });
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
    } finally {
      tempDocService?.destroy?.();
    }
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
