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

const UNRESOLVED_COLOR = 'var(--nim-text-faint, #9ca3af)';

function statusColor(status: string | undefined): string {
  if (!status) return UNRESOLVED_COLOR;
  return STATUS_COLORS[status] ?? 'var(--nim-text-muted, #6b7280)';
}

interface TrackerReferenceChipProps {
  referenceKey: string;
  nodeKey?: string;
}

export function TrackerReferenceChip({
  referenceKey,
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
          background: 'var(--nim-surface-secondary, rgba(127,127,127,0.12))',
          border: '1px solid var(--nim-border, rgba(127,127,127,0.25))',
          whiteSpace: 'nowrap',
          userSelect: 'none',
        }}
      >
        <span
          className="tracker-reference-chip-dot"
          style={{
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
          }}
        />
        <span
          className="tracker-reference-chip-key"
          style={{ fontWeight: 600, color: 'var(--nim-text, inherit)' }}
        >
          {label}
        </span>
        {title ? (
          <span
            className="tracker-reference-chip-title"
            style={{
              color: 'var(--nim-text-muted, #6b7280)',
              maxWidth: '18ch',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
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
  return (
    <div
      style={{
        minWidth: '220px',
        maxWidth: '320px',
        padding: '10px 12px',
        borderRadius: '8px',
        background: 'var(--nim-surface, #2d2d2d)',
        border: '1px solid var(--nim-border, rgba(127,127,127,0.3))',
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        fontSize: '12px',
        color: 'var(--nim-text, #e5e5e5)',
        zIndex: 1000,
      }}
    >
      {resolved ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              marginBottom: '4px',
            }}
          >
            <span
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: statusColor(resolved.status),
                flexShrink: 0,
              }}
            />
            <span style={{ fontWeight: 600 }}>
              {resolved.issueKey ?? referenceKey}
            </span>
            {resolved.status ? (
              <span style={{ color: 'var(--nim-text-muted, #9ca3af)' }}>
                {resolved.status}
              </span>
            ) : null}
          </div>
          <div style={{ marginBottom: '8px' }}>{resolved.title}</div>
          <div
            style={{
              display: 'flex',
              gap: '8px',
              color: 'var(--nim-text-faint, #9ca3af)',
              marginBottom: '8px',
            }}
          >
            {resolved.type ? <span>{resolved.type}</span> : null}
            {resolved.priority ? <span>· {resolved.priority}</span> : null}
            {resolved.owner ? <span>· {resolved.owner}</span> : null}
          </div>
          <button
            type="button"
            onClick={onGoTo}
            style={{
              fontSize: '12px',
              padding: '4px 10px',
              borderRadius: '6px',
              border: '1px solid var(--nim-border, rgba(127,127,127,0.3))',
              background: 'var(--nim-surface-secondary, rgba(127,127,127,0.12))',
              color: 'var(--nim-text, inherit)',
              cursor: 'pointer',
            }}
          >
            Go to item
          </button>
        </>
      ) : (
        <div style={{ color: 'var(--nim-text-muted, #9ca3af)' }}>
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>
            {referenceKey}
          </div>
          <div>This tracker item couldn’t be resolved in this workspace.</div>
        </div>
      )}
    </div>
  );
}
