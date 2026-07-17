/**
 * Canonical tracker record -- the single authoritative shape for tracker items.
 *
 * All user-defined business data lives in `fields`.
 * System/infrastructure metadata lives in `system`.
 * No layer outside the schema may assume field names.
 */

import type { TrackerIdentity, TrackerActivity, TrackerItem, TrackerItemSource, TrackerOrigin } from './DocumentService';
import type { TrackerCommentEntry as TrackerComment } from '../sync/trackerProtocol';

// ---------------------------------------------------------------------------
// Canonical Record
// ---------------------------------------------------------------------------

export interface LinkedCommit {
  sha: string;
  message: string;
  sessionId?: string;
  timestamp: string;
}

/**
 * Explicit link from a tracker item to a pull request, written by the PR
 * view's "Link tracker item" action (or agent tooling). Complements the
 * zero-config path where any url-type field matching a PR URL counts as a
 * reference (see plugins/TrackerPlugin/prReferences.ts).
 */
export interface LinkedPullRequest {
  /** GitHub remote as "owner/repo" (lowercase). */
  remote: string;
  number: number;
  url?: string;
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
  linkedPullRequests?: LinkedPullRequest[];
  documentId?: string;
  activity?: TrackerActivity[];
  comments?: TrackerComment[];
  /** Structured origin (how the item entered Nimbalyst; pointer to upstream for imports). */
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
  'linkedPullRequests',
  'documentId',
  'activity',
  'comments',
  'origin',
  // also pulled from row-level columns, not from data JSONB
  'assigneeId',
  'reporterId',
]);

/**
 * Fields on the old TrackerItem that map to top-level TrackerRecord props
 * or system metadata -- not to `fields`.
 */
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
// TrackerItem <-> TrackerRecord converters
// ---------------------------------------------------------------------------

function isDateOnlyOrMidnightUtc(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    || /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(trimmed);
}

function chooseUpdatedAt(item: TrackerItem, lastIndexedIso: string | undefined): string | undefined {
  const candidate = item.updated ?? item.created;
  if (
    item.source === 'frontmatter'
    && lastIndexedIso
    && isDateOnlyOrMidnightUtc(candidate)
  ) {
    return lastIndexedIso;
  }
  return item.updated ?? item.created ?? lastIndexedIso;
}

/**
 * Convert a legacy TrackerItem to the canonical TrackerRecord.
 * All TrackerItem properties that aren't system/routing keys go into `fields`.
 * No privileged field vocabulary -- the converter is generic.
 */
export function trackerItemToRecord(item: TrackerItem): TrackerRecord {
  const fields: Record<string, unknown> = {};

  // Move all non-system, non-routing properties into the fields bag.
  // This is generic -- no hardcoded list of "business fields".
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined) continue;
    if (NON_FIELD_KEYS.has(key)) continue;
    fields[key] = value;
  }

  // Merge customFields into fields (customFields was the old catch-all)
  if (item.customFields) {
    for (const [key, value] of Object.entries(item.customFields)) {
      if (value !== undefined && !NON_FIELD_KEYS.has(key)) {
        fields[key] = value;
      }
    }
  }

  // NIM-1559: NEVER fabricate `new Date()` for a missing created/updated. This
  // mapping runs on EVERY tracker reload (initial load, metadata-changed,
  // workspace scan). Defaulting an absent timestamp to `now` produced a fresh
  // value each reload, so any item without a frontmatter `created`/`updated`
  // (e.g. a plan file with no dates) showed "just now" and jumped to the top of
  // the Updated-sorted table on every restart/refresh. Fall back to the item's
  // `lastIndexed` (a stable file mtime), then epoch -- a stable, non-churning
  // value that sorts undated items to the bottom instead of the top.
  const lastIndexedIso = item.lastIndexed instanceof Date
    ? item.lastIndexed.toISOString()
    : typeof item.lastIndexed === 'string'
      ? item.lastIndexed
      : undefined;
  const EPOCH_ISO = new Date(0).toISOString();
  const updatedAt = chooseUpdatedAt(item, lastIndexedIso) ?? EPOCH_ISO;

  const record: TrackerRecord = {
    id: item.id,
    primaryType: item.type,
    typeTags: item.typeTags ?? [item.type],
    issueNumber: item.issueNumber,
    issueKey: item.issueKey,
    source: (item.source as TrackerRecord['source']) ?? 'native',
    sourceRef: item.sourceRef,
    archived: item.archived ?? false,
    syncStatus: (item.syncStatus as TrackerRecord['syncStatus']) ?? 'local',
    content: item.content,
    system: {
      workspace: item.workspace,
      documentPath: item.module || undefined,
      lineNumber: item.lineNumber,
      createdAt: item.created ?? lastIndexedIso ?? EPOCH_ISO,
      updatedAt,
      lastIndexed: lastIndexedIso,
      authorIdentity: item.authorIdentity,
      lastModifiedBy: item.lastModifiedBy,
      createdByAgent: item.createdByAgent,
      linkedSessions: item.linkedSessions,
      linkedCommitSha: item.linkedCommitSha,
      linkedCommits: item.linkedCommits,
      documentId: item.documentId,
      origin: item.origin,
    },
    fields,
  };

  // Pull any SYSTEM_KEYS found in customFields into system generically.
  // This avoids hardcoding field names -- any key declared in SYSTEM_KEYS
  // (e.g. activity, comments) that came through the JSONB catch-all lands here.
  if (item.customFields) {
    for (const key of SYSTEM_KEYS) {
      if (key in item.customFields && (record.system as any)[key] === undefined) {
        (record.system as any)[key] = item.customFields[key];
      }
    }
  }

  return record;
}

/**
 * Convert a canonical TrackerRecord back to the legacy TrackerItem shape.
 * Used during the migration period while consumers still expect TrackerItem.
 *
 * Maps record.fields back to TrackerItem's top-level properties.
 * All fields that don't map to a TrackerItem property go into customFields.
 */
export function trackerRecordToItem(record: TrackerRecord): TrackerItem {
  const f = record.fields;

  // TrackerItem has these properties that come from fields.
  // Everything else goes into customFields.
  const trackerItemFieldProps = new Set([
    'title', 'status', 'priority', 'owner', 'description',
    'tags', 'dueDate', 'progress', 'assigneeEmail', 'reporterEmail', 'labels',
  ]);
  const customFields: Record<string, any> = {};
  for (const [key, value] of Object.entries(f)) {
    if (!trackerItemFieldProps.has(key)) {
      customFields[key] = value;
    }
  }

  return {
    id: record.id,
    type: record.primaryType,
    typeTags: record.typeTags,
    issueNumber: record.issueNumber,
    issueKey: record.issueKey,
    // Map fields to TrackerItem's fixed properties
    title: (f.title as string) ?? '',
    status: (f.status as string) ?? 'to-do',
    priority: f.priority as TrackerItem['priority'],
    owner: f.owner as string | undefined,
    description: f.description as string | undefined,
    tags: f.tags as string[] | undefined,
    dueDate: f.dueDate as string | undefined,
    progress: f.progress as number | undefined,
    assigneeEmail: f.assigneeEmail as string | undefined,
    reporterEmail: f.reporterEmail as string | undefined,
    labels: f.labels as string[] | undefined,
    module: record.system.documentPath ?? '',
    lineNumber: record.system.lineNumber,
    workspace: record.system.workspace,
    created: record.system.createdAt,
    updated: record.system.updatedAt,
    lastIndexed: record.system.lastIndexed ? new Date(record.system.lastIndexed) : new Date(),
    content: record.content,
    archived: record.archived,
    archivedAt: undefined, // not stored on TrackerRecord -- derive from activity if needed
    origin: record.system.origin,
    source: record.source as TrackerItemSource,
    sourceRef: record.sourceRef,
    authorIdentity: record.system.authorIdentity,
    lastModifiedBy: record.system.lastModifiedBy,
    createdByAgent: record.system.createdByAgent,
    linkedSessions: record.system.linkedSessions,
    linkedCommitSha: record.system.linkedCommitSha,
    linkedCommits: record.system.linkedCommits,
    documentId: record.system.documentId,
    syncStatus: record.syncStatus as TrackerItem['syncStatus'],
    customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
  };
}

// ---------------------------------------------------------------------------
// DB Row <-> TrackerRecord converters
// ---------------------------------------------------------------------------

/**
 * Convert a PGLite tracker_items row to a TrackerRecord.
 *
 * The row has top-level SQL columns (id, type, workspace, etc.)
 * plus a JSONB `data` column that contains all field values and
 * system metadata mixed together.
 */
export function dbRowToRecord(row: any): TrackerRecord {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data || {};
  const nestedCustomFields =
    data.customFields && typeof data.customFields === 'object' && !Array.isArray(data.customFields)
      ? data.customFields as Record<string, unknown>
      : undefined;

  // type_tags is TEXT[] in PGLite (returns string[]) but TEXT in SQLite (returns a
  // JSON-encoded string). Parse the SQLite shape back into an array, otherwise a raw
  // string flows downstream and breaks array operations on typeTags.
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

  // Separate system keys from user fields
  const fields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (NON_FIELD_KEYS.has(key) || SYSTEM_KEYS.has(key)) continue;
    if (value !== undefined) {
      fields[key] = value;
    }
  }
  if (nestedCustomFields) {
    for (const [key, value] of Object.entries(nestedCustomFields)) {
      if (NON_FIELD_KEYS.has(key) || SYSTEM_KEYS.has(key)) continue;
      if (value !== undefined) {
        fields[key] = value;
      }
    }
  }

  const systemValue = (key: string): unknown =>
    data[key] !== undefined ? data[key] : nestedCustomFields?.[key];

  return {
    id: row.id,
    primaryType: row.type,
    typeTags,
    issueNumber: row.issue_number ?? undefined,
    issueKey: row.issue_key ?? undefined,
    source: row.source || (row.document_path ? 'inline' : 'native'),
    sourceRef: row.source_ref ?? undefined,
    archived: row.archived ?? false,
    syncStatus: row.sync_status || 'local',
    content: row.content ?? undefined,
    system: {
      workspace: row.workspace,
      documentPath: row.document_path || undefined,
      lineNumber: row.line_number ?? undefined,
      createdAt: data.created || (row.created ? new Date(row.created).toISOString() : new Date().toISOString()),
      updatedAt: data.updated || (row.updated ? new Date(row.updated).toISOString() : new Date().toISOString()),
      lastIndexed: row.last_indexed ? new Date(row.last_indexed).toISOString() : undefined,
      authorIdentity: systemValue('authorIdentity') as TrackerIdentity | null | undefined,
      lastModifiedBy: systemValue('lastModifiedBy') as TrackerIdentity | null | undefined,
      createdByAgent: (systemValue('createdByAgent') as boolean | undefined) || false,
      linkedSessions: systemValue('linkedSessions') as string[] | undefined,
      linkedCommitSha: systemValue('linkedCommitSha') as string | undefined,
      linkedCommits: systemValue('linkedCommits') as LinkedCommit[] | undefined,
      linkedPullRequests: systemValue('linkedPullRequests') as LinkedPullRequest[] | undefined,
      documentId: systemValue('documentId') as string | undefined,
      activity: systemValue('activity') as TrackerActivity[] | undefined,
      comments: systemValue('comments') as TrackerComment[] | undefined,
      origin: systemValue('origin') as TrackerOrigin | undefined,
    },
    fields,
  };
}

/**
 * Prepare parameters for inserting/updating a TrackerRecord in PGLite.
 *
 * Returns the JSONB `data` payload (merging fields + system metadata)
 * and the top-level column values needed for the SQL statement.
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
  // Build the JSONB data object: merge fields + system metadata
  const data: Record<string, unknown> = { ...record.fields };

  // System metadata stored in JSONB
  if (record.system.authorIdentity) data.authorIdentity = record.system.authorIdentity;
  if (record.system.lastModifiedBy) data.lastModifiedBy = record.system.lastModifiedBy;
  if (record.system.createdByAgent) data.createdByAgent = record.system.createdByAgent;
  if (record.system.linkedSessions?.length) data.linkedSessions = record.system.linkedSessions;
  if (record.system.linkedCommitSha) data.linkedCommitSha = record.system.linkedCommitSha;
  if (record.system.linkedCommits?.length) data.linkedCommits = record.system.linkedCommits;
  if (record.system.linkedPullRequests?.length) data.linkedPullRequests = record.system.linkedPullRequests;
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
