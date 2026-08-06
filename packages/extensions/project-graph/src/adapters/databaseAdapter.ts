import type { Adapter, AdapterResult } from './types';
import type { ProjectGraphEdge, ProjectGraphNode } from '../types';
import { TRACKER_CATEGORY } from '../schema';
import { dirLabel, dirNodeId, moduleForPath } from './paths';

/**
 * Loads AI sessions, the files those sessions edited, and tracker items from
 * Nimbalyst's PGLite database via the read-only `host.data.query` API.
 *
 * Replaces the old `worktreeAdapter` (which only saw worktree directories and
 * mislabeled them as sessions). Now we get the real `ai_sessions` table plus
 * the `session_files` join and the `tracker_items` table -- the entities the
 * graph is supposed to be about.
 *
 * Two queries fire in parallel:
 *   1. sessions LEFT JOIN session_files -- one row per session/file pair
 *   2. tracker items
 *
 * Both are scoped to the current workspace.
 */

const SESSION_WINDOW_DAYS = 90;
const SESSION_LIMIT = 1000;
const TRACKER_LIMIT = 1000;

interface SessionRow {
  id: string;
  title: string | null;
  provider: string | null;
  model: string | null;
  status: string | null;
  session_type: string | null;
  agent_role: string | null;
  worktree_id: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  last_activity: string | Date | null;
  // PGLite returns this JSON column already parsed; better-sqlite3 returns a
  // JSON string. Normalize via parseData (see DATABASE.md). Carries the session
  // workflow-phase history under `activity[]`.
  metadata: Record<string, unknown> | string | null;
  // boolean on PGLite, 0/1 integer on better-sqlite3.
  is_archived: boolean | number | null;
}

/**
 * Edited-file rows, fetched in a SEPARATE query from sessions. Joining files
 * onto the session query fans the (potentially large) session row -- metadata
 * blob included -- across every edited file, which blew past the 10s SQLite
 * worker timeout once the window grew to 1000 sessions. Keeping this lightweight
 * (two small columns, no metadata) avoids the blow-up.
 */
interface SessionFileRow {
  session_id: string;
  file_path: string | null;
}

interface TrackerRow {
  id: string;
  issue_number: number | null;
  issue_key: string | null;
  type: string;
  // PGLite returns the JSONB column already parsed; better-sqlite3 returns it as
  // a JSON string. Handle both (see parseData / packages/electron/DATABASE.md).
  data: Record<string, unknown> | string | null;
  document_path: string | null;
  title: string | null;
  status: string | null;
  created: string | Date | null;
  updated: string | Date | null;
}

/**
 * Normalize the tracker `data` column across backends. On PGLite it arrives as a
 * parsed object; on better-sqlite3 it's a JSON string. Anything else (or a parse
 * failure) yields an empty object so callers can read fields uniformly.
 */
function parseData(raw: Record<string, unknown> | string | null): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

/**
 * Map a tracker primaryType to a graph node type. Custom tracker types fall
 * through unchanged -- the schema layer is responsible for treating unknown
 * types gracefully.
 */
function trackerTypeToNodeType(type: string): string {
  return type;
}

/**
 * Category for a tracker node. Only the curated, well-known types get a
 * specific home; every other (user-defined) tracker type falls into the generic
 * "Trackers" category so it clusters with its peers and stays consistent with
 * the sidebar grouping. Trackers are user-configurable, so this is a small
 * convenience map, not an exhaustive registry.
 */
function trackerCategoryFor(type: string): ProjectGraphNode['category'] {
  switch (type) {
    case 'objective':
    case 'initiative':
    case 'project':
    case 'module':
    case 'feature':
    case 'plan':
    case 'decision':
      return 'strategy';
    case 'bug':
    case 'task':
    case 'incident':
    case 'github-issue':
    case 'github-pr':
      return 'delivery';
    case 'customer':
    case 'collaborator':
      return 'people';
    default:
      return TRACKER_CATEGORY;
  }
}

function toEpochMs(value: string | Date | null | undefined): number | undefined {
  if (!value) return undefined;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Tracker statuses that count as "closed" for the timeline animation. Bugs
 * and tasks with these statuses fade after their `updated` timestamp.
 */
const CLOSED_TRACKER_STATUSES = new Set([
  'closed', 'done', 'resolved', 'completed', 'fixed', 'won\'t-fix', 'wontfix',
  'in-review', 'merged', 'cancelled', 'canceled',
]);

const COMPLETED_SESSION_STATUSES = new Set([
  'completed', 'complete', 'archived', 'failed', 'stopped', 'cancelled', 'canceled',
]);

/**
 * Collect tags + labels off a blob into a deduped string list. Used for both a
 * tracker `data` blob and a session `metadata` blob (which carries tags under
 * `metadata.tags`, set by update_session_meta). Both `tags` and `labels` are
 * plain string arrays at the top level (verified against the live SQLite store);
 * labels are the collaborative projection, tags the simple field. We union them
 * so a lane shows up whichever the item used.
 */
function tagsFromData(data: Record<string, unknown>): string[] | undefined {
  const out = new Set<string>();
  for (const key of ['tags', 'labels'] as const) {
    const raw = data[key];
    if (!Array.isArray(raw)) continue;
    for (const t of raw) {
      if (typeof t === 'string' && t.trim()) out.add(t.trim());
    }
  }
  return out.size > 0 ? Array.from(out) : undefined;
}

function severityFromFields(fields: Record<string, unknown> | null): ProjectGraphNode['severity'] {
  if (!fields) return undefined;
  const raw = (fields.priority ?? fields.severity);
  if (typeof raw !== 'string') return undefined;
  const v = raw.toLowerCase();
  if (v === 'critical' || v === 'p0') return 'critical';
  if (v === 'high' || v === 'p1') return 'high';
  if (v === 'medium' || v === 'p2') return 'medium';
  if (v === 'low' || v === 'p3') return 'low';
  return undefined;
}

export const databaseAdapter: Adapter = {
  id: 'database',
  label: 'database',
  async run(host): Promise<AdapterResult> {
    if (!host.data?.query) {
      return { nodes: [], edges: [], status: 'unavailable', message: 'host.data.query missing' };
    }

    let sessionRows: SessionRow[] = [];
    let trackerRows: TrackerRow[] = [];
    const errors: string[] = [];

    // Cutoff computed in JS as an ISO8601 string rather than with Postgres
    // `NOW() - INTERVAL` arithmetic, which is a syntax error on the better-sqlite3
    // backend. `created_at` is timestamptz on PGLite and ISO8601 text on SQLite;
    // an ISO string compares correctly against both (lexicographic on SQLite).
    const sessionCutoffIso = new Date(Date.now() - SESSION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Run the queries in parallel. If one fails, we still surface whatever the
    // others returned -- a missing table shouldn't blank the whole graph.
    // Sessions and their edited files are fetched SEPARATELY (no join) so the
    // large session metadata blob isn't fanned out across every file row.
    let fileRows: SessionFileRow[] = [];
    const [sessionResult, fileResult, trackerResult] = await Promise.allSettled([
      host.data.query<SessionRow>(
        `SELECT id, title, provider, model, status, session_type, agent_role,
                worktree_id, created_at, updated_at, last_activity, metadata, is_archived
         FROM ai_sessions
         WHERE workspace_id = $1
           AND created_at > $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [host.workspacePath, sessionCutoffIso, SESSION_LIMIT],
      ),
      host.data.query<SessionFileRow>(
        `SELECT sf.session_id, sf.file_path
         FROM session_files sf
         JOIN (
           SELECT id FROM ai_sessions
           WHERE workspace_id = $1
             AND created_at > $2
           ORDER BY created_at DESC
           LIMIT $3
         ) s ON s.id = sf.session_id
         WHERE sf.workspace_id = $1
           AND sf.link_type = 'edited'`,
        [host.workspacePath, sessionCutoffIso, SESSION_LIMIT],
      ),
      host.data.query<TrackerRow>(
        `SELECT id, issue_number, issue_key, type, data, document_path,
                title, status, created, updated
         FROM tracker_items
         WHERE workspace = $1
           AND deleted_at IS NULL
           AND COALESCE(archived, false) = false
         ORDER BY updated DESC NULLS LAST
         LIMIT $2`,
        [host.workspacePath, TRACKER_LIMIT],
      ),
    ]);

    if (sessionResult.status === 'fulfilled') {
      sessionRows = sessionResult.value;
    } else {
      errors.push(`sessions: ${String(sessionResult.reason).slice(0, 160)}`);
    }
    if (fileResult.status === 'fulfilled') {
      fileRows = fileResult.value;
    } else {
      errors.push(`files: ${String(fileResult.reason).slice(0, 160)}`);
    }
    if (trackerResult.status === 'fulfilled') {
      trackerRows = trackerResult.value;
    } else {
      errors.push(`trackers: ${String(trackerResult.reason).slice(0, 160)}`);
    }

    if (sessionRows.length === 0 && trackerRows.length === 0 && errors.length > 0) {
      return { nodes: [], edges: [], status: 'error', message: errors.join('; ') };
    }

    const nodes: ProjectGraphNode[] = [];
    const edges: ProjectGraphEdge[] = [];
    const sessionNodeIds = new Set<string>();
    const dirNodes = new Map<string, { count: number }>();
    const trackerSessionEdgeIds = new Set<string>();
    // Deduped session->dir edges. One session can touch many files in the same
    // dir; we want a single edge with an aggregate count, not N parallel edges.
    const sessionDirCounts = new Map<string, number>();

    // -------- Sessions (one row each; files handled separately below) --------
    for (const row of sessionRows) {
      const sessionId = `session:${row.id}`;
      if (!sessionNodeIds.has(sessionId)) {
        sessionNodeIds.add(sessionId);
        const createdAt = toEpochMs(row.created_at);
        const lastActivityAt = toEpochMs(row.last_activity) ?? toEpochMs(row.updated_at);
        // Archived sessions are historical/closed work -- include them (the
        // timeline is about history) and treat archived OR a completed status as
        // terminal so the bar ends at last activity instead of running to now.
        const isArchived = row.is_archived === true || row.is_archived === 1;
        const isCompleted =
          isArchived || (row.status ? COMPLETED_SESSION_STATUSES.has(row.status.toLowerCase()) : false);
        // Workflow-phase history lives in metadata.activity[] (see
        // sessionPhaseTransition.ts). Surfacing it under fields.data.activity lets
        // the timeline reconstruct phase segments exactly like tracker items --
        // the renderer reads `fields.data.activity` and is source-agnostic.
        const metadata = parseData(row.metadata);
        const activity = Array.isArray(metadata.activity) ? metadata.activity : [];
        const phase = typeof metadata.phase === 'string' ? metadata.phase : undefined;
        nodes.push({
          id: sessionId,
          type: 'ai-session',
          label: row.title || 'Untitled session',
          sublabel: [row.provider, row.model].filter(Boolean).join(' · ') || undefined,
          category: 'delivery',
          source: 'session',
          visibility: 'local',
          // Prefer the workflow phase for timeline coloring; fall back to the
          // operational status when no phase has been assigned yet.
          status: phase ?? row.status ?? undefined,
          // Session tags live in metadata.tags (set by update_session_meta),
          // alongside phase/activity. Without this the timeline's group-by-tag
          // mode never lanes AI sessions (they all fell into "Untagged").
          tags: tagsFromData(metadata),
          createdAt,
          closedAt: isCompleted ? lastActivityAt : undefined,
          fields: {
            id: row.id,
            provider: row.provider,
            model: row.model,
            sessionType: row.session_type,
            agentRole: row.agent_role,
            worktreeId: row.worktree_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastActivity: row.last_activity,
            phase,
            data: { activity },
          },
        });
      }
    }

    // -------- Edited files -> directory rollups + session->dir edges --------
    // Separate pass over the lightweight file query (see SessionFileRow). Only
    // attribute files to sessions we actually emitted a node for.
    for (const fr of fileRows) {
      if (!fr.file_path) continue;
      const sessionId = `session:${fr.session_id}`;
      if (!sessionNodeIds.has(sessionId)) continue;
      // Session file paths are stored absolute (and may live in a sibling
      // worktree); skip anything outside the workspace rather than bucketing it.
      const dir = moduleForPath(fr.file_path, host.workspacePath);
      if (!dir) continue;
      const existing = dirNodes.get(dir);
      dirNodes.set(dir, { count: (existing?.count ?? 0) + 1 });
      const key = `${sessionId}\x00${dir}`;
      sessionDirCounts.set(key, (sessionDirCounts.get(key) ?? 0) + 1);
    }

    // Materialize directory nodes and session->dir edges. Doing this after the
    // loop means we only emit each dir once and only emit one edge per
    // (session, dir) pair with the aggregate file count.
    for (const [dir, info] of dirNodes) {
      nodes.push({
        id: dirNodeId(dir),
        type: 'directory',
        label: dirLabel(dir),
        sublabel: dir,
        category: 'knowledge',
        source: 'file',
        visibility: 'workspace-shared',
        badges: [{ key: 'edits', value: info.count }],
        fields: { path: dir, rollup: true, editCount: info.count },
      });
    }
    for (const [key, count] of sessionDirCounts) {
      const [sessionId, dir] = key.split('\x00');
      const dirId = dirNodeId(dir!);
      edges.push({
        id: `${sessionId}->${dirId}`,
        type: 'edited_in',
        sourceId: sessionId!,
        targetId: dirId,
        strength: count,
      });
    }

    // -------- Tracker items + linkedSessions edges --------
    for (const row of trackerRows) {
      const nodeId = `tracker:${row.id}`;
      const data = parseData(row.data);
      const nodeType = trackerTypeToNodeType(row.type);
      const labelPrefix = row.issue_key ?? (row.issue_number != null ? `#${row.issue_number}` : null);
      const title = row.title ?? (typeof data.title === 'string' ? (data.title as string) : null);
      const label = labelPrefix && title ? `${labelPrefix} ${title}` : (title || labelPrefix || row.id);

      const createdAt = toEpochMs(row.created);
      const updatedAt = toEpochMs(row.updated);
      const isClosed = row.status ? CLOSED_TRACKER_STATUSES.has(row.status.toLowerCase()) : false;
      nodes.push({
        id: nodeId,
        type: nodeType,
        label,
        sublabel: row.document_path ?? undefined,
        category: trackerCategoryFor(row.type),
        source: 'tracker',
        visibility: 'workspace-shared',
        status: row.status ?? undefined,
        severity: severityFromFields(data),
        tags: tagsFromData(data),
        createdAt,
        closedAt: isClosed ? updatedAt : undefined,
        fields: {
          id: row.id,
          issueKey: row.issue_key,
          issueNumber: row.issue_number,
          documentPath: row.document_path,
          createdAt: row.created,
          updatedAt: row.updated,
          // Surface the raw data so the inspector can show priority/labels/etc.
          // without another round-trip.
          data,
        },
      });

      // `linkedSessions` is a device-local convenience field (see TrackerRecord
      // SYSTEM_KEYS); the JSONB column carries it at the top level of `data`.
      const linkedSessions = Array.isArray(data.linkedSessions) ? (data.linkedSessions as unknown[]) : [];
      for (const sid of linkedSessions) {
        if (typeof sid !== 'string') continue;
        const sessionNodeId = `session:${sid}`;
        const edgeId = `${nodeId}->${sessionNodeId}`;
        if (trackerSessionEdgeIds.has(edgeId)) continue;
        trackerSessionEdgeIds.add(edgeId);
        edges.push({
          id: edgeId,
          type: 'worked_on_in',
          sourceId: nodeId,
          targetId: sessionNodeId,
        });
      }

      // linkedCommitSha + linkedCommits both point at commit nodes the git
      // adapter emits. Use the canonical `commit:<sha>` id so the edges
      // dedupe-merge cleanly with the git adapter's nodes.
      const linkedCommits = Array.isArray(data.linkedCommits) ? (data.linkedCommits as Array<Record<string, unknown>>) : [];
      const commitShas = new Set<string>();
      if (typeof data.linkedCommitSha === 'string') commitShas.add(data.linkedCommitSha);
      for (const c of linkedCommits) {
        if (typeof c?.sha === 'string') commitShas.add(c.sha);
      }
      // Defect-like items "fix" their linked commits; everything else merely
      // "references" them. Kept as a tiny heuristic since tracker types are
      // user-defined and carry no fix/reference semantics of their own.
      const fixesCommits = row.type === 'bug' || row.type === 'incident';
      for (const sha of commitShas) {
        edges.push({
          id: `${nodeId}->commit:${sha}`,
          type: fixesCommits ? 'fixes' : 'references',
          sourceId: nodeId,
          targetId: `commit:${sha}`,
        });
      }
    }

    const message = errors.length > 0 ? errors.join('; ') : undefined;
    const status: AdapterResult['status'] = errors.length > 0 ? 'error' : 'ok';
    return { nodes, edges, status, message };
  },
};
