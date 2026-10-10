/**
 * TrackerReferenceChip — inline chip rendered by `TrackerReferenceNode`.
 *
 * Shows the item's type, reference key, LIVE title, workflow state, and owner,
 * resolved from the canonical runtime tracker store. Clicking opens a hover-card
 * preview popover (floating-ui) with a "Go to item" action. Inside a typed
 * page's body (see `trackerReferenceSource.ts`) hovering opens it too, and the
 * card offers the named relations allowed between the two types.
 *
 * When the key can't be resolved, it degrades to a muted chip showing just the
 * key — it never throws and never blocks rendering.
 */

import type { JSX, MouseEvent as ReactMouseEvent } from 'react';
import * as React from 'react';
import {
  useFloating,
  offset,
  flip,
  shift,
  autoUpdate,
  FloatingPortal,
  useClick,
  useHover,
  safePolygon,
  useDismiss,
  useRole,
  useInteractions,
} from '@floating-ui/react';
import { windowControlsClearance } from '../../ui/floating/windowControlsClearance';
import {
  globalRegistry,
  resolveKnownStatusCategory,
  type StatusCategory,
} from '@nimbalyst/tracker-schema';
import { LexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey } from 'lexical';

import { $isTrackerReferenceNode } from './TrackerReferenceNodeCore';
import {
  TrackerReferenceRelationMenu,
  trackerReferenceRelationLabel,
  trackerReferenceRelationOptions,
} from './TrackerReferenceRelationMenu';
import { useTrackerReferenceSource } from './trackerReferenceSource';

import {
  useResolvedTrackerReference,
  navigateToTrackerReference,
  type ResolvedTrackerReference,
} from './trackerReferenceData';
import {
  getTypeColor,
  getTypeIcon,
  getInitials,
} from '../TrackerPlugin/components/trackerColumns';
import { TrackerReferencePreview, displayLabel, normalizeStatus } from './TrackerReferencePreview';

type StatusTone =
  | 'to-do'
  | 'in-progress'
  | 'in-review'
  | 'completed'
  | 'blocked'
  | 'informational'
  | 'neutral';

interface StatusPresentation {
  color: string;
  background: string;
  border: string;
  icon?: string;
  label: string;
  tone: StatusTone;
}

const STATUS_TONES: Record<
  StatusTone,
  Omit<StatusPresentation, 'label' | 'tone'>
> = {
  'to-do': {
    color: 'var(--nim-text-muted)',
    background: 'var(--nim-bg-tertiary)',
    border: 'var(--nim-border)',
  },
  'in-progress': {
    color: 'var(--nim-warning)',
    background: 'color-mix(in srgb, var(--nim-warning) 12%, transparent)',
    border: 'color-mix(in srgb, var(--nim-warning) 40%, var(--nim-border))',
  },
  'in-review': {
    color: 'var(--nim-purple)',
    background: 'color-mix(in srgb, var(--nim-purple) 12%, transparent)',
    border: 'color-mix(in srgb, var(--nim-purple) 40%, var(--nim-border))',
  },
  completed: {
    color: 'var(--nim-success)',
    background: 'color-mix(in srgb, var(--nim-success) 12%, transparent)',
    border: 'color-mix(in srgb, var(--nim-success) 40%, var(--nim-border))',
    icon: 'check',
  },
  blocked: {
    color: 'var(--nim-error)',
    background: 'color-mix(in srgb, var(--nim-error) 12%, transparent)',
    border: 'color-mix(in srgb, var(--nim-error) 40%, var(--nim-border))',
  },
  informational: {
    color: 'var(--nim-info)',
    background: 'color-mix(in srgb, var(--nim-info) 12%, transparent)',
    border: 'color-mix(in srgb, var(--nim-info) 40%, var(--nim-border))',
  },
  neutral: {
    color: 'var(--nim-text-muted)',
    background: 'var(--nim-bg-tertiary)',
    border: 'var(--nim-border)',
  },
};

/**
 * Overrides for statuses whose tone the lifecycle category cannot express.
 *
 * `in-review` and `blocked` are both `started`, but a reviewer and a blockage
 * are not the same news, so they keep their own colours. Everything the category
 * DOES express -- finished, abandoned, not begun -- is deliberately absent:
 * listing `done` here but not `completed` is precisely how a plan's closing
 * status ended up rendering as neutral.
 */
const STATUS_TONE_BY_VALUE: Record<string, StatusTone> = {
  'in-review': 'in-review',
  blocked: 'blocked',
  proposed: 'informational',
  'in-discussion': 'informational',
};

// Transcript markdown can remount a link renderer during routine message
// updates while preserving the outer message row. Scope open cards to that
// stable host and a per-reference key so they survive the child remount without
// leaking across messages or duplicate references.
const previewOpenKeysByHost = new WeakMap<HTMLElement, Set<string>>();

/** Tone for a status the type's schema categorises. */
const TONE_BY_CATEGORY: Record<StatusCategory, StatusTone> = {
  backlog: 'to-do',
  unstarted: 'to-do',
  started: 'in-progress',
  done: 'completed',
  cancelled: 'neutral',
};

function getStatusPresentation(
  normalizedStatus: string | undefined,
  type: string | undefined,
): StatusPresentation | null {
  if (!normalizedStatus) return null;
  // The per-value table still wins where it says something the category cannot:
  // `in-review` and `blocked` are both `started`, but they deserve their own
  // colours. Everything else derives from the schema, so a type that closes on
  // `completed` or `implemented` reads as finished without being listed here.
  //
  // Deliberately the KNOWN category, not the resolved one: a status this install
  // has never heard of stays neutral. Painting it as in-progress would state
  // something about it that nobody has said.
  const category = resolveKnownStatusCategory(type ?? '', normalizedStatus);
  const tone = STATUS_TONE_BY_VALUE[normalizedStatus]
    ?? (category ? TONE_BY_CATEGORY[category] : 'neutral');
  return {
    ...STATUS_TONES[tone],
    label: displayLabel(normalizedStatus),
    tone,
  };
}

export interface TrackerReferenceChipProps {
  referenceKey: string;
  nodeKey?: string;
  /** Predicate id of the relation the link states; null for a plain link. */
  relation?: string | null;
  /** Stable per-renderer identity used to preserve an open transcript card. */
  previewStateKey?: string;
  /** Compact chips omit the live title while retaining preview and navigation. */
  variant?: 'default' | 'compact';
  /** Host-provided label while this renderer has no local tracker record. */
  unresolvedLabel?: string;
  /**
   * Host navigation override.
   *
   * Dedicated windows without a local tracker store use this to hand the
   * reference back to the desktop router. Receiving `null` is intentional:
   * the host can still route the stable reference key to the owning workspace.
   */
  onNavigate?: (resolved: ResolvedTrackerReference | null) => void;
}

export function TrackerReferenceChip({
  referenceKey,
  nodeKey,
  relation = null,
  previewStateKey,
  variant = 'default',
  unresolvedLabel,
  onNavigate,
}: TrackerReferenceChipProps): JSX.Element {
  const resolved = useResolvedTrackerReference(referenceKey);
  const source = useTrackerReferenceSource();
  const editor = React.useContext(LexicalComposerContext)?.[0] ?? null;
  const [open, setOpen] = React.useState(false);
  const referenceHostRef = React.useRef<HTMLElement | null>(null);
  const openStateKey = previewStateKey ?? nodeKey ?? referenceKey;
  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    const host = referenceHostRef.current;
    if (host) {
      let openKeys = previewOpenKeysByHost.get(host);
      if (nextOpen) {
        if (!openKeys) {
          openKeys = new Set();
          previewOpenKeysByHost.set(host, openKeys);
        }
        openKeys.add(openStateKey);
      } else if (openKeys) {
        openKeys.delete(openStateKey);
      }
    }
  }, [openStateKey]);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: handleOpenChange,
    placement: 'bottom-start',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  // Hover only inside a typed page, where the card is where a link's relation
  // is chosen; elsewhere the preview stays click-to-open.
  const hover = useHover(context, {
    enabled: source !== null,
    delay: { open: 350, close: 150 },
    handleClose: safePolygon(),
  });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    hover,
    dismiss,
    role,
  ]);
  const setReference = React.useCallback(
    (node: HTMLElement | null) => {
      refs.setReference(node);
      if (!node) return;

      const host =
        (node.closest(
          '.tracker-reference, .rich-transcript-message',
        ) as HTMLElement | null) ?? node;
      referenceHostRef.current = host;
      if (previewOpenKeysByHost.get(host)?.has(openStateKey)) {
        setOpen(true);
      }
    },
    [openStateKey, refs],
  );

  const normalizedStatus = normalizeStatus(resolved?.status);
  const statusPresentation = getStatusPresentation(normalizedStatus, resolved?.type);
  const isCompleted = statusPresentation?.tone === 'completed';
  const label = resolved?.issueKey ?? unresolvedLabel ?? referenceKey;
  const title = resolved?.title;
  // The name is what a reader cares about, so it carries the weight. A type
  // with no key prefix falls back to the raw item id, which is never shown
  // inline; the key stays in the tooltip and the preview card.
  const showTitle = Boolean(title) && (variant === 'default' || !resolved?.issueKey);
  const showKey = !showTitle || Boolean(resolved?.issueKey);
  const typeColor = resolved?.type ? getTypeColor(resolved.type) : undefined;
  const typeIcon = resolved?.type ? getTypeIcon(resolved.type) : undefined;
  const ownerInitials = resolved?.owner
    ? getInitials(
        resolved.owner.includes('@')
          ? resolved.owner.split('@')[0]
          : resolved.owner,
      )
    : undefined;
  const tooltip = resolved
    ? `${label}${resolved.status ? ` · ${resolved.status}` : ''}${
        resolved.title ? ` — ${resolved.title}` : ''
      }`
    : `${label} (not resolved locally)`;
  const relationLabel = relation
    ? trackerReferenceRelationLabel(globalRegistry, relation)
    : undefined;

  let relationMenu: JSX.Element | null = null;
  if (open && source && resolved?.type && resolved.id !== source.itemId) {
    const canChoose = Boolean(editor && nodeKey && editor.isEditable());
    relationMenu = (
      <TrackerReferenceRelationMenu
        options={trackerReferenceRelationOptions(globalRegistry, source.type, resolved.type)}
        relation={relation}
        relationLabel={relationLabel}
        onChoose={
          canChoose && editor && nodeKey
            ? next => {
                editor.update(() => {
                  const node = $getNodeByKey(nodeKey);
                  if ($isTrackerReferenceNode(node)) node.setRelation(next);
                });
              }
            : undefined
        }
      />
    );
  }

  return (
    <>
      <span
        ref={setReference}
        {...getReferenceProps()}
        className="tracker-reference-chip"
        data-issue-key={referenceKey}
        data-resolved={resolved ? 'true' : 'false'}
        data-status={normalizedStatus}
        data-status-tone={statusPresentation?.tone}
        data-completed={isCompleted ? 'true' : 'false'}
        data-type={resolved?.type}
        data-owner={resolved?.owner}
        data-relation={relation ?? undefined}
        title={relationLabel ? `${relationLabel}: ${tooltip}` : tooltip}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          maxWidth: '100%',
          boxSizing: 'border-box',
          padding: '1px 6px',
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
        {typeIcon && typeColor ? (
          <span
            className="material-symbols-outlined tracker-reference-chip-type-icon"
            role="img"
            aria-label={`${displayLabel(resolved?.type ?? '')} item`}
            style={{
              color: typeColor,
              flexShrink: 0,
              fontSize: '15px',
              lineHeight: 1,
            }}
          >
            {typeIcon}
          </span>
        ) : null}
        {showKey ? (
          <span
            className="tracker-reference-chip-key"
            style={{
              flexShrink: 0,
              fontWeight: showTitle ? 400 : 700,
              color: showTitle ? 'var(--nim-text-muted)' : 'var(--nim-text)',
            }}
          >
            {label}
          </span>
        ) : null}
        {showTitle ? (
          <span
            className="tracker-reference-chip-title"
            style={{
              display: 'inline-block',
              minWidth: 0,
              maxWidth: '32ch',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              fontWeight: 600,
              color: 'var(--nim-text)',
              textDecoration: isCompleted ? 'line-through' : undefined,
            }}
          >
            {title}
          </span>
        ) : null}
        {statusPresentation ? (
          <span
            className="tracker-reference-chip-status"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '2px',
              flexShrink: 0,
              padding: '0 4px',
              borderRadius: '999px',
              border: `1px solid ${statusPresentation.border}`,
              background: statusPresentation.background,
              color: statusPresentation.color,
              fontSize: '10px',
              fontWeight: 600,
              lineHeight: '14px',
              whiteSpace: 'nowrap',
            }}
          >
            {statusPresentation.icon ? (
              <span
                className="material-symbols-outlined tracker-reference-chip-status-icon"
                aria-hidden="true"
                style={{ fontSize: '11px', lineHeight: 1 }}
              >
                {statusPresentation.icon}
              </span>
            ) : null}
            {statusPresentation.label}
          </span>
        ) : null}
        {ownerInitials ? (
          <span
            className="tracker-reference-chip-owner"
            aria-label={`Owner: ${resolved?.owner}`}
            title={resolved?.owner}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '18px',
              height: '18px',
              flexShrink: 0,
              borderRadius: '50%',
              border: '1px solid var(--nim-border)',
              background: 'var(--nim-bg-tertiary)',
              color: 'var(--nim-text-muted)',
              fontSize: '9px',
              fontWeight: 650,
              lineHeight: 1,
            }}
          >
            {ownerInitials}
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
              displayLabel={label}
              relationMenu={relationMenu}
              onGoTo={
                resolved || onNavigate
                  ? (event: ReactMouseEvent) => {
                      if (onNavigate) onNavigate(resolved);
                      else if (resolved) navigateToTrackerReference(resolved, { fromPage: true, newTab: event.metaKey || event.ctrlKey });
                      handleOpenChange(false);
                    }
                  : undefined
              }
              onOpenItem={
                onNavigate
                  ? undefined
                  : (itemId: string, event: ReactMouseEvent) => {
                      navigateToTrackerReference({ id: itemId }, { fromPage: true, newTab: event.metaKey || event.ctrlKey });
                      handleOpenChange(false);
                    }
              }
            />
          </div>
        </FloatingPortal>
      ) : null}
    </>
  );
}
