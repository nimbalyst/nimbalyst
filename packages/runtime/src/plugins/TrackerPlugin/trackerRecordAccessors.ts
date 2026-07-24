/**
 * Accessor utilities for reading TrackerRecord fields via schema roles.
 *
 * These are pure functions (no React hooks) so they can be used in both
 * renderer components and non-React code (MCP handlers, sync, etc.).
 */

import type { TrackerRecord } from '../../core/TrackerRecord';
import type { TrackerIdentity } from '../../core/DocumentService';
import type { TrackerSchemaRole, FieldDefinition } from './models/TrackerDataModel';
import { globalRegistry, getRoleField } from './models/TrackerDataModel';

/**
 * Conventional field names for each role.
 * Used as fallback when a model doesn't declare explicit roles.
 */
const ROLE_DEFAULTS: Record<TrackerSchemaRole, string> = {
  title: 'title',
  workflowStatus: 'status',
  priority: 'priority',
  assignee: 'owner',
  reporter: 'reporterEmail',
  tags: 'tags',
  startDate: 'startDate',
  dueDate: 'dueDate',
  progress: 'progress',
  // No conventional fallbacks: these roles only apply when a schema declares
  // them explicitly (externalKey names a field; prMergedStatus names a status
  // VALUE and must never be resolved through getFieldByRole).
  externalKey: '',
  prMergedStatus: '',
};

/**
 * Resolve the field name for a role given a tracker type.
 * Uses explicit role mapping first, falls back to conventional defaults.
 */
export function resolveRoleFieldName(type: string, role: TrackerSchemaRole): string {
  const model = globalRegistry.get(type);
  if (model) {
    const explicit = getRoleField(model, role);
    if (explicit) return explicit;
  }
  return ROLE_DEFAULTS[role];
}

/**
 * Whether a tracker item is shared with the team.
 * - `shared`: item participates in team collaboration.
 * - `local`: item stays on this device / project only.
 * - `n/a`: the tracker type never syncs (sync mode `local`), so sharing
 *   doesn't apply.
 */
export type TrackerItemShareState = 'shared' | 'local' | 'n/a';

/**
 * Determine whether a tracker item is shared with the team.
 *
 * - `shared`-mode types: every item is always shared.
 * - `local`-mode types: sharing never applies (returns `n/a`).
 * - `hybrid`-mode types: per-item, driven by the explicit `share` flag
 *   (surfaced under `fields` as `{ status, body }` or the legacy
 *   `fields.shared === true`). Items pushed to a room before the explicit flag
 *   existed (syncStatus `synced`/`pending`) count as shared so they keep
 *   collaborating.
 *
 * Pure (no React/host deps) so the table column, the item detail view, and
 * non-React code all agree on one definition.
 */
export function getItemShareState(record: TrackerRecord): TrackerItemShareState {
  const mode = globalRegistry.get(record.primaryType ?? '')?.sync?.mode ?? 'local';
  if (mode === 'shared') return 'shared';
  if (mode === 'local') return 'n/a';
  // hybrid: per-item
  const f = (record.fields ?? {}) as Record<string, any>;
  const share = f.share && typeof f.share === 'object' ? f.share : null;
  // An EXPLICIT flag is authoritative -- trust it immediately (so an unshare
  // reads as local even before the room state propagates).
  const hasExplicit =
    f.shared === true ||
    (share && (share.status === 'team' || share.status === 'private' || share.body === 'team' || share.body === 'private'));
  if (hasExplicit) {
    return (f.shared === true || share?.status === 'team' || share?.body === 'team') ? 'shared' : 'local';
  }
  // No explicit flag: a legacy item already pushed to the room counts as shared.
  return (record.syncStatus === 'synced' || record.syncStatus === 'pending') ? 'shared' : 'local';
}

/**
 * Convenience boolean: is this item actively shared with the team?
 * `local` and `n/a` both read as not-shared.
 */
export function isItemSharedWithTeam(record: TrackerRecord): boolean {
  return getItemShareState(record) === 'shared';
}

/**
 * Get the value of the field that fulfills a given role for a record.
 * Uses the model's explicit role mapping first, falls back to
 * conventional field names when no role is declared.
 */
export function getFieldByRole(record: TrackerRecord, role: TrackerSchemaRole): unknown {
  const model = globalRegistry.get(record.primaryType);
  const fieldName = model ? (getRoleField(model, role) ?? ROLE_DEFAULTS[role]) : ROLE_DEFAULTS[role];
  return record.fields[fieldName];
}

/**
 * Get a typed field value by role with a fallback.
 */
export function getFieldByRoleAs<T>(record: TrackerRecord, role: TrackerSchemaRole, fallback: T): T {
  const value = getFieldByRole(record, role);
  return (value as T) ?? fallback;
}

/**
 * Get a string field value directly from record.fields.
 */
export function getRecordField(record: TrackerRecord, fieldName: string): unknown {
  return record.fields[fieldName];
}

/**
 * Get a string field value with fallback.
 */
export function getRecordFieldStr(record: TrackerRecord, fieldName: string, fallback = ''): string {
  const value = record.fields[fieldName];
  return typeof value === 'string' ? value : fallback;
}

/**
 * Get the title of a record using the title role.
 * Falls back to empty string if no title role is defined.
 */
export function getRecordTitle(record: TrackerRecord): string {
  return getFieldByRoleAs<string>(record, 'title', '');
}

/**
 * Get the workflow status of a record using the workflowStatus role.
 */
export function getRecordStatus(record: TrackerRecord): string {
  return getFieldByRoleAs<string>(record, 'workflowStatus', '');
}

/**
 * Get the priority of a record using the priority role.
 */
export function getRecordPriority(record: TrackerRecord): string {
  return getFieldByRoleAs<string>(record, 'priority', '');
}

/**
 * Get the kanban sort order key for a record.
 * This is a plain data field, not a schema role.
 */
export function getRecordSortOrder(record: TrackerRecord): string | undefined {
  return record.fields.kanbanSortOrder as string | undefined;
}

/**
 * Get the display value of the externalKey role, or '' when the type doesn't
 * declare one. url-type field values ({ url, label }) contribute their label
 * (falling back to the url); scalars render as-is.
 */
export function getRecordExternalKey(record: TrackerRecord): string {
  const model = globalRegistry.get(record.primaryType);
  const fieldName = model ? getRoleField(model, 'externalKey') : undefined;
  if (!fieldName) return '';
  const value = record.fields[fieldName];
  if (value == null) return '';
  if (typeof value === 'object') {
    const obj = value as { label?: unknown; url?: unknown };
    if (typeof obj.label === 'string' && obj.label) return obj.label;
    if (typeof obj.url === 'string') return obj.url;
    return '';
  }
  return String(value);
}

/**
 * Get the FieldDefinition for the field that fulfills a role in a record's type.
 * Falls back to conventional field names when no role is declared.
 */
export function getFieldDefForRole(type: string, role: TrackerSchemaRole): FieldDefinition | undefined {
  const model = globalRegistry.get(type);
  if (!model) return undefined;
  const fieldName = getRoleField(model, role) ?? ROLE_DEFAULTS[role];
  return model.fields.find(f => f.name === fieldName);
}

/**
 * Get the status options for a record's type (the workflowStatus role's select options).
 */
export function getStatusOptions(type: string): Array<{ value: string; label: string; icon?: string; color?: string }> {
  const fieldDef = getFieldDefForRole(type, 'workflowStatus');
  return fieldDef?.options ?? [];
}

/**
 * Get the priority options for a record's type.
 */
export function getPriorityOptions(type: string): Array<{ value: string; label: string; icon?: string; color?: string }> {
  const fieldDef = getFieldDefForRole(type, 'priority');
  return fieldDef?.options ?? [];
}

// ---------------------------------------------------------------------------
// Kanban column ordering (NIM-789)
// ---------------------------------------------------------------------------

export interface KanbanStatusColumn {
  value: string;
  label: string;
}

/**
 * Fallback columns used only when a type declares no workflowStatus options.
 * This is NOT a canonical status order: a schema's `workflowStatus` field
 * `options` order is always authoritative when present.
 */
const DEFAULT_KANBAN_COLUMNS: KanbanStatusColumn[] = [
  { value: 'to-do', label: 'To Do' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'in-review', label: 'In Review' },
  { value: 'done', label: 'Done' },
];

/** Title-case a kebab status value, e.g. `another-one` -> `Another One`. */
function titleCaseStatus(status: string): string {
  return status
    .split('-')
    .map(w => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Pure ordering helper for kanban columns.
 *
 * The schema's workflowStatus option order is authoritative — columns appear
 * in exactly the order the type declares them, never reordered by how many
 * items fall in each status. Statuses present on items but absent from the
 * schema are appended in first-seen order so nothing silently disappears.
 * When a type declares no options, a sensible default set is used.
 */
export function orderKanbanColumns(
  schemaOptions: Array<{ value: string; label: string }>,
  itemStatuses: string[],
): KanbanStatusColumn[] {
  const columns: KanbanStatusColumn[] = [];
  const seen = new Set<string>();

  for (const o of schemaOptions) {
    if (!seen.has(o.value)) {
      seen.add(o.value);
      columns.push({ value: o.value, label: o.label });
    }
  }

  if (columns.length === 0) {
    for (const col of DEFAULT_KANBAN_COLUMNS) {
      seen.add(col.value);
      columns.push(col);
    }
  }

  for (const raw of itemStatuses) {
    const status = (raw || 'to-do').toLowerCase();
    if (!seen.has(status)) {
      seen.add(status);
      columns.push({ value: status, label: titleCaseStatus(status) });
    }
  }

  return columns;
}

/**
 * Build kanban status columns for a tracker type, deriving column order from
 * the type's workflowStatus field options (via the registry). Items contribute
 * only any extra statuses not covered by the schema. `'all'` (the mixed-type
 * pseudo view) has no single schema, so it falls back to defaults + item scan.
 */
export function buildKanbanStatusColumns(
  type: string | 'all',
  items: TrackerRecord[],
): KanbanStatusColumn[] {
  const schemaOptions = type !== 'all' ? getStatusOptions(type) : [];
  const itemStatuses = items.map(r => getRecordStatus(r) || 'to-do');
  return orderKanbanColumns(schemaOptions, itemStatuses);
}

// ---------------------------------------------------------------------------
// Identity matching
// ---------------------------------------------------------------------------

/**
 * Check whether a string value (owner, assigneeEmail, etc.) matches any
 * facet of the given identity.  All comparisons are case-insensitive.
 */
function matchesIdentity(value: string, identity: TrackerIdentity): boolean {
  const v = value.toLowerCase();
  if (identity.email && v === identity.email.toLowerCase()) return true;
  if (identity.displayName && v === identity.displayName.toLowerCase()) return true;
  if (identity.gitEmail && v === identity.gitEmail.toLowerCase()) return true;
  if (identity.gitName && v === identity.gitName.toLowerCase()) return true;
  return false;
}

/**
 * Whether two identities denote the same person. Used for author-scoped
 * permissions (e.g. comment edit/delete by author — NIM-360). Matches on any
 * stable facet, case-insensitively, and cross-matches email <-> gitEmail since
 * the same person may have been captured under either at write time. Display
 * name is only a tiebreaker when no email/git facet is present on both sides
 * (names collide too easily to authorize on alone).
 */
export function isSameIdentity(
  a: TrackerIdentity | null | undefined,
  b: TrackerIdentity | null | undefined,
): boolean {
  if (!a || !b) return false;
  const norm = (s?: string | null) => (s ? s.trim().toLowerCase() : '');
  const aEmails = [norm(a.email), norm(a.gitEmail)].filter(Boolean);
  const bEmails = [norm(b.email), norm(b.gitEmail)].filter(Boolean);
  for (const ae of aEmails) {
    if (bEmails.includes(ae)) return true;
  }
  if (aEmails.length === 0 && bEmails.length === 0) {
    const ad = norm(a.displayName);
    const bd = norm(b.displayName);
    if (ad && bd && ad === bd) return true;
  }
  return false;
}

/**
 * Determine whether a TrackerRecord belongs to the given identity.
 *
 * Matches on:
 *  1. The assignee-role field (defaults to `owner`) -- any identity facet
 *  2. The `assigneeEmail` field -- any identity facet
 *  3. The author identity stored in system metadata -- email or git email
 *
 * All comparisons are case-insensitive.
 */
export function isMyRecord(record: TrackerRecord, identity: TrackerIdentity): boolean {
  // 1. Assignee role field (resolves to 'owner' by default)
  const assignee = getFieldByRole(record, 'assignee') as string | undefined;
  if (assignee && matchesIdentity(assignee, identity)) return true;

  // 2. Explicit assigneeEmail field (used by MCP tools)
  const assigneeEmail = record.fields.assigneeEmail as string | undefined;
  if (assigneeEmail && matchesIdentity(assigneeEmail, identity)) return true;

  // 3. Author identity (who created the item)
  const author = record.system.authorIdentity;
  if (author?.email && identity.email &&
      author.email.toLowerCase() === identity.email.toLowerCase()) return true;
  if (author?.gitEmail && identity.gitEmail &&
      author.gitEmail.toLowerCase() === identity.gitEmail.toLowerCase()) return true;

  return false;
}
