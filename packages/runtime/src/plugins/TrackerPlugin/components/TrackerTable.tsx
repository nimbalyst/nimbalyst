/**
 * TrackerTable - Standalone table component for displaying tracker items
 * Shows bugs, tasks, plans, and ideas across all documents in workspace
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useFloating, offset, flip, shift, FloatingPortal } from '@floating-ui/react';
import { useAtomValue } from 'jotai';
import type {
  TrackerItemType,
} from '../../../core/DocumentService';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import { trackerItemsByTypeAtom, trackerDataLoadedAtom } from '../trackerDataAtoms';
import {
  EXTENSION_OWNED_KEYS,
  LEGACY_KEY_TO_TYPE,
  buildFullDocumentTrackerId,
} from '../documentHeader/frontmatterUtils';
import { getRecordTitle, getRecordStatus, getRecordPriority, getFieldByRole, resolveRoleFieldName, getItemShareState } from '../trackerRecordAccessors';
import { globalRegistry, parseDate, normalizeRelationshipValue } from '../models';
import {usePostHog} from "posthog-js/react";
import {
  resolveColumnsForType,
  getDefaultColumnConfig,
  getStatusColor as getStatusColorFromRegistry,
  getPriorityColor as getPriorityColorFromRegistry,
  getTypeColor as getTypeColorFromRegistry,
  getTypeIcon as getTypeIconFromRegistry,
  formatRelativeDate,
  getCellValue,
  type TrackerColumnDef,
  type TypeColumnConfig,
} from './trackerColumns';
import { UserAvatar } from './UserAvatar';
import { DisplayOptionsPanel } from './DisplayOptionsPanel';
import { useTrackerRows } from './useTrackerRows';
import { groupTrackerItems, normalizeTrackerGroupBy } from '../trackerGrouping';

export type SortColumn = 'title' | 'type' | 'status' | 'priority' | 'progress' | 'module' | 'lastIndexed' | (string & {});
export type SortDirection = 'asc' | 'desc';

interface TrackerTableProps {
  filterType?: TrackerItemType | 'all';
  sortBy?: SortColumn;
  sortDirection?: SortDirection;
  onSortChange?: (column: SortColumn, direction: SortDirection) => void;
  hideTypeTabs?: boolean;
  onSwitchToFilesMode?: () => void;
  /** Callback when user wants to create a new tracker item of the current type */
  onNewItem?: (type: TrackerItemType) => void;
  /** Callback when user clicks a row to select an item (opens detail panel) */
  onItemSelect?: (itemId: string) => void;
  /** Currently selected item ID for row highlighting */
  selectedItemId?: string | null;
  /** Override items instead of reading from atoms (used for archived view) */
  overrideItems?: TrackerRecord[];
  /** Callback for bulk/single archive action */
  onArchiveItems?: (itemIds: string[], archive: boolean) => void;
  /** Callback for bulk/single delete action */
  onDeleteItems?: (itemIds: string[]) => void;
  /** Copy a shareable deep link for the given tracker item. Only shown when
   *  exactly one item is selected. Callers omit this when the workspace
   *  has no team configured. */
  onCopyDeepLink?: (itemId: string) => void;
  /** External search query from parent toolbar (replaces internal search input) */
  searchQuery?: string;
  /** Column configuration (visible columns, order, widths) */
  columnConfig?: import('./trackerColumns').TypeColumnConfig;
  /** Callback when column config changes (from display options panel) */
  onColumnConfigChange?: (config: import('./trackerColumns').TypeColumnConfig) => void;
}

export const TrackerGroupHeader: React.FC<{
  label: string;
  count: number;
  className?: string;
  style?: React.CSSProperties;
}> = ({ label, count, className = '', style }) => (
  <div
    data-testid="tracker-table-group-header"
    className={`tracker-table-group-header flex items-center gap-2 px-3 py-1.5 bg-[var(--nim-bg-secondary)] border-b border-[var(--nim-border)] text-[11px] font-semibold text-[var(--nim-text-muted)] ${className}`}
    style={style}
  >
    <span className="truncate">{label}</span>
    <span className="text-[10px] font-medium text-[var(--nim-text-faint)]">
      {count} item{count === 1 ? '' : 's'}
    </span>
  </div>
);

/**
 * Get educational description for each tracker type
 */
function getTypeDescription(type: TrackerItemType): { title: string; description: string; hints: string[] } {
  const descriptions: Record<TrackerItemType, { title: string; description: string; hints: string[] }> = {
    'plan': {
      title: 'Plans',
      description: 'Plans help you organize features, projects, and initiatives with AI assistance. Use /plan in chat to create a new plan document with status tracking.',
      hints: [
        'Use /plan in agent chat to create a new plan',
        'Plans support progress tracking and status updates',
        'Click "+ New" to start planning with AI',
      ],
    },
    'bug': {
      title: 'Bugs',
      description: "Bugs track issues and defects that need fixing. They're stored as inline items in your markdown documents, making them easy to find alongside related notes.",
      hints: [
        'Type #bug in any markdown file to create a bug',
        'Use /track bug in agent chat',
        'Click "+ New" to quickly add a bug',
      ],
    },
    'task': {
      title: 'Tasks',
      description: 'Tasks track work items and todos. Add them inline to any document or use the quick-add panel.',
      hints: [
        'Type #task in any markdown file to create a task',
        'Use /track task in agent chat',
        'Click "+ New" to quickly add a task',
      ],
    },
    'idea': {
      title: 'Ideas',
      description: 'Ideas capture concepts and proposals to explore. Jot them down quickly and revisit later.',
      hints: [
        'Type #idea in any markdown file to capture an idea',
        'Use /track idea in agent chat',
        'Click "+ New" to quickly add an idea',
      ],
    },
    'decision': {
      title: 'Decisions',
      description: 'Decisions document important choices and their rationale. Great for architectural decisions that need context preserved.',
      hints: [
        'Type #decision in any markdown file',
        'Use /track decision in agent chat',
        'Click "+ New" to document a decision',
      ],
    },
    'automation': {
      title: 'Automations',
      description: 'Automations are scheduled AI-powered tasks. Create a markdown file in nimbalyst-local/automations/ with a schedule and prompt.',
      hints: [
        'Use /automation in agent chat to create one',
        'Open an automation file to configure its schedule',
        'Automations run on a daily, weekly, or interval schedule',
      ],
    },
    'feature': {
      title: 'Features',
      description: 'Features track shippable capabilities with release versioning. Items can be tagged with both feature and task types for multi-dimensional tracking.',
      hints: [
        'Use /track feature in agent chat',
        'Click "+ New" to add a feature',
        'Features have release version and release notes fields',
      ],
    },
  };
  return descriptions[type] || descriptions['task'];
}

/**
 * Get color for tracker type (used for icons and accents)
 */
function getTypeColor(type: TrackerItemType): string {
  const colors: Record<TrackerItemType, string> = {
    'bug': '#dc2626',
    'task': '#2563eb',
    'plan': '#7c3aed',
    'idea': '#ca8a04',
    'decision': '#8b5cf6',
    'automation': '#60a5fa',
    'feature': '#10b981',
  };
  return colors[type] || '#6b7280';
}

/**
 * Multi-select checkbox dropdown for filtering table columns.
 */
const MultiSelectFilter: React.FC<{
  values: string[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
}> = ({ values, selected, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (val: string) => {
    const next = new Set(selected);
    if (next.has(val)) next.delete(val); else next.add(val);
    onChange(next);
  };

  const activeCount = selected.size;

  return (
    <div ref={ref} className="relative">
      <button
        className={`w-full py-1 px-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-xs text-left truncate focus:outline-none focus:border-[var(--nim-primary)] ${
          activeCount > 0 ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-faint)]'
        }`}
        onClick={() => setOpen(!open)}
      >
        {activeCount > 0 ? `${activeCount} selected` : 'All'}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-0.5 w-40 max-h-48 overflow-auto bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded shadow-lg z-30">
          {activeCount > 0 && (
            <button
              className="w-full px-2 py-1 text-xs text-[var(--nim-primary)] hover:bg-[var(--nim-bg-hover)] text-left border-b border-[var(--nim-border)]"
              onClick={() => onChange(new Set())}
            >
              Clear all
            </button>
          )}
          {values.map(val => (
            <label
              key={val}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--nim-text)] cursor-pointer hover:bg-[var(--nim-bg-hover)]"
            >
              <input
                type="checkbox"
                className="w-3 h-3"
                checked={selected.has(val)}
                onChange={() => toggle(val)}
              />
              <span className="truncate">{val || '(empty)'}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

const BUILTIN_STATUS_COLORS: Record<string, string> = {
  'to-do': '#6b7280',
  'in-progress': '#eab308',
  'in-review': '#8b5cf6',
  'done': '#22c55e',
  'blocked': '#ef4444',
};

function getStatusColor(status: string, trackerType?: string): string {
  // Check built-in statuses first
  if (BUILTIN_STATUS_COLORS[status]) {
    return BUILTIN_STATUS_COLORS[status];
  }

  // Look up color from the tracker model's status field options
  if (trackerType) {
    const model = globalRegistry.get(trackerType);
    if (model) {
      const statusField = model.fields.find(f => f.name === resolveRoleFieldName(model.type, 'workflowStatus'));
      if (statusField?.options) {
        const option = statusField.options.find(o => o.value === status);
        if (option?.color) {
          return option.color;
        }
      }
    }
  }

  return '#6b7280';
}

function getPriorityColor(priority: string | undefined): string {
  if (!priority) return '#6b7280';
  const priorityColors: Record<string, string> = {
    'critical': '#dc2626',
    'high': '#ef4444',
    'medium': '#f59e0b',
    'low': '#6b7280',
  };
  return priorityColors[priority] || '#6b7280';
}

function getTypeIcon(type: TrackerItemType): string {
  const icons: Record<TrackerItemType, string> = {
    'bug': 'bug_report',
    'task': 'check_box',
    'plan': 'assignment',
    'idea': 'lightbulb',
    'decision': 'gavel',
    'automation': 'auto_mode',
    'feature': 'rocket_launch',
  };
  return icons[type];
}

function formatDate(date: Date): string {
  // If date is invalid or epoch (our placeholder for missing dates), show nothing
  if (!date || date.getTime() === 0 || isNaN(date.getTime())) {
    return '';
  }

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
 * Convert full-document tracker items (from frontmatter) to TrackerRecord format
 * Works for any tracker type that supports fullDocument mode (plan, decision, etc.)
 */
/**
 * Format a complex object for display in a string field.
 * Handles known patterns like automation schedules, otherwise falls back to JSON.
 */
function formatObjectForStringField(value: Record<string, any>): string {
  // Automation schedule objects
  if (value.type && (value.type === 'interval' || value.type === 'daily' || value.type === 'weekly')) {
    switch (value.type) {
      case 'interval':
        return `Every ${value.intervalMinutes} min`;
      case 'daily':
        return `Daily at ${value.time ?? ''}`;
      case 'weekly': {
        const days = (value.days as string[]) ?? [];
        return `${days.map((d: string) => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')} at ${value.time ?? ''}`;
      }
    }
  }
  return JSON.stringify(value);
}

/**
 * Resolve the tracker frontmatter data for a given document and tracker type.
 * Returns merged data with top-level fields as canonical and embedded fields as fallback.
 * Returns null if the document doesn't match this tracker type.
 *
 * Mirrors `detectTrackerFromFrontmatter` in `frontmatterUtils.ts`: extension-owned
 * keys (e.g. `automationStatus` for the automations extension) are checked before
 * `trackerStatus`, and legacy per-type keys (`planStatus`, `decisionStatus`, etc.)
 * remain supported as a fallback. Without keeping this logic aligned, the Tracker
 * view silently drops documents that the rest of the system still classifies as
 * full-document tracker items. See nimbalyst#67 and nimbalyst#481.
 */
export function resolveTrackerFrontmatter(frontmatter: Record<string, any> | undefined, trackerType: string): Record<string, any> | null {
  if (!frontmatter) return null;

  // Extension-owned key takes priority -- the extension owns the nested block,
  // so its presence is enough to classify the doc as that tracker type.
  for (const [extKey, extType] of Object.entries(EXTENSION_OWNED_KEYS)) {
    if (extType !== trackerType) continue;
    if (frontmatter[extKey] && typeof frontmatter[extKey] === 'object') {
      const extData = frontmatter[extKey] as Record<string, any>;
      const { [extKey]: _ext, trackerStatus: _ts, ...topLevel } = frontmatter;
      return { ...topLevel, ...extData };
    }
  }

  // Check trackerStatus with nested type field (canonical format)
  if (frontmatter.trackerStatus && typeof frontmatter.trackerStatus === 'object') {
    const trackerData = frontmatter.trackerStatus as Record<string, any>;
    if (trackerData.type === trackerType) {
      // Top-level fields are canonical, trackerStatus holds only `type`
      const { trackerStatus: _, ...topLevel } = frontmatter;
      return { ...trackerData, ...topLevel };
    }
  }

  // Legacy fallback: older plan/decision/etc. docs still store their fields
  // inside per-type nested keys instead of canonical top-level trackerStatus.
  for (const [legacyKey, legacyType] of Object.entries(LEGACY_KEY_TO_TYPE)) {
    if (legacyType !== trackerType) continue;
    if (frontmatter[legacyKey] && typeof frontmatter[legacyKey] === 'object') {
      const legacyData = frontmatter[legacyKey] as Record<string, any>;
      const { [legacyKey]: _, trackerStatus: _ts, ...topLevel } = frontmatter;
      return { ...legacyData, ...topLevel };
    }
  }

  return null;
}

export function convertFullDocumentToTrackerItems(metadata: any[], trackerType: TrackerItemType): TrackerRecord[] {
  return metadata
    .filter(doc => {
      const hasTrackerStatus = resolveTrackerFrontmatter(doc.frontmatter, trackerType) !== null;
      const pathLower = doc.path.toLowerCase();
      const isAgentFile = pathLower.includes('/agents/') || pathLower.includes('\\agents\\');
      return hasTrackerStatus && !isAgentFile;
    })
    .map(doc => {
      const trackerStatus = resolveTrackerFrontmatter(doc.frontmatter, trackerType) || {};
      const frontmatter = doc.frontmatter;

      // Use file modified date for full-document trackers (more accurate than frontmatter)
      let actualDate: Date | null = null;
      if (doc.lastModified) {
        if (doc.lastModified instanceof Date) {
          actualDate = doc.lastModified;
        } else {
          const parsed = new Date(doc.lastModified);
          if (!isNaN(parsed.getTime())) actualDate = parsed;
        }
      }

      // Build fields from the tracker model's field definitions
      const fields: Record<string, unknown> = {
        title: trackerStatus.title || frontmatter.title || doc.path.split('/').pop()?.replace('.md', '') || 'Untitled',
        status: (trackerStatus.status || frontmatter.status || 'to-do').toLowerCase(),
        priority: trackerStatus.priority || frontmatter.priority || 'medium',
        owner: trackerStatus.owner || frontmatter.owner,
        tags: trackerStatus.tags || frontmatter.tags,
        progress: trackerStatus.progress || frontmatter.progress,
      };

      // Add all model-defined fields
      const model = globalRegistry.get(trackerType);
      if (model) {
        for (const field of model.fields) {
          if (fields[field.name] !== undefined) continue;
          let value = trackerStatus[field.name] ?? frontmatter[field.name];
          if (value === undefined && (field.type === 'date' || field.type === 'datetime')) {
            value = trackerStatus.date ?? frontmatter.date;
          }
          if (value !== undefined && value !== null) {
            if (field.type === 'date' || field.type === 'datetime') {
              fields[field.name] = parseDate(value) ?? value;
            } else if (field.type === 'string' && typeof value === 'object' && value !== null) {
              fields[field.name] = formatObjectForStringField(value);
            } else {
              fields[field.name] = value;
            }
          }
        }
      }

      return {
        id: trackerStatus.planId || trackerStatus.decisionId || trackerStatus.id || buildFullDocumentTrackerId(trackerType, doc.path),
        primaryType: trackerType,
        typeTags: [trackerType],
        source: 'frontmatter' as const,
        archived: false,
        syncStatus: 'local' as const,
        system: {
          workspace: doc.workspace || '',
          documentPath: doc.path,
          lineNumber: 0,
          createdAt: (trackerStatus.created || frontmatter.created || '').toString(),
          updatedAt: (trackerStatus.updated || frontmatter.updated || '').toString(),
          lastIndexed: (actualDate || new Date(0)).toISOString(),
        },
        fields,
      } satisfies TrackerRecord;
    });
}

/**
 * Render a cell value based on column definition.
 * Extracted to keep the row rendering clean.
 *
 * Exported so the new `TrackerTableGrid` view can render the same cell
 * content without duplicating the field-by-field switch.
 */
export function renderCell(
  col: TrackerColumnDef,
  item: TrackerRecord,
  value: any,
  editingCell: { itemId: string; field: string } | null,
  isItemEditable: (item: TrackerRecord) => boolean,
  setEditingCell: (cell: { itemId: string; field: 'status' | 'priority' | 'title' } | null) => void,
  editingTitle: string,
  setEditingTitle: (title: string) => void,
  titleInputRef: React.RefObject<HTMLInputElement>,
  handleFieldUpdate: (item: TrackerRecord, field: string, value: string) => void,
): React.ReactNode {
  // Resolve field values via schema roles (generic for any schema)
  const title = getRecordTitle(item);
  const status = getRecordStatus(item);
  const priority = getRecordPriority(item);
  const progress = getFieldByRole(item, 'progress') as number | undefined;
  const labels = getFieldByRole(item, 'tags') as string[] | undefined;
  const module = item.system.documentPath;

  switch (col.id) {
    case 'type':
      return (
        <span className={`type-icon flex items-center justify-center w-5 h-5 rounded`} style={{ color: getTypeColor(item.primaryType) }}>
          <span className="material-symbols-outlined text-sm">{getTypeIcon(item.primaryType)}</span>
        </span>
      );

    case 'title':
      if (editingCell?.itemId === item.id && editingCell?.field === 'title') {
        return (
          <input
            ref={titleInputRef}
            type="text"
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onBlur={() => {
              if (editingTitle.trim() && editingTitle !== (item.fields.title as string)) handleFieldUpdate(item, 'title', editingTitle.trim());
              else setEditingCell(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { if (editingTitle.trim() && editingTitle !== title) handleFieldUpdate(item, 'title', editingTitle.trim()); else setEditingCell(null); }
              else if (e.key === 'Escape') setEditingCell(null);
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-[var(--nim-bg-secondary)] border border-[var(--nim-primary)] rounded px-1 py-0.5 text-[var(--nim-text)] font-medium outline-none"
          />
        );
      }
      return (
        <div className="title-text text-[13px] font-medium text-[var(--nim-text)] truncate min-w-0">{title}</div>
      );

    case 'key':
      if (!item.issueKey) return null;
      return (
        <span className="text-[11px] font-mono font-medium uppercase tracking-[0.04em] text-[var(--nim-text-faint)] truncate">
          {item.issueKey}
        </span>
      );

    case 'status': {
      if (isItemEditable(item) && editingCell?.itemId === item.id && editingCell?.field === 'status') {
        const tracker = globalRegistry.get(item.primaryType);
        const statusField = tracker?.fields.find(fld => fld.name === 'status');
        const rawOptions = statusField?.options || ['to-do', 'in-progress', 'done', 'blocked'];
        return (
          <select
            autoFocus
            value={status}
            onChange={(e) => handleFieldUpdate(item, 'status', e.target.value)}
            onBlur={() => setEditingCell(null)}
            onClick={(e) => e.stopPropagation()}
            className="bg-[var(--nim-bg-secondary)] border border-[var(--nim-primary)] rounded text-[11px] text-[var(--nim-text)] px-1 py-0.5 outline-none"
          >
            {rawOptions.map(opt => {
              const val = typeof opt === 'string' ? opt : opt.value;
              const lbl = typeof opt === 'string' ? opt.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : opt.label;
              return <option key={val} value={val}>{lbl}</option>;
            })}
          </select>
        );
      }
      const statusColor = getStatusColor(status, item.primaryType);
      return (
        <span
          className={`status-badge inline-block py-0.5 px-2 rounded-[10px] text-[11px] font-medium border ${isItemEditable(item) ? 'cursor-pointer hover:opacity-80' : ''}`}
          style={{ backgroundColor: `${statusColor}20`, color: statusColor, borderColor: statusColor }}
          onClick={(e) => { if (isItemEditable(item)) { e.stopPropagation(); setEditingCell({ itemId: item.id, field: 'status' }); } }}
        >
          {status.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
        </span>
      );
    }

    case 'priority': {
      if (isItemEditable(item) && editingCell?.itemId === item.id && editingCell?.field === 'priority') {
        return (
          <select
            autoFocus
            value={priority || 'medium'}
            onChange={(e) => handleFieldUpdate(item, 'priority', e.target.value)}
            onBlur={() => setEditingCell(null)}
            onClick={(e) => e.stopPropagation()}
            className="bg-[var(--nim-bg-secondary)] border border-[var(--nim-primary)] rounded text-xs text-[var(--nim-text)] px-1 py-0.5 outline-none"
          >
            {['low', 'medium', 'high', 'critical'].map(p => (
              <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
            ))}
          </select>
        );
      }
      return (
        <span
          className={`priority-badge font-semibold text-xs ${isItemEditable(item) ? 'cursor-pointer hover:opacity-80' : ''}`}
          style={{ color: getPriorityColor(priority || 'medium') }}
          onClick={(e) => { if (isItemEditable(item)) { e.stopPropagation(); setEditingCell({ itemId: item.id, field: 'priority' }); } }}
        >
          {(priority || 'medium').charAt(0).toUpperCase() + (priority || 'medium').slice(1)}
        </span>
      );
    }

    case 'module':
      if (module) {
        return <span className="text-[var(--nim-text-muted)] text-xs font-mono whitespace-nowrap overflow-hidden text-ellipsis block">{module}</span>;
      }
      return (
        <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ backgroundColor: '#6b728015', color: '#9ca3af' }} title="Stored in database" data-testid="tracker-source-db-badge">
          <span className="material-symbols-outlined text-[11px]">storage</span>
          Database
        </span>
      );

    case 'updated': {
      const lastIndexed = item.system.lastIndexed ? new Date(item.system.lastIndexed) : new Date(0);
      return <span className="text-[var(--nim-text-faint)] text-xs">{formatRelativeDate(lastIndexed)}</span>;
    }

    case 'created':
      if (!value) return null;
      if (typeof value === 'string') {
        const d = new Date(value);
        return <span className="text-[var(--nim-text-faint)] text-xs">{isNaN(d.getTime()) ? value : formatRelativeDate(d)}</span>;
      }
      return <span className="text-[var(--nim-text-faint)] text-xs">{formatRelativeDate(value as Date)}</span>;

    case 'shared': {
      // Read-only share indicator. `n/a` (sync mode `local`) renders nothing.
      const shareState = getItemShareState(item);
      if (shareState === 'n/a') return null;
      const shared = shareState === 'shared';
      const shareColor = shared ? '#22c55e' : '#6b7280';
      return (
        <span
          className="shared-badge inline-flex items-center gap-1 py-0.5 px-2 rounded-[10px] text-[11px] font-medium border"
          style={{ backgroundColor: `${shareColor}20`, color: shareColor, borderColor: shareColor }}
          data-testid="tracker-shared-badge"
          title={shared ? 'Shared with the team' : 'Local to this device'}
        >
          <span className="material-symbols-outlined text-[13px]">{shared ? 'group' : 'person'}</span>
          {shared ? 'Shared' : 'Local'}
        </span>
      );
    }

    default: {
      // Generic field rendering -- dispatch by col.render type
      if (value == null) return null;

      switch (col.render) {
        case 'avatar':
          return <UserAvatar identity={value as string} showName />;

        case 'progress': {
          const pct = typeof value === 'number' ? value : 0;
          return (
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-[11px] font-semibold text-[var(--nim-text)]">{pct}%</span>
              <div className="w-full h-1 bg-[var(--nim-bg-tertiary)] rounded-sm relative overflow-hidden">
                <div className="absolute top-0 left-0 h-full bg-[var(--nim-primary)] rounded-sm" style={{ width: `${pct}%` }}></div>
              </div>
            </div>
          );
        }

        case 'tags':
          if (!Array.isArray(value) || value.length === 0) return null;
          return (
            <div className="flex flex-wrap gap-0.5">
              {(value as string[]).map((l: string) => (
                <span key={l} className="inline-block px-1.5 py-0.5 text-[10px] rounded bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">{l}</span>
              ))}
            </div>
          );

        case 'date':
          if (value instanceof Date) return <span className="text-[var(--nim-text-faint)] text-xs">{formatRelativeDate(value)}</span>;
          if (typeof value === 'string') {
            const d = new Date(value);
            return <span className="text-[var(--nim-text-faint)] text-xs">{isNaN(d.getTime()) ? value : formatRelativeDate(d)}</span>;
          }
          return null;

        case 'badge': {
          const strVal = String(value);
          const badgeColor = col.role === 'workflowStatus' ? getStatusColorFromRegistry(strVal, item.primaryType)
            : col.role === 'priority' ? getPriorityColorFromRegistry(strVal)
            : '#6b7280';
          return (
            <span
              className={`status-badge inline-block py-0.5 px-2 rounded-[10px] text-[11px] font-medium border ${isItemEditable(item) ? 'cursor-pointer hover:opacity-80' : ''}`}
              style={{ backgroundColor: `${badgeColor}20`, color: badgeColor, borderColor: badgeColor }}
              onClick={(e) => { if (isItemEditable(item)) { e.stopPropagation(); setEditingCell({ itemId: item.id, field: col.id as any }); } }}
            >
              {strVal.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
            </span>
          );
        }

        case 'relationship': {
          const links = normalizeRelationshipValue(value);
          if (links.length === 0) return null;
          return (
            <div className="flex flex-wrap gap-0.5">
              {links.map((l) => (
                <span
                  key={l.itemId}
                  className="relationship-pill inline-block px-1.5 py-0.5 text-[10px] rounded-full bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]"
                  title={l.title || l.itemId}
                >
                  {l.issueKey || l.title || l.itemId}
                </span>
              ))}
            </div>
          );
        }

        case 'url': {
          // Accept legacy plain-string values as well as { url, label } objects.
          const urlStr = typeof value === 'string'
            ? value
            : (value && typeof value === 'object' && typeof (value as any).url === 'string')
              ? (value as any).url
              : '';
          if (!urlStr) return null;
          const labelStr = (value && typeof value === 'object' && typeof (value as any).label === 'string')
            ? (value as any).label
            : '';
          return (
            <a
              href={urlStr}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--nim-primary)] hover:underline text-xs inline-flex items-center gap-1 max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
              title={urlStr}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="material-symbols-outlined text-[11px] shrink-0">link</span>
              <span className="overflow-hidden text-ellipsis">{labelStr || urlStr}</span>
            </a>
          );
        }

        default:
          if (Array.isArray(value)) return <span className="text-[var(--nim-text-muted)] text-xs">{value.join(', ')}</span>;
          return <span className="text-[var(--nim-text-muted)] text-xs">{String(value)}</span>;
      }
    }
  }
}

export function TrackerTable({
  filterType = 'all',
  sortBy = 'lastIndexed',
  sortDirection = 'desc',
  onSortChange,
  hideTypeTabs = false,
  onSwitchToFilesMode,
  onNewItem,
  onItemSelect,
  selectedItemId,
  overrideItems,
  onArchiveItems,
  onDeleteItems,
  onCopyDeepLink,
  searchQuery: externalSearchQuery,
  columnConfig: externalColumnConfig,
  onColumnConfigChange,
}: TrackerTableProps): JSX.Element {
  // Type filter: use prop filterType when hideTypeTabs is true, otherwise use internal state
  const [internalTypeFilter, setInternalTypeFilter] = useState<TrackerItemType | 'all'>('all');
  const activeTypeFilter = hideTypeTabs ? filterType : internalTypeFilter;

  // Display options panel state
  const [showDisplayOptions, setShowDisplayOptions] = useState(false);

  // Column configuration: use external config or derive from type
  const effectiveColumnConfig = useMemo(() => {
    if (externalColumnConfig) return externalColumnConfig;
    return getDefaultColumnConfig(activeTypeFilter === 'all' ? '' : activeTypeFilter);
  }, [externalColumnConfig, activeTypeFilter]);

  // Resolve all available columns for the current type
  const allColumns = useMemo(() => {
    return resolveColumnsForType(activeTypeFilter === 'all' ? '' : activeTypeFilter);
  }, [activeTypeFilter]);

  // Get the visible column defs in order
  const visibleColumnDefs = useMemo(() => {
    return effectiveColumnConfig.visibleColumns
      .map(id => allColumns.find(c => c.id === id))
      .filter((c): c is TrackerColumnDef => c !== undefined);
  }, [effectiveColumnConfig.visibleColumns, allColumns]);

  // Read tracker items from cross-platform atoms (populated by host adapter)
  const atomItems = useAtomValue(trackerItemsByTypeAtom(activeTypeFilter));
  const dataLoaded = useAtomValue(trackerDataLoadedAtom);

  // Use override items if provided (e.g., for archived view), otherwise atom items
  const sourceItems = overrideItems ?? atomItems;

  // Items from source (atom or override)
  const items = useMemo(() => {
    return sourceItems.map((item: TrackerRecord) => {
      const dateSource = item.system.updatedAt || item.system.createdAt;
      let actualDate: Date | null = null;
      if (dateSource) {
        const parsed = new Date(dateSource);
        if (!isNaN(parsed.getTime())) {
          actualDate = parsed;
        }
      }
      // Ensure lastIndexed is a valid ISO string for sorting
      const lastIndexed = actualDate ? actualDate.toISOString() : (item.system.lastIndexed || new Date(0).toISOString());
      return {
        ...item,
        system: { ...item.system, lastIndexed },
      };
    });
  }, [sourceItems]);

  const loading = !dataLoaded && items.length === 0;
  const [error, setError] = useState<string | null>(null);
  const [currentSortBy, setCurrentSortBy] = useState<SortColumn>(sortBy);
  const [currentSortDirection, setCurrentSortDirection] = useState<SortDirection>(sortDirection);
  const [internalSearchTerm, setInternalSearchTerm] = useState('');
  // Use external search query from parent when provided, otherwise use internal state
  const searchTerm = externalSearchQuery ?? internalSearchTerm;
  const setSearchTerm = externalSearchQuery !== undefined ? () => {} : setInternalSearchTerm;
  const hasExternalSearch = externalSearchQuery !== undefined;
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [customFieldFilters, setCustomFieldFilters] = useState<Record<string, Set<string>>>({});
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const hasActiveFilters = statusFilter !== 'all' || priorityFilter !== 'all';
  const posthog = usePostHog();

  // Close filter menu on outside click
  useEffect(() => {
    if (!showFilterMenu) return;
    const handler = (e: MouseEvent) => {
      if (filterMenuRef.current && !filterMenuRef.current.contains(e.target as Node)) setShowFilterMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showFilterMenu]);

  // Reset filters when tracker type changes (different types have different fields/statuses)
  useEffect(() => {
    setStatusFilter('all');
    setCustomFieldFilters({});
  }, [activeTypeFilter]);

  const sortItems = useCallback((itemsToSort: TrackerRecord[], sortColumn: SortColumn, sortDir: SortDirection) => {
    const sorted = [...itemsToSort].sort((a, b) => {
      let compareValue = 0;

      switch (sortColumn) {
        case 'manual': {
          const aKey = (a.fields.kanbanSortOrder as string) ?? '';
          const bKey = (b.fields.kanbanSortOrder as string) ?? '';
          // Raw string comparison, not localeCompare -- fractional indexing
          // keys sort by character code order (0-9, A-Z, a-z).
          compareValue = aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
          break;
        }
        case 'type':
          compareValue = a.primaryType.localeCompare(b.primaryType);
          break;
        case 'module':
          compareValue = (a.system.documentPath ?? '').localeCompare(b.system.documentPath ?? '');
          break;
        case 'lastIndexed': {
          const aTime = a.system.lastIndexed ? new Date(a.system.lastIndexed).getTime() : 0;
          const bTime = b.system.lastIndexed ? new Date(b.system.lastIndexed).getTime() : 0;
          compareValue = aTime - bTime;
          break;
        }
        default: {
          // Generic field sort via getCellValue (handles all schema fields + builtins)
          const aVal = getCellValue(a, sortColumn);
          const bVal = getCellValue(b, sortColumn);
          if (aVal == null && bVal == null) { compareValue = 0; break; }
          if (aVal == null) { compareValue = 1; break; }
          if (bVal == null) { compareValue = -1; break; }
          if (aVal instanceof Date && bVal instanceof Date) { compareValue = aVal.getTime() - bVal.getTime(); break; }
          if (typeof aVal === 'number' && typeof bVal === 'number') { compareValue = aVal - bVal; break; }
          compareValue = String(aVal).localeCompare(String(bVal));
          break;
        }
      }

      return sortDir === 'asc' ? compareValue : -compareValue;
    });

    return sorted;
  }, []);

  const filteredItems = items
    .filter(item => {
      // Apply search filter
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const matchesSearch =
          item.issueKey?.toLowerCase().includes(searchLower) ||
          String(item.issueNumber ?? '').includes(searchLower) ||
          getRecordTitle(item).toLowerCase().includes(searchLower) ||
          (item.system.documentPath ?? '').toLowerCase().includes(searchLower) ||
          (String(getFieldByRole(item, 'assignee') ?? '')).toLowerCase().includes(searchLower) ||
          (Array.isArray(getFieldByRole(item, 'tags')) && (getFieldByRole(item, 'tags') as string[]).some((tag: string) => tag.toLowerCase().includes(searchLower)));
        if (!matchesSearch) return false;
      }

      // Apply type filter
      if (activeTypeFilter !== 'all' && item.primaryType !== activeTypeFilter) {
        return false;
      }

      // Apply status filter
      if (statusFilter !== 'all' && getRecordStatus(item) !== statusFilter) {
        return false;
      }

      // Apply priority filter
      if (priorityFilter !== 'all' && getRecordPriority(item) !== priorityFilter) {
        return false;
      }

      // Apply custom field filters
      for (const [fieldKey, selectedValues] of Object.entries(customFieldFilters)) {
        if (selectedValues.size === 0) continue;
        const value = item.fields[fieldKey];
        if (Array.isArray(value)) {
          // For array fields (e.g. tags), pass if any selected value is in the array
          if (!value.some(v => selectedValues.has(String(v)))) return false;
        } else {
          const strVal = value != null ? String(value) : '';
          if (!selectedValues.has(strVal)) return false;
        }
      }

      return true;
    });

  // console.log('[TrackerTable] Render - items:', items.length, 'filtered:', filteredItems.length, 'typeFilter:', typeFilter);
  const sortedItems = sortItems(filteredItems, currentSortBy, currentSortDirection);
  const activeGroupBy = normalizeTrackerGroupBy(effectiveColumnConfig.groupBy);
  const isGrouped = activeGroupBy !== 'none';
  const groupedItems = useMemo(
    () => groupTrackerItems(sortedItems, activeGroupBy),
    [sortedItems, activeGroupBy],
  );
  const rowIndexById = useMemo(() => {
    return new Map(sortedItems.map((item, index) => [item.id, index]));
  }, [sortedItems]);

  // Row interaction model -- shared with TrackerTableGrid via useTrackerRows.
  const rows = useTrackerRows({
    items: sortedItems,
    activeTypeFilter,
    onItemSelect,
    onDeleteItems,
    onArchiveItems,
    onSwitchToFilesMode,
  });

  // Local aliases so the existing JSX below stays readable.
  const {
    selectedIds,
    setSelectedIds,
    focusedIndex,
    containerRef: tableRef,
    editingCell,
    setEditingCell,
    editingTitle,
    setEditingTitle,
    titleInputRef,
    handleFieldUpdate,
    isItemEditable,
    handleRowClick,
    openItemInEditor,
    contextAnchor,
    contextRefs,
    contextFloatingStyles,
    handleContextMenu,
    closeContextMenu,
    handleBulkStatusUpdate,
    handleBulkPriorityUpdate,
  } = rows;

  const handleColumnClick = (column: SortColumn) => {
    const newDirection = currentSortBy === column && currentSortDirection === 'desc' ? 'asc' : 'desc';
    if (currentSortBy !== column) {
      posthog.capture('tracker_table_sort', { column });
    }
    setCurrentSortBy(column);
    setCurrentSortDirection(newDirection);

    if (onSortChange) {
      onSortChange(column, newDirection);
    }
  };

  const getSortIndicator = (column: SortColumn) => {
    if (currentSortBy !== column) {
      return <span className="sort-indicator opacity-30 text-sm">&#8645;</span>;
    }
    return currentSortDirection === 'desc'
      ? <span className="sort-indicator active opacity-100 text-[var(--nim-primary)] text-sm">&#8595;</span>
      : <span className="sort-indicator active opacity-100 text-[var(--nim-primary)] text-sm">&#8593;</span>;
  };

  // Build status options from the active tracker model's field definition
  // (must be before early returns to maintain consistent hook order)
  const statusOptions = useMemo(() => {
    const allOption = { value: 'all', label: 'All' };

    if (activeTypeFilter && activeTypeFilter !== 'all') {
      const model = globalRegistry.get(activeTypeFilter);
      if (model) {
        const statusField = model.fields.find(f => f.name === resolveRoleFieldName(model.type, 'workflowStatus'));
        if (statusField?.options && statusField.options.length > 0) {
          return [
            allOption,
            ...statusField.options.map(o => ({
              value: o.value,
              label: o.label,
            })),
          ];
        }
      }
    }

    // Fallback for built-in types or 'all' view
    return [
      allOption,
      { value: 'to-do', label: 'To Do' },
      { value: 'in-progress', label: 'In Progress' },
      { value: 'in-review', label: 'In Review' },
      { value: 'done', label: 'Done' },
      { value: 'blocked', label: 'Blocked' },
    ];
  }, [activeTypeFilter]);

  // Derive extra columns from the tracker model's tableView.defaultColumns
  const extraColumns = useMemo(() => {
    const builtinColumns = new Set(['title', 'status', 'priority', 'progress']);
    if (activeTypeFilter && activeTypeFilter !== 'all') {
      const model = globalRegistry.get(activeTypeFilter);
      if (model?.tableView?.defaultColumns) {
        return model.tableView.defaultColumns
          .filter(col => !builtinColumns.has(col))
          .map(col => {
            const field = model.fields.find(f => f.name === col);
            // Convert camelCase to display label (e.g. publishDate -> Publish Date)
            const label = field?.name
              ? field.name.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())
              : col;
            return { key: col, label, type: field?.type || 'string' };
          });
      }
    }
    return [];
  }, [activeTypeFilter]);

  // Collect unique values for filterable extra columns (string, user, array types)
  const extraColumnValues = useMemo(() => {
    const filterableTypes = new Set(['string', 'user', 'select', 'array']);
    const result: Record<string, string[]> = {};
    for (const col of extraColumns) {
      if (!filterableTypes.has(col.type)) continue;
      const valSet = new Set<string>();
      for (const item of items) {
        const val = item.fields[col.key];
        if (val == null) continue;
        if (Array.isArray(val)) {
          val.forEach(v => valSet.add(String(v)));
        } else {
          valSet.add(String(val));
        }
      }
      if (valSet.size > 0) {
        result[col.key] = Array.from(valSet).sort();
      }
    }
    return result;
  }, [extraColumns, items]);

  // Only show full-page loading spinner if we have no items yet
  if (loading && items.length === 0) {
    return (
      <div className="tracker-table-loading flex flex-col items-center justify-center py-[60px] px-5 text-[var(--nim-text-muted)] text-center gap-3">
        <div className="spinner w-8 h-8 border-[3px] border-[var(--nim-border)] border-t-[var(--nim-primary)] rounded-full animate-spin"></div>
        <span>Loading tracker items...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="tracker-table-error flex flex-col items-center justify-center py-[60px] px-5 text-[#ef4444] text-center gap-3">
        <span>Warning: {error}</span>
      </div>
    );
  }

  const priorityOptions = [
    { value: 'all', label: 'All' },
    { value: 'critical', label: 'Critical' },
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
    { value: 'low', label: 'Low' },
  ];

  const typeOptions = [
    { value: 'all', label: 'All', icon: 'list' },
    { value: 'bug', label: 'Bugs', icon: 'bug_report' },
    { value: 'task', label: 'Tasks', icon: 'check_box' },
    { value: 'plan', label: 'Plans', icon: 'assignment' },
    { value: 'idea', label: 'Ideas', icon: 'lightbulb' },
    { value: 'decision', label: 'Decisions', icon: 'gavel' },
  ];

  const renderTrackerRow = (item: TrackerRecord, index: number) => {
    const title = getRecordTitle(item);

    return (
      <div
        key={item.id || index}
        className={`tracker-table-row flex items-center gap-3 px-3 py-[7px] border-b border-[var(--nim-border)] cursor-pointer transition-colors duration-100 hover:bg-[var(--nim-bg-secondary)] select-none ${
          selectedIds.has(item.id) ? 'bg-[var(--nim-bg-secondary)]' : ''
        } ${
          selectedItemId && item.id === selectedItemId ? 'bg-[var(--nim-bg-secondary)]' : ''
        } ${
          focusedIndex === index ? 'outline outline-1 outline-[var(--nim-primary)] -outline-offset-1' : ''
        }`}
        data-testid="tracker-table-row"
        data-item-id={item.id}
        data-item-title={item.fields.title as string}
        onClick={(e) => handleRowClick(item, index, e)}
        onDoubleClick={() => { if (item.system.documentPath) openItemInEditor(item); }}
        onContextMenu={(e) => handleContextMenu(e, item, index)}
      >
        <span className="shrink-0 w-5 flex items-center justify-center" style={{ color: getTypeColor(item.primaryType), opacity: 0.7 }}>
          <span className="material-symbols-outlined" style={{ fontSize: '16px', fontVariationSettings: "'wght' 300" }}>{getTypeIcon(item.primaryType)}</span>
        </span>

        <div className="tracker-table-cell title flex-1 min-w-0">
          {editingCell?.itemId === item.id && editingCell?.field === 'title' ? (
            <input
              ref={titleInputRef}
              type="text"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={() => {
                if (editingTitle.trim() && editingTitle !== (item.fields.title as string)) handleFieldUpdate(item, 'title', editingTitle.trim());
                else setEditingCell(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { if (editingTitle.trim() && editingTitle !== title) handleFieldUpdate(item, 'title', editingTitle.trim()); else setEditingCell(null); }
                else if (e.key === 'Escape') setEditingCell(null);
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-full bg-[var(--nim-bg-secondary)] border border-[var(--nim-primary)] rounded px-1 py-0.5 text-[13px] text-[var(--nim-text)] font-medium outline-none"
            />
          ) : (
            <div className="flex items-baseline gap-2 min-w-0">
              {item.issueKey && (
                <span className="shrink-0 text-[10px] font-mono font-medium uppercase tracking-[0.08em] text-[var(--nim-text-faint)]">{item.issueKey}</span>
              )}
              <span className="text-[13px] font-medium text-[var(--nim-text)] truncate">{title}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {visibleColumnDefs.filter(col => col.id !== 'type' && col.id !== 'title').map(col => {
            const value = getCellValue(item, col.id);
            return (
              <div key={col.id} className={`tracker-table-cell ${col.id}`}>
                {renderCell(col, item, value, editingCell, isItemEditable, setEditingCell, editingTitle, setEditingTitle, titleInputRef, handleFieldUpdate)}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="tracker-table-wrapper flex flex-col h-full w-full bg-[var(--nim-bg)]" data-testid="tracker-table">
      {/* Display options panel (positioned relative to wrapper) */}
      {showDisplayOptions && onColumnConfigChange && (
        <div className="relative">
          <DisplayOptionsPanel
            availableColumns={allColumns}
            config={effectiveColumnConfig}
            onConfigChange={(config) => onColumnConfigChange(config)}
            onClose={() => setShowDisplayOptions(false)}
          />
        </div>
      )}

      {/* Type filter tabs */}
      {!hideTypeTabs && (
        <div className="tracker-type-tabs flex gap-1 py-3 px-4 bg-[var(--nim-bg)] border-b border-[var(--nim-border)]">
          {typeOptions.map(option => (
            <button
              key={option.value}
              className={`tracker-type-tab flex items-center gap-1.5 py-2 px-3 border border-[var(--nim-border)] rounded-md text-[var(--nim-text-muted)] text-[13px] font-medium cursor-pointer transition-all duration-150 hover:bg-[var(--nim-bg-secondary)] ${internalTypeFilter === option.value ? 'active bg-[var(--nim-bg-secondary)] !border-[var(--nim-primary)] !text-[var(--nim-primary)]' : ''}`}
              onClick={() => setInternalTypeFilter(option.value as TrackerItemType | 'all')}
            >
              <span className="material-symbols-outlined text-lg">{option.icon}</span>
              <span>{option.label}</span>
              {option.value === 'all' && <span className={`count py-0.5 px-1.5 rounded-[10px] text-[11px] font-semibold ${internalTypeFilter === option.value ? 'bg-[var(--nim-primary)] text-[var(--nim-bg)]' : 'bg-[var(--nim-bg-tertiary)]'}`}>{items.length}</span>}
              {option.value !== 'all' && (
                <span className={`count py-0.5 px-1.5 rounded-[10px] text-[11px] font-semibold ${internalTypeFilter === option.value ? 'bg-[var(--nim-primary)] text-[var(--nim-bg)]' : 'bg-[var(--nim-bg-tertiary)]'}`}>{items.filter(i => i.primaryType === option.value).length}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar: filter + display options + count */}
      {items.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--nim-border)] bg-[var(--nim-bg)]">
          {/* Filter button */}
          <div className="relative" ref={filterMenuRef}>
            <button
              className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded border transition-colors ${
                showFilterMenu || hasActiveFilters
                  ? 'bg-[var(--nim-bg-tertiary)] border-[var(--nim-primary)] text-[var(--nim-primary)]'
                  : 'bg-[var(--nim-bg-secondary)] border-[var(--nim-border)] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:border-[var(--nim-text-faint)]'
              }`}
              onClick={() => setShowFilterMenu(!showFilterMenu)}
            >
              <span className="material-symbols-outlined text-xs">filter_list</span>
              Filter
              {hasActiveFilters && (
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--nim-primary)]" />
              )}
            </button>
            {showFilterMenu && (
              <div className="absolute left-0 top-full mt-1 w-[200px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md shadow-lg z-50 py-1 text-[12px]">
                {/* Status section */}
                <div className="px-2 py-1 text-[10px] font-semibold text-[var(--nim-text-faint)] uppercase tracking-wider">Status</div>
                {statusOptions.map(option => (
                  <button
                    key={option.value}
                    className={`w-full text-left px-3 py-1 hover:bg-[var(--nim-bg-hover)] flex items-center gap-2 ${
                      statusFilter === option.value ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text)]'
                    }`}
                    onClick={() => { setStatusFilter(option.value === statusFilter ? 'all' : option.value); }}
                  >
                    {statusFilter === option.value && <span className="material-symbols-outlined text-xs">check</span>}
                    <span className={statusFilter === option.value ? '' : 'ml-[18px]'}>{option.label}</span>
                  </button>
                ))}
                <div className="border-t border-[var(--nim-border)] my-1" />
                {/* Priority section */}
                <div className="px-2 py-1 text-[10px] font-semibold text-[var(--nim-text-faint)] uppercase tracking-wider">Priority</div>
                {priorityOptions.map(option => (
                  <button
                    key={option.value}
                    className={`w-full text-left px-3 py-1 hover:bg-[var(--nim-bg-hover)] flex items-center gap-2 ${
                      priorityFilter === option.value ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text)]'
                    }`}
                    onClick={() => { setPriorityFilter(option.value === priorityFilter ? 'all' : option.value); }}
                  >
                    {priorityFilter === option.value && <span className="material-symbols-outlined text-xs">check</span>}
                    <span className={priorityFilter === option.value ? '' : 'ml-[18px]'}>{option.label}</span>
                  </button>
                ))}
                {hasActiveFilters && (
                  <>
                    <div className="border-t border-[var(--nim-border)] my-1" />
                    <button
                      className="w-full text-left px-3 py-1 text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                      onClick={() => { setStatusFilter('all'); setPriorityFilter('all'); setShowFilterMenu(false); }}
                    >
                      Clear all filters
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Active filter chips */}
          {statusFilter !== 'all' && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">
              {statusFilter.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
              <button className="hover:text-[var(--nim-text)]" onClick={() => setStatusFilter('all')}><span className="material-symbols-outlined" style={{ fontSize: '11px' }}>close</span></button>
            </span>
          )}
          {priorityFilter !== 'all' && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">
              {priorityFilter.charAt(0).toUpperCase() + priorityFilter.slice(1)}
              <button className="hover:text-[var(--nim-text)]" onClick={() => setPriorityFilter('all')}><span className="material-symbols-outlined" style={{ fontSize: '11px' }}>close</span></button>
            </span>
          )}

          <div className="flex-1" />

          {/* Display options */}
          {onColumnConfigChange && (
            <button
              className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] transition-colors"
              onClick={() => setShowDisplayOptions(!showDisplayOptions)}
              title="Display options"
            >
              <span className="material-symbols-outlined text-sm">tune</span>
            </button>
          )}

          <span className="text-[11px] text-[var(--nim-text-faint)]">{sortedItems.length} item{sortedItems.length !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* List */}
      <div ref={tableRef} tabIndex={0} className="tracker-table-container tracker-table flex-1 overflow-auto pb-1 outline-none">
        {sortedItems.length === 0 ? (
          <div>
            {loading ? (
              <div className="tracker-table-loading flex items-center justify-center gap-3 py-6 px-6 text-[var(--nim-text-muted)]">
                <div className="w-5 h-5 border-2 border-[var(--nim-border)] border-t-[var(--nim-primary)] rounded-full animate-spin"></div>
                <span className="text-sm">Loading...</span>
              </div>
            ) : activeTypeFilter !== 'all' ? (
              (() => {
                const typeInfo = getTypeDescription(activeTypeFilter as TrackerItemType);
                const typeColor = getTypeColor(activeTypeFilter as TrackerItemType);
                const typeIcon = getTypeIcon(activeTypeFilter as TrackerItemType);
                return (
                  <div className="tracker-table-empty flex items-center gap-4 py-4 px-6">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: `${typeColor}12` }}>
                      <span className="material-symbols-outlined text-lg" style={{ color: typeColor }}>{typeIcon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[var(--nim-text-muted)] m-0">{typeInfo.description}</p>
                      <p className="text-xs text-[var(--nim-text-faint)] m-0 mt-1">
                        {activeTypeFilter === 'plan' ? (
                          <>Use <code className="px-1 py-0.5 bg-[var(--nim-bg-secondary)] rounded text-[10px]">/plan</code> in chat to create a new plan</>
                        ) : (
                          <>Type <code className="px-1 py-0.5 bg-[var(--nim-bg-secondary)] rounded text-[10px]">#{activeTypeFilter}</code> in markdown or use <code className="px-1 py-0.5 bg-[var(--nim-bg-secondary)] rounded text-[10px]">/track {activeTypeFilter}</code> in chat</>
                        )}
                      </p>
                    </div>
                    {onNewItem && globalRegistry.get(activeTypeFilter)?.creatable !== false && (
                      <button
                        className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium text-white border-none cursor-pointer transition-all duration-150 hover:opacity-90"
                        style={{ backgroundColor: typeColor }}
                        onClick={() => onNewItem(activeTypeFilter as TrackerItemType)}
                      >
                        <span className="flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">add</span>
                          New {activeTypeFilter.charAt(0).toUpperCase() + activeTypeFilter.slice(1)}
                        </span>
                      </button>
                    )}
                  </div>
                );
              })()
            ) : (
              <div className="tracker-table-empty flex items-center justify-center gap-2 py-4 px-6">
                <p className="text-sm text-[var(--nim-text-muted)] m-0">No tracker items found</p>
                <p className="text-xs text-[var(--nim-text-faint)] m-0">Create items using #bug, #task, #plan, or #idea in any markdown file</p>
              </div>
            )}
          </div>
        ) : isGrouped ? (
          groupedItems.map((group) => (
            <React.Fragment key={`${activeGroupBy}:${group.key || 'empty'}`}>
              <TrackerGroupHeader label={group.label} count={group.items.length} />
              {group.items.map((item) => renderTrackerRow(item, rowIndexById.get(item.id) ?? 0))}
            </React.Fragment>
          ))
        ) : (
          sortedItems.map((item, index) => renderTrackerRow(item, index))
        )}
      </div>

      {/* Context menu */}
      {contextAnchor && selectedIds.size > 0 && (
        <FloatingPortal>
        <div
          ref={contextRefs.setFloating}
          className="z-50 min-w-[180px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md shadow-lg py-1 text-[13px]"
          style={contextFloatingStyles}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-[11px] text-[var(--nim-text-faint)] font-medium">
            {selectedIds.size} item{selectedIds.size > 1 ? 's' : ''} selected
          </div>
          <div className="border-b border-[var(--nim-border)] my-1" />

          {/* Status submenu */}
          <ContextSubmenu label="Set Status" icon="swap_horiz">
            {(() => {
              const tracker = activeTypeFilter !== 'all' ? globalRegistry.get(activeTypeFilter) : null;
              const statusFieldName = activeTypeFilter !== 'all' ? resolveRoleFieldName(activeTypeFilter, 'workflowStatus') : 'status';
              const statusField = tracker?.fields.find(f => f.name === statusFieldName);
              const rawOptions: Array<string | { value: string; label: string }> = statusField?.options || [
                { value: 'to-do', label: 'To Do' },
                { value: 'in-progress', label: 'In Progress' },
                { value: 'in-review', label: 'In Review' },
                { value: 'done', label: 'Done' },
                { value: 'blocked', label: 'Blocked' },
              ];
              return rawOptions.map(opt => {
                const val = typeof opt === 'string' ? opt : opt.value;
                const label = typeof opt === 'string' ? opt.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : opt.label;
                return (
                  <button
                    key={val}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                    onClick={() => handleBulkStatusUpdate(val)}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: getStatusColor(val as string, activeTypeFilter !== 'all' ? activeTypeFilter : undefined) }}
                    />
                    {label}
                  </button>
                );
              });
            })()}
          </ContextSubmenu>

          {/* Priority submenu */}
          <ContextSubmenu label="Set Priority" icon="flag">
            {['critical', 'high', 'medium', 'low'].map(p => (
              <button
                key={p}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                onClick={() => handleBulkPriorityUpdate(p)}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: getPriorityColor(p as string) }}
                />
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </ContextSubmenu>

          <div className="border-b border-[var(--nim-border)] my-1" />

          {/* Copy Link (single-selection only) */}
          {onCopyDeepLink && selectedIds.size === 1 && (
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
              onClick={() => {
                const [onlyId] = selectedIds;
                closeContextMenu();
                onCopyDeepLink(onlyId);
              }}
            >
              <span className="material-symbols-outlined text-sm">link</span>
              Copy Link
            </button>
          )}

          {/* Archive */}
          {onArchiveItems && (
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
              onClick={() => {
                closeContextMenu();
                onArchiveItems(Array.from(selectedIds), true);
                setSelectedIds(new Set());
              }}
            >
              <span className="material-symbols-outlined text-sm">archive</span>
              Archive
            </button>
          )}

          {/* Delete */}
          {onDeleteItems && (
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#ef4444] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
              onClick={() => {
                closeContextMenu();
                const ids = Array.from(selectedIds);
                if (window.confirm(`Delete ${ids.length} item${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) {
                  onDeleteItems(ids);
                  setSelectedIds(new Set());
                }
              }}
            >
              <span className="material-symbols-outlined text-sm">delete</span>
              Delete
            </button>
          )}
        </div>
        </FloatingPortal>
      )}
    </div>
  );
}

/** Context menu submenu with hover-expand. Exported for reuse in the new
 *  TrackerTableGrid context menu. */
export const ContextSubmenu: React.FC<{
  label: string;
  icon: string;
  children: React.ReactNode;
}> = ({ label, icon, children }) => {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { refs, floatingStyles } = useFloating({
    placement: 'right-start',
    middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  const handleEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(true);
  };
  const handleLeave = () => {
    timeoutRef.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <div
      ref={refs.setReference as React.RefCallback<HTMLDivElement>}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer">
        <span className="material-symbols-outlined text-sm">{icon}</span>
        <span className="flex-1">{label}</span>
        <span className="material-symbols-outlined text-xs text-[var(--nim-text-faint)]">chevron_right</span>
      </div>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            className="min-w-[140px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md shadow-lg py-1 z-[60]"
            style={floatingStyles}
            onMouseEnter={handleEnter}
            onMouseLeave={handleLeave}
          >
            {children}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
};
