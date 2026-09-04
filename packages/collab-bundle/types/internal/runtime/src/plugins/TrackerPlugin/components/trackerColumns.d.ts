/**
 * Column registry for the tracker table.
 * Defines all available columns, their rendering behavior, and default visibility.
 * Column configs are per-type and persisted to workspace state.
 *
 * Column IDs match actual field names from the schema (resolved via roles).
 * No hardcoded business field vocabulary -- the schema is the contract.
 */
import type { TrackerRecord } from '../../../core/TrackerRecord';
import { type FieldDefinition, type TrackerSchemaRole } from '../models/TrackerDataModel';
import { type CellEditorKind } from './trackerCellEditors';
export type ColumnRenderType = 'badge' | 'text' | 'date' | 'avatar' | 'progress' | 'tags' | 'type-icon' | 'module' | 'url' | 'relationship';
/**
 * How the structural `type` column presents an item's type: as the type's glyph,
 * or as its name. A workspace running dozens of custom types cannot tell them
 * apart by glyph alone, so the name has to be available (nimbalyst#1422).
 */
export type TypeColumnDisplay = 'icon' | 'label';
export declare const DEFAULT_TYPE_COLUMN_DISPLAY: TypeColumnDisplay;
export interface TrackerColumnDef {
    /** Unique column ID -- matches the field name in the schema */
    id: string;
    /** Display label in header and settings */
    label: string;
    /** Default width in px, or 'auto' for flex */
    width: number | 'auto';
    /** Minimum width in px */
    minWidth?: number;
    /** Whether the column is sortable */
    sortable: boolean;
    /** How to render the cell value */
    render: ColumnRenderType;
    /** Whether this column is visible by default */
    defaultVisible: boolean;
    /** Sort key (if different from id) */
    sortKey?: string;
    /** Whether this is a built-in column (not removable from registry) */
    builtin: boolean;
    /** Schema role this column fulfills (if any). Used for rendering hints. */
    role?: TrackerSchemaRole;
    /** Whether the grid may edit this column's cells in place. */
    editable: boolean;
    /** Which cell editor to open on edit. `readonly` when `editable` is false. */
    edit: CellEditorKind;
    /**
     * Only on the structural `type` column: whether the cell draws the glyph or
     * the type name. Set by {@link applyTypeColumnDisplay} from the view's config
     * so the cell renderer needs no extra argument.
     */
    typeDisplay?: TypeColumnDisplay;
}
/** Per-type column configuration (persisted) */
export interface TypeColumnConfig {
    /** Ordered list of visible column IDs */
    visibleColumns: string[];
    /** Custom column widths (overrides defaults) */
    columnWidths: Record<string, number>;
    /**
     * How the Type column presents itself. Absent on every view saved before the
     * option existed, so it resolves to `icon` and nobody's table changes shape
     * without asking.
     */
    typeColumnDisplay?: TypeColumnDisplay;
}
/** The Type column's display mode for a config that may predate the option. */
export declare function resolveTypeColumnDisplay(config: Pick<TypeColumnConfig, 'typeColumnDisplay'> | null | undefined): TypeColumnDisplay;
/**
 * Stamp the Type column with the view's chosen display mode, widening it when it
 * has to hold a name: 64px fits a glyph and truncates every type name to nothing.
 * Other columns pass through untouched.
 */
export declare function applyTypeColumnDisplay(columns: TrackerColumnDef[], display: TypeColumnDisplay): TrackerColumnDef[];
/**
 * Resolve the full list of TrackerColumnDef for a given type.
 * Builds columns from the schema's field definitions and roles.
 * Column IDs match actual field names so getCellValue can find them generically.
 */
export declare function resolveColumnsForType(type: string): TrackerColumnDef[];
/**
 * Resolve the record field one column reads for one item.
 *
 * A role-bearing column resolves per record, because the same column can be backed by
 * a different field on each type -- `dueDate` is `dueDate` on most schemas but
 * `targetDate` on `goal`. In a single-type view this is a no-op (the column id already
 * is the field name); in the cross-tracker "All" view it is what makes the column
 * show anything at all.
 */
export declare function resolveColumnFieldName(recordType: string, column: TrackerColumnDef): string;
/**
 * Get the default column config for a type.
 * Resolves visible columns from schema roles + tableView.defaultColumns.
 */
export declare function getDefaultColumnConfig(type: string): TypeColumnConfig;
export declare const BUILTIN_COLUMNS: TrackerColumnDef[];
export declare const DEFAULT_VISIBLE_COLUMNS: string[];
export declare const BUILTIN_STATUS_COLORS: Record<string, string>;
export declare function getStatusColor(status: string, trackerType?: string): string;
export declare function getPriorityColor(priority: string | undefined): string;
export declare function getTypeColor(type: string): string;
export declare function getTypeIcon(type: string): string;
/**
 * Human-readable name for a tracker type. A registered type names itself; an
 * unregistered one gets its identifier tidied up rather than shown raw, since
 * this is what the Type column prints in label mode.
 */
export declare function getTypeLabel(type: string): string;
/**
 * Elapsed-time label for an instant, e.g. `3h ago` / `in 3d`.
 *
 * Future instants get their own labels rather than falling into the
 * `minutes < 1` branch, which used to render every future date as "Just now"
 * (nimbalyst#1156). For a calendar day use `formatRelativeCalendarDay`.
 */
export declare function formatRelativeDate(date: Date, now?: Date): string;
/**
 * Relative label for a calendar day, compared by local date rather than by
 * elapsed milliseconds.
 *
 * A due date entered as today should read "Today" all day long, not "20h ago"
 * once the evening arrives, and a date a few days out should name the distance
 * rather than collapsing to a timestamp label.
 */
export declare function formatRelativeCalendarDay(date: Date, now?: Date): string;
/**
 * Display text and hover title for a tracker date cell.
 *
 * Dispatches on the *stored* value: a calendar day (`YYYY-MM-DD`) is compared
 * by local date, anything else is treated as an instant. The title always
 * carries the exact value so the relative label never hides the real date.
 */
export declare function formatTrackerDateCell(value: unknown, now?: Date): {
    display: string;
    title: string;
};
export declare function getEffectiveUpdatedDate(record: TrackerRecord): Date | undefined;
/**
 * Get the cell value for a column from a tracker record.
 * Column IDs match field names in the schema, so this is generic.
 * The only special cases are structural columns (type, updated, module).
 */
export declare function getCellValue(record: TrackerRecord, columnId: string): any;
/**
 * Resolve the schema field backing a column, if any.
 * Structural columns are derived rather than stored, so they have no field.
 */
export declare function getFieldForColumn(type: string, columnId: string): FieldDefinition | undefined;
/**
 * Get initials from a display name (for avatar rendering).
 */
export declare function getInitials(name: string): string;
/**
 * Generate a stable color from a string (for avatar background).
 */
export declare function stringToColor(str: string): string;
