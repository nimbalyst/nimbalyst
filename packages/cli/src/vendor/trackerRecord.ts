/**
 * VENDORED COPY of `packages/runtime/src/core/TrackerRecord.ts`.
 *
 * Why vendored and not imported from `@nimbalyst/runtime/core/TrackerRecord`:
 * the runtime package is built with Vite into browser/electron-oriented bundle
 * chunks. Its `package.json` exports map advertises `./core/TrackerRecord.js`
 * but the Vite build does not emit that standalone Node-ESM file (only a mirrored
 * `.d.ts` and bundled chunks), so a runtime `import` from the published package
 * would fail. The conversion logic here is pure (no I/O, no heavy deps), so we
 * carry an exact copy.
 *
 * This resolves the plan's open question "Whether nim bundles its own copy of the
 * runtime tracker core or depends on the published @nimbalyst/runtime" in favor
 * of bundling — forced by the build reality above.
 *
 * KEEP IN SYNC: if `recordToDbParams` / `dbRowToRecord` / the key-sets change in
 * the runtime, mirror the change here. The CLI must never hand-roll a *different*
 * JSON parse of the `data` column — it must agree byte-for-byte with the app.
 */

// ---------------------------------------------------------------------------
// Minimal structural types (the runtime imports these from DocumentService /
// trackerProtocol; the CLI only needs them structurally).
// ---------------------------------------------------------------------------

export type TrackerIdentity = Record<string, unknown>;
export interface TrackerActivity {
  [key: string]: unknown;
}
export interface TrackerComment {
  [key: string]: unknown;
}
export type TrackerOrigin = Record<string, unknown>;

export interface LinkedCommit {
  sha: string;
  message: string;
  sessionId?: string;
  timestamp: string;
}

export interface TrackerRecordSystem {
  workspace: string;
  documentPath?: string;
  lineNumber?: number;
  createdAt: string;
  updatedAt: string;
  lastIndexed?: string;
  authorIdentity?: TrackerIdentity | null;
  lastModifiedBy?: TrackerIdentity | null;
  createdByAgent?: boolean;
  linkedSessions?: string[];
  linkedCommitSha?: string;
  linkedCommits?: LinkedCommit[];
  documentId?: string;
  activity?: TrackerActivity[];
  comments?: TrackerComment[];
  origin?: TrackerOrigin;
}

export interface TrackerRecord {
  id: string;
  primaryType: string;
  typeTags: string[];
  issueNumber?: number;
  issueKey?: string;
  source: 'native' | 'inline' | 'frontmatter' | 'import';
  sourceRef?: string;
  archived: boolean;
  syncStatus: 'local' | 'pending' | 'synced';
  content?: unknown;
  system: TrackerRecordSystem;
  fields: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fields that live in `system`, NOT in `fields`
// ---------------------------------------------------------------------------

const SYSTEM_KEYS = new Set([
  'authorIdentity',
  'lastModifiedBy',
  'createdByAgent',
  'linkedSessions',
  'linkedCommitSha',
  'linkedCommits',
  'documentId',
  'activity',
  'comments',
  'origin',
  // also pulled from row-level columns, not from data JSONB
  'assigneeId',
  'reporterId',
]);

const NON_FIELD_KEYS = new Set([
  // top-level record props
  'id', 'type', 'typeTags', 'issueNumber', 'issueKey',
  'source', 'sourceRef', 'archived', 'archivedAt', 'syncStatus',
  'content', 'module', 'lineNumber', 'workspace', 'lastIndexed',
  'created', 'updated',
  // system keys
  ...SYSTEM_KEYS,
  // deprecated compat keys
  'assigneeId', 'reporterId',
  // old catch-all that's being replaced
  'customFields',
]);

// ---------------------------------------------------------------------------
// DB Row -> TrackerRecord (read path)
// ---------------------------------------------------------------------------

/**
 * Convert a tracker_items row to a TrackerRecord.
 *
 * The `data` column is JSON TEXT on SQLite (parsed object on PGLite). `type_tags`
 * is a JSON-encoded string on SQLite (TEXT[] on PGLite). Both divergences are
 * handled defensively so the same function works against either backend.
 */
export function dbRowToRecord(row: any): TrackerRecord {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data || {};

  const rawTypeTags = row.type_tags;
  const parsedTypeTags: string[] | undefined = Array.isArray(rawTypeTags)
    ? rawTypeTags
    : typeof rawTypeTags === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(rawTypeTags);
            return Array.isArray(parsed) ? (parsed as string[]) : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined;
  const typeTags: string[] = parsedTypeTags && parsedTypeTags.length > 0
    ? parsedTypeTags
    : [row.type];

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (NON_FIELD_KEYS.has(key) || SYSTEM_KEYS.has(key)) continue;
    if (value !== undefined) {
      fields[key] = value;
    }
  }

  return {
    id: row.id,
    primaryType: row.type,
    typeTags,
    issueNumber: row.issue_number ?? undefined,
    issueKey: row.issue_key ?? undefined,
    source: row.source || (row.document_path ? 'inline' : 'native'),
    sourceRef: row.source_ref ?? undefined,
    archived: row.archived === 1 || row.archived === true || false,
    syncStatus: row.sync_status || 'local',
    content: parseMaybeJson(row.content),
    system: {
      workspace: row.workspace,
      documentPath: row.document_path || undefined,
      lineNumber: row.line_number ?? undefined,
      createdAt: data.created || (row.created ? toIso(row.created) : new Date().toISOString()),
      updatedAt: data.updated || (row.updated ? toIso(row.updated) : new Date().toISOString()),
      lastIndexed: row.last_indexed ? toIso(row.last_indexed) : undefined,
      authorIdentity: data.authorIdentity || undefined,
      lastModifiedBy: data.lastModifiedBy || undefined,
      createdByAgent: data.createdByAgent || false,
      linkedSessions: data.linkedSessions || undefined,
      linkedCommitSha: data.linkedCommitSha || undefined,
      linkedCommits: data.linkedCommits || undefined,
      documentId: data.documentId || undefined,
      activity: data.activity || undefined,
      comments: data.comments || undefined,
      origin: data.origin || undefined,
    },
    fields,
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  try {
    return new Date(value as any).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (value == null) return undefined;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// TrackerRecord -> DB params (write path)
// ---------------------------------------------------------------------------

/**
 * Faithful mirror of `recordToDbParams` from the runtime's
 * `packages/runtime/src/core/TrackerRecord.ts`. It is the documented inverse of
 * `dbRowToRecord` and completes this vendored mirror.
 *
 * NOTE on the offline write path: the CLI's DirectGateway does NOT build a row
 * via this function. The app's MCP tool handlers (`tracker_create` /
 * `tracker_update` / `tracker_add_comment`) hand-build the `data` JSON with a
 * subtly different shape than this converter (e.g. create stores `data.created`
 * as a date-only `YYYY-MM-DD` string and never writes `data.updated`, while this
 * converter stores both as full ISO). To keep a CLI-written row byte-for-byte
 * indistinguishable from an app-written one, DirectGateway mirrors those
 * handlers directly. This export is retained as the canonical contract for any
 * future caller that wants the runtime's record→row conversion.
 */
export function recordToDbParams(record: TrackerRecord): {
  id: string;
  type: string;
  typeTags: string[];
  data: string;
  workspace: string;
  documentPath: string;
  lineNumber: number | null;
  syncStatus: string;
  content: string | null;
  archived: boolean;
  source: string;
  sourceRef: string | null;
} {
  const data: Record<string, unknown> = { ...record.fields };

  if (record.system.authorIdentity) data.authorIdentity = record.system.authorIdentity;
  if (record.system.lastModifiedBy) data.lastModifiedBy = record.system.lastModifiedBy;
  if (record.system.createdByAgent) data.createdByAgent = record.system.createdByAgent;
  if (record.system.linkedSessions?.length) data.linkedSessions = record.system.linkedSessions;
  if (record.system.linkedCommitSha) data.linkedCommitSha = record.system.linkedCommitSha;
  if (record.system.linkedCommits?.length) data.linkedCommits = record.system.linkedCommits;
  if (record.system.documentId) data.documentId = record.system.documentId;
  if (record.system.activity?.length) data.activity = record.system.activity;
  if (record.system.comments?.length) data.comments = record.system.comments;
  if (record.system.origin) data.origin = record.system.origin;
  if (record.system.createdAt) data.created = record.system.createdAt;
  if (record.system.updatedAt) data.updated = record.system.updatedAt;

  return {
    id: record.id,
    type: record.primaryType,
    typeTags: record.typeTags,
    data: JSON.stringify(data),
    workspace: record.system.workspace,
    documentPath: record.system.documentPath ?? '',
    lineNumber: record.system.lineNumber ?? null,
    syncStatus: record.syncStatus,
    content: record.content != null ? JSON.stringify(record.content) : null,
    archived: record.archived,
    source: record.source,
    sourceRef: record.sourceRef ?? null,
  };
}
