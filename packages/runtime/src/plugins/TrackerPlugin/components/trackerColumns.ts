/**
 * Column registry for the tracker table.
 * Defines all available columns, their rendering behavior, and default visibility.
 * Column configs are per-type and persisted to workspace state.
 *
 * Column IDs match actual field names from the schema (resolved via roles).
 * No hardcoded business field vocabulary -- the schema is the contract.
 */

import type { TrackerRecord } from '../../../core/TrackerRecord';
import { globalRegistry, type FieldDefinition, type TrackerSchemaRole } from '../models/TrackerDataModel';
import { defaultTrackerTypeColor, defaultTrackerTypeIcon } from '../models/trackerTypeIdentity';
import { isDateOnlyValue, parseDate } from '../models/dateUtils';
import { resolveDisplayIssueKey } from '../models/localIssueKey';
import { resolveRoleFieldName, getFieldByRole, getItemPublicationState } from '../trackerRecordAccessors';
import { resolveCellEditor, READONLY_STRUCTURAL_COLUMNS, type CellEditorKind } from './trackerCellEditors';

// ============================================================================
// Types
// ============================================================================

export type ColumnRenderType = 'badge' | 'text' | 'date' | 'avatar' | 'progress' | 'tags' | 'type-icon' | 'module' | 'url' | 'relationship';

/**
 * How the structural `type` column presents an item's type: as the type's glyph,
 * or as its name. A workspace running dozens of custom types cannot tell them
 * apart by glyph alone, so the name has to be available (nimbalyst#1422).
 */
export type TypeColumnDisplay = 'icon' | 'label';

export const DEFAULT_TYPE_COLUMN_DISPLAY: TypeColumnDisplay = 'icon';

/** Width the `type` column needs once it carries a type name rather than a glyph. */
const TYPE_COLUMN_LABEL_WIDTH = 120;

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
export function resolveTypeColumnDisplay(config: Pick<TypeColumnConfig, 'typeColumnDisplay'> | null | undefined): TypeColumnDisplay {
  return config?.typeColumnDisplay === 'label' ? 'label' : DEFAULT_TYPE_COLUMN_DISPLAY;
}

/**
 * Stamp the Type column with the view's chosen display mode, widening it when it
 * has to hold a name: 64px fits a glyph and truncates every type name to nothing.
 * Other columns pass through untouched.
 */
export function applyTypeColumnDisplay(columns: TrackerColumnDef[], display: TypeColumnDisplay): TrackerColumnDef[] {
  if (display !== 'label') return columns;
  return columns.map(column => (column.id === 'type'
    ? { ...column, typeDisplay: display, width: TYPE_COLUMN_LABEL_WIDTH, minWidth: 80 }
    : column));
}

// ============================================================================
// Structural Columns (not driven by schema fields)
// ============================================================================

/** Columns that exist independent of schema field definitions. All derived, so none are editable. */
const STRUCTURAL_COLUMNS: TrackerColumnDef[] = [
  { id: 'type', label: 'Type', width: 64, minWidth: 64, sortable: true, render: 'type-icon', defaultVisible: true, builtin: true, editable: false, edit: 'readonly' },
  // Wide enough for a five-digit key at the grid's 12px, since the key is the
  // row's open affordance and a truncated one cannot be read or aimed at.
  { id: 'key', label: 'Key', width: 110, minWidth: 90, sortable: true, render: 'text', defaultVisible: true, sortKey: 'issueKey', builtin: true, editable: false, edit: 'readonly' },
  { id: 'updated', label: 'Updated', width: 100, sortable: true, render: 'date', defaultVisible: true, sortKey: 'lastIndexed', builtin: true, editable: false, edit: 'readonly' },
  { id: 'viewed', label: 'Viewed', width: 100, sortable: true, render: 'date', defaultVisible: false, builtin: true, editable: false, edit: 'readonly' },
  { id: 'createdBy', label: 'Created by', width: 140, minWidth: 100, sortable: true, render: 'avatar', defaultVisible: false, builtin: true, editable: false, edit: 'readonly' },
  { id: 'updatedBy', label: 'Updated by', width: 140, minWidth: 100, sortable: true, render: 'avatar', defaultVisible: false, builtin: true, editable: false, edit: 'readonly' },
  { id: 'module', label: 'Source', width: 150, minWidth: 100, sortable: true, render: 'module', defaultVisible: false, builtin: true, editable: false, edit: 'readonly' },
  // Label is the product vocabulary (Draft/Published); the id stays `shared`
  // so saved views and typed `shared:` filter tokens keep resolving.
  { id: 'shared', label: 'Publication', width: 90, minWidth: 70, sortable: true, render: 'badge', defaultVisible: false, builtin: true, editable: false, edit: 'readonly' },
];

/**
 * Columns used when no schema model is registered for the requested type -- which is
 * how the cross-tracker "All" view resolves its columns (it passes the empty string).
 *
 * Every entry carries a `role`, so the row layer resolves it to whatever field each
 * item's own type maps that role to: `assignee` reads `owner` on most schemas but
 * `dueDate` reads `targetDate` on `goal`. Without these, the All view could only ever
 * show title/status/priority, so "what's overdue?" and "who owns this?" were
 * unanswerable across trackers (nimbalyst#1129).
 *
 * The ids are the conventional field names from ROLE_DEFAULTS rather than the role
 * names, so a persisted column config or filter clause means the same thing whether it
 * was saved from the All view or from a single-tracker view.
 */
const ROLE_FALLBACK_COLUMNS: TrackerColumnDef[] = [
  { id: 'title', label: 'Title', width: 'auto', minWidth: 200, sortable: true, render: 'text', defaultVisible: true, builtin: true, role: 'title', editable: true, edit: 'text' },
  { id: 'status', label: 'Status', width: 120, sortable: true, render: 'badge', defaultVisible: true, builtin: true, role: 'workflowStatus', editable: true, edit: 'select' },
  { id: 'priority', label: 'Priority', width: 100, sortable: true, render: 'badge', defaultVisible: true, builtin: true, role: 'priority', editable: true, edit: 'select' },
  { id: 'owner', label: 'Owner', width: 120, minWidth: 100, sortable: true, render: 'avatar', defaultVisible: true, builtin: true, role: 'assignee', editable: true, edit: 'user' },
  { id: 'dueDate', label: 'Due Date', width: 100, sortable: true, render: 'date', defaultVisible: true, builtin: true, role: 'dueDate', editable: true, edit: 'date' },
  { id: 'startDate', label: 'Start Date', width: 100, sortable: true, render: 'date', defaultVisible: false, builtin: true, role: 'startDate', editable: true, edit: 'date' },
  { id: 'reporterEmail', label: 'Reporter', width: 120, minWidth: 100, sortable: true, render: 'avatar', defaultVisible: false, builtin: true, role: 'reporter', editable: true, edit: 'user' },
  { id: 'tags', label: 'Tags', width: 120, sortable: true, render: 'tags', defaultVisible: false, builtin: true, role: 'tags', editable: true, edit: 'multiselect' },
  { id: 'progress', label: 'Progress', width: 60, sortable: true, render: 'progress', defaultVisible: false, builtin: true, role: 'progress', editable: true, edit: 'number' },
];

/**
 * Infer the column render type from a FieldDefinition.
 */
function inferRenderType(field: FieldDefinition): ColumnRenderType {
  if (field.type === 'relationship' || field.type === 'reference') return 'relationship';
  if (field.type === 'date' || field.type === 'datetime') return 'date';
  if (field.type === 'array') return 'tags';
  if (field.type === 'user') return 'avatar';
  if (field.type === 'select') return 'badge';
  if (field.type === 'url') return 'url';
  if (field.type === 'number' && field.max !== undefined && field.max <= 100) return 'progress';
  return 'text';
}

/**
 * Infer default column width from field type and role.
 */
function inferWidth(field: FieldDefinition, role?: TrackerSchemaRole): number | 'auto' {
  if (role === 'title') return 'auto';
  if (field.type === 'user') return 120;
  if (field.type === 'select') return 120;
  if (field.type === 'number') return 60;
  if (field.type === 'date' || field.type === 'datetime') return 100;
  if (field.type === 'array') return 120;
  if (field.type === 'url') return 200;
  return 120;
}

// Role display priority (lower = earlier in default column order)
const ROLE_PRIORITY: Record<string, number> = {
  title: 0, workflowStatus: 1, priority: 2, assignee: 3,
  reporter: 4, tags: 5, progress: 6, startDate: 7, dueDate: 8,
};

/**
 * Resolve the full list of TrackerColumnDef for a given type.
 * Builds columns from the schema's field definitions and roles.
 * Column IDs match actual field names so getCellValue can find them generically.
 */
export function resolveColumnsForType(type: string): TrackerColumnDef[] {
  const model = globalRegistry.get(type);
  if (!model) {
    // No model: return structural columns + conventional field columns. These stay
    // editable so an unregistered type still gets inline title/status/priority edits.
    return [...STRUCTURAL_COLUMNS, ...ROLE_FALLBACK_COLUMNS];
  }

  // Build role reverse lookup: fieldName -> role
  const fieldToRole = new Map<string, TrackerSchemaRole>();
  if (model.roles) {
    for (const [role, fieldName] of Object.entries(model.roles)) {
      fieldToRole.set(fieldName, role as TrackerSchemaRole);
    }
  }

  // Structural columns always present
  const columns: TrackerColumnDef[] = [...STRUCTURAL_COLUMNS];

  // Skip internal/system field names
  const skipFields = new Set(['created', 'updated', 'description']);

  // Add columns for each field in the model
  for (const field of model.fields) {
    if (skipFields.has(field.name)) continue;

    const role = fieldToRole.get(field.name);
    const render = inferRenderType(field);
    const width = inferWidth(field, role);
    const label = field.name.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
    const editor = resolveCellEditor(field);

    columns.push({
      id: field.name,
      label,
      width,
      minWidth: role === 'title' ? 200 : undefined,
      sortable: true,
      render,
      defaultVisible: role != null || (model.tableView?.defaultColumns?.includes(field.name) ?? false),
      builtin: role != null,
      role,
      editable: editor.kind !== 'readonly' && !READONLY_STRUCTURAL_COLUMNS.has(field.name),
      edit: editor.kind,
    });
  }

  // Add 'created' column (always available but not visible by default)
  columns.push({ id: 'created', label: 'Created', width: 100, sortable: true, render: 'date', defaultVisible: false, builtin: true, editable: false, edit: 'readonly' });

  return columns;
}

/**
 * Resolve the record field one column reads for one item.
 *
 * A role-bearing column resolves per record, because the same column can be backed by
 * a different field on each type -- `dueDate` is `dueDate` on most schemas but
 * `targetDate` on `goal`. In a single-type view this is a no-op (the column id already
 * is the field name); in the cross-tracker "All" view it is what makes the column
 * show anything at all.
 */
export function resolveColumnFieldName(recordType: string, column: TrackerColumnDef): string {
  return column.role ? resolveRoleFieldName(recordType, column.role) : column.id;
}

/**
 * Get the default column config for a type.
 * Resolves visible columns from schema roles + tableView.defaultColumns.
 */
export function getDefaultColumnConfig(type: string): TypeColumnConfig {
  const columns = resolveColumnsForType(type);

  // Default visible: structural 'type' and 'key' first, then role columns by priority, then 'updated'
  const visibleColumns: string[] = ['type', 'key'];

  // Sort role columns by display priority
  const roleColumns = columns
    .filter(c => c.role && c.defaultVisible)
    .sort((a, b) => (ROLE_PRIORITY[a.role!] ?? 99) - (ROLE_PRIORITY[b.role!] ?? 99));

  for (const col of roleColumns) {
    visibleColumns.push(col.id);
  }

  // Add 'updated' at the end
  visibleColumns.push('updated');

  // Add any tableView.defaultColumns that aren't already included
  const model = globalRegistry.get(type);
  if (model?.tableView?.defaultColumns) {
    for (const col of model.tableView.defaultColumns) {
      if (!visibleColumns.includes(col)) {
        const updatedIdx = visibleColumns.indexOf('updated');
        if (updatedIdx >= 0) visibleColumns.splice(updatedIdx, 0, col);
        else visibleColumns.push(col);
      }
    }
  }

  return { visibleColumns, columnWidths: {}, typeColumnDisplay: DEFAULT_TYPE_COLUMN_DISPLAY };
}

// Keep the old name exported for backward compat
export const BUILTIN_COLUMNS = STRUCTURAL_COLUMNS;
export const DEFAULT_VISIBLE_COLUMNS = ['type', 'title', 'status', 'priority', 'owner', 'updated'];

// ============================================================================
// Color and formatting helpers
// ============================================================================

export const BUILTIN_STATUS_COLORS: Record<string, string> = {
  'to-do': '#6b7280',
  'in-progress': '#eab308',
  'in-review': '#8b5cf6',
  'done': '#22c55e',
  'blocked': '#ef4444',
};

export function getStatusColor(status: string, trackerType?: string): string {
  if (BUILTIN_STATUS_COLORS[status]) return BUILTIN_STATUS_COLORS[status];
  if (trackerType) {
    const model = globalRegistry.get(trackerType);
    if (model) {
      const statusFieldName = resolveRoleFieldName(trackerType, 'workflowStatus');
      const statusField = model.fields.find(f => f.name === statusFieldName);
      if (statusField?.options) {
        const option = statusField.options.find(o => o.value === status);
        if (option?.color) return option.color;
      }
    }
  }
  return '#6b7280';
}

export function getPriorityColor(priority: string | undefined): string {
  if (!priority) return '#6b7280';
  const colors: Record<string, string> = { critical: '#dc2626', high: '#ef4444', medium: '#f59e0b', low: '#6b7280' };
  return colors[priority] || '#6b7280';
}

export function getTypeColor(type: string): string {
  const model = globalRegistry.get(type);
  if (model?.color) return model.color;
  return defaultTrackerTypeColor(type);
}

export function getTypeIcon(type: string): string {
  const model = globalRegistry.get(type);
  if (model?.icon) return model.icon;
  return defaultTrackerTypeIcon(type);
}

/**
 * Human-readable name for a tracker type. A registered type names itself; an
 * unregistered one gets its identifier tidied up rather than shown raw, since
 * this is what the Type column prints in label mode.
 */
export function getTypeLabel(type: string): string {
  const model = globalRegistry.get(type);
  if (model?.displayName) return model.displayName;
  const spaced = type
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (!spaced) return type;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Elapsed-time label for an instant, e.g. `3h ago` / `in 3d`.
 *
 * Future instants get their own labels rather than falling into the
 * `minutes < 1` branch, which used to render every future date as "Just now"
 * (nimbalyst#1156). For a calendar day use `formatRelativeCalendarDay`.
 */
export function formatRelativeDate(date: Date, now: Date = new Date()): string {
  if (!date || date.getTime() === 0 || isNaN(date.getTime())) return '';
  const diff = now.getTime() - date.getTime();
  const isFuture = diff < 0;
  const elapsed = Math.abs(diff);
  const minutes = Math.floor(elapsed / (1000 * 60));
  const hours = Math.floor(elapsed / (1000 * 60 * 60));
  const days = Math.floor(elapsed / (1000 * 60 * 60 * 24));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return isFuture ? `in ${minutes}m` : `${minutes}m ago`;
  if (hours < 24) return isFuture ? `in ${hours}h` : `${hours}h ago`;
  if (days === 1) return isFuture ? 'Tomorrow' : 'Yesterday';
  if (days < 7) return isFuture ? `in ${days}d` : `${days}d ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return isFuture ? `in ${weeks}w` : `${weeks}w ago`;
  }
  return date.toLocaleDateString();
}

/** Local midnight of the day `date` falls on. */
function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function pluralDays(count: number): string {
  return count === 1 ? '1 day' : `${count} days`;
}

function pluralWeeks(count: number): string {
  return count === 1 ? '1 week' : `${count} weeks`;
}

/**
 * Relative label for a calendar day, compared by local date rather than by
 * elapsed milliseconds.
 *
 * A due date entered as today should read "Today" all day long, not "20h ago"
 * once the evening arrives, and a date a few days out should name the distance
 * rather than collapsing to a timestamp label.
 */
export function formatRelativeCalendarDay(date: Date, now: Date = new Date()): string {
  if (!date || isNaN(date.getTime())) return '';
  const dayMs = 1000 * 60 * 60 * 24;
  // Positive is in the future. Round because DST makes some local days 23 or 25 hours.
  const days = Math.round(
    (startOfLocalDay(date).getTime() - startOfLocalDay(now).getTime()) / dayMs,
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  const distance = Math.abs(days);
  if (distance >= 30) return date.toLocaleDateString();
  const label = distance < 7 ? pluralDays(distance) : pluralWeeks(Math.floor(distance / 7));
  return days > 0 ? `in ${label}` : `${label} ago`;
}

/**
 * Display text and hover title for a tracker date cell.
 *
 * Dispatches on the *stored* value: a calendar day (`YYYY-MM-DD`) is compared
 * by local date, anything else is treated as an instant. The title always
 * carries the exact value so the relative label never hides the real date.
 */
export function formatTrackerDateCell(
  value: unknown,
  now: Date = new Date(),
): { display: string; title: string } {
  if (value === undefined || value === null || value === '') return { display: '', title: '' };

  const date = parseDate(value);
  if (!date) return { display: String(value), title: '' };

  if (isDateOnlyValue(value)) {
    return {
      display: formatRelativeCalendarDay(date, now),
      title: date.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      }),
    };
  }

  return {
    display: formatRelativeDate(date, now),
    title: date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
  };
}

function parseValidDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function getEffectiveUpdatedDate(record: TrackerRecord): Date | undefined {
  const lastIndexed = parseValidDate(record.system.lastIndexed);
  const dateSource = record.system.updatedAt || record.system.createdAt;
  if (record.source === 'frontmatter' && lastIndexed && isDateOnlyValue(dateSource)) {
    return lastIndexed;
  }
  return parseValidDate(dateSource) ?? lastIndexed;
}

/**
 * Get the cell value for a column from a tracker record.
 * Column IDs match field names in the schema, so this is generic.
 * The only special cases are structural columns (type, updated, module).
 */
export function getCellValue(record: TrackerRecord, columnId: string): any {
  switch (columnId) {
    case 'type': return record.primaryType;
    case 'key': return resolveDisplayIssueKey(record) ?? '';
    case 'updated': return getEffectiveUpdatedDate(record);
    case 'viewed': return record.fields.viewed;
    case 'created': return record.system.createdAt;
    case 'createdBy': return record.system.authorIdentity;
    case 'updatedBy': {
      if (record.system.lastModifiedBy) return record.system.lastModifiedBy;
      return [...(record.system.activity ?? [])]
        .filter(entry => entry.authorIdentity)
        .sort((left, right) => right.timestamp - left.timestamp)[0]?.authorIdentity;
    }
    case 'archived': return record.archived;
    case 'module': return record.system.documentPath;
    case 'shared': return getItemPublicationState(record);
    default: return record.fields[columnId];
  }
}

/**
 * Resolve the schema field backing a column, if any.
 * Structural columns are derived rather than stored, so they have no field.
 */
export function getFieldForColumn(type: string, columnId: string): FieldDefinition | undefined {
  if (READONLY_STRUCTURAL_COLUMNS.has(columnId)) return undefined;
  return globalRegistry.get(type)?.fields.find(f => f.name === columnId);
}

/**
 * Get initials from a display name (for avatar rendering).
 */
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

/**
 * Generate a stable color from a string (for avatar background).
 */
export function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6'];
  return colors[Math.abs(hash) % colors.length];
}
