/**
 * TrackerToolWidget - Custom widget for tracker MCP tools.
 *
 * Handles: tracker_list, tracker_get, tracker_create, tracker_update,
 *          tracker_link_session, tracker_link_file
 *
 * Shows compact, structured summaries of tracker operations in the AI transcript,
 * matching the visual style of UpdateSessionMetaWidget.
 *
 * Supports structured JSON results (new format) with fallback to plain text (old sessions).
 */

import React from 'react';
import type { CustomToolWidgetProps } from './index';

// ---------- Types ----------

interface TrackerItem {
  id: string;
  type: string;
  typeTags?: string[];
  title: string;
  status?: string;
  priority?: string;
  tags?: string[];
  owner?: string;
  dueDate?: string;
}

interface StructuredCreated {
  action: 'created';
  item: TrackerItem;
}

interface StructuredUpdated {
  action: 'updated';
  id: string;
  type: string;
  typeTags?: string[];
  title: string;
  changes: Record<string, { from: any; to: any }>;
}

interface StructuredListed {
  action: 'listed';
  filters: Record<string, string>;
  count: number;
  items: TrackerItem[];
}

interface StructuredRetrieved {
  action: 'retrieved';
  item: TrackerItem;
}

interface StructuredLinked {
  action: 'linked';
  trackerId: string;
  type: string;
  title: string;
  linkedCount: number;
}

interface StructuredLinkedFile {
  action: 'linked_file';
  filePath: string;
  linkedCount: number;
}

type StructuredResult =
  | StructuredCreated
  | StructuredUpdated
  | StructuredListed
  | StructuredRetrieved
  | StructuredLinked
  | StructuredLinkedFile;

// ---------- Helpers ----------

function getResultText(result: unknown): string | null {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    for (const block of result) {
      if (block && block.type === 'text' && block.text) return block.text as string;
    }
    return null;
  }
  const r = result as any;
  if (r.content && Array.isArray(r.content)) {
    for (const block of r.content) {
      if (block.type === 'text' && block.text) return block.text as string;
    }
  }
  if (r.result != null) return getResultText(r.result);
  if (r.output != null && typeof r.output === 'string') return r.output;
  if (r.summary != null && typeof r.summary === 'string') return r.summary;
  return null;
}

function extractStructured(tool: { result?: unknown }): { structured: StructuredResult; summary: string } | null {
  if (tool.result && typeof tool.result === 'object' && !Array.isArray(tool.result)) {
    const r = tool.result as any;
    if (r.structured && r.summary) {
      return { structured: r.structured as StructuredResult, summary: r.summary as string };
    }
  }

  const text = getResultText(tool.result);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed.structured && parsed.summary) {
      return { structured: parsed.structured, summary: parsed.summary };
    }
  } catch {
    // Not JSON -- old format
  }
  return null;
}

function navigateToTrackerItem(itemId: string): void {
  window.dispatchEvent(
    new CustomEvent('nimbalyst:navigate-tracker-item', { detail: { itemId } })
  );
}

// ---------- Style constants ----------

const TYPE_COLORS: Record<string, string> = {
  bug: '#f87171',
  task: '#60a5fa',
  plan: '#a78bfa',
  idea: '#fbbf24',
  decision: '#4ade80',
  feature: '#10b981',
};

const getTypeColor = (type: string) => TYPE_COLORS[type] || 'var(--nim-text-muted)';

const STATUS_COLORS: Record<string, string> = {
  'done': '#4ade80',
  'completed': '#4ade80',
  'in-progress': '#60a5fa',
  'active': '#60a5fa',
};

const getStatusColor = (status: string) => STATUS_COLORS[status] || 'var(--nim-text-muted)';

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#fbbf24',
  medium: '#9ca3af',
  low: '#808080',
};

const getPriorityColor = (priority: string) => PRIORITY_COLORS[priority] || 'var(--nim-text-muted)';

// ---------- Small components ----------

const TypeBadge: React.FC<{ type: string }> = ({ type }) => (
  <span
    style={{
      fontSize: '10px',
      padding: '0px 6px',
      borderRadius: '10px',
      fontWeight: 600,
      lineHeight: '18px',
      background: `${getTypeColor(type)}22`,
      color: getTypeColor(type),
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
    }}
  >
    {type}
  </span>
);

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const color = getStatusColor(status);
  return (
    <span
      style={{
        fontSize: '10px',
        padding: '0px 6px',
        borderRadius: '10px',
        fontWeight: 500,
        lineHeight: '18px',
        background: `${color}18`,
        color,
        border: `1px solid ${color}30`,
      }}
    >
      {status}
    </span>
  );
};

const PriorityBadge: React.FC<{ priority: string }> = ({ priority }) => {
  const color = getPriorityColor(priority);
  return (
    <span
      style={{
        fontSize: '10px',
        padding: '0px 6px',
        borderRadius: '10px',
        fontWeight: 500,
        lineHeight: '18px',
        background: `${color}18`,
        color,
        border: `1px solid ${color}30`,
      }}
    >
      {priority}
    </span>
  );
};

const TagPill: React.FC<{ tag: string; variant: 'kept' | 'added' | 'removed' }> = ({ tag, variant }) => {
  const styles: Record<string, React.CSSProperties> = {
    kept: {
      background: 'var(--nim-bg-tertiary)',
      color: 'var(--nim-text-muted)',
      border: '1px solid var(--nim-border)',
    },
    added: {
      background: 'rgba(74,222,128,0.12)',
      color: '#4ade80',
      border: '1px solid rgba(74,222,128,0.3)',
    },
    removed: {
      background: 'rgba(248,113,113,0.12)',
      color: '#f87171',
      border: '1px solid rgba(248,113,113,0.3)',
      textDecoration: 'line-through',
    },
  };
  const prefix = variant === 'added' ? '+' : variant === 'removed' ? '-' : '';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '2px',
        fontSize: '10px',
        padding: '0px 6px',
        borderRadius: '10px',
        fontWeight: 500,
        lineHeight: '18px',
        ...styles[variant],
      }}
    >
      {prefix && <span style={{ fontWeight: 700, fontSize: '11px' }}>{prefix}</span>}
      #{tag}
    </span>
  );
};

const Arrow: React.FC = () => (
  <span style={{ color: 'var(--nim-text-faint)', fontSize: '10px', padding: '0 2px' }}>
    {'\u2192'}
  </span>
);

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontWeight: 500, minWidth: '50px' }}>
    {children}
  </span>
);

const ClickableTitle: React.FC<{ title: string; itemId: string }> = ({ title, itemId }) => (
  <span
    onClick={() => navigateToTrackerItem(itemId)}
    style={{
      fontSize: '11px',
      color: 'var(--nim-text)',
      fontWeight: 500,
      cursor: 'pointer',
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.textDecoration = 'underline';
      e.currentTarget.style.color = 'var(--nim-primary)';
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.textDecoration = 'none';
      e.currentTarget.style.color = 'var(--nim-text)';
    }}
  >
    {title}
  </span>
);

const Row: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
    {children}
  </div>
);

const WidgetShell: React.FC<{ header: React.ReactNode; children: React.ReactNode }> = ({ header, children }) => (
  <div
    style={{
      border: '1px solid var(--nim-border)',
      borderRadius: '6px',
      overflow: 'hidden',
      fontSize: '11px',
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '5px 10px',
        background: 'var(--nim-bg-tertiary)',
        borderBottom: '1px solid var(--nim-border)',
      }}
    >
      {header}
    </div>
    <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {children}
    </div>
  </div>
);

// ---------- Per-action renderers ----------

const SecondaryTypeBadges: React.FC<{ typeTags?: string[]; primaryType: string }> = ({ typeTags, primaryType }) => {
  // Older transcripts may have persisted typeTags as a JSON-encoded string (SQLite
  // shape) rather than an array; tolerate that instead of crashing the widget.
  const tags: string[] | undefined = Array.isArray(typeTags)
    ? typeTags
    : typeof typeTags === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(typeTags);
            return Array.isArray(parsed) ? (parsed as string[]) : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined;
  if (!tags) return null;
  const secondary = tags.filter(t => t !== primaryType);
  if (secondary.length === 0) return null;
  return (
    <>
      {secondary.map(tag => (
        <TypeBadge key={tag} type={tag} />
      ))}
    </>
  );
};

const CreatedView: React.FC<{ data: StructuredCreated }> = ({ data }) => {
  const { item } = data;
  return (
    <WidgetShell
      header={
        <>
          <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>Tracker Created</span>
          <span style={{ fontFamily: 'monospace', fontSize: '9px', color: 'var(--nim-text-faint)', marginLeft: 'auto' }}>
            {item.id}
          </span>
        </>
      }
    >
      <Row>
        <Label>Type</Label>
        <TypeBadge type={item.type} />
        <SecondaryTypeBadges typeTags={item.typeTags} primaryType={item.type} />
      </Row>
      <Row>
        <Label>Title</Label>
        <ClickableTitle title={item.title} itemId={item.id} />
      </Row>
      <Row>
        <Label>Status</Label>
        {item.status && <StatusBadge status={item.status} />}
        {item.priority && (
          <>
            <span style={{ width: '12px' }} />
            <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontWeight: 500 }}>Priority</span>
            <PriorityBadge priority={item.priority} />
          </>
        )}
      </Row>
      {Array.isArray(item.tags) && item.tags.length > 0 && (
        <Row>
          <Label>Tags</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
            {item.tags.map((t) => (
              <TagPill key={t} tag={t} variant="kept" />
            ))}
          </div>
        </Row>
      )}
    </WidgetShell>
  );
};

// Fields rendered by dedicated UI; everything else falls through to GenericChangeRow
// so custom tracker types (incident, decision, plan, ...) show their field updates.
const SPECIAL_CHANGE_KEYS = new Set([
  'status', 'priority', 'title', 'owner', 'archived', 'progress', 'tags', 'description',
]);

function formatChangeValue(value: any): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map((v) => String(v)).join(', ');
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  const s = String(value);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

function humanizeFieldName(field: string): string {
  // camelCase / snake_case -> "Title Case With Spaces"
  return field
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function normalizeTagList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

const GenericChangeRow: React.FC<{ field: string; change: { from: any; to: any } }> = ({ field, change }) => (
  <Row>
    <Label>{humanizeFieldName(field)}</Label>
    <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', textDecoration: 'line-through' }}>
      {formatChangeValue(change.from)}
    </span>
    <Arrow />
    <span style={{ fontSize: '11px', color: 'var(--nim-text-muted)' }}>
      {formatChangeValue(change.to)}
    </span>
  </Row>
);

const DescriptionChangeRow: React.FC<{ change: { from: any; to: any } }> = ({ change }) => {
  const fromLen = typeof change.from === 'string' ? change.from.length : 0;
  const toLen = typeof change.to === 'string' ? change.to.length : 0;
  return (
    <Row>
      <Label>Description</Label>
      <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)' }}>
        {fromLen.toLocaleString()} chars
      </span>
      <Arrow />
      <span style={{ fontSize: '11px', color: 'var(--nim-text-muted)' }}>
        {toLen.toLocaleString()} chars
      </span>
    </Row>
  );
};

const UpdatedView: React.FC<{ data: StructuredUpdated }> = ({ data }) => {
  const { changes } = data;
  const changedKeys = Object.keys(changes);
  if (changedKeys.length === 0) return null;

  // Compute tag diff
  let tagDiff: { kept: string[]; added: string[]; removed: string[] } | null = null;
  if (changes.tags) {
    const fromTags = normalizeTagList(changes.tags.from);
    const toTags = normalizeTagList(changes.tags.to);
    const fromSet = new Set(fromTags);
    const toSet = new Set(toTags);
    tagDiff = {
      kept: toTags.filter((t) => fromSet.has(t)),
      added: toTags.filter((t) => !fromSet.has(t)),
      removed: fromTags.filter((t) => !toSet.has(t)),
    };
  }

  const otherChangedKeys = changedKeys.filter((k) => !SPECIAL_CHANGE_KEYS.has(k));

  return (
    <WidgetShell
      header={
        <>
          <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>Tracker Updated</span>
          <TypeBadge type={data.type} />
          <SecondaryTypeBadges typeTags={data.typeTags} primaryType={data.type} />
          <span
            onClick={() => navigateToTrackerItem(data.id)}
            style={{
              color: 'var(--nim-text-muted)',
              fontSize: '10px',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--nim-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--nim-text-muted)'; }}
          >
            {data.title}
          </span>
        </>
      }
    >
      {changes.status && (
        <Row>
          <Label>Status</Label>
          <StatusBadge status={String(changes.status.from || 'none')} />
          <Arrow />
          <StatusBadge status={String(changes.status.to)} />
        </Row>
      )}
      {changes.priority && (
        <Row>
          <Label>Priority</Label>
          <PriorityBadge priority={String(changes.priority.from || 'none')} />
          <Arrow />
          <PriorityBadge priority={String(changes.priority.to)} />
        </Row>
      )}
      {changes.title && (
        <Row>
          <Label>Title</Label>
          <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', textDecoration: 'line-through' }}>
            {String(changes.title.from)}
          </span>
          <Arrow />
          <span style={{ fontSize: '11px', color: 'var(--nim-text)', fontWeight: 500 }}>
            {String(changes.title.to)}
          </span>
        </Row>
      )}
      {changes.owner && (
        <Row>
          <Label>Owner</Label>
          <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)' }}>{String(changes.owner.from || 'none')}</span>
          <Arrow />
          <span style={{ fontSize: '11px', color: 'var(--nim-text-muted)' }}>{String(changes.owner.to)}</span>
        </Row>
      )}
      {changes.archived !== undefined && (
        <Row>
          <Label>Archived</Label>
          <span style={{ fontSize: '10px', color: changes.archived.to ? '#fbbf24' : '#4ade80' }}>
            {changes.archived.to ? 'archived' : 'unarchived'}
          </span>
        </Row>
      )}
      {changes.progress !== undefined && (
        <Row>
          <Label>Progress</Label>
          <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)' }}>{String(changes.progress.from ?? 0)}%</span>
          <Arrow />
          <span style={{ fontSize: '11px', color: 'var(--nim-text-muted)' }}>{String(changes.progress.to)}%</span>
        </Row>
      )}
      {tagDiff && (tagDiff.kept.length > 0 || tagDiff.added.length > 0 || tagDiff.removed.length > 0) && (
        <Row>
          <Label>Tags</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
            {tagDiff.kept.map((t) => <TagPill key={`k-${t}`} tag={t} variant="kept" />)}
            {tagDiff.added.map((t) => <TagPill key={`a-${t}`} tag={t} variant="added" />)}
            {tagDiff.removed.map((t) => <TagPill key={`r-${t}`} tag={t} variant="removed" />)}
          </div>
        </Row>
      )}
      {changes.description && <DescriptionChangeRow change={changes.description} />}
      {otherChangedKeys.map((key) => (
        <GenericChangeRow key={key} field={key} change={changes[key]} />
      ))}
    </WidgetShell>
  );
};

const ListedView: React.FC<{ data: StructuredListed }> = ({ data }) => {
  const filterSummary = Object.entries(data.filters)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  return (
    <WidgetShell
      header={
        <>
          <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>Tracker List</span>
          {filterSummary && (
            <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)' }}>{filterSummary}</span>
          )}
          <span style={{ fontSize: '10px', color: 'var(--nim-primary)', fontWeight: 500 }}>({data.count})</span>
        </>
      }
    >
      {data.items.length === 0 ? (
        <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontStyle: 'italic' }}>
          No items found
        </span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
          {data.items.map((item, i) => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '3px 0',
                borderTop: i > 0 ? '1px solid rgba(74,74,74,0.4)' : undefined,
                paddingTop: i > 0 ? '5px' : '3px',
              }}
            >
              <TypeBadge type={item.type} />
              <SecondaryTypeBadges typeTags={item.typeTags} primaryType={item.type} />
              <span
                onClick={() => navigateToTrackerItem(item.id)}
                style={{
                  fontSize: '11px',
                  color: 'var(--nim-text-muted)',
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--nim-primary)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--nim-text-muted)'; }}
              >
                {item.title}
              </span>
              {item.status && <StatusBadge status={item.status} />}
              {item.priority && <PriorityBadge priority={item.priority} />}
            </div>
          ))}
        </div>
      )}
    </WidgetShell>
  );
};

const RetrievedView: React.FC<{ data: StructuredRetrieved }> = ({ data }) => {
  const { item } = data;
  return (
    <WidgetShell
      header={
        <>
          <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>Tracker Item</span>
          <span style={{ flex: 1 }} />
          <TypeBadge type={item.type} />
        </>
      }
    >
      <Row>
        <Label>Title</Label>
        <ClickableTitle title={item.title} itemId={item.id} />
      </Row>
      <Row>
        <Label>Status</Label>
        {item.status && <StatusBadge status={item.status} />}
        {item.priority && (
          <>
            <span style={{ width: '12px' }} />
            <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontWeight: 500 }}>Priority</span>
            <PriorityBadge priority={item.priority} />
          </>
        )}
      </Row>
      {Array.isArray(item.tags) && item.tags.length > 0 && (
        <Row>
          <Label>Tags</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
            {item.tags.map((t) => <TagPill key={t} tag={t} variant="kept" />)}
          </div>
        </Row>
      )}
      {item.owner && (
        <Row>
          <Label>Owner</Label>
          <span style={{ fontSize: '11px', color: 'var(--nim-text-muted)' }}>{item.owner}</span>
        </Row>
      )}
    </WidgetShell>
  );
};

const LinkedView: React.FC<{ data: StructuredLinked }> = ({ data }) => (
  <WidgetShell
    header={
      <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>Tracker Linked</span>
    }
  >
    <Row>
      <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)' }}>Linked to</span>
      <TypeBadge type={data.type} />
      <ClickableTitle title={data.title} itemId={data.trackerId} />
      <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)' }}>
        ({data.linkedCount} session{data.linkedCount !== 1 ? 's' : ''})
      </span>
    </Row>
  </WidgetShell>
);

const LinkedFileView: React.FC<{ data: StructuredLinkedFile }> = ({ data }) => (
  <WidgetShell
    header={
      <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>File Linked</span>
    }
  >
    <Row>
      <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)' }}>Linked</span>
      <span style={{ fontSize: '11px', color: 'var(--nim-text-muted)', fontFamily: 'monospace' }}>
        {data.filePath}
      </span>
      <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)' }}>
        ({data.linkedCount} total link{data.linkedCount !== 1 ? 's' : ''})
      </span>
    </Row>
  </WidgetShell>
);

// ---------- Fallback for old text results ----------

function getBaseName(toolName: string): string {
  return toolName.replace(/^mcp__[^_]+__/, '');
}

function getToolLabel(toolName: string): string {
  const base = getBaseName(toolName);
  switch (base) {
    case 'tracker_list': return 'Tracker List';
    case 'tracker_get': return 'Tracker Get';
    case 'tracker_create': return 'Tracker Create';
    case 'tracker_update': return 'Tracker Update';
    case 'tracker_link_session': return 'Tracker Link';
    case 'tracker_link_file': return 'File Link';
    default: return 'Tracker';
  }
}

const FallbackView: React.FC<{ toolName: string; resultText: string | null; args: Record<string, any> }> = ({
  toolName,
  resultText,
  args,
}) => {
  const label = getToolLabel(toolName);

  if (!resultText) {
    // Pending state
    return (
      <div
        style={{
          border: '1px solid var(--nim-border)',
          borderRadius: '6px',
          overflow: 'hidden',
          fontSize: '11px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '5px 10px',
            background: 'var(--nim-bg-tertiary)',
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>{label}</span>
          {args.type && <TypeBadge type={args.type} />}
          {args.title && (
            <span style={{ color: 'var(--nim-text-muted)', fontSize: '10px' }}>{args.title}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <WidgetShell
      header={
        <>
          <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>{label}</span>
          {args.type && <TypeBadge type={args.type} />}
        </>
      }
    >
      <div
        style={{
          color: 'var(--nim-text-muted)',
          fontSize: '10px',
          whiteSpace: 'pre-wrap',
          maxHeight: '200px',
          overflowY: 'auto',
          lineHeight: '1.5',
        }}
      >
        {resultText}
      </div>
    </WidgetShell>
  );
};

// ---------- Main widget ----------

export const TrackerToolWidget: React.FC<CustomToolWidgetProps> = ({ message }) => {
  const tool = message.toolCall;
  if (!tool) return null;

  const args = (tool.arguments || {}) as Record<string, any>;
  const isError = (tool.result as any)?.isError === true;

  // Try structured JSON first
  const parsed = extractStructured(tool);
  if (parsed && !isError) {
    const { structured } = parsed;
    switch (structured.action) {
      case 'created':
        return <CreatedView data={structured} />;
      case 'updated':
        return <UpdatedView data={structured} />;
      case 'listed':
        return <ListedView data={structured} />;
      case 'retrieved':
        return <RetrievedView data={structured} />;
      case 'linked':
        return <LinkedView data={structured} />;
      case 'linked_file':
        return <LinkedFileView data={structured} />;
    }
  }

  // Error state
  const resultText = getResultText(tool.result);
  if (isError) {
    const label = getToolLabel(tool.toolName);
    return (
      <div
        style={{
          border: '1px solid rgba(248,113,113,0.3)',
          borderRadius: '6px',
          overflow: 'hidden',
          fontSize: '11px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '5px 10px',
            background: 'rgba(248,113,113,0.08)',
            borderBottom: '1px solid rgba(248,113,113,0.15)',
          }}
        >
          <span style={{ fontWeight: 600, color: '#f87171' }}>{label}</span>
        </div>
        <div style={{ padding: '6px 10px', color: '#f87171', fontSize: '10px' }}>
          {resultText}
        </div>
      </div>
    );
  }

  // Fallback: plain text for old sessions
  return <FallbackView toolName={tool.toolName} resultText={resultText} args={args} />;
};

TrackerToolWidget.displayName = 'TrackerToolWidget';
