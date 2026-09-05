/**
 * Row -> node/edge mapping shared by the legacy snapshot adapter and the
 * incremental index.
 *
 * These two paths read the same tables and must not drift on the semantics the
 * September 5 review pinned down: what counts as closed, that archival is a
 * shelf location rather than an outcome, and how each edge was produced. Both
 * import from here so a change lands in one place and one set of tests covers
 * both callers.
 *
 * Everything here is pure — no host, no queries — so the rules are testable
 * without a database.
 */
import type { EdgeType, ProjectGraphEdge, ProjectGraphNode } from '../types';
import { TRACKER_CATEGORY } from '../schema';
import { resolveReferenceId, type ReferenceRoots } from './referenceIds';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface SessionRow {
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
  /**
   * PGLite returns this JSON column already parsed; better-sqlite3 returns a
   * JSON string. Normalize via {@link parseJsonColumn} (see DATABASE.md).
   * Carries the session workflow-phase history under `activity[]`.
   */
  metadata: Record<string, unknown> | string | null;
  /** boolean on PGLite, 0/1 integer on better-sqlite3. */
  is_archived: boolean | number | null;
}

export interface TrackerRow {
  id: string;
  issue_number: number | null;
  issue_key: string | null;
  type: string;
  /** Parsed object on PGLite, JSON string on better-sqlite3. */
  data: Record<string, unknown> | string | null;
  document_path: string | null;
  title: string | null;
  status: string | null;
  created: string | Date | null;
  updated: string | Date | null;
  /** boolean on PGLite, 0/1 integer on better-sqlite3; may be absent. */
  archived?: boolean | number | null;
}

export interface SessionFileRow {
  session_id: string;
  file_path: string | null;
}

// ---------------------------------------------------------------------------
// Backend-divergent value normalization (see packages/electron/DATABASE.md)
// ---------------------------------------------------------------------------

/**
 * Sub-objects of a tracker's `data` blob that the index does not use and that
 * dominate its size. Measured on this workspace's 5,150 non-deleted items:
 * `data` totals 26.6 MB, of which `activity` is 14.3 MB (54%) and `description`
 * is 5.3 MB (20%). `customFields` (2.6 MB) is KEPT — it carries the recorded
 * relationships — as are the small scalar keys the mapper reads.
 *
 * This trims what is RETAINED, not what is transferred: the column is still
 * selected whole, because the two backends disagree on JSON sub-extraction
 * (`data->'k'` is a parsed object on PGLite and a JSON string on SQLite, see
 * DATABASE.md) and per-key extraction would need two different queries. The
 * transfer cost is real and documented on the source; the memory cost is not
 * paid twice.
 */
const TRIMMED_TRACKER_DATA_KEYS = ['activity', 'description', 'comments', 'body'] as const;

/**
 * Normalize a JSON column across backends: parsed object on PGLite, JSON string
 * on better-sqlite3. Anything else (or a parse failure) yields an empty object
 * so callers read fields uniformly.
 */
export function parseJsonColumn(raw: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
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

/** Boolean columns come back as `true/false` on PGLite and `1/0` on SQLite. */
export function toBool(raw: boolean | number | string | null | undefined): boolean {
  if (raw === true || raw === 1) return true;
  if (typeof raw === 'string') return raw === 'true' || raw === '1' || raw === 't';
  return false;
}

export function toEpochMs(value: string | Date | number | null | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Tracker statuses that are genuinely terminal.
 *
 * `in-review` is deliberately absent: an item in review is still open work that
 * still needs someone. Treating it as closed made the recency views report it
 * as finished (September 5 review).
 */
export const CLOSED_TRACKER_STATUSES = new Set([
  'closed', 'done', 'resolved', 'completed', 'fixed', "won't-fix", 'wontfix',
  'merged', 'cancelled', 'canceled',
]);

/**
 * Session statuses that are terminal. `archived` is deliberately absent: a
 * session can be filed away mid-flight, and the archive flag travels separately
 * on `fields.archived`.
 */
export const COMPLETED_SESSION_STATUSES = new Set([
  'completed', 'complete', 'failed', 'stopped', 'cancelled', 'canceled',
]);

// ---------------------------------------------------------------------------
// Edge provenance
// ---------------------------------------------------------------------------

type Provenance = NonNullable<ProjectGraphEdge['provenance']>;

/**
 * The one place each relation's evidence is stated. Consumers render this text,
 * so it describes what the source actually recorded — not what the relation is
 * named.
 */
export const EDGE_PROVENANCE: Record<string, Provenance> = {
  worked_on_in: {
    kind: 'recorded',
    basis: 'An explicit tracker-to-session link, recorded on the tracker item or on the session.',
  },
  references: {
    kind: 'recorded',
    basis: 'A commit sha recorded on the tracker item.',
  },
  fixes: {
    // The sha is recorded; "fixes" rather than "references" is this layer's
    // inference from the item's type, and the item never said so.
    kind: 'derived',
    basis: 'A commit sha recorded on the tracker item; "fixes" is derived from the item type, not recorded.',
  },
  edited_in: {
    kind: 'derived',
    basis: 'The session edited a file whose path rolls up to this directory. The directory itself was not recorded.',
  },
  touches: {
    kind: 'derived',
    basis: 'The commit changed a file whose path rolls up to this directory. The directory itself was not recorded.',
  },
  contains: {
    kind: 'derived',
    basis: 'Directory containment derived from the module path.',
  },
  part_of: {
    kind: 'derived',
    basis: "Derived from the record's own file path, not from a recorded relationship.",
  },
  closes: {
    kind: 'recorded',
    basis: 'A closing-issue reference recorded on the pull request.',
  },
};

export function provenanceFor(type: EdgeType | string): Provenance {
  return (
    EDGE_PROVENANCE[type] ?? {
      kind: 'unknown',
      basis: 'The basis for this relation was not recorded.',
    }
  );
}

/** Attach the canonical provenance for an edge's type unless one is supplied. */
export function withProvenance(edge: ProjectGraphEdge): ProjectGraphEdge {
  return edge.provenance ? edge : { ...edge, provenance: provenanceFor(edge.type) };
}

// ---------------------------------------------------------------------------
// Shared field helpers
// ---------------------------------------------------------------------------

/**
 * Collect tags + labels off a blob into a deduped list. Used for both a tracker
 * `data` blob and a session `metadata` blob (tags land there via
 * update_session_meta). `labels` is the collaborative projection and `tags` the
 * simple field; unioning them means a lane appears whichever the item used.
 */
export function tagsFromData(data: Record<string, unknown>): string[] | undefined {
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

export function severityFromFields(fields: Record<string, unknown> | null): ProjectGraphNode['severity'] {
  if (!fields) return undefined;
  const raw = fields.priority ?? fields.severity;
  if (typeof raw !== 'string') return undefined;
  const v = raw.toLowerCase();
  if (v === 'critical' || v === 'p0') return 'critical';
  if (v === 'high' || v === 'p1') return 'high';
  if (v === 'medium' || v === 'p2') return 'medium';
  if (v === 'low' || v === 'p3') return 'low';
  return undefined;
}

/**
 * Category for a tracker node. Only curated, well-known types get a specific
 * home; every other (user-defined) type falls into the generic "Trackers"
 * category so it clusters with its peers.
 */
export function trackerCategoryFor(type: string): ProjectGraphNode['category'] {
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

// ---------------------------------------------------------------------------
// Row -> node
// ---------------------------------------------------------------------------

export function sessionNodeId(id: string): string {
  return `session:${id}`;
}

export function trackerNodeId(id: string): string {
  return `tracker:${id}`;
}

export function sessionRowToNode(
  row: SessionRow,
  options: { dataProjection?: DataProjection } = {},
): ProjectGraphNode {
  const createdAt = toEpochMs(row.created_at);
  const lastActivityAt = toEpochMs(row.last_activity) ?? toEpochMs(row.updated_at);
  const archived = toBool(row.is_archived);
  // Archival is independent of completion: an archived session may never have
  // finished, and a finished session may never be archived.
  const isCompleted = row.status ? COMPLETED_SESSION_STATUSES.has(row.status.toLowerCase()) : false;
  // Workflow-phase history lives in metadata.activity[] (see
  // sessionPhaseTransition.ts). Surfacing it under fields.data.activity lets
  // consumers reconstruct phase segments exactly like tracker items.
  const metadata = parseJsonColumn(row.metadata);
  const activity = Array.isArray(metadata.activity) ? metadata.activity : [];
  const phase = typeof metadata.phase === 'string' ? metadata.phase : undefined;

  return {
    id: sessionNodeId(row.id),
    type: 'ai-session',
    label: row.title || 'Untitled session',
    sublabel: [row.provider, row.model].filter(Boolean).join(' · ') || undefined,
    category: 'delivery',
    source: 'session',
    visibility: 'local',
    // Prefer the workflow phase for coloring; fall back to operational status.
    status: phase ?? row.status ?? undefined,
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
      lastActivityAt,
      phase,
      archived,
      // Shared trackers keep their session links on session metadata. Expose
      // the recorded IDs so consumers need no second query.
      linkedTrackerItemIds: Array.isArray(metadata.linkedTrackerItemIds)
        ? metadata.linkedTrackerItemIds.filter((id): id is string => typeof id === 'string')
        : [],
      ...(options.dataProjection === 'indexed'
        ? {
            dataProjection: 'indexed' as const,
            droppedKeys: Object.keys(metadata).filter(
              k => !(INDEXED_SESSION_METADATA_KEYS as readonly string[]).includes(k),
            ),
          }
        : {
            dataProjection: 'legacy' as const,
            trimmedKeys: trimBlob(metadata, TRIMMED_SESSION_METADATA_KEYS).trimmedKeys,
          }),
      // The phase history, and nothing else from the blob. Each entry is
      // reduced in the indexed projection; see projectActivity.
      data: { activity: options.dataProjection === 'indexed' ? projectActivity(activity) : activity },
    },
  };
}

export function trackerRowToNode(
  row: TrackerRow,
  options: { dataProjection?: DataProjection } = {},
): ProjectGraphNode {
  // The mapper reads scalars off the FULL blob; only the retained copy is
  // projected, so nothing below sees a reduced view.
  const data = parseJsonColumn(row.data);
  const labelPrefix = row.issue_key ?? (row.issue_number != null ? `#${row.issue_number}` : null);
  const title = row.title ?? (typeof data.title === 'string' ? (data.title as string) : null);
  const label = labelPrefix && title ? `${labelPrefix} ${title}` : title || labelPrefix || row.id;
  const createdAt = toEpochMs(row.created);
  const updatedAt = toEpochMs(row.updated);
  const isClosed = row.status ? CLOSED_TRACKER_STATUSES.has(row.status.toLowerCase()) : false;

  return {
    id: trackerNodeId(row.id),
    // Custom tracker types pass through unchanged; the schema layer handles
    // unknown types gracefully.
    type: row.type,
    label,
    sublabel: row.document_path ?? undefined,
    category: trackerCategoryFor(row.type),
    source: 'tracker',
    visibility: 'workspace-shared',
    status: row.status ?? undefined,
    severity: severityFromFields(data),
    tags: tagsFromData(data),
    createdAt,
    // `updated` at close time is the best available close signal; archival
    // never contributes to it.
    closedAt: isClosed ? updatedAt : undefined,
    fields: {
      id: row.id,
      issueKey: row.issue_key,
      issueNumber: row.issue_number,
      documentPath: row.document_path,
      createdAt: row.created,
      updatedAt: row.updated,
      updatedAtMs: updatedAt,
      archived: toBool(row.archived),
      // `body` arrives through `loadDetail`, not here. The dropped-key list
      // names what went so a consumer can tell it apart from absent-at-source.
      ...trackerDataFields(data, options.dataProjection ?? 'legacy'),
    },
  };
}

/**
 * Which retention rule a mapping call uses.
 *
 * `legacy` keeps the near-full blob for the original graph's inspector;
 * `indexed` applies the allow-list projection above. Defaulting to `legacy`
 * means the old surface is unchanged unless a caller opts in.
 */
export type DataProjection = 'legacy' | 'indexed';

/**
 * ALLOW-list for the indexed projection of a tracker's `data`.
 *
 * A deny-list is not a bound on a user- and vendor-extensible blob: any key
 * nobody thought of passes straight through. The index keeps only link, status,
 * tag and state-history metadata; a body reaches a consumer through
 * `loadDetail`, never through the index.
 */
const INDEXED_TRACKER_DATA_KEYS = [
  // links
  'linkedSessions', 'linkedCommits', 'linkedCommitSha', 'customFields',
  // status / classification
  'priority', 'severity', 'status',
  // tags
  'tags', 'labels',
  // state history
  'activity',
] as const;

const INDEXED_SESSION_METADATA_KEYS = [
  'phase', 'tags', 'labels', 'activity', 'linkedTrackerItemIds',
] as const;

/**
 * Fields kept on each `activity` entry. The rest of an entry is an
 * `authorIdentity` blob (email, display name, git name, git email) repeated on
 * every transition — 30,418 of them across this workspace, and none needed to
 * reconstruct when a state changed.
 */
const INDEXED_ACTIVITY_ENTRY_KEYS = [
  'id', 'action', 'field', 'timestamp', 'from', 'to', 'fromValue', 'toValue', 'status', 'phase',
] as const;

/** Metadata keys the LEGACY session mapping drops; see TRIMMED_TRACKER_DATA_KEYS. */
const TRIMMED_SESSION_METADATA_KEYS = ['documentContext', 'attachments', 'originalTask'] as const;

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * Drop the named keys, recording which were actually present so a consumer can
 * tell "trimmed" from "absent at the source".
 */
function trimBlob(
  data: Record<string, unknown>,
  keys: readonly string[],
): { data: Record<string, unknown>; trimmedKeys: string[] } {
  const trimmedKeys: string[] = [];
  let out: Record<string, unknown> | null = null;
  for (const key of keys) {
    if (!(key in data)) continue;
    if (!out) out = { ...data };
    delete out[key];
    trimmedKeys.push(key);
  }
  return { data: out ?? data, trimmedKeys };
}

export function projectActivity(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map(entry =>
    entry && typeof entry === 'object'
      ? pick(entry as Record<string, unknown>, INDEXED_ACTIVITY_ENTRY_KEYS)
      : entry,
  );
}

/**
 * Keep only the relationship-shaped entries of `customFields`. Decided on VALUE
 * shape, not field name, because the same name is a relationship on one tracker
 * type and a plain scalar on another.
 */
function projectCustomFields(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entries = Array.isArray(value) ? value : [value];
    const isRelationship = entries.some(
      e => !!e && typeof e === 'object' && typeof (e as { itemId?: unknown }).itemId === 'string',
    );
    if (isRelationship) out[key] = value;
  }
  return out;
}

/**
 * Project a tracker `data` blob to the indexed allow-list, reporting every key
 * dropped so a consumer can tell "not indexed" from "not recorded".
 */
export function projectTrackerData(data: Record<string, unknown>): {
  data: Record<string, unknown>;
  droppedKeys: string[];
} {
  const kept = pick(data, INDEXED_TRACKER_DATA_KEYS);
  if (kept.activity !== undefined) kept.activity = projectActivity(kept.activity);
  if (kept.customFields !== undefined) {
    const projected = projectCustomFields(kept.customFields);
    if (projected && Object.keys(projected).length > 0) kept.customFields = projected;
    else delete kept.customFields;
  }
  const allowed = new Set<string>(INDEXED_TRACKER_DATA_KEYS);
  return { data: kept, droppedKeys: Object.keys(data).filter(k => !allowed.has(k)) };
}

function trackerDataFields(data: Record<string, unknown>, projection: DataProjection) {
  if (projection === 'indexed') {
    const projected = projectTrackerData(data);
    return { data: projected.data, droppedKeys: projected.droppedKeys, dataProjection: 'indexed' as const };
  }
  const trimmed = trimBlob(data, TRIMMED_TRACKER_DATA_KEYS);
  return { data: trimmed.data, trimmedKeys: trimmed.trimmedKeys, dataProjection: 'legacy' as const };
}

/**
 * The edges a tracker row records about itself: session links and commit links.
 * Endpoints may not be loaded — that is the caller's problem to represent, not
 * a reason to withhold the relation.
 */
export function trackerRowEdges(row: TrackerRow): ProjectGraphEdge[] {
  const data = parseJsonColumn(row.data);
  const nodeId = trackerNodeId(row.id);
  const out: ProjectGraphEdge[] = [];
  const seen = new Set<string>();

  const push = (id: string, type: EdgeType, targetId: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, type, sourceId: nodeId, targetId, provenance: provenanceFor(type) });
  };

  // `linkedSessions` is a device-local convenience field (see TrackerRecord
  // SYSTEM_KEYS); the JSON column carries it at the top level of `data`.
  const linkedSessions = Array.isArray(data.linkedSessions) ? (data.linkedSessions as unknown[]) : [];
  for (const sid of linkedSessions) {
    if (typeof sid !== 'string') continue;
    push(`${nodeId}->${sessionNodeId(sid)}`, 'worked_on_in', sessionNodeId(sid));
  }

  const linkedCommits = Array.isArray(data.linkedCommits)
    ? (data.linkedCommits as Array<Record<string, unknown>>)
    : [];
  const commitShas = new Set<string>();
  if (typeof data.linkedCommitSha === 'string') commitShas.add(data.linkedCommitSha);
  for (const c of linkedCommits) {
    if (typeof c?.sha === 'string') commitShas.add(c.sha);
  }
  // Defect-like items "fix" their linked commits; everything else merely
  // "references" them. Tracker types are user-defined and carry no fix/reference
  // semantics of their own, so the distinction is derived (see EDGE_PROVENANCE).
  const fixesCommits = row.type === 'bug' || row.type === 'incident';
  for (const sha of commitShas) {
    push(`${nodeId}->commit:${sha}`, fixesCommits ? 'fixes' : 'references', `commit:${sha}`);
  }

  return out;
}

/**
 * Session-side tracker links. Trackers shared with a team keep the link on the
 * session's metadata rather than in the tracker's `data`, so both directions
 * have to be read to see the same relation.
 */
export function sessionRowEdges(row: SessionRow, roots: ReferenceRoots): ProjectGraphEdge[] {
  const metadata = parseJsonColumn(row.metadata);
  const ids = Array.isArray(metadata.linkedTrackerItemIds) ? metadata.linkedTrackerItemIds : [];
  const sessionId = sessionNodeId(row.id);
  const out: ProjectGraphEdge[] = [];
  const seen = new Set<string>();

  for (const raw of ids) {
    if (typeof raw !== 'string' || !raw) continue;
    // `linkedTrackerItemIds` is not all tracker ids: 148 sessions in this
    // workspace record entries like `file:nimbalyst-local/plans/foo.md`.
    // Prefixing those with `tracker:` produced an id no source can own, which
    // rendered as a permanently missing tracker item.
    const ref = resolveReferenceId(raw, roots);
    // Keyed on the CANONICAL id, so an absolute and a relative reference to the
    // same file collapse to one edge.
    const id = `${ref.id}->${sessionId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      type: 'worked_on_in',
      sourceId: ref.id,
      targetId: sessionId,
      provenance: {
        kind: 'recorded',
        basis:
          ref.kind === 'tracker'
            ? 'An explicit tracker-to-session link, recorded on the session.'
            : ref.kind === 'file'
              ? `A file reference recorded on the session (${ref.path}). No indexed source owns this path.`
              : `A file reference recorded on the session, resolved to the indexed ${ref.kind} for ${ref.path}.`,
      },
    });
  }
  return out;
}
