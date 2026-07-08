/**
 * Column registry for the tracker table.
 * Defines all available columns, their rendering behavior, and default visibility.
 * Column configs are per-type and persisted to workspace state.
 *
 * Column IDs match actual field names from the schema (resolved via roles).
 * No hardcoded business field vocabulary -- the schema is the contract.
 */

import type { TrackerRecord } from '../../../core/TrackerRecord';
import type { TrackerSchemaRole, FieldDefinition } from '../models/TrackerDataModel';
import { globalRegistry } from '../models';
import { resolveRoleFieldName, getFieldByRole, getItemShareState } from '../trackerRecordAccessors';

// ============================================================================
// Types
// ============================================================================

export type ColumnRenderType = 'badge' | 'text' | 'date' | 'avatar' | 'progress' | 'tags' | 'type-icon' | 'module' | 'url' | 'relationship';

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
}

/** Per-type column configuration (persisted) */
export interface TypeColumnConfig {
  /** Ordered list of visible column IDs */
  visibleColumns: string[];
  /** Custom column widths (overrides defaults) */
  columnWidths: Record<string, number>;
  /** Grouping field (null = no grouping) */
  groupBy: string | null;
}

// ============================================================================
// Structural Columns (not driven by schema fields)
// ============================================================================

/** Columns that exist independent of schema field definitions */
const STRUCTURAL_COLUMNS: TrackerColumnDef[] = [
  { id: 'type', label: 'Type', width: 64, minWidth: 64, sortable: true, render: 'type-icon', defaultVisible: true, builtin: true },
  { id: 'key', label: 'Key', width: 90, sortable: true, render: 'text', defaultVisible: true, sortKey: 'issueKey', builtin: true },
  { id: 'updated', label: 'Updated', width: 100, sortable: true, render: 'date', defaultVisible: true, sortKey: 'lastIndexed', builtin: true },
  { id: 'module', label: 'Source', width: 150, minWidth: 100, sortable: true, render: 'module', defaultVisible: false, builtin: true },
  { id: 'shared', label: 'Shared', width: 90, minWidth: 70, sortable: true, render: 'badge', defaultVisible: false, builtin: true },
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
    // No model: return structural columns + conventional field columns
    return [
      ...STRUCTURAL_COLUMNS,
      { id: 'title', label: 'Title', width: 'auto', minWidth: 200, sortable: true, render: 'text', defaultVisible: true, builtin: true, role: 'title' },
      { id: 'status', label: 'Status', width: 120, sortable: true, render: 'badge', defaultVisible: true, builtin: true, role: 'workflowStatus' },
      { id: 'priority', label: 'Priority', width: 100, sortable: true, render: 'badge', defaultVisible: true, builtin: true, role: 'priority' },
    ];
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
    });
  }

  // Add 'created' column (always available but not visible by default)
  columns.push({ id: 'created', label: 'Created', width: 100, sortable: true, render: 'date', defaultVisible: false, builtin: true });

  return columns;
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

  return { visibleColumns, columnWidths: {}, groupBy: null };
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
  const colors: Record<string, string> = {
    bug: '#dc2626', task: '#2563eb', plan: '#7c3aed', idea: '#ca8a04',
    decision: '#8b5cf6', automation: '#60a5fa', feature: '#10b981',
  };
  return colors[type] || '#6b7280';
}

export function getTypeIcon(type: string): string {
  const model = globalRegistry.get(type);
  if (model?.icon) return model.icon;
  const icons: Record<string, string> = {
    bug: 'bug_report', task: 'check_box', plan: 'assignment', idea: 'lightbulb',
    decision: 'gavel', automation: 'auto_mode', feature: 'rocket_launch',
  };
  return icons[type] || 'label';
}

export function formatRelativeDate(date: Date): string {
  if (!date || date.getTime() === 0 || isNaN(date.getTime())) return '';
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return date.toLocaleDateString();
}

/**
 * Get the cell value for a column from a tracker record.
 * Column IDs match field names in the schema, so this is generic.
 * The only special cases are structural columns (type, updated, module).
 */
export function getCellValue(record: TrackerRecord, columnId: string): any {
  switch (columnId) {
    case 'type': return record.primaryType;
    case 'key': return record.issueKey ?? '';
    case 'updated': return record.system.lastIndexed ? new Date(record.system.lastIndexed) : undefined;
    case 'module': return record.system.documentPath;
    case 'shared': return getItemShareState(record);
    default: return record.fields[columnId];
  }
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
