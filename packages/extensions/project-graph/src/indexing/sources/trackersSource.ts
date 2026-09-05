/**
 * Tracker items — the whole eligible corpus, not the 1,000 most recently
 * updated.
 *
 * The September 5 census showed what the old `ORDER BY updated DESC LIMIT 1000`
 * selection actually admitted: 815 of 1,037 partner records, 39 of 1,079 bugs,
 * 2 of 176 decisions, and none at all of 343 product-feature or 56
 * feature-module records. That is not a sample, it is a bias — recency ordering
 * plus a cap silently excluded whole record types. Keyset enumeration by
 * primary key admits every type at the same rate.
 */
import type { ProjectGraphEdge } from '../../types';
import type { IndexPage, IndexSource, IndexSourceContext, SourcePrepareResult } from '../types';
import { trackerRowEdges, trackerRowToNode, type TrackerRow } from '../../adapters/recordMapping';
import { trackerRelationshipEdges, type TrackerFieldDefinition } from '../../adapters/trackerRelationships';
import { loadRelationshipFieldIndex } from '../../adapters/trackerTypeDefs';
import { countRows, requireQuery } from './sql';

const TRACKER_COLUMNS = `id, issue_number, issue_key, type, data, document_path,
        title, status, created, updated, archived`;

export function createTrackersSource(): IndexSource {
  // Relationship field definitions per tracker type, loaded once per run.
  // Without a type's schema this stays empty for that type and no relationship
  // edges are emitted for it — the correct answer, since field names alone
  // cannot distinguish a relationship from a same-named scalar.
  let relationshipFields = new Map<string, TrackerFieldDefinition[]>();

  return {
    id: 'trackers',
    label: 'Tracker items',

    async prepare(ctx): Promise<SourcePrepareResult> {
      const query = requireQuery(ctx.host);
      if (!query) {
        return { availability: 'unavailable', message: 'Database read permission is not granted.', total: null };
      }
      relationshipFields = await loadRelationshipFieldIndex(ctx.host).catch(() => new Map());
      try {
        const total = await countRows(
          query,
          `SELECT COUNT(*) AS n FROM tracker_items
           WHERE workspace = $1 AND deleted_at IS NULL${archivedPredicate(ctx)}`,
          [ctx.host.workspacePath],
        );
        return { availability: 'available', total, scope: scopeDescription(ctx) };
      } catch (err) {
        return { availability: 'error', message: String(err).slice(0, 200), total: null };
      }
    },

    async page(ctx, cursor, pageSize): Promise<IndexPage> {
      const query = requireQuery(ctx.host);
      if (!query) return { records: [], edges: [], rows: 0 };

      const rows = await query<TrackerRow>(
        `SELECT ${TRACKER_COLUMNS}
         FROM tracker_items
         WHERE workspace = $1
           AND deleted_at IS NULL
           AND id > $2${archivedPredicate(ctx)}
         ORDER BY id ASC
         LIMIT $3`,
        [ctx.host.workspacePath, cursor ?? '', pageSize],
      );
      ctx.signal.throwIfCancelled();

      const edges: ProjectGraphEdge[] = [];
      for (const row of rows) {
        edges.push(...trackerRowEdges(row));
        // Item-to-item links the user recorded in relationship fields
        // (dependencies, collection membership, module/feature refs). Endpoints
        // may not be indexed yet; the index keeps them as unresolved rather
        // than dropping the recorded fact.
        edges.push(...trackerRelationshipEdges(row, relationshipFields.get(row.type) ?? []));
      }

      const last = rows[rows.length - 1];
      return {
        records: rows.map(row => trackerRowToNode(row, { dataProjection: 'indexed' })),
        edges,
        cursor: rows.length === pageSize && last ? last.id : undefined,
        rows: rows.length,
      };
    },

    owns(nodeId) {
      return nodeId.startsWith('tracker:');
    },

    /**
     * The item's body, read from `tracker_body_cache`. Bodies are versioned and
     * append-only there, so the newest `body_version` is the current text.
     *
     * Deliberately NOT part of the indexing pass: `description` alone is 5.3 MB
     * across this workspace's 5,150 items, and the index is metadata.
     */
    async loadDetail(ctx, nodeId) {
      const query = requireQuery(ctx.host);
      if (!query) return null;
      const rows = await query<{ content: string | null; body_version: number | null }>(
        `SELECT content, body_version FROM tracker_body_cache
         WHERE item_id = $1 ORDER BY body_version DESC LIMIT 1`,
        [nodeId.slice('tracker:'.length)],
      );
      const content = rows[0]?.content;
      if (typeof content !== 'string') return null;
      const truncated = content.length > BODY_DETAIL_CHARS;
      return {
        body: truncated ? content.slice(0, BODY_DETAIL_CHARS) : content,
        truncated,
        fields: { bodyVersion: rows[0]?.body_version ?? null },
      };
    },

    async resolve(ctx, nodeId) {
      const query = requireQuery(ctx.host);
      if (!query) return null;
      const rows = await query<TrackerRow>(
        `SELECT ${TRACKER_COLUMNS} FROM tracker_items
         WHERE workspace = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1`,
        [ctx.host.workspacePath, nodeId.slice('tracker:'.length)],
      );
      return rows[0] ? trackerRowToNode(rows[0], { dataProjection: 'indexed' }) : null;
    },
  };
}

/** Ceiling on a single on-demand body read. */
const BODY_DETAIL_CHARS = 64 * 1024;

/** `archived` is boolean on PGLite and 0/1 on SQLite; `false` is accepted by both. */
function archivedPredicate(ctx: IndexSourceContext): string {
  return ctx.options.includeArchived ? '' : ' AND COALESCE(archived, false) = false';
}

function scopeDescription(ctx: IndexSourceContext): string {
  return `All non-deleted tracker items in this workspace, ${
    ctx.options.includeArchived ? 'including archived' : 'excluding archived'
  }. Metadata and recorded relationships only; bodies are fetched on demand.`;
}
