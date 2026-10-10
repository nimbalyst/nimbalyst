/**
 * Cell editor registry for the editable tracker grid.
 *
 * Maps a schema `FieldDefinition` to the editor a grid cell should use, and
 * converts values across the editor <-> storage boundary. Kept pure and free of
 * React/RevoGrid imports so both the grid surface and the detail panel can share
 * it, and so the mapping is unit-testable on its own.
 *
 * Storage shapes follow TrackerDataModel: `url` stores {@link UrlFieldValue},
 * `relationship` stores {@link TrackerRelationshipValue}[], `multiselect`/`array`
 * store string[], and dates store ISO strings.
 */
import type { FieldDefinition, FieldOption } from '../../../../../tracker-schema/src/browser';
/** Which editor a cell renders when it enters edit mode. */
export type CellEditorKind = 'text' | 'multiline' | 'number' | 'select' | 'multiselect' | 'date' | 'datetime' | 'boolean' | 'user' | 'relationship' | 'url' | 'readonly';
export interface CellEditorDescriptor {
    kind: CellEditorKind;
    /** Choices for select/multiselect editors. */
    options?: FieldOption[];
    /** Relationship/multiselect cardinality. */
    multiValue?: boolean;
    min?: number;
    max?: number;
    targetTrackerTypes?: string[] | '*';
    relationshipTypeKey?: string;
}
/** Structural columns are derived, not stored fields -- never editable. */
export declare const READONLY_STRUCTURAL_COLUMNS: Set<string>;
/**
 * Resolve the editor for a schema field. A missing field (or one the schema
 * marks `readOnly`) yields a `readonly` descriptor so the grid renders it as a
 * plain, non-editable cell rather than guessing.
 */
export declare function resolveCellEditor(field: FieldDefinition | undefined): CellEditorDescriptor;
/** Whether a column backed by `field` can be edited in place in the grid. */
export declare function isFieldEditableInGrid(columnId: string, field: FieldDefinition | undefined): boolean;
/**
 * Convert a value produced by a cell editor into the shape the tracker stores.
 *
 * Returns `undefined` to mean "clear this field" so a blanked cell round-trips
 * to an actual clear rather than persisting an empty string.
 */
export declare function coerceCellValue(field: FieldDefinition | undefined, raw: unknown): unknown;
/**
 * Convert a stored value into the plain text a text-like editor seeds with.
 * Rich editors (select, relationship, boolean) take the stored value directly.
 */
export declare function formatCellForEditor(field: FieldDefinition | undefined, stored: unknown): string;
