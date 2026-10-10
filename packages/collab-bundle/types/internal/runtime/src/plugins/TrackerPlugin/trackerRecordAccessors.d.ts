/**
 * Accessor utilities for reading TrackerRecord fields via schema roles.
 *
 * These are pure functions (no React hooks) so they can be used in both
 * renderer components and non-React code (MCP handlers, sync, etc.).
 */
import type { TrackerRecord } from '../../core/TrackerRecord';
import type { TrackerIdentity } from '../../core/DocumentService';
import type { TrackerSchemaRole, FieldDefinition } from '../../../../tracker-schema/src/browser';
/**
 * Resolve the field name for a role given a tracker type.
 * Uses explicit role mapping first, falls back to conventional defaults.
 */
export declare function resolveRoleFieldName(type: string, role: TrackerSchemaRole): string;
/**
 * Whether a tracker item is published to the team.
 * - `published`: item participates in team collaboration.
 * - `draft`: item stays local until it is published.
 * - `n/a`: the tracker is personal, so publication does not apply.
 */
export type TrackerItemPublicationState = 'published' | 'draft' | 'n/a';
/**
 * Determine whether a tracker item is published to the team.
 *
 * - Personal trackers: publication never applies (returns `n/a`).
 * - Team trackers: the existing per-item bit is Draft/Published, with
 *   `draftByDefault` deciding the state of items that do not yet carry an
 *   explicit value. Items pushed to a room before that flag existed
 *   (syncStatus `synced`/`pending`) count as published so they keep
 *   collaborating.
 *
 * Pure (no React/host deps) so the table column, the item detail view, and
 * non-React code all agree on one definition.
 */
export declare function getItemPublicationState(record: TrackerRecord): TrackerItemPublicationState;
/**
 * Convenience boolean: is this item actively shared with the team?
 * `local` and `n/a` both read as not-shared.
 */
export declare function isItemPublished(record: TrackerRecord): boolean;
/**
 * Get the value of the field that fulfills a given role for a record.
 * Uses the model's explicit role mapping first, falls back to
 * conventional field names when no role is declared.
 */
export declare function getFieldByRole(record: TrackerRecord, role: TrackerSchemaRole): unknown;
/**
 * Get a typed field value by role with a fallback.
 */
export declare function getFieldByRoleAs<T>(record: TrackerRecord, role: TrackerSchemaRole, fallback: T): T;
/**
 * Get a string field value directly from record.fields.
 */
export declare function getRecordField(record: TrackerRecord, fieldName: string): unknown;
/**
 * Get a string field value with fallback.
 */
export declare function getRecordFieldStr(record: TrackerRecord, fieldName: string, fallback?: string): string;
/**
 * Get the title of a record using the title role.
 * Falls back to empty string if no title role is defined.
 */
export declare function getRecordTitle(record: TrackerRecord): string;
/**
 * Get the workflow status of a record using the workflowStatus role.
 */
export declare function getRecordStatus(record: TrackerRecord): string;
/**
 * Get the priority of a record using the priority role.
 */
export declare function getRecordPriority(record: TrackerRecord): string;
/**
 * Get the kanban sort order key for a record.
 * This is a plain data field, not a schema role.
 */
export declare function getRecordSortOrder(record: TrackerRecord): string | undefined;
/**
 * Get the display value of the externalKey role, or '' when the type doesn't
 * declare one. url-type field values ({ url, label }) contribute their label
 * (falling back to the url); scalars render as-is.
 */
export declare function getRecordExternalKey(record: TrackerRecord): string;
/**
 * Get the FieldDefinition for the field that fulfills a role in a record's type.
 * Falls back to conventional field names when no role is declared.
 */
export declare function getFieldDefForRole(type: string, role: TrackerSchemaRole): FieldDefinition | undefined;
/**
 * Get the status options for a record's type (the workflowStatus role's select options).
 */
export declare function getStatusOptions(type: string): Array<{
    value: string;
    label: string;
    icon?: string;
    color?: string;
}>;
/**
 * Get the priority options for a record's type.
 */
export declare function getPriorityOptions(type: string): Array<{
    value: string;
    label: string;
    icon?: string;
    color?: string;
}>;
export interface KanbanStatusColumn {
    value: string;
    label: string;
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
export declare function orderKanbanColumns(schemaOptions: Array<{
    value: string;
    label: string;
}>, itemStatuses: string[]): KanbanStatusColumn[];
/**
 * Build kanban status columns for a tracker type, deriving column order from
 * the type's workflowStatus field options (via the registry). Items contribute
 * only any extra statuses not covered by the schema. `'all'` (the mixed-type
 * pseudo view) has no single schema, so it falls back to defaults + item scan.
 */
export declare function buildKanbanStatusColumns(type: string | 'all', items: TrackerRecord[]): KanbanStatusColumn[];
/**
 * One entry in a "Set Status" menu built for a specific selection.
 *
 * `kind` decides what the click writes. A `value` choice writes that literal
 * status to every selected item, which is only sound when they share a type. A
 * `category` choice writes each item the status *its own* type uses for that
 * category, because there is no single value that means "done" across a bug
 * (`done`), a plan (`completed`) and an idea (which cannot be done at all).
 */
export interface SelectionStatusChoice {
    kind: 'value' | 'category';
    /** The literal status, or the StatusCategory name for a category choice. */
    value: string;
    label: string;
}
/**
 * The statuses a "Set Status" menu should offer for a given selection.
 *
 * Scoping to the selection is what keeps this menu honest. The board's *column*
 * list is a different question — it unions every status present on the board so
 * no item is hidden — and reusing it here offered a bug card the statuses of the
 * `customer` and `user` types (`multiple-users`, `slowing`), writing values the
 * bug schema does not declare. In an all-types workspace that list also ran past
 * thirty entries.
 *
 * A single-type selection gets that type's declared options verbatim, in schema
 * order. A mixed selection falls back to lifecycle categories, and offers only
 * the categories that *every* selected type can express — a category one type
 * cannot represent would otherwise apply to some of the selection and silently
 * skip the rest.
 */
export declare function buildSelectionStatusChoices(items: TrackerRecord[]): SelectionStatusChoice[];
/**
 * The status to write to one item for a chosen menu entry, or `undefined` when
 * the item's type cannot express it (which `buildSelectionStatusChoices` already
 * excludes, but callers should skip rather than write a bogus value).
 */
export declare function resolveSelectionStatusValue(choice: SelectionStatusChoice, type: string): string | undefined;
/**
 * Whether two identities denote the same person. Used for author-scoped
 * permissions (e.g. comment edit/delete by author — NIM-360). Matches on any
 * stable facet, case-insensitively, and cross-matches email <-> gitEmail since
 * the same person may have been captured under either at write time. Display
 * name is only a tiebreaker when no email/git facet is present on both sides
 * (names collide too easily to authorize on alone).
 */
export declare function isSameIdentity(a: TrackerIdentity | null | undefined, b: TrackerIdentity | null | undefined): boolean;
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
export declare function isMyRecord(record: TrackerRecord, identity: TrackerIdentity): boolean;
