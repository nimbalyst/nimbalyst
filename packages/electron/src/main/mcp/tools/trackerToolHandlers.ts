import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel';
import type { TrackerItem } from '@nimbalyst/runtime';
import { getCurrentIdentity } from '../../services/TrackerIdentityService';
import {
  ensureWorkspaceTrackerSchemasLoaded,
  getTrackerRoleField,
} from '../../services/TrackerSchemaService';
import {
  getEffectiveTrackerSharingPolicy,
  getInitialTrackerSyncStatus,
  shouldSyncTrackerItem,
} from '../../services/TrackerPolicyService';
import { isTrackerSyncActive, isTrackerSyncConfigured, syncTrackerItem } from '../../services/TrackerSyncManager';
import { awaitServerIssueKey } from '../../services/tracker/awaitServerIssueKey';
import { isLocalIssueKey, resolveDisplayIssueKey } from '../../../shared/localIssueKey';
import { applyHeadlessBodyMarkdown } from '../../services/MainBodyDocService';
import { applyRelationshipFieldWrites } from '../../services/tracker/relationshipFieldWrite';
import { appendActivity } from '../../services/tracker/trackerActivity';
import { assignLocalKeysToRows } from '../../services/tracker/localKeyAllocator';
import { workspaceLocalKeyStore } from '../../services/tracker/workspaceLocalKeyStore';
import { extractItemCustomFields } from '../../services/tracker/trackerRowCustomFields';
import { nestRelationshipFieldsIntoCustomFields, readStoredFieldValue, writeStoredFieldValue } from '../../services/tracker/relationshipFieldStorage';
import {
  isRelationshipField,
  matchesFilterSet,
  isUntriaged,
  priorityOptionsFor,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { humanOnlyStatusMessage, isHumanOnlyStatus } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerReview';
import {
  READINESS_FILTER_FIELD,
  STATUS_CATEGORY_FILTER_FIELD,
  isTerminalStatus,
  statusCategoryOfItem,
  type StatusCategory,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerStatusCategory';
import { computeReadiness, type Readiness } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerReadiness';
import {
  describeUnresolvedBlockers,
  projectBlockedBy,
  type BlockerVisibilityScope,
  type ProjectedBlockerRef,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerBlockerVisibility';
import { trackerItemToRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getRecordStatus, getRecordTitle, resolveRoleFieldName } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { buildTrackerRadar, getRecentTeammateActivity } from '@nimbalyst/tracker-core';
import { getVisibleTrackerLinkedSessions, shouldPersistTrackerLinkedSessions } from '../../../shared/trackerSessionLinks';
import { buildFullDocumentTrackerId } from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterUtils';
import { normalizeLegacyLabelValues } from '@nimbalyst/runtime/sync';
import { getTrackerImporterRegistry } from '../../services/tracker/TrackerImporterRegistry';
import { getTrackerImportService } from '../../services/tracker/TrackerImportService';
import { fromDbBoolean } from '../../services/tracker/trackerDbValue';
import {
  trackTrackerMutation,
  type TrackerMutationAction,
} from '../../services/analytics/trackerMutationAnalytics';
import {
  getDocumentServiceForWorkspace,
  resolveTrackerItemFromDocumentService,
  resolveTrackerRowByReference,
} from './trackerToolItemAccess';
import { handleTrackerPublicationUpdate } from './trackerPublicationTool';
import { handleGithubIssueOverlayCreate } from './githubIssueOverlayTool';
import {
  bodyWriteFailure,
  DESTRUCTIVE_CONFIRM_PARAM_DESCRIPTION,
  getAssignedIssueKey,
  getTrackerDisplayRef,
  issueKeyAvailabilityNote,
  issueKeyMessage,
  issueKeyStatus,
  localIssueKeyResponseMessage,
  TRACKER_TRACKS_EXPLANATION,
  type BodyWriteFailure,
  type McpToolResult,
} from './trackerToolResult';

export {
  handleTrackerDefineType,
  handleTrackerDeleteType,
  handleTrackerListTypes,
} from './trackerSchemaToolHandlers';

function trackMcpTrackerMutation(
  action: TrackerMutationAction,
  itemId: string,
  trackerType: string,
  shared: boolean,
): void {
  trackTrackerMutation({
    itemId,
    action,
    actorType: 'agent',
    collaborationScope: shared ? 'shared' : 'personal',
    trackerType,
    view: 'agent_tool',
  });
}

function trackerRadarAdvisory(item: TrackerItem | null | undefined, workspacePath?: string): string {
  if (!item) return '';
  try {
    const activity = getRecentTeammateActivity(
      trackerItemToRecord(item),
      getCurrentIdentity(workspacePath),
    );
    return activity ? `\n- **Radar**: ${activity.summary}` : '';
  } catch {
    // Advisory-only: malformed legacy metadata must never turn a successful
    // tracker mutation into a failed tool call.
    return '';
  }
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
//     favor of MCP being able to author descriptions for any tracker sharing setting, and
//     the BodyDocCache will eventually mediate writes through the Y.Doc.

/**
 * Read linkedTrackerItemIds from a raw ai_sessions.metadata column value.
 * Whole-column JSON reads return a parsed object on PGLite but a raw JSON
 * string on SQLite (NIM-829; see packages/electron/DATABASE.md), so every
 * consumer must parse defensively or SQLite sees an empty list — which
 * clobbered links on write and broadcast zero linked items to renderers.
 */
export function readLinkedTrackerItemIds(rawMetadata: unknown): string[] {
  const metadata =
    typeof rawMetadata === 'string'
      ? JSON.parse(rawMetadata)
      : (rawMetadata as Record<string, any>) ?? {};
  return Array.isArray(metadata?.linkedTrackerItemIds) ? metadata.linkedTrackerItemIds : [];
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
    const linkedTrackerItemIds = readLinkedTrackerItemIds(sessionResult.rows[0].metadata);
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
    const linkedTrackerItemIds = readLinkedTrackerItemIds(sessionResult.rows[0].metadata);
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

/**
 * `content` is stored as JSON.stringify(markdown) (see updateTrackerItemContent /
 * tracker_create). Undo that encoding on read; legacy/plain rows without JSON
 * quoting pass through unchanged.
 */
export function parseTrackerContent(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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
    // `getTrackerDisplayRef` falls back to the raw id without this, so an
    // unpublished item reports a uuid to the agent instead of its number.
    localKey: row.local_key ?? undefined,
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
    content: row.content != null ? parseTrackerContent(row.content) : undefined,
    archived: row.archived ?? false,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : undefined,
    source: row.source || (row.document_path ? 'inline' : 'native'),
    sourceRef: row.source_ref || undefined,
    // Structured origin (external-source importers). Must be surfaced as a
    // top-level field, not left to fall into `customFields` below: the
    // TrackerRecord conversion reads `item.origin` into `system.origin`, and
    // the DB write-back only persists `data.origin` when `system.origin` is
    // set. If origin sits in customFields instead, the first sync re-serialize
    // rewrites `data` without it and the `data.origin.external.urn` index goes
    // empty (imports then fail to resolve their own URN).
    origin: data.origin || undefined,
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
  // Pass through all extra JSONB data fields (activity, comments, kanbanSortOrder,
  // relationship fields, etc.) as customFields so they survive the TrackerItem ->
  // TrackerRecord conversion. Synced items NEST these under data.customFields, so
  // un-nest via extractItemCustomFields rather than copying the raw `customFields`
  // key through (which double-nested it and dropped the fields on the sync
  // round-trip -- NIM-1305 / NIM-1077). Uses the result object's own keys as the
  // "known" set -- no hardcoded list.
  const cf = extractItemCustomFields(data, new Set(Object.keys(result)));
  if (cf) result.customFields = cf;
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
      "List tracker items (bugs, tasks, plans, ideas, decisions, etc.) with optional filtering. Returns a summary of each item. Use this to see what work items exist.\n\nIMPORTANT: only OPEN items are returned by default. Items in a terminal status (done or cancelled) are excluded unless you pass `includeClosed: true`, or ask for a closed status directly via `status` / `statusCategory`. So a result here is the outstanding work, not everything ever filed -- say so if you report a count.",
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
            "Filter by status (e.g., 'to-do', 'in-progress', 'done'). Asking for a closed status implies includeClosed.",
        },
        statusCategory: {
          type: "string",
          description:
            "Filter by lifecycle category: 'backlog', 'unstarted', 'started', 'done', or 'cancelled'. Unlike `status`, this is comparable across types -- each type closes on a different status value ('done' for a bug, 'completed' for a plan, 'rejected' for an idea) but they share a category. Implies includeClosed when set to 'done' or 'cancelled'.",
        },
        readiness: {
          type: 'string',
          enum: ['ready', 'blocked', 'any'],
          description: 'Filter by dependency readiness: \'ready\', \'blocked\', or \'any\' (default). Setting this also returns `blockedBy`, `unblocks`, and `unresolvedBlockerIds` (declared dependencies that no longer exist, which do not block) for each item. A blocker your own type or archived scope excluded is still counted, and still reports its status, but is marked `outOfScope` and withholds its title and reference -- widen those filters to see it.',
        },
        includeClosed: {
          type: "boolean",
          description:
            "Include items in a terminal status -- done or cancelled (default: false). BY DEFAULT THIS TOOL RETURNS ONLY OPEN ITEMS, so a count here is a count of outstanding work, not of everything ever filed. Set true to see closed items too.",
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
          description: "Maximum number of items to return (default: 50, capped at 250). Bulk export only: -1 returns up to 10,000 items at once and is expensive -- prefer a narrower `type`/`where` filter over dumping everything.",
        },
        where: {
          type: "array",
          description: "Field-level filters for querying on any schema-defined field. Each entry is { field, op, value }. This is the same filter language the tracker grid's column filters and saved views use. Ops: '=', '!=', 'contains', 'not-contains', 'in', 'not-in', '>', '>=', '<', '<=', 'between' (value is a 2-element array), 'is-empty', 'is-not-empty' (no value). Comparisons are case-insensitive; date and number fields compare in order.",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: "Field name in the tracker data (e.g., 'severity', 'component')" },
              op: { type: "string", description: "Operator: '=', '!=', 'contains', 'not-contains', 'in', 'not-in', '>', '>=', '<', '<=', 'between', 'is-empty', 'is-not-empty'" },
              value: { description: "Value to compare against. Array for 'in'/'not-in', 2-element array for 'between', omitted for 'is-empty'/'is-not-empty'." },
            },
            required: ["field", "op"],
          },
        },
        whereCombinator: {
          type: "string",
          description: "How `where` clauses combine: 'and' (default) or 'or'.",
        },
        inbox: {
          type: "boolean",
          description: "Only items that still need triage: no assignee, no priority, not in a milestone/release, and still on their type's initial status. This is the same queue the tracker's triage inbox shows. Combine with `type` to scope it to one type.",
        },
        full: {
          type: "boolean",
          description: "Return every stored field per item (custom fields, linked sessions/commits, source refs, origin). Off by default so results stay small; only turn it on when you actually need those extra fields, and pair it with `type`/`where` to keep the set narrow.",
        },
      },
    },
  },
  {
    name: 'tracker_ready',
    description:
      'Find the open tracker items that can be started now. This is the ready work queue for deciding what to work on next: items are ranked by how much other work they unblock, then by priority, grouped into independent tracks, and always include readiness explanations. ' + TRACKER_TRACKS_EXPLANATION + ' Items in a dependency cycle never appear because every member remains blocked; use tracker_list with readiness \'blocked\' to inspect blocked work.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description: 'Filter by primary item type (e.g., \'bug\', \'task\', \'plan\', \'idea\', \'decision\')',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of items to return (default: 50, capped at 250).',
        },
      },
    },
  },
  {
    name: 'work_radar',
    description:
      'Show compact recent team activity from synced tracker history. Call with an issueKey before starting work on an item to see whether a teammate has already touched it; call without one to see active work across the current tracker corpus.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        windowHours: {
          type: 'number',
          description: 'Rolling window in hours, clamped to 2..72 (default 24).',
        },
        issueKey: {
          type: 'string',
          description: 'Optional issue key, local key, or stable item id to inspect.',
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
      "Create a new tracker item (bug, task, plan, idea, decision, or any custom type).\n\nBy default, the new item is NOT linked to the current session. Pass linkSession: true to link it, or call tracker_link_session afterward.\n\nIMPORTANT: Never create an item already marked 'done' or 'completed'. Use 'to-do', 'in-progress', or 'in-review'.",
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
      "Update an existing tracker item's metadata or content. Can change title, status, priority, tags, description, owner, dueDate, progress, assigneeId, reporterId, labels, linkedCommitSha, or archive state.\n\nIMPORTANT: Use 'in-review' when work is finished but not yet committed -- do not set 'done' on your own judgment. Once the user commits the work, that is their approval: prefer closing the item through a 'Fixes <issue key>' reference in the commit message, which closes it automatically. Setting 'done' directly is acceptable only for work the user has already committed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The tracker item ID or issue key to update",
        },
        linkSession: {
          type: "boolean",
          description:
            "If true, link the current AI session to this item as part of the update. Defaults to false -- updating an item does NOT auto-link the session.",
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
        published: {
          type: "boolean",
          description: "Publish a draft team item so the server assigns its issue key. Run this as a separate update from content or field changes.",
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
      "List available tracker types and their schemas, including owner (builtin, personal, or team:<name>), lastChangedBy, schema activity, and any git-tracked team-file warning. Returns built-in and custom tracker types unless filtered.",
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
      "Define or update a tracker type schema in the current workspace. Team-owned edits write through for everyone and the result reports that scope explicitly. Two modes: (1) pass `schema` to define/replace a CUSTOM type (full schema object). (2) pass `patch` to override a BUILT-IN type (feature, bug, task, plan, decision, idea, automation) with a small delta — add/rename/remove status options, tweak labels/icons/colors, add fields — without redeclaring the whole schema. Patches resolve against the live built-in at load, so upstream improvements still flow through. Persisted to .nimbalyst/trackers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        schema: {
          type: "object",
          description: "Full custom tracker type schema object to persist. Cannot target a built-in type — use `patch` for those.",
        },
        patch: {
          type: "object",
          description:
            "Delta override for a tracker type (required: `type`). Merge semantics: `fields[]` by name (`{name, set?, options?, remove?}`); select options by value (`options: {set?: [{value,label,icon?,color?,category?}], remove?: [value], order?: [value]}`); scalars (displayName, icon, color, inlineTemplate, sharing, draftByDefault) last-writer; `roles` shallow-merged. On the workflow-status field, `category` declares where the status sits in the lifecycle — 'backlog', 'unstarted', 'started', 'done', or 'cancelled' — and is what makes an item count as closed for progress rollups and the Open/Closed filter. ALWAYS set it when adding a status; an omitted category is guessed from the value's name and defaults to open. Example — add a way to close something you are not going to do: {\"type\":\"feature\",\"fields\":[{\"name\":\"status\",\"options\":{\"set\":[{\"value\":\"wont-do\",\"label\":\"Won't Do\",\"icon\":\"do_not_disturb_on\",\"color\":\"#64748b\",\"category\":\"cancelled\"}]}}]}.",
        },
        fileName: {
          type: "string",
          description: "Optional YAML filename to use within .nimbalyst/trackers (full-schema mode only).",
        },
        overwrite: {
          type: "boolean",
          description: "Full-schema mode: replace an existing custom type of the same name. Defaults to false, which refuses to clobber. When true, the existing YAML is backed up first. (Patch mode always backs up and refines the existing patch.)",
        },
        promoteExistingItems: {
          type: "boolean",
          description: "Required when changing a personal tracker to team sharing. Publishes every existing item so the server assigns keys from the team's shared sequence.",
        },
        confirmDestructive: {
          type: "boolean",
          description: DESTRUCTIVE_CONFIRM_PARAM_DESCRIPTION,
        },
      },
    },
  },
  {
    name: "tracker_delete_type",
    description:
      "Delete a custom tracker type schema, or reset a built-in type's override back to its shipped default. Pass `resetOverride: true` with a built-in `type` to remove its .patch.yaml/override and restore the default. The result reports whether the blast radius is personal or team-wide.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          description: "The tracker type key to delete (custom) or reset (built-in with resetOverride).",
        },
        resetOverride: {
          type: "boolean",
          description: "When true and `type` is a built-in, remove its workspace override (patch or full snapshot) and restore the shipped default instead of refusing.",
        },
        confirmDestructive: {
          type: "boolean",
          description: DESTRUCTIVE_CONFIRM_PARAM_DESCRIPTION,
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
  {
    name: "tracker_importer_list",
    description:
      "List installed external-source importers (e.g. GitHub Issues), their URN scheme, the tracker types they import as, and whether the user is authenticated. Use before tracker_importer_search / tracker_import to discover available providers.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "tracker_importer_search",
    description:
      "Search importable items from an external source for one binding (e.g. a GitHub repo). Returns a page of lightweight entries (externalId, urn, url, title, state). Fetch the full body at import time via tracker_import.",
    inputSchema: {
      type: "object" as const,
      properties: {
        providerId: {
          type: "string",
          description: "Importer id from tracker_importer_list (e.g. 'github-issues')",
        },
        bindingId: {
          type: "string",
          description: "Binding id (e.g. 'owner/repo' for GitHub). If omitted, the importer's first binding is used.",
        },
        search: { type: "string", description: "Free-text search filter" },
        state: {
          type: "string",
          description: "Item state filter: 'open' | 'closed' | 'all' (default 'open')",
        },
        limit: { type: "number", description: "Max items to return" },
      },
      required: ["providerId"],
    },
  },
  {
    name: "tracker_import",
    description:
      "Import one external item into the native tracker as an ordinary item that carries a back-link (origin) to its source. Creates a new item, or returns the existing one if this external item was already imported. Returns the local tracker id and URN.",
    inputSchema: {
      type: "object" as const,
      properties: {
        providerId: {
          type: "string",
          description: "Importer id (e.g. 'github-issues')",
        },
        externalId: {
          type: "string",
          description: "The provider's id for the item (e.g. a GitHub issue number, from tracker_importer_search)",
        },
        primaryType: {
          type: "string",
          description: "Tracker type to create as (e.g. 'bug', 'task'). Defaults to the importer's first allowed type.",
        },
      },
      required: ["providerId", "externalId"],
    },
  },
  {
    name: "tracker_resnapshot",
    description:
      "Pull the latest from an imported item's external source and merge it conservatively: title/status update only if unchanged locally, labels union, and the body is flagged (never auto-overwritten) when upstream changed. Identify the item by its URN.",
    inputSchema: {
      type: "object" as const,
      properties: {
        urn: {
          type: "string",
          description: "External URN of the imported item, e.g. 'github://owner/repo#42'",
        },
      },
      required: ["urn"],
    },
  },
  {
    name: "tracker_get_by_urn",
    description:
      "Resolve the local tracker item for an external URN (e.g. 'github://owner/repo#42'). Returns the item if it has been imported, else null. Use to check whether an external item already exists locally.",
    inputSchema: {
      type: "object" as const,
      properties: {
        urn: {
          type: "string",
          description: "External URN, e.g. 'github://owner/repo#42' or 'linear://NIM-123'",
        },
      },
      required: ["urn"],
    },
  },
];

type TrackerListMode = 'list' | 'ready';

export async function handleTrackerList(
  args: any,
  workspacePath: string | undefined,
  mode: TrackerListMode = 'list',
): Promise<McpToolResult> {
  try {
    const requestedLimit = Number(args.limit);
    const limit = requestedLimit < 0
      ? 10_000
      : Math.min(Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 50, 250);
    // Register custom (.nimbalyst/trackers/*.yaml) types before any role/inbox
    // resolution runs. Without this, a custom type's workflowStatus role falls
    // back to `status` and its inbox/collection predicates answer wrongly --
    // and the answer would depend on whether an earlier tool warmed the registry.
    if (workspacePath) ensureWorkspaceTrackerSchemasLoaded(workspacePath);
    const { documentServices } = await import("../../window/WindowManager");
    let docService = workspacePath ? documentServices.get(workspacePath) : undefined;
    let tempDocService: { destroy?: () => void } | undefined;
    if (!docService && workspacePath) {
      const { ElectronDocumentService } = await import("../../services/ElectronDocumentService");
      docService = new ElectronDocumentService(workspacePath);
      tempDocService = docService;
    }
    const rawItems = docService ? await docService.listTrackerItems() : [];
    const readinessWasSet = args.readiness !== undefined;
    const requestedReadiness = args.readiness === 'ready' || args.readiness === 'blocked'
      ? args.readiness
      : 'any';
    const includeReadiness = mode === 'ready' || readinessWasSet || args.full === true;
    const full = args.full === true;

    // Built on first use and never at all for the calls that don't ask about
    // readiness, which is nearly all of them: a record projection of the whole
    // corpus plus a dependency-graph Tarjan pass is far too much to spend on
    // every tracker_list. It must keep reading `rawItems` -- the FULL corpus --
    // and never the filtered `items` below. Readiness computed over a list that
    // already dropped closed or archived items turns every satisfied blocker
    // into a dangling id, and every blocked item then reports ready.
    let readinessByItemId: Map<string, Readiness> | undefined;
    const getReadiness = (): Map<string, Readiness> => (
      readinessByItemId ??= computeReadiness(rawItems.map(trackerItemToRecord), getRecordStatus)
    );

    const getFieldValue = (item: TrackerItem, field: string): unknown => {
      const record = item as unknown as Record<string, unknown>;
      if (field === READINESS_FILTER_FIELD) {
        return getReadiness().get(item.id)?.state;
      }
      // The lifecycle category is synthetic -- no item stores it -- and it is
      // the only field a "not closed" clause can be written over uniformly,
      // because each type closes on a different status value. Kept in step with
      // the renderer's accessor by both routing through statusCategoryOfItem.
      if (field === STATUS_CATEGORY_FILTER_FIELD) {
        return statusCategoryOfItem(item.type, name => (
          record[name] !== undefined ? record[name] : item.customFields?.[name]
        ));
      }
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

    const ownerField = resolveFieldForFilter('assignee', 'owner');
    const statusField = resolveFieldForFilter('workflowStatus', 'status');
    const priorityField = resolveFieldForFilter('priority', 'priority');
    const searchTerm = args.search ? String(args.search).toLowerCase() : '';
    const rawItemById = new Map(rawItems.map((item) => [item.id, item]));
    const priorityRankByItemId = mode === 'ready'
      ? new Map(rawItems.map((item) => {
          const itemPriorityField = getTrackerRoleField(item.type, 'priority') ?? 'priority';
          const priority = String(getFieldValue(item, itemPriorityField) ?? '').toLowerCase();
          const options = priorityOptionsFor(item.type).map((option) => option.toLowerCase());
          const schemaRank = options.indexOf(priority);
          const fallbackRank = ['low', 'medium', 'high', 'critical'].indexOf(priority);
          return [item.id, schemaRank >= 0 ? schemaRank : fallbackRank] as const;
        }))
      : undefined;

    // Readiness stays derived over the full corpus above; what narrows here is
    // only what leaves the handler. The scoping filters -- type, archive, and
    // the workspace the caller named -- carve off items this caller chose not to
    // look at, and a blocker sitting in one of them must not hand back its title
    // or its private reference. Built on first use, alongside the readiness map
    // and for the same reason.
    let blockerScope: BlockerVisibilityScope | undefined;
    const getBlockerScope = (): BlockerVisibilityScope => (blockerScope ??= {
      type: typeof args.type === 'string' && args.type ? args.type : undefined,
      excludedItemIds: new Set(
        rawItems
          .filter((item) => (workspacePath !== undefined && item.workspace !== workspacePath)
            || fromDbBoolean(item.archived) !== Boolean(args.archived))
          .map((item) => item.id),
      ),
    });

    const readinessDetailsFor = (item: TrackerItem): {
      blockedBy: ProjectedBlockerRef[];
      unblocks: number;
      unresolvedBlockerIds?: string[];
    } => {
      const readiness = getReadiness().get(item.id);
      const blockedBy = (readiness?.blockedBy ?? []).map((blocker) => {
        const blockerItem = rawItemById.get(blocker.itemId);
        return blockerItem ? {
          ...blocker,
          ref: getTrackerDisplayRef(blockerItem),
          refStatus: issueKeyStatus(blockerItem),
        } : blocker;
      });
      const unresolvedBlockerIds = readiness?.unresolvedBlockerIds ?? [];
      return {
        blockedBy: projectBlockedBy(blockedBy, getBlockerScope()),
        unblocks: readiness?.unblocks ?? 0,
        // A declared dependency that resolves to nothing does not block, but
        // omitting it entirely leaves an item indistinguishable from genuinely
        // dependency-free work with a broken link nobody can see. Present only
        // when there is one: an empty array on every row of a long ready queue
        // costs more context than the rare warning is worth.
        ...(unresolvedBlockerIds.length > 0 ? { unresolvedBlockerIds } : {}),
      };
    };

    // A `where` clause with `=`/`!=` and an empty operand means "match items
    // whose field is empty" (the idiom before `is-empty` existed). The shared
    // matcher SKIPS a blank binary clause -- right for a half-typed grid filter,
    // wrong for an explicit API query -- so rewrite those to the unary ops here.
    // A caller who names a terminal status (or category, or a `where` clause
    // over the category) has asked for closed work, so the open-only default
    // must stand aside rather than silently return an empty list.
    const terminalCategories: StatusCategory[] = ['done', 'cancelled'];
    const asksForClosedCategory = terminalCategories.includes(
      String(args.statusCategory ?? '').toLowerCase() as StatusCategory,
    );
    const whereMentionsCategory = (Array.isArray(args.where) ? args.where : [])
      .some((clause: any) => clause?.field === STATUS_CATEGORY_FILTER_FIELD);
    const includeClosed = args.includeClosed === true
      || asksForClosedCategory
      || whereMentionsCategory
      || (typeof args.status === 'string' && args.status.trim() !== ''
        && isTerminalStatus(String(args.type ?? ''), args.status));

    const whereClauses = (Array.isArray(args.where) ? args.where : []).map((clause: any) => {
      if (clause && (clause.op === '=' || clause.op === '!=')
        && (clause.value === '' || clause.value === null || clause.value === undefined)) {
        return { field: clause.field, op: clause.op === '=' ? 'is-empty' : 'is-not-empty' };
      }
      return clause;
    });

    const items = rawItems
      .filter((item) => !workspacePath || item.workspace === workspacePath)
      .filter((item) => fromDbBoolean(item.archived) === Boolean(args.archived))
      .filter((item) => !args.type || item.type === args.type)
      .filter((item) => !args.typeTag || (item.typeTags || [item.type]).includes(args.typeTag))
      .filter((item) => {
        if (!args.owner) return true;
        return String(getFieldValue(item, ownerField) ?? '') === String(args.owner);
      })
      .filter((item) => {
        if (!args.status) return true;
        return String(getFieldValue(item, statusField) ?? '').toLowerCase() === String(args.status).toLowerCase();
      })
      .filter((item) => {
        if (!args.statusCategory) return true;
        return statusCategoryOfItem(item.type, name => getFieldValue(item, name))
          === String(args.statusCategory).toLowerCase();
      })
      .filter((item) => {
        // Open-only by default. An explicit request for closed work -- via
        // includeClosed, a terminal `status`, or a terminal `statusCategory` --
        // turns it off: asking for done items and being handed nothing would be
        // the one failure this default must never produce.
        if (includeClosed) return true;
        return !isTerminalStatus(item.type, String(getFieldValue(item, statusField) ?? ''));
      })
      .filter((item) => {
        if (!args.priority) return true;
        return String(getFieldValue(item, priorityField) ?? '').toLowerCase() === String(args.priority).toLowerCase();
      })
      .filter((item) => requestedReadiness === 'any'
        || getReadiness().get(item.id)?.state === requestedReadiness)
      .filter((item) => {
        if (!args.inbox) return true;
        // The same predicate the triage inbox renders, so "what still needs a
        // decision?" means one thing to an agent and to the UI. Snoozes are
        // personal and deliberately not applied here.
        // Roles resolve per record, not per `args.type`: a global inbox spans
        // types that name the same role differently.
        return isUntriaged(trackerItemToRecord(item), {
          getStatus: (record) => String(record.fields[resolveRoleFieldName(record.primaryType, 'workflowStatus')] ?? ''),
          getPriority: (record) => String(record.fields[resolveRoleFieldName(record.primaryType, 'priority')] ?? ''),
          getAssignee: (record) => record.fields[resolveRoleFieldName(record.primaryType, 'assignee')],
        });
      })
      .filter((item) => {
        if (whereClauses.length === 0) return true;
        // Shared with the grid's column filters and saved views, so an agent
        // query and a saved view are literally the same filter object.
        return matchesFilterSet(
          { combinator: args.whereCombinator === 'or' ? 'or' : 'and', clauses: whereClauses },
          (field) => getFieldValue(item, field),
        );
      })
      .filter((item) => {
        if (!searchTerm) return true;
        const haystack = [
          item.issueKey,
          String(item.issueNumber ?? ''),
          item.title,
          item.description,
          item.module,
          Array.isArray(item.tags) ? item.tags.join(' ') : '',
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(searchTerm);
      })
      .sort((a, b) => {
        if (mode === 'ready') {
          const leverage = (getReadiness().get(b.id)?.unblocks ?? 0)
            - (getReadiness().get(a.id)?.unblocks ?? 0);
          if (leverage !== 0) return leverage;
          const priority = (priorityRankByItemId?.get(b.id) ?? -1)
            - (priorityRankByItemId?.get(a.id) ?? -1);
          if (priority !== 0) return priority;
        }
        return String(b.updated || '').localeCompare(String(a.updated || ''));
      })
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        issueNumber: item.issueNumber ?? undefined,
        issueKey: getAssignedIssueKey(item),
        localKey: item.localKey ?? undefined,
        issueKeyStatus: issueKeyStatus(item),
        type: item.type,
        typeTags: item.typeTags && item.typeTags.length > 0 ? item.typeTags : [item.type],
        title: item.title || '',
        status: item.status || '',
        priority: item.priority || '',
        tags: item.tags || [],
        customFields: item.customFields || {},
        archived: item.archived ?? false,
        source: item.source || 'native',
        sourceRef: item.sourceRef,
        syncStatus: item.syncStatus || 'local',
        workspace: item.workspace,
        module: item.module,
        lineNumber: item.lineNumber,
        created: item.created,
        updated: item.updated,
        linkedSessions: item.linkedSessions,
        linkedCommitSha: item.linkedCommitSha,
        origin: item.origin,
        ...(includeReadiness ? readinessDetailsFor(item) : {}),
        ...(mode === 'ready' ? {
          trackId: getReadiness().get(item.id)?.trackId ?? item.id,
        } : {}),
      }));

    const readyTrackOrder = new Map<string, number>();
    if (mode === 'ready') {
      for (const item of items) {
        const trackId = (item as any).trackId as string;
        if (!readyTrackOrder.has(trackId)) readyTrackOrder.set(trackId, readyTrackOrder.size);
      }
      items.sort((a: any, b: any) => (
        (readyTrackOrder.get(a.trackId) ?? 0) - (readyTrackOrder.get(b.trackId) ?? 0)
      ));
    }

    const cycleItems = mode === 'ready'
      ? rawItems
          .filter((item) => !workspacePath || item.workspace === workspacePath)
          .filter((item) => fromDbBoolean(item.archived) === false)
          .filter((item) => !args.type || item.type === args.type)
          .filter((item) => getReadiness().get(item.id)?.inCycle)
          .map((item) => ({
            id: item.id,
            ref: getTrackerDisplayRef(item),
            refStatus: issueKeyStatus(item),
            type: item.type,
            title: item.title || '',
            status: item.status || '',
            issueKey: getAssignedIssueKey(item),
            localKey: item.localKey ?? undefined,
          }))
      : [];
    tempDocService?.destroy?.();

    // The ref is whatever actually resolves: a room key, else this machine's
    // number, else the raw id. Explaining the absence is only worth a line when
    // there is no number either -- repeating the private-number caveat on every
    // row of a long list would drown the list it is annotating.
    const listCanIssueKeys = isTrackerSyncConfigured(workspacePath);
    const localKeyMessage = localIssueKeyResponseMessage([
      ...items,
      ...items.flatMap((item: any) => item.blockedBy
        ?.filter((blocker: any) => blocker.refStatus === 'local')
        .map((blocker: any) => ({ localKey: blocker.ref })) ?? []),
      ...cycleItems,
    ], { canIssueKeys: listCanIssueKeys });
    const formatSummaryItem = (item: any): string =>
      `- [${item.type}] ${item.title} (${item.status || "no status"}, ${item.priority || "no priority"}, ${item.syncStatus}) [ref: ${getTrackerDisplayRef(item)}]${item.issueKeyStatus === 'unassigned' ? ` — ${issueKeyMessage(item, { canIssueKeys: listCanIssueKeys })}` : ''}`;
    const summary = mode === 'ready'
      ? [...readyTrackOrder.keys()]
          .map((trackId) => `Track ${trackId}:\n${items
            .filter((item: any) => item.trackId === trackId)
            .map(formatSummaryItem)
            .join('\n')}`)
          .join('\n\n')
      : items.map(formatSummaryItem).join("\n");

    const filters: Record<string, string> = {};
    if (args.type) filters.type = args.type;
    if (args.typeTag) filters.typeTag = args.typeTag;
    if (args.status) filters.status = args.status;
    if (args.priority) filters.priority = args.priority;
    if (args.owner) filters.owner = args.owner;
    if (args.search) filters.search = args.search;
    if (args.inbox) filters.inbox = 'true';
    if (readinessWasSet || mode === 'ready') filters.readiness = requestedReadiness;

    // Lean by default so an ordinary agent list stays small; `full` adds the
    // heavy fields (custom fields, links, origin) the CLI/export path needs.
    // Passing every stored field on every list was a large, silent token cost.
    const structured = {
      action: "listed" as const,
      filters,
      count: items.length,
      items: items.map((item: any) => ({
        id: item.id,
        issueNumber: item.issueNumber,
        issueKey: item.issueKey,
        localKey: item.localKey,
        issueKeyStatus: item.issueKeyStatus,
        type: item.type,
        typeTags: item.typeTags,
        title: item.title,
        status: item.status,
        priority: item.priority,
        tags: item.tags,
        archived: item.archived,
        source: item.source,
        syncStatus: item.syncStatus,
        updated: item.updated,
        ...(includeReadiness ? {
          blockedBy: item.blockedBy,
          unblocks: item.unblocks,
          ...(item.unresolvedBlockerIds ? { unresolvedBlockerIds: item.unresolvedBlockerIds } : {}),
        } : {}),
        ...(mode === 'ready' ? { trackId: item.trackId } : {}),
        ...(full ? {
          customFields: item.customFields,
          sourceRef: item.sourceRef,
          workspace: item.workspace,
          module: item.module,
          lineNumber: item.lineNumber,
          created: item.created,
          linkedSessions: item.linkedSessions,
          linkedCommitSha: item.linkedCommitSha,
          origin: item.origin,
        } : {}),
      })),
      ...(mode === 'ready' ? {
        trackCount: readyTrackOrder.size,
        dependencyCycleItems: cycleItems.map(({
          issueKey: _issueKey,
          localKey: _localKey,
          ...item
        }) => item),
      } : {}),
    };

    const cycleSummary = cycleItems.length > 0
      ? `\n\n${cycleItems.length} open item(s) are in a dependency cycle and cannot appear in this queue:\n${cycleItems.map((item) => `- [${item.type}] ${item.title} [ref: ${item.ref}]`).join('\n')}`
      : '';
    const localKeySummary = localKeyMessage ? `\n\nIssue key note: ${localKeyMessage}` : '';
    // Once per response, not per row -- same call the private-number caveat
    // makes. Counted over distinct targets, because one deleted item cited by
    // three dependents is one broken link to go and fix.
    const unresolvedBlockerCount = new Set(
      items.flatMap((item: any) => item.unresolvedBlockerIds ?? []),
    ).size;
    const unresolvedBlockerSummary = unresolvedBlockerCount > 0
      ? `\n\nBroken dependency links: ${describeUnresolvedBlockers(unresolvedBlockerCount)} The targets are listed as \`unresolvedBlockerIds\` on the items that declare them.`
      : '';
    const trackAvailabilitySummary = mode === 'ready'
      ? `${readyTrackOrder.size} independent track${readyTrackOrder.size === 1 ? '' : 's'} available. ${TRACKER_TRACKS_EXPLANATION}\n\n`
      : '';

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured,
            summary: trackAvailabilitySummary + (items.length > 0
              ? `Found ${items.length} tracker item(s):\n\n${summary}${cycleSummary}${unresolvedBlockerSummary}${localKeySummary}`
              : `No tracker items found matching the filters.${cycleSummary}${unresolvedBlockerSummary}${localKeySummary}`),
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

export function handleTrackerReady(
  args: { type?: string; limit?: number },
  workspacePath: string | undefined,
): Promise<McpToolResult> {
  const requestedLimit = Number(args.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 250)
    : undefined;
  return handleTrackerList(
    { type: args.type, limit, readiness: 'ready' },
    workspacePath,
    'ready',
  );
}

export async function handleWorkRadar(
  args: { windowHours?: number; issueKey?: string },
  workspacePath?: string,
): Promise<McpToolResult> {
  let tempDocService: { destroy?: () => void } | undefined;
  try {
    if (workspacePath) ensureWorkspaceTrackerSchemasLoaded(workspacePath);
    const { documentServices } = await import('../../window/WindowManager');
    let docService = workspacePath ? documentServices.get(workspacePath) : undefined;
    if (!docService && workspacePath) {
      const { ElectronDocumentService } = await import('../../services/ElectronDocumentService');
      docService = new ElectronDocumentService(workspacePath);
      tempDocService = docService;
    }
    const reference = args.issueKey?.trim().toLowerCase();
    const rawItems = docService ? await docService.listTrackerItems() : [];
    const selected = reference
      ? rawItems.filter((item) => [item.issueKey, item.localKey, item.id]
          .some((value) => value?.toLowerCase() === reference))
      : rawItems;
    const radar = buildTrackerRadar(selected.map(trackerItemToRecord), {
      windowHours: args.windowHours,
      currentIdentity: getCurrentIdentity(workspacePath),
      getTitle: getRecordTitle,
      getStatus: getRecordStatus,
    });
    const allThreads = radar.lanes.flatMap((lane) => lane.marks.map((mark) => ({
      actor: lane.actor.displayName,
      title: mark.label,
      issueKey: mark.kind === 'thread' ? mark.items[0]?.issueKey : undefined,
      itemIds: mark.itemIds,
      state: mark.state,
      lastActivityAt: mark.lastActivityAt,
      agentDriven: mark.agentDriven,
    }))).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const allSameItem = radar.ties.map((tie) => ({
      issueKey: tie.issueKey,
      itemId: tie.itemId,
      actors: [
        radar.lanes.find((lane) => lane.actorKey === tie.fromActorKey)?.actor.displayName,
        radar.lanes.find((lane) => lane.actorKey === tie.toActorKey)?.actor.displayName,
      ].filter((value): value is string => Boolean(value)),
      kind: tie.type,
    }));
    // A bare session-start read can span thousands of items. Preserve every
    // issue-scoped result, but bound the team-wide payload so the coordination
    // check does not consume the context it is meant to protect.
    const threads = reference ? allThreads : allThreads.slice(0, 50);
    const sameItem = reference ? allSameItem : allSameItem.slice(0, 20);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          structured: {
            windowHours: radar.windowHours,
            totalThreads: allThreads.length,
            threads,
            sameItem,
            waitingOnYou: radar.waitingOnYou.slice(0, 20),
            youHandedOff: radar.youHandedOff.slice(0, 20),
            truncated: threads.length < allThreads.length || sameItem.length < allSameItem.length,
          },
          summary: reference && selected.length === 0
            ? `No tracker item matched ${args.issueKey}.`
            : `${allThreads.length} recent work thread${allThreads.length === 1 ? '' : 's'} across ${radar.lanes.length} actor lane${radar.lanes.length === 1 ? '' : 's'}; ${allSameItem.length} shared-item signal${allSameItem.length === 1 ? '' : 's'}.`,
        }),
      }],
      isError: false,
    };
  } catch (error) {
    console.error('[MCP Server] work_radar failed:', error);
    return {
      content: [{ type: 'text', text: `Error reading work radar: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  } finally {
    tempDocService?.destroy?.();
  }
}

export async function handleTrackerGet(
  args: any,
  workspacePath?: string,
): Promise<McpToolResult> {
  try {
    // Local issue keys are short-lived and reused after the server replaces
    // them. Looking one up by key can therefore return a different item than
    // the caller intended; the stable item id is the only safe fallback.
    if (isLocalIssueKey(args.id)) {
      return {
        content: [
          {
            type: "text",
            text: `Provisional tracker key cannot be resolved safely: ${args.id}. Re-read the item using its stable ID.`,
          },
        ],
        isError: true,
      };
    }

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
        // Match the local number too. `tracker_create` hands one back as the
        // item's ref, so refusing to resolve it here makes the tool contradict
        // itself one call later.
        item = all.find(candidate => candidate.issueKey === args.id
          || candidate.localKey === args.id) || null;
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
    const assignedIssueKey = getAssignedIssueKey(item);
    const getCanIssueKeys = isTrackerSyncConfigured(workspacePath);
    // Show the reference that resolves, then explain what kind it is. Printing
    // the message *instead of* the number was the #1346 symptom: an item with
    // `NIM.75` sitting in `local_key` reported that it had no key at all.
    //
    // `resolveDisplayIssueKey`, not `getTrackerDisplayRef`: the latter falls
    // back to the raw row id, and an id dressed up as a key is exactly what
    // TRACKER_SCHEMA_SHARING.md forbids on this line. With no key of either
    // kind the message stands alone, as before.
    const getDisplayKey = resolveDisplayIssueKey(item);
    const getIssueKeyMessage = issueKeyMessage(item, { canIssueKeys: getCanIssueKeys });
    lines.push(`**Issue Key**: ${getDisplayKey ?? getIssueKeyMessage}`);
    if (getDisplayKey && getIssueKeyMessage) {
      lines.push(`**Issue Key Note**: ${getIssueKeyMessage}`);
    }
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
    // Schema-defined custom fields (e.g. github-pr's prNumber/author/branches)
    // live in customFields, not on the known-field whitelist above. Render them
    // so cold readers see them in the summary as well as the structured payload.
    // Drop internal/system keys that leak into the bag (sync bookkeeping or
    // values already rendered as top-level fields) so only genuine schema
    // fields surface.
    const internalCustomFieldKeys = new Set([
      "typeTags",
      "issueNumber",
      "issueKey",
      "archived",
      "source",
      "syncStatus",
      "bodyVersion",
      "labelsMap",
      "activity",
      "comments",
      "linkedSessions",
    ]);
    const displayCustomFields: Record<string, any> = {};
    if (item.customFields) {
      for (const [key, value] of Object.entries(item.customFields)) {
        if (value === undefined || value === null) continue;
        if (internalCustomFieldKeys.has(key)) continue;
        displayCustomFields[key] = value;
      }
    }
    for (const [key, value] of Object.entries(displayCustomFields)) {
      const rendered =
        typeof value === "object" ? JSON.stringify(value) : String(value);
      lines.push(`**${key}**: ${rendered}`);
    }
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
        issueKey: assignedIssueKey,
        localKey: item.localKey ?? undefined,
        issueKeyStatus: issueKeyStatus(item),
        ...(getIssueKeyMessage ? { issueKeyMessage: getIssueKeyMessage } : {}),
        type: item.type,
        typeTags: item.typeTags && item.typeTags.length > 0 ? item.typeTags : [item.type],
        title: item.title || "Untitled",
        status: item.status || undefined,
        priority: item.priority || undefined,
        tags: item.tags || [],
        owner: item.owner || undefined,
        dueDate: item.dueDate || undefined,
        // #1224: without these the tool contradicts its own mutations -- an
        // agent that archived an item read it back as active, and comments
        // arrive in customFields, which the filter below strips.
        // `fromDbBoolean`: the flag is INTEGER on SQLite, boolean on PGLite.
        archived: fromDbBoolean(item.archived),
        archivedAt: item.archivedAt || undefined,
        comments: item.customFields?.comments || undefined,
        // Surface schema-defined custom fields (e.g. github-pr's prNumber) that
        // are otherwise dropped by the known-field whitelist above. Uses the
        // same internal-key filtering as the summary so the bag is clean.
        customFields:
          Object.keys(displayCustomFields).length > 0
            ? displayCustomFields
            : undefined,
      },
    };
    tempDocService?.destroy?.();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured,
            summary: lines.join("\n") + trackerRadarAdvisory(item, workspacePath),
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

/**
 * Refuse an agent write that promotes an item past review. Agents may move work
 * to `in-review`; only a person approves it. Returns the error result to send
 * back, or null when the write is allowed.
 */
function rejectHumanOnlyStatus(args: any, trackerType?: string): McpToolResult | null {
  const workflowFields = new Set<string>(['status']);
  const models = trackerType
    ? [globalRegistry.get(trackerType)].filter(Boolean)
    : globalRegistry.getAll();
  for (const model of models) {
    const fieldName = model
      ? getTrackerRoleField(model.type, 'workflowStatus') ?? 'status'
      : 'status';
    workflowFields.add(fieldName);
  }

  const candidates = [args?.status];
  if (args?.fields && typeof args.fields === 'object') {
    for (const fieldName of workflowFields) {
      candidates.push(args.fields[fieldName]);
    }
  }
  const blocked = candidates.find((value) => isHumanOnlyStatus(value));
  if (!blocked) return null;
  return {
    content: [{ type: "text", text: humanOnlyStatusMessage(String(blocked)) }],
    isError: true,
  };
}

export async function handleTrackerCreate(
  args: any,
  workspacePath: string | undefined,
  sessionId?: string | undefined
): Promise<McpToolResult> {
  try {
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

    // Make custom (.nimbalyst/trackers/*.yaml) types visible to the registry so
    // type validation below accepts them (NIM-760).
    ensureWorkspaceTrackerSchemasLoaded(workspacePath);

    const humanOnly = rejectHumanOnlyStatus(args, args.type);
    if (humanOnly) return humanOnly;

    const issueOverlayResult = await handleGithubIssueOverlayCreate(
      args,
      workspacePath,
      Boolean(sessionId && args.linkSession === true),
      {
        linkSession: (itemId) =>
          handleTrackerLinkSession({ trackerId: itemId }, sessionId, workspacePath),
        notifyAdded: (itemId) => notifyTrackerItemAdded(workspacePath, itemId),
        notifyUpdated: (itemId) => notifyTrackerItemUpdated(workspacePath, itemId),
      },
    );
    if (issueOverlayResult) return issueOverlayResult;

    const { getDatabase } = await import("../../database/initialize");
    const db = getDatabase();

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
    const sharingPolicy = workspacePath
      ? getEffectiveTrackerSharingPolicy(workspacePath, args.type, model)
      : { sharing: 'personal' as const, draftByDefault: false };
    // `syncStatus` is computed after `data` is assembled below because a team
    // tracker's Draft/Published decision depends on the existing share flag.

    // Callers may supply an explicit id (e.g. external imports derive a
    // deterministic, URN-based id so two clients importing the same upstream
    // item converge on one row at the sync `ON CONFLICT (id)` layer instead of
    // creating duplicates). Otherwise allocate the usual random id.
    const id =
      typeof args.id === 'string' && args.id.trim()
        ? args.id.trim()
        : `${args.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Resolve field names via schema roles so that fixed MCP args
    // (title, status, priority, etc.) are placed at the correct field name
    // for the target schema. E.g., a schema with roles: { title: 'name' }
    // will store args.title in data.name.
    const rf = (role: string, fallback: string) => getTrackerRoleField(args.type, role as any) ?? fallback;
    const titleField = rf('title', 'title');
    const statusField = rf('workflowStatus', 'status');
    const priorityField = rf('priority', 'priority');

    // Default the initial status from the schema, not a hardcoded "to-do".
    // Types whose status options don't include "to-do" (plan -> 'draft',
    // idea -> 'new', milestone -> 'planned') would otherwise start on an
    // out-of-schema status.
    const statusFieldDef = model?.fields?.find((f) => f.name === statusField);
    const defaultStatus =
      (typeof statusFieldDef?.default === 'string' && statusFieldDef.default) || 'to-do';

    const data: Record<string, any> = {
      [titleField]: args.title,
      [statusField]: args.status || defaultStatus,
      [priorityField]: args.priority || "medium",
      created: new Date().toISOString().split("T")[0],
      authorIdentity,
      // Imports pass createdByAgent: false (the item is mirrored from upstream,
      // not authored by the agent). MCP tool callers default to true.
      createdByAgent: args.createdByAgent !== undefined ? args.createdByAgent : true,
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

    // Auto-populate required self-identifier fields (e.g. plan.planId,
    // decision.decisionId) that the schema marks required but no MCP caller
    // ever supplies. These are non-inline string fields; seed them with the
    // item id so they're stable and unique. Without this, full-document types
    // fail schema validation and cannot be created via tracker_create at all.
    for (const f of model?.fields ?? []) {
      if (f.required && f.type === 'string' && f.displayInline === false && data[f.name] === undefined) {
        data[f.name] = id;
      }
    }

    // Canonicalize + validate relationship fields (Epic C) before persistence.
    const relWrite = applyRelationshipFieldWrites(data, globalRegistry.get(args.type)?.fields ?? [], id);
    if (!relWrite.ok) {
      return {
        content: [{ type: 'text', text: `Invalid relationship field "${relWrite.field}": ${relWrite.errors.join('; ')}` }],
        isError: true,
      };
    }

    const validationResult = globalRegistry.validate(args.type, data);
    if (!validationResult.valid) {
      return buildTrackerSchemaValidationError('tracker_create', args.type, validationResult.errors);
    }

    // Per-item sync decision (NIM-876): team drafts sync only once published, so
    // the initial status depends on the assembled `data` (its share flag).
    const syncStatus = getInitialTrackerSyncStatus(sharingPolicy, data);

    // Record creation activity
    appendActivity(data, authorIdentity, 'created');

    // Structured origin (external-source importers). Provenance lives entirely
    // in data.origin (and the data.origin.external.urn index). The legacy
    // `source` column stays 'native' for external imports on purpose: imported
    // items ARE native DB items (no file backing), and code paths like
    // handleTrackerUpdate treat source==='import' as file-backed. Only
    // inline/frontmatter (genuinely file-backed) map onto the legacy column.
    if (args.origin) {
      data.origin = args.origin;
    }
    const originSource: string =
      args.origin?.kind === 'inline'
        ? 'inline'
        : args.origin?.kind === 'frontmatter'
          ? 'frontmatter'
          : 'native';
    const originSourceRef: string | null =
      args.origin?.kind === 'inline' || args.origin?.kind === 'frontmatter'
        ? args.origin.filePath
        : null;

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
      ) VALUES ($1, $2, $3, $4, $5, '', NULL, NOW(), NOW(), NOW(), $6, $7, FALSE, $8, $9)`,
      [id, args.type, typeTags, JSON.stringify(data), workspacePath, syncStatus, contentJson, originSource, originSourceRef]
    );

    // Number the row before it is read back, so an agent-created item reports
    // its key in this tool's own result rather than only after the next list
    // sweep. Failure is not fatal -- an unnumbered item still works, and the
    // list will pick it up.
    if (workspacePath) {
      try {
        await assignLocalKeysToRows(db, workspaceLocalKeyStore, workspacePath, [id]);
      } catch (error) {
        console.error('[MCP Server] tracker_create local number assignment failed:', error);
      }
    }

    let createdRow = await resolveTrackerRowByReference(db, id, workspacePath);
    let createdItem = createdRow ? rowToTrackerItem(createdRow) : null;

    if (
      createdItem &&
      workspacePath &&
      shouldSyncTrackerItem(sharingPolicy, data) &&
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

    // Route the description through the canonical body path so it shows up
    // in the editor when the item is opened. The initial INSERT above sets
    // `content` for backward compatibility, but that column alone is not
    // enough: without this block `body_version` stays at 0,
    // `tracker_body_cache` is never populated, and the live
    // DocumentRoom Y.Doc is never seeded -- so the collaborative editor
    // mounts empty. This mirrors `ElectronDocumentService.updateTrackerItemContent`
    // inline so we do not depend on `documentServices` having an entry for
    // this workspace (which is empty after a main-process hot-reload until
    // the first window finishes wiring up).
    let bodyWriteResult: BodyWriteFailure | undefined;
    if (descriptionText) {
      let localSnapshotStored = false;
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
        localSnapshotStored = true;

        // Re-sync metadata so peers learn the bodyVersion bump (cold readers
        // invalidate their cache and refetch from `tracker_body_cache`).
        if (shouldSyncTrackerItem(sharingPolicy, data) && isTrackerSyncActive(workspacePath)) {
          createdRow = await resolveTrackerRowByReference(db, id, workspacePath);
          createdItem = createdRow ? rowToTrackerItem(createdRow) : createdItem;
          if (createdItem) {
            await syncTrackerItem(createdItem);
          }
        }

        // Seed the live DocumentRoom Y.Doc so the collaborative editor mounts
        // with content instead of waiting on a never-bootstrapped room. No-op
        // for local trackers (resolveConfig returns null without a team).
        const collaborativeBodyStored = await applyHeadlessBodyMarkdown(workspacePath, id, descriptionText);
        if (
          collaborativeBodyStored === false &&
          shouldSyncTrackerItem(sharingPolicy, data)
        ) {
          bodyWriteResult = bodyWriteFailure(true);
          console.error('[MCP Server] tracker_create collaborative body write failed:', {
            itemId: id,
            workspacePath,
          });
        }
      } catch (bodyError) {
        bodyWriteResult = bodyWriteFailure(localSnapshotStored);
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
      const linkedIds = readLinkedTrackerItemIds(sessionResult.rows[0]?.metadata);
      await notifySessionLinkedTrackerChanged(sessionId, linkedIds);
    }

    // Notify renderer of the new item (correct channel + event format)
    await notifyTrackerItemAdded(workspacePath, id);
    trackMcpTrackerMutation(
      'created',
      id,
      args.type,
      shouldSyncTrackerItem(sharingPolicy, data),
    );

    // Only a published team item can receive a key. The room owns the team's
    // single sequence, so wait briefly for its assignment without ever minting
    // a client-side placeholder. Personal items and drafts skip this entirely.
    if (
      shouldSyncTrackerItem(sharingPolicy, data) &&
      isTrackerSyncActive(workspacePath) &&
      !getAssignedIssueKey(createdItem || {})
    ) {
      try {
        const serverKey = await awaitServerIssueKey(db, id);
        if (serverKey) {
          createdRow = await resolveTrackerRowByReference(db, id, workspacePath);
          createdItem = createdRow ? rowToTrackerItem(createdRow) : createdItem;
        }
      } catch (awaitError) {
        console.error('[MCP Server] tracker_create issue key wait failed:', awaitError);
      }
    }

    const createdRef = createdItem || { id };
    const createdKeyContext = {
      published: shouldSyncTrackerItem(sharingPolicy, data),
      canIssueKeys: isTrackerSyncConfigured(workspacePath),
    };
    const createdKeyMessage = issueKeyMessage(createdRef, createdKeyContext);
    const structured = {
      action: "created" as const,
      item: {
        id,
        issueNumber: createdItem?.issueNumber,
        issueKey: getAssignedIssueKey(createdRef),
        localKey: createdRef.localKey ?? undefined,
        issueKeyStatus: issueKeyStatus(createdRef),
        ...(createdKeyMessage ? { issueKeyMessage: createdKeyMessage } : {}),
        type: args.type,
        typeTags,
        title: data[titleField],
        status: data[statusField],
        priority: data[priorityField],
        tags: data.tags || [],
      },
      ...(bodyWriteResult ? { bodyWrite: bodyWriteResult } : {}),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured,
            summary: `Created tracker item:\n- **Type**: ${args.type}\n- **Title**: ${data[titleField]}\n- **Status**: ${data[statusField]}\n- **Ref**: ${getTrackerDisplayRef(createdRef)}\n- **ID**: ${id}${issueKeyAvailabilityNote(createdRef, createdKeyContext)}${bodyWriteResult ? `\n- **Body write**: Failed — ${bodyWriteResult.message}` : ''}${trackerRadarAdvisory(createdItem, workspacePath)}`,
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
    // NIM-438: a description delivered via the generic fields bag
    // (fields.description) must update the canonical visible body the same way
    // a top-level `description` does. The body-seed path keys off
    // args.description, so hoist fields.description up to the top level (and
    // drop it from the bag to avoid a redundant data.description write) before
    // any field processing runs.
    if (
      args &&
      args.fields &&
      typeof args.fields === 'object' &&
      args.fields.description !== undefined &&
      args.description === undefined
    ) {
      args.description = args.fields.description;
      delete args.fields.description;
    }

    // Make custom (.nimbalyst/trackers/*.yaml) types visible so primaryType
    // reassignment and schema validation accept them (NIM-760).
    ensureWorkspaceTrackerSchemasLoaded(workspacePath);

    // Updates name only an item id, so inspect all registered workflow-role
    // field names. This keeps the approval boundary fail-closed before opening
    // the database even when a custom schema calls the field something else.
    const humanOnly = rejectHumanOnlyStatus(args);
    if (humanOnly) return humanOnly;

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

      if (args.published !== undefined) {
        return await handleTrackerPublicationUpdate(args, item, workspacePath, db, docService, rowToTrackerItem);
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

        // NIM-879: linking is opt-in on update, matching tracker_create (NIM-408).
        // Without this gate, every status/field update silently linked the ambient
        // session, polluting sessions with unrelated items the agent merely touched.
        if (sessionId && args.linkSession === true) {
          const linked = await createBidirectionalLink(publicTrackerId, sessionId, {
            trackerRowId: storageRowId,
          });
          if (linked) {
            const sessionResult = await db.query<any>(
              `SELECT metadata FROM ai_sessions WHERE id = $1`,
              [sessionId]
            );
            const linkedIds = readLinkedTrackerItemIds(sessionResult.rows[0]?.metadata);
            await notifySessionLinkedTrackerChanged(sessionId, linkedIds);
          }
        }

        if (row) {
          await notifyTrackerItemUpdated(workspacePath, row.id);
        }

        if (row && workspacePath) {
          const updateModel = globalRegistry.get(refreshedItem.type);
          const sharingPolicy = getEffectiveTrackerSharingPolicy(workspacePath, refreshedItem.type, updateModel);
          if (shouldSyncTrackerItem(sharingPolicy, refreshedItem)) {
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

        const fileBackedPolicy = getEffectiveTrackerSharingPolicy(
          workspacePath ?? refreshedItem.workspace,
          refreshedItem.type,
          globalRegistry.get(refreshedItem.type),
        );
        trackMcpTrackerMutation(
          args.status !== undefined
            ? 'status_changed'
            : args.owner !== undefined || args.assigneeEmail !== undefined || args.assigneeId !== undefined
              ? 'assigned'
              : 'field_changed',
          refreshedItem.id,
          refreshedItem.type,
          shouldSyncTrackerItem(fileBackedPolicy, refreshedItem),
        );

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
                  issueKey: getAssignedIssueKey(refreshedItem),
                  localKey: refreshedItem.localKey ?? undefined,
                  issueKeyStatus: issueKeyStatus(refreshedItem),
                  type: refreshedItem.type,
                  typeTags: refreshedItem.typeTags && refreshedItem.typeTags.length > 0
                    ? refreshedItem.typeTags
                    : [refreshedItem.type],
                  title: refreshedItem.title || '',
                  changes,
                },
                summary: [
                  `Updated tracker item ${getTrackerDisplayRef(refreshedItem)}:`,
                  ...updateSummaryParts,
                ].join('\n') + issueKeyAvailabilityNote(refreshedItem, {
                  canIssueKeys: isTrackerSyncConfigured(workspacePath),
                }) + trackerRadarAdvisory(refreshedItem, workspacePath),
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
      // Snapshot the pre-update data (deep copy) so inverse relationship
      // propagation can diff added/dropped targets after `data` is mutated below.
      // The diff read is customFields-aware, so the nested synced shape is fine.
      const oldDataSnapshot: Record<string, unknown> = JSON.parse(JSON.stringify(data));
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
      const explicitlyWrittenFields = new Set<string>();
      const explicitlyUnsetFields = new Set<string>();

      if (args.tags !== undefined && !Array.isArray(args.tags)) {
        args.tags = [];
      }

      for (const [argName, role, fallback] of roleMap) {
        if (args[argName] !== undefined) {
          const fieldName = rf(role, fallback);
          const oldVal = data[fieldName];
          changes[fieldName] = { from: oldVal, to: args[argName] };
          data[fieldName] = args[argName];
          explicitlyWrittenFields.add(fieldName);
        }
      }

      if (args.assigneeEmail !== undefined) {
        data.assigneeEmail = args.assigneeEmail;
        if (args.owner === undefined) {
          const ownerField = rf('assignee', 'owner');
          changes[ownerField] = { from: data[ownerField], to: args.assigneeEmail };
          data[ownerField] = args.assigneeEmail;
          explicitlyWrittenFields.add(ownerField);
        }
      }
      if (args.description !== undefined) {
        const normalizedDesc = args.description.replace(/\\n/g, '\n');
        changes.description = { from: data.description, to: normalizedDesc };
        data.description = normalizedDesc;
      }
      if (args.labels !== undefined) { data.labels = args.labels; }
      if (args.linkedCommitSha !== undefined) { data.linkedCommitSha = args.linkedCommitSha; }
      // Structured origin refresh (external-source re-snapshot). Merged into the
      // data JSONB so the source chip + URN index stay current.
      if (args.origin !== undefined) { data.origin = args.origin; }
      if (args.archived !== undefined) {
        changes.archived = { from: row.archived ?? false, to: args.archived };
      }
      if (args.fields && typeof args.fields === 'object') {
        for (const [key, value] of Object.entries(args.fields)) {
          if (value === undefined) continue;
          const oldVal = readStoredFieldValue(data, key);
          if (oldVal !== value) {
            changes[key] = { from: oldVal, to: value };
          }
          data[key] = value;
          explicitlyWrittenFields.add(key);
        }
      }
      if (args.unsetFields && Array.isArray(args.unsetFields)) {
        for (const key of args.unsetFields) {
          const oldVal = readStoredFieldValue(data, key);
          if (oldVal === undefined) continue;
          changes[key] = { from: oldVal, to: undefined };
          delete data[key];
          if (data.customFields && typeof data.customFields === 'object' && !Array.isArray(data.customFields)) {
            delete (data.customFields as Record<string, unknown>)[key];
          }
          explicitlyUnsetFields.add(key);
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

      // Canonicalize + validate relationship fields (Epic C) before persistence.
      const relWrite = applyRelationshipFieldWrites(data, globalRegistry.get(row.type)?.fields ?? [], row.id);
      if (!relWrite.ok) {
        return {
          content: [{ type: 'text', text: `Invalid relationship field "${relWrite.field}": ${relWrite.errors.join('; ')}` }],
          isError: true,
        };
      }

      const validationResult = globalRegistry.validate(row.type, data);
      if (!validationResult.valid) {
        return buildTrackerSchemaValidationError('tracker_update', row.type, validationResult.errors);
      }

      // Capture which relationship fields actually changed (canonical NEW values,
      // still top-level here) so inverse propagation runs below — then route the
      // source's relationship writes into data.customFields (the durable synced
      // shape) so they survive sync re-serialization and the inverse read finds
      // them (NIM-1305). Non-relationship custom fields are left as-is.
      const updateDefs = globalRegistry.get(row.type)?.fields ?? [];
      const relChangedFields: Record<string, unknown> = {};
      for (const def of updateDefs) {
        if (!isRelationshipField(def)) continue;
        if (explicitlyUnsetFields.has(def.name)) {
          relChangedFields[def.name] = undefined;
        } else if (explicitlyWrittenFields.has(def.name)) {
          relChangedFields[def.name] = data[def.name];
        }
      }
      nestRelationshipFieldsIntoCustomFields(data, updateDefs, { writtenFields: explicitlyWrittenFields });

      // A field this schema does NOT type as a relationship is left at the top
      // level by the pass above -- but if the item already stores that field
      // under data.customFields, the nested copy is what readers surface, so the
      // write would be shadowed and silently revert. Route each remaining write
      // to the shape that already owns it. This runs AFTER
      // applyRelationshipFieldWrites (unlike ElectronDocumentService, which
      // canonicalizes its `updates` before writing) so a known relationship
      // field is still validated and serialized first.
      for (const key of explicitlyWrittenFields) {
        if (key in data) writeStoredFieldValue(data, key, data[key]);
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

      let bodyWriteResult: BodyWriteFailure | undefined;
      if (args.description !== undefined) {
        const normalizedContent = args.description.replace(/\\n/g, '\n');
        const contentJson = JSON.stringify(normalizedContent);
        let localSnapshotStored = false;
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
        localSnapshotStored = true;

        if (workspacePath) {
          try {
            const collaborativeBodyStored = await applyHeadlessBodyMarkdown(
              workspacePath,
              row.id,
              normalizedContent,
            );
            const bodySharingPolicy = getEffectiveTrackerSharingPolicy(
              workspacePath,
              row.type,
              globalRegistry.get(row.type),
            );
            const bodyItem = rowToTrackerItem({
              ...row,
              data: JSON.stringify(data),
            });
            if (
              collaborativeBodyStored === false &&
              shouldSyncTrackerItem(bodySharingPolicy, bodyItem)
            ) {
              bodyWriteResult = bodyWriteFailure(true);
              console.error('[MCP Server] tracker_update collaborative body write failed:', {
                itemId: row.id,
                workspacePath,
              });
            }
          } catch (bodyError) {
            bodyWriteResult = bodyWriteFailure(localSnapshotStored);
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

      // NIM-879: linking is opt-in on update, matching tracker_create (NIM-408).
      if (sessionId && args.linkSession === true) {
        const linked = await createBidirectionalLink(publicTrackerId, sessionId, {
          trackerRowId: row.id,
        });
        if (linked) {
          const sessionResult = await db.query<any>(
            `SELECT metadata FROM ai_sessions WHERE id = $1`,
            [sessionId]
          );
          const linkedIds = readLinkedTrackerItemIds(sessionResult.rows[0]?.metadata);
          await notifySessionLinkedTrackerChanged(sessionId, linkedIds);
        }
      }

      await notifyTrackerItemUpdated(workspacePath, row.id);

      const refreshedRow = await resolveTrackerRowByReference(db, row.id, workspacePath);
      const effectiveWorkspacePath = refreshedRow?.workspace || workspacePath;
      if (refreshedRow && effectiveWorkspacePath) {
        const updateModel = globalRegistry.get(refreshedRow.type);
        const sharingPolicy = getEffectiveTrackerSharingPolicy(effectiveWorkspacePath, refreshedRow.type, updateModel);
        if (shouldSyncTrackerItem(sharingPolicy, rowToTrackerItem(refreshedRow))) {
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
      // Defect A (NIM-1305): materialize inverse relationship fields on target
      // items, mirroring the IPC update handler via the shared, customFields-aware
      // service helper. Without this, an agent setting `modules`/`parentModule`
      // via MCP never wrote the inverse `features`/`submodules` on the target.
      if (docService && Object.keys(relChangedFields).length > 0) {
        try {
          await docService.propagateInverseForUpdate(
            {
              id: row.id,
              type: row.type,
              issueKey: row.issue_key ?? undefined,
              title: (data[rf('title', 'title')] as string) ?? row.title,
            },
            relChangedFields,
            oldDataSnapshot,
            globalRegistry.get(row.type)?.sharing,
            globalRegistry.get(row.type)?.draftByDefault,
          );
        } catch (invErr) {
          console.error('[MCP Server] tracker_update inverse propagation failed:', invErr);
        }
      }

      const postSyncRow = await resolveTrackerRowByReference(db, row.id, workspacePath);
      const analyticsRow = postSyncRow ?? refreshedRow ?? row;
      const analyticsWorkspace = analyticsRow.workspace ?? workspacePath ?? '';
      const analyticsPolicy = getEffectiveTrackerSharingPolicy(
        analyticsWorkspace,
        analyticsRow.type,
        globalRegistry.get(analyticsRow.type),
      );
      trackMcpTrackerMutation(
        args.status !== undefined
          ? 'status_changed'
          : args.owner !== undefined || args.assigneeEmail !== undefined || args.assigneeId !== undefined
            ? 'assigned'
            : 'field_changed',
        analyticsRow.id,
        analyticsRow.type,
        shouldSyncTrackerItem(analyticsPolicy, rowToTrackerItem(analyticsRow)),
      );

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

      const updatedRef = {
        id: publicTrackerId,
        issueKey: postSyncRow?.issue_key ?? refreshedRow?.issue_key ?? row.issue_key ?? undefined,
        localKey: postSyncRow?.local_key ?? refreshedRow?.local_key ?? row.local_key ?? undefined,
      };
      const updatedKeyContext = { canIssueKeys: isTrackerSyncConfigured(effectiveWorkspacePath) };
      const updatedKeyMessage = issueKeyMessage(updatedRef, updatedKeyContext);
      const structured: Record<string, any> = {
        action: "updated" as const,
        id: publicTrackerId,
        issueNumber: postSyncRow?.issue_number ?? refreshedRow?.issue_number ?? row.issue_number ?? undefined,
        issueKey: getAssignedIssueKey(updatedRef),
        localKey: updatedRef.localKey,
        issueKeyStatus: issueKeyStatus(updatedRef),
        ...(updatedKeyMessage ? { issueKeyMessage: updatedKeyMessage } : {}),
        type: row.type,
        typeTags: currentTypeTags,
        title: data[rf('title', 'title')],
        changes,
        ...(bodyWriteResult ? { bodyWrite: bodyWriteResult } : {}),
      };

      const summaryLines = [
        `Updated tracker item ${getTrackerDisplayRef(updatedRef)}:`,
        ...updateSummaryParts,
        ...(updatedKeyMessage ? [`- **Issue key**: ${updatedKeyMessage}`] : []),
        ...(bodyWriteResult ? [`- **Body write**: Failed — ${bodyWriteResult.message}`] : []),
      ];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              structured,
              summary: summaryLines.join("\n") + trackerRadarAdvisory(
                rowToTrackerItem({ ...row, data }),
                effectiveWorkspacePath,
              ),
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
      const linkedIds = readLinkedTrackerItemIds(sessionResult.rows[0]?.metadata);
      await notifySessionLinkedTrackerChanged(targetSessionId, linkedIds);

      const linkedRef = {
        id: item.id,
        issueKey: item.issueKey ?? existing.issue_key ?? undefined,
        localKey: item.localKey ?? existing.local_key ?? undefined,
      };
      const structured = {
        action: "linked" as const,
        trackerId: item.id,
        issueNumber: item.issueNumber ?? existing.issue_number ?? undefined,
        issueKey: getAssignedIssueKey(linkedRef),
        localKey: linkedRef.localKey,
        issueKeyStatus: issueKeyStatus(linkedRef),
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
              summary: `Linked session ${targetSessionId} to tracker item ${getTrackerDisplayRef(linkedRef)}. Total linked sessions: ${linkedSessions.length}${issueKeyAvailabilityNote(linkedRef, { canIssueKeys: isTrackerSyncConfigured(workspacePath) })}`,
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
        const linkedIds = readLinkedTrackerItemIds(sessionResult.rows[0]?.metadata);
        await notifySessionLinkedTrackerChanged(targetSessionId, linkedIds);
      }

      const unlinkedRef = {
        id: item.id,
        issueKey: item.issueKey ?? existing.issue_key ?? undefined,
        localKey: item.localKey ?? existing.local_key ?? undefined,
      };
      const structured = {
        action: "unlinked" as const,
        trackerId: item.id,
        issueNumber: item.issueNumber ?? existing.issue_number ?? undefined,
        issueKey: getAssignedIssueKey(unlinkedRef),
        localKey: unlinkedRef.localKey,
        issueKeyStatus: issueKeyStatus(unlinkedRef),
        type: item.type || existing.type || "",
        title: item.title || trackerData.title || "",
        linkedCount: linkedSessions.length,
        sessionId: targetSessionId,
        removed,
      };

      const displayRef = getTrackerDisplayRef(unlinkedRef);
      const summary = (removed
        ? `Unlinked session ${targetSessionId} from tracker item ${displayRef}. Total linked sessions: ${linkedSessions.length}`
        : `Session ${targetSessionId} was not linked to tracker item ${displayRef}. Total linked sessions: ${linkedSessions.length}`)
        + issueKeyAvailabilityNote(unlinkedRef, { canIssueKeys: isTrackerSyncConfigured(workspacePath) });

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

    const linkedTrackerItemIds = readLinkedTrackerItemIds(sessionResult.rows[0].metadata);
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
    const comments = data.comments || data.customFields?.comments || [];
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
    if (data.customFields?.comments) {
      delete data.customFields.comments;
      if (Object.keys(data.customFields).length === 0) delete data.customFields;
    }

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
        const sharingPolicy = getEffectiveTrackerSharingPolicy(workspacePath, row.type);
        if (shouldSyncTrackerItem(sharingPolicy, data)) {
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

    trackMcpTrackerMutation(
      'commented',
      row.id,
      row.type,
      workspacePath
        ? shouldSyncTrackerItem(getEffectiveTrackerSharingPolicy(workspacePath, row.type), data)
        : false,
    );

    const commentedRef = {
      id: row.id,
      issueKey: row.issue_key ?? undefined,
      localKey: row.local_key ?? undefined,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            structured: {
              action: "commented" as const,
              trackerId: row.id,
              issueNumber: row.issue_number ?? undefined,
              issueKey: getAssignedIssueKey(commentedRef),
              localKey: commentedRef.localKey,
              issueKeyStatus: issueKeyStatus(commentedRef),
              commentId,
              author: authorIdentity.displayName,
            },
            summary: `Added comment to ${getTrackerDisplayRef(commentedRef)} by ${authorIdentity.displayName}${issueKeyAvailabilityNote(commentedRef, { canIssueKeys: isTrackerSyncConfigured(workspacePath) })}${trackerRadarAdvisory(rowToTrackerItem({ ...row, data }), workspacePath)}`,
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

// ---------------------------------------------------------------------------
// External-source importers
// ---------------------------------------------------------------------------

export async function handleTrackerImporterList(
  _args: any,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  try {
    if (!workspacePath) {
      return { content: [{ type: "text", text: "Error: No workspace path available." }], isError: true };
    }
    const importers = await getTrackerImporterRegistry().listImporters(workspacePath);
    return {
      content: [{ type: "text", text: JSON.stringify({ importers }, null, 2) }],
      isError: false,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error listing importers: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function handleTrackerImporterSearch(
  args: any,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  try {
    if (!workspacePath) {
      return { content: [{ type: "text", text: "Error: No workspace path available." }], isError: true };
    }
    const registry = getTrackerImporterRegistry();
    const bindings = await registry.listBindings(workspacePath, args.providerId);
    if (bindings.length === 0) {
      return {
        content: [{ type: "text", text: `Importer '${args.providerId}' has no configured bindings. Configure one in its settings panel first.` }],
        isError: true,
      };
    }
    const binding = args.bindingId
      ? bindings.find((b) => b.id === args.bindingId)
      : bindings[0];
    if (!binding) {
      return {
        content: [{ type: "text", text: `Binding '${args.bindingId}' not found for importer '${args.providerId}'. Available: ${bindings.map((b) => b.id).join(', ')}` }],
        isError: true,
      };
    }
    const page = await registry.listItems(workspacePath, args.providerId, binding, {
      search: args.search,
      state: args.state,
      limit: args.limit,
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ binding: binding.id, ...page }, null, 2) }],
      isError: false,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error searching importable items: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function handleTrackerImport(
  args: any,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  try {
    if (!workspacePath) {
      return { content: [{ type: "text", text: "Error: No workspace path available." }], isError: true };
    }
    const result = await getTrackerImportService().runImport({
      workspacePath,
      providerId: args.providerId,
      externalId: String(args.externalId),
      primaryType: args.primaryType,
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          id: result.id,
          urn: result.urn,
          created: result.created,
          summary: result.created
            ? `Imported ${result.urn} as ${result.id}`
            : `${result.urn} was already imported as ${result.id}`,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error importing item: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function handleTrackerResnapshot(
  args: any,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  try {
    if (!workspacePath) {
      return { content: [{ type: "text", text: "Error: No workspace path available." }], isError: true };
    }
    const result = await getTrackerImportService().resnapshot({ workspacePath, urn: args.urn });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          id: result.id,
          urn: result.urn,
          titleUpdated: result.titleUpdated,
          statusUpdated: result.statusUpdated,
          bodyChanged: result.bodyChanged,
          summary: result.bodyChanged
            ? `Re-snapshotted ${result.urn}; upstream body changed and is flagged for review.`
            : `Re-snapshotted ${result.urn}.`,
        }, null, 2),
      }],
      isError: false,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error re-snapshotting: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function handleTrackerGetByUrn(
  args: any,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  try {
    if (!workspacePath) {
      return { content: [{ type: "text", text: "Error: No workspace path available." }], isError: true };
    }
    const id = await getTrackerImporterRegistry().findLocalIdByUrn(workspacePath, args.urn);
    if (!id) {
      return {
        content: [{ type: "text", text: JSON.stringify({ found: false, urn: args.urn }, null, 2) }],
        isError: false,
      };
    }
    // Delegate to tracker_get for the full item rendering.
    return handleTrackerGet({ id }, workspacePath);
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error resolving URN: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}
