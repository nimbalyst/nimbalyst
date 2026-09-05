import type { Adapter, AdapterResult } from './types';
import type { ProjectGraphEdge, ProjectGraphNode } from '../types';
import { dirLabel, dirNodeId, moduleForPath } from './paths';
import {
  provenanceFor,
  sessionNodeId,
  sessionRowToNode,
  trackerRowEdges,
  trackerRowToNode,
  type SessionFileRow,
  type SessionRow,
  type TrackerRow,
} from './recordMapping';

/**
 * Loads AI sessions, the files those sessions edited, and tracker items from
 * Nimbalyst's local database via the read-only `host.data.query` API.
 *
 * This is the LEGACY bounded snapshot that feeds the original graph canvas. It
 * keeps a fixed cap on purpose — the canvas force-layout is what the cap exists
 * to protect. The incremental, complete index lives in `src/indexing/` and does
 * not go through here.
 *
 * Row -> node mapping is shared with the index via `recordMapping.ts` so
 * lifecycle and provenance rules cannot drift between the two paths.
 *
 * Three queries fire in parallel:
 *   1. sessions
 *   2. session_files (separate, so the large session metadata blob is not
 *      fanned out across every edited file)
 *   3. tracker items
 *
 * All are scoped to the current workspace.
 */

const SESSION_WINDOW_DAYS = 90;
const SESSION_LIMIT = 1000;
const TRACKER_LIMIT = 1000;

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
      // Archived items are INCLUDED (the August timeframe design records
      // archived-visible-by-default). `archived` is surfaced as a flag on the
      // node instead of being filtered out or treated as a closure.
      host.data.query<TrackerRow>(
        `SELECT id, issue_number, issue_key, type, data, document_path,
                title, status, created, updated, archived
         FROM tracker_items
         WHERE workspace = $1
           AND deleted_at IS NULL
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
    // Deduped session->dir edges. One session can touch many files in the same
    // dir; we want a single edge with an aggregate count, not N parallel edges.
    const sessionDirCounts = new Map<string, number>();

    // -------- Sessions (one row each; files handled separately below) --------
    for (const row of sessionRows) {
      const id = sessionNodeId(row.id);
      if (sessionNodeIds.has(id)) continue;
      sessionNodeIds.add(id);
      nodes.push(sessionRowToNode(row));
    }

    // -------- Edited files -> directory rollups + session->dir edges --------
    for (const fr of fileRows) {
      if (!fr.file_path) continue;
      const id = sessionNodeId(fr.session_id);
      if (!sessionNodeIds.has(id)) continue;
      // Session file paths are stored absolute (and may live in a sibling
      // worktree); skip anything outside the workspace rather than bucketing it.
      const dir = moduleForPath(fr.file_path, host.workspacePath);
      if (!dir) continue;
      const existing = dirNodes.get(dir);
      dirNodes.set(dir, { count: (existing?.count ?? 0) + 1 });
      const key = `${id}\x00${dir}`;
      sessionDirCounts.set(key, (sessionDirCounts.get(key) ?? 0) + 1);
    }

    // Materialize directory nodes and session->dir edges after the loop so we
    // emit each dir once and one edge per (session, dir) pair.
    for (const [dir, info] of dirNodes) {
      nodes.push(directoryNode(dir, 'edits', info.count));
    }
    for (const [key, count] of sessionDirCounts) {
      const [id, dir] = key.split('\x00');
      const dirId = dirNodeId(dir!);
      edges.push({
        id: `${id}->${dirId}`,
        type: 'edited_in',
        sourceId: id!,
        targetId: dirId,
        strength: count,
        provenance: provenanceFor('edited_in'),
      });
    }

    // -------- Tracker items + their recorded links --------
    for (const row of trackerRows) {
      nodes.push(trackerRowToNode(row));
      // Endpoints may be outside this bounded snapshot. Emit the relation
      // anyway; the loader decides what the canvas can draw.
      edges.push(...trackerRowEdges(row));
    }

    const message = errors.length > 0 ? errors.join('; ') : undefined;
    const status: AdapterResult['status'] = errors.length > 0 ? 'error' : 'ok';
    return { nodes, edges, status, message };
  },
};

/** A rolled-up directory node. Shared shape between the edit and touch rollups. */
export function directoryNode(dir: string, badgeKey: string, count: number): ProjectGraphNode {
  return {
    id: dirNodeId(dir),
    type: 'directory',
    label: dirLabel(dir),
    sublabel: dir,
    category: 'knowledge',
    source: 'file',
    visibility: 'workspace-shared',
    badges: [{ key: badgeKey, value: count }],
    fields: { path: dir, rollup: true, [`${badgeKey === 'edits' ? 'edit' : 'touch'}Count`]: count },
  };
}
