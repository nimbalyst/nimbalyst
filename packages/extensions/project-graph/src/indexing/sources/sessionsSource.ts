/**
 * Sessions, and the directory evidence of what they edited.
 *
 * The whole eligible workspace scope is indexed, by page, in a stable key
 * order. The legacy adapter's `created_at > cutoff ORDER BY created_at DESC
 * LIMIT 1000` predicate is exactly what hid an old session that was resumed
 * last week; ordering by primary key instead means the order carries no
 * selection meaning and enumeration is complete.
 *
 * Two phases behind one opaque cursor:
 *   `s:<id>`  — session header rows
 *   `f:<sid>\x00<path>` — edited-file rows, aggregated into (session, directory)
 *
 * The file phase is separate because joining files onto the session query fans
 * the large metadata blob across every edited file. There are ~74k edited-file
 * rows in a mature workspace against ~6k sessions; two small columns paged
 * separately is the difference between a few MB and a stall.
 */
import type { ProjectGraphEdge, ProjectGraphNode } from '../../types';
import type { IndexPage, IndexSource, IndexSourceContext, SourcePrepareResult } from '../types';
import {
  sessionNodeId,
  sessionRowEdges,
  sessionRowToNode,
  provenanceFor,
  type SessionFileRow,
  type SessionRow,
} from '../../adapters/recordMapping';
import { dirNodeId, moduleForPath } from '../../adapters/paths';
import { directoryNode } from '../../adapters/databaseAdapter';
import { requireQuery, countRows } from './sql';

const SESSION_COLUMNS = `id, title, provider, model, status, session_type, agent_role,
        worktree_id, created_at, updated_at, last_activity, metadata, is_archived`;

const FILE_PHASE = 'f:';
const SESSION_PHASE = 's:';

export function createSessionsSource(): IndexSource {
  // (session -> directory) edit counts accumulated across file pages. Kept on
  // the source instance for one load; the index resets sources per load.
  let dirEdits = new Map<string, number>();
  let dirTotals = new Map<string, number>();

  return {
    id: 'sessions',
    label: 'AI sessions',

    async prepare(ctx): Promise<SourcePrepareResult> {
      const query = requireQuery(ctx.host);
      if (!query) {
        return { availability: 'unavailable', message: 'Database read permission is not granted.', total: null };
      }
      dirEdits = new Map();
      dirTotals = new Map();
      try {
        const total = await countRows(
          query,
          `SELECT COUNT(*) AS n FROM ai_sessions WHERE workspace_id = $1${archivedPredicate(ctx)}`,
          [ctx.host.workspacePath],
        );
        return {
          availability: 'available',
          total,
          scope: `All AI sessions in this workspace, ${
            ctx.options.includeArchived ? 'including archived' : 'excluding archived'
          }, plus the directories their edited files roll up to. Transcripts are never read.`,
        };
      } catch (err) {
        return { availability: 'error', message: describe(err), total: null };
      }
    },

    async page(ctx, cursor, pageSize): Promise<IndexPage> {
      const query = requireQuery(ctx.host);
      if (!query) return { records: [], edges: [], rows: 0 };

      if (cursor == null || cursor.startsWith(SESSION_PHASE)) {
        return pageSessions(ctx, query, cursor?.slice(SESSION_PHASE.length) ?? '', pageSize);
      }
      return pageFiles(ctx, query, cursor.slice(FILE_PHASE.length), pageSize, dirEdits, dirTotals);
    },

    owns(nodeId) {
      return nodeId.startsWith('session:');
    },

    async resolve(ctx, nodeId) {
      const query = requireQuery(ctx.host);
      if (!query) return null;
      const id = nodeId.slice('session:'.length);
      const rows = await query<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM ai_sessions WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
        [ctx.host.workspacePath, id],
      );
      return rows[0] ? sessionRowToNode(rows[0], { dataProjection: 'indexed' }) : null;
    },
  };
}

async function pageSessions(
  ctx: IndexSourceContext,
  query: NonNullable<ReturnType<typeof requireQuery>>,
  afterId: string,
  pageSize: number,
): Promise<IndexPage> {
  // Keyset on the primary key rather than OFFSET: OFFSET re-walks every skipped
  // row on each page, which turns a full enumeration quadratic.
  const rows = await query<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
     FROM ai_sessions
     WHERE workspace_id = $1
       AND id > $2${archivedPredicate(ctx)}
     ORDER BY id ASC
     LIMIT $3`,
    [ctx.host.workspacePath, afterId, pageSize],
  );
  ctx.signal.throwIfCancelled();

  // The indexed projection: links, status, tags and the reduced phase history.
  // Descriptions, attachments and arbitrary metadata never enter the index.
  const records = rows.map(row => sessionRowToNode(row, { dataProjection: 'indexed' }));
  const edges: ProjectGraphEdge[] = [];
  const roots = { workspacePath: ctx.host.workspacePath };
  for (const row of rows) edges.push(...sessionRowEdges(row, roots));

  const last = rows[rows.length - 1];
  // Exhausting sessions hands off to the file phase rather than ending; the
  // cursor is opaque to the caller, which only sees "more work remains".
  const cursor = rows.length === pageSize && last ? `${SESSION_PHASE}${last.id}` : `${FILE_PHASE}`;
  return { records, edges, cursor, rows: rows.length };
}

async function pageFiles(
  ctx: IndexSourceContext,
  query: NonNullable<ReturnType<typeof requireQuery>>,
  after: string,
  pageSize: number,
  dirEdits: Map<string, number>,
  dirTotals: Map<string, number>,
): Promise<IndexPage> {
  const sep = after.indexOf('\x00');
  const afterSession = sep >= 0 ? after.slice(0, sep) : '';
  const afterPath = sep >= 0 ? after.slice(sep + 1) : '';

  // Row-value keyset over the composite (session_id, file_path) order. Both
  // backends support row-value comparison; verified against the live store.
  const rows = await query<SessionFileRow>(
    `SELECT session_id, file_path
     FROM session_files
     WHERE workspace_id = $1
       AND link_type = 'edited'
       AND (session_id, file_path) > ($2, $3)
     ORDER BY session_id ASC, file_path ASC
     LIMIT $4`,
    [ctx.host.workspacePath, afterSession, afterPath, pageSize],
  );
  ctx.signal.throwIfCancelled();

  const records: ProjectGraphNode[] = [];
  const edges: ProjectGraphEdge[] = [];
  const touchedDirs = new Set<string>();
  const touchedKeys = new Set<string>();

  for (const row of rows) {
    if (!row.file_path) continue;
    // Session file paths are absolute and may live in a sibling worktree; a
    // path outside the workspace is skipped rather than bucketed into a junk
    // node.
    const dir = moduleForPath(row.file_path, ctx.host.workspacePath);
    if (!dir) continue;
    const key = `${sessionNodeId(row.session_id)}\x00${dir}`;
    dirEdits.set(key, (dirEdits.get(key) ?? 0) + 1);
    dirTotals.set(dir, (dirTotals.get(dir) ?? 0) + 1);
    touchedDirs.add(dir);
    touchedKeys.add(key);
  }

  // Emit only what this page changed, each carrying its running aggregate. The
  // index merges by id and a later emission supersedes an earlier one, so the
  // last count written for a pair is its total. Re-emitting the whole
  // accumulated map every page would be quadratic in the number of pages
  // against a ~74k-row table.
  for (const dir of touchedDirs) records.push(directoryNode(dir, 'edits', dirTotals.get(dir) ?? 0));
  for (const key of touchedKeys) {
    const [sid, dir] = key.split('\x00');
    const dirId = dirNodeId(dir!);
    edges.push({
      id: `${sid}->${dirId}`,
      type: 'edited_in',
      sourceId: sid!,
      targetId: dirId,
      strength: dirEdits.get(key) ?? 1,
      provenance: provenanceFor('edited_in'),
    });
  }

  const last = rows[rows.length - 1];
  const cursor =
    rows.length === pageSize && last
      ? `${FILE_PHASE}${last.session_id}\x00${last.file_path ?? ''}`
      : undefined;
  return { records, edges, cursor, rows: rows.length };
}

/**
 * `is_archived` is a boolean on PGLite and 0/1 on better-sqlite3. Comparing to
 * the SQL literal `false` is the one form both accept.
 */
function archivedPredicate(ctx: IndexSourceContext): string {
  return ctx.options.includeArchived ? '' : ' AND COALESCE(is_archived, false) = false';
}

function describe(err: unknown): string {
  return String(err).slice(0, 200);
}
