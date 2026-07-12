/**
 * TrackerReferenceChip — inline chip rendered by `TrackerReferenceNode`.
 *
 * Shows the reference key + a colored status dot + the item's LIVE title,
 * resolved from the canonical runtime tracker store. Clicking opens a hover-card
 * preview popover (floating-ui) with a "Go to item" action.
 *
 * When the key can't be resolved, it degrades to a muted chip showing just the
 * key — it never throws and never blocks rendering.
 */

import * as React from 'react';
import {
  useFloating,
  offset,
  flip,
  shift,
  autoUpdate,
  FloatingPortal,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
} from '@floating-ui/react';

import {
  useResolvedTrackerReference,
  navigateToTrackerReference,
  type ResolvedTrackerReference,
} from './trackerReferenceData';
import {
  formatRelativeDate,
  getPriorityColor,
  getStatusColor,
  getTypeColor,
  getTypeIcon,
} from '../TrackerPlugin/components/trackerColumns';

// Status palette mirrors the tracker-mode board (KanbanBoard / TrackerItemDetail).
// Kept inline here because the chip lives in the platform-agnostic runtime and
// must not import renderer components.
const STATUS_COLORS: Record<string, string> = {
  'to-do': '#6b7280',
  'in-progress': '#eab308',
  'in-review': '#8b5cf6',
  done: '#22c55e',
  completed: '#22c55e',
  implemented: '#22c55e',
  decided: '#22c55e',
  blocked: '#ef4444',
  rejected: '#ef4444',
  superseded: '#6b7280',
  proposed: '#60a5fa',
  'in-discussion': '#60a5fa',
  "won't-fix": '#6b7280',
  'wont-fix': '#6b7280',
};

const UNRESOLVED_COLOR = 'var(--nim-text-faint)';

// These statuses represent successfully finished work across the built-in
// tracker types. Other terminal states (rejected, superseded, won't-fix) keep
// their own status color without presenting the item as completed.
const COMPLETED_STATUSES = new Set([
  'done',
  'completed',
  'implemented',
  'decided',
]);

function normalizeStatus(status: string | undefined): string | undefined {
  return status?.trim().toLowerCase();
}

function statusColor(status: string | undefined): string {
  const normalizedStatus = normalizeStatus(status);
  if (!normalizedStatus) return UNRESOLVED_COLOR;
  return STATUS_COLORS[normalizedStatus] ?? 'var(--nim-text-muted)';
}

function displayLabel(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface MetadataBadgeProps {
  color: string;
  icon?: string;
  label: string;
  className: string;
}

function MetadataBadge({
  color,
  icon,
  label,
  className,
}: MetadataBadgeProps): JSX.Element {
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        minHeight: '22px',
        padding: '1px 7px',
        borderRadius: '999px',
        border: `1px solid ${color}40`,
        background: `${color}18`,
        color,
        fontSize: '10px',
        fontWeight: 600,
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
      }}
    >
      {icon ? (
        <span
          className="material-symbols-outlined"
          aria-hidden="true"
          style={{ fontSize: '13px', lineHeight: 1 }}
        >
          {icon}
        </span>
      ) : (
        <span
          aria-hidden="true"
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
          }}
        />
      )}
      {label}
    </span>
  );
}

export interface TrackerReferenceChipProps {
  referenceKey: string;
  nodeKey?: string;
  /** Compact chips omit the live title while retaining preview and navigation. */
  variant?: 'default' | 'compact';
}

export function TrackerReferenceChip({
  referenceKey,
  variant = 'default',
}: TrackerReferenceChipProps): JSX.Element {
  const resolved = useResolvedTrackerReference(referenceKey);
  const [open, setOpen] = React.useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const color = statusColor(resolved?.status);
  const normalizedStatus = normalizeStatus(resolved?.status);
  const isCompleted = normalizedStatus
    ? COMPLETED_STATUSES.has(normalizedStatus)
    : false;
  const label = resolved?.issueKey ?? referenceKey;
  const title = resolved?.title;
  const tooltip = resolved
    ? `${label}${resolved.status ? ` · ${resolved.status}` : ''}${
        resolved.title ? ` — ${resolved.title}` : ''
      }`
    : `${label} (not resolved)`;

  return (
    <>
      <span
        ref={refs.setReference}
        {...getReferenceProps()}
        className="tracker-reference-chip"
        data-issue-key={referenceKey}
        data-resolved={resolved ? 'true' : 'false'}
        data-status={normalizedStatus}
        data-completed={isCompleted ? 'true' : 'false'}
        title={tooltip}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '0 6px',
          borderRadius: '10px',
          fontSize: '0.85em',
          lineHeight: '1.5',
          verticalAlign: 'baseline',
          cursor: 'pointer',
          background: 'var(--nim-bg-secondary)',
          border: '1px solid var(--nim-border)',
          whiteSpace: 'nowrap',
          userSelect: 'none',
        }}
      >
        <span
          className="tracker-reference-chip-dot"
          aria-hidden="true"
          style={{
            width: isCompleted ? '13px' : '7px',
            height: isCompleted ? '13px' : '7px',
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
            color: '#fff',
            fontSize: '10px',
            fontWeight: 700,
            lineHeight: isCompleted ? '13px' : '7px',
            textAlign: 'center',
          }}
        >
          {isCompleted ? '✓' : null}
        </span>
        <span
          className="tracker-reference-chip-key"
          style={{
            fontWeight: 600,
            color: isCompleted ? 'var(--nim-text-muted)' : 'var(--nim-text)',
            textDecoration: isCompleted ? 'line-through' : undefined,
          }}
        >
          {label}
        </span>
        {title && variant === 'default' ? (
          <span
            className="tracker-reference-chip-title"
            style={{
              color: 'var(--nim-text-muted)',
              maxWidth: '40ch',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              textDecoration: isCompleted ? 'line-through' : undefined,
            }}
          >
            {title}
          </span>
        ) : null}
      </span>
      {open ? (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="tracker-reference-preview"
          >
            <TrackerReferencePreview
              referenceKey={referenceKey}
              resolved={resolved}
              onGoTo={() => {
                if (resolved) {
                  navigateToTrackerReference(resolved);
                }
                setOpen(false);
              }}
            />
          </div>
        </FloatingPortal>
      ) : null}
    </>
  );
}

interface TrackerReferencePreviewProps {
  referenceKey: string;
  resolved: ResolvedTrackerReference | null;
  onGoTo: () => void;
}

function TrackerReferencePreview({
  referenceKey,
  resolved,
  onGoTo,
}: TrackerReferencePreviewProps): JSX.Element {
  const typeColor = resolved?.type
    ? getTypeColor(resolved.type)
    : 'var(--nim-text-muted)';
  const resolvedStatusColor = resolved?.status
    ? getStatusColor(
        normalizeStatus(resolved.status) ?? resolved.status,
        resolved.type,
      )
    : 'var(--nim-text-muted)';
  const priorityColor = getPriorityColor(resolved?.priority);
  const updatedDate = resolved?.updatedAt
    ? new Date(resolved.updatedAt)
    : undefined;
  const updatedLabel =
    updatedDate && !Number.isNaN(updatedDate.getTime())
      ? formatRelativeDate(updatedDate)
      : '';

  return (
    <div
      style={{
        width: 'min(340px, calc(100vw - 24px))',
        padding: '12px',
        borderRadius: '10px',
        background: 'var(--nim-bg)',
        border: '1px solid var(--nim-border)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        fontSize: '12px',
        color: 'var(--nim-text)',
        zIndex: 1000,
      }}
    >
      {resolved ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '7px',
            }}
          >
            <span
              style={{
                color: 'var(--nim-text-faint)',
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {resolved.issueKey ?? referenceKey}
            </span>
          </div>
          <div
            style={{
              marginBottom: '10px',
              fontSize: '14px',
              fontWeight: 550,
              lineHeight: 1.35,
            }}
          >
            {resolved.title}
          </div>
          <div
            className="tracker-reference-preview-badges"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px',
              marginBottom: '12px',
            }}
          >
            {resolved.type ? (
              <MetadataBadge
                className="tracker-reference-preview-type"
                color={typeColor}
                icon={getTypeIcon(resolved.type)}
                label={displayLabel(resolved.type)}
              />
            ) : null}
            {resolved.status ? (
              <MetadataBadge
                className="tracker-reference-preview-status"
                color={resolvedStatusColor}
                label={displayLabel(resolved.status)}
              />
            ) : null}
            {resolved.priority ? (
              <MetadataBadge
                className="tracker-reference-preview-priority"
                color={priorityColor}
                icon="flag"
                label={`${displayLabel(resolved.priority)} priority`}
              />
            ) : null}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              paddingTop: '10px',
              borderTop: '1px solid var(--nim-border)',
            }}
          >
            <div
              className="tracker-reference-preview-updated"
              title={updatedDate?.toLocaleString()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--nim-text-faint)',
                fontSize: '10px',
              }}
            >
              <span
                className="material-symbols-outlined"
                aria-hidden="true"
                style={{ fontSize: '13px' }}
              >
                schedule
              </span>
              {updatedLabel
                ? `Updated ${updatedLabel}`
                : 'Update time unavailable'}
              {resolved.owner ? ` · ${resolved.owner}` : ''}
            </div>
            <button
              type="button"
              onClick={onGoTo}
              style={{
                marginLeft: 'auto',
                flexShrink: 0,
                fontSize: '11px',
                fontWeight: 600,
                padding: '5px 10px',
                borderRadius: '6px',
                border: '1px solid var(--nim-border)',
                background: 'var(--nim-bg-secondary)',
                color: 'var(--nim-text)',
                cursor: 'pointer',
              }}
            >
              Go to item
            </button>
          </div>
        </>
      ) : (
        <div style={{ color: 'var(--nim-text-muted)' }}>
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>
            {referenceKey}
          </div>
          <div>This tracker item couldn’t be resolved in this workspace.</div>
        </div>
      )}
    </div>
  );
}
