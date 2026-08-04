import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import { reasonChipLabel } from './inboxViewModel';
import type { InboxRowView } from './inboxTypes';

/**
 * One delivery row.
 *
 * Two lines, in the order a reader triages: what kind of thing this is and
 * where it lives, then who said what. The delivery reason — the least varied
 * field on the surface, and the loudest thing on the old four-line row — is a
 * chip now, and only for the reasons that are not already implied by the type
 * icon or the Follows filter.
 *
 * Renders only what `toRowView` allowed through, so an unavailable row cannot
 * leak its former source no matter what this component asks for.
 */
export function InboxRow({
  row,
  selected,
  onSelect,
  onOpen,
  onDismiss,
}: {
  row: InboxRowView;
  selected: boolean;
  /** A plain click. Never navigates. */
  onSelect: (row: InboxRowView) => void;
  /** Enter or a double click. Navigates and consumes read state on success. */
  onOpen: (row: InboxRowView) => void;
  onDismiss: (row: InboxRowView) => void;
}) {
  const unavailable = row.availability !== 'available';
  const chip = reasonChipLabel(row.reason);
  const emphasized = row.reason === 'mention' || row.reason === 'agentMention';

  return (
    <div
      className={`inbox-row group relative flex cursor-pointer items-start gap-2.5 border-b border-[var(--nim-border)] py-2 pl-2.5 pr-3 text-left last:border-b-0 ${
        selected
          ? 'bg-[var(--nim-bg-selected)] shadow-[inset_2px_0_0_var(--nim-primary)]'
          : row.unread
            ? 'bg-[var(--nim-bg-hover)] hover:bg-[var(--nim-bg-active)]'
            : 'bg-transparent hover:bg-[var(--nim-bg-hover)]'
      }`}
      data-testid={`inbox-row-${row.id}`}
      data-availability={row.availability}
      data-reason={row.reason}
      data-source-kind={row.sourceKind}
      data-item-type={row.itemType}
      data-unread={row.unread ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={() => onSelect(row)}
      onDoubleClick={() => onOpen(row)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onOpen(row);
          return;
        }
        if (event.key === ' ') {
          event.preventDefault();
          onSelect(row);
        }
      }}
    >
      <span
        className={`inbox-row-unread-marker mt-2 size-2 shrink-0 rounded-full ${
          row.unread ? 'bg-[var(--nim-primary)]' : 'bg-transparent'
        }`}
        data-testid={row.unread ? 'inbox-row-unread-marker' : undefined}
        aria-label={row.unread ? 'Unread' : undefined}
      />

      <span
        className="inbox-row-type-icon mt-px flex size-6 shrink-0 items-center justify-center rounded-md"
        style={{
          backgroundColor: `color-mix(in srgb, ${row.type.accent} 16%, transparent)`,
          color: row.type.accent,
        }}
        data-testid="inbox-row-type-icon"
      >
        <MaterialSymbol icon={row.type.icon} size={14} />
      </span>

      <div className="inbox-row-body min-w-0 flex-1">
        <div className="inbox-row-headline flex min-w-0 items-center gap-2">
          <span
            className="inbox-row-type-label shrink-0 text-[11px] font-bold uppercase tracking-wide"
            style={{ color: row.type.accent }}
            data-testid="inbox-row-type-label"
          >
            {row.type.label}
          </span>

          {chip && (
            <span
              className={`inbox-row-reason-chip shrink-0 rounded px-1.5 text-[10px] font-bold uppercase tracking-wide ${
                emphasized
                  ? 'bg-[color-mix(in_srgb,var(--nim-primary)_20%,transparent)] text-[var(--nim-primary)]'
                  : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]'
              }`}
              data-testid="inbox-row-reason-chip"
            >
              {chip}
            </span>
          )}

          <span className={`inbox-row-where min-w-0 truncate text-[13px] ${
            row.unread ? 'font-semibold text-[var(--nim-text)]' : 'text-[var(--nim-text-muted)]'
          }`}
          >
            {row.sourceTitle ?? (unavailable ? '' : row.orgName)}
            {row.sourceTitle && (
              <span className="inbox-row-where-context text-[var(--nim-text-faint)]">
                {' · '}
                {row.projectName ? `${row.orgName} / ${row.projectName}` : row.orgName}
              </span>
            )}
          </span>

          {row.subscription === 'muted' && (
            <span className="inbox-row-muted shrink-0 text-[var(--nim-text-faint)]" title="Muted">
              <MaterialSymbol icon="notifications_off" size={12} />
            </span>
          )}

          <span className="inbox-row-timestamp ml-auto shrink-0 pl-2 text-[11px] text-[var(--nim-text-faint)] group-hover:invisible">
            {row.timestampLabel}
          </span>
        </div>

        <div className="inbox-row-detail mt-0.5 flex min-w-0 items-center gap-1.5">
          {row.actor && (
            <>
              {row.actor.kind === 'agent'
                ? (
                  <span
                    className="inbox-row-agent-glyph flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-[color-mix(in_srgb,var(--nim-primary)_18%,transparent)] text-[var(--nim-primary)]"
                    data-testid="inbox-row-agent-glyph"
                    aria-label="Agent"
                  >
                    <MaterialSymbol icon="smart_toy" size={11} />
                  </span>
                )
                : (
                  <span className="inbox-row-actor-avatar flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--nim-bg-active)] text-[8px] font-semibold text-[var(--nim-text-muted)]">
                    {row.actor.displayName.slice(0, 1).toUpperCase()}
                  </span>
                )}
              <span className={`inbox-row-actor shrink-0 truncate text-[12px] ${
                row.unread ? 'text-[var(--nim-text)]' : 'text-[var(--nim-text-muted)]'
              }`}
              >
                {row.actor.displayName}
              </span>
              {row.actor.onBehalfOfDisplayName && (
                <span className="inbox-row-actor-owner shrink-0 text-[11px] text-[var(--nim-text-faint)]">
                  for {row.actor.onBehalfOfDisplayName}
                </span>
              )}
              {row.actor.pending && (
                <span
                  className="inbox-row-agent-pending flex shrink-0 items-center gap-1 rounded bg-[var(--nim-bg-tertiary)] px-1.5 text-[10px] text-[var(--nim-text-muted)]"
                  data-testid="inbox-row-agent-pending"
                  title="Dispatched to your agent; waiting for the session to pick it up"
                >
                  <MaterialSymbol icon="hourglass_top" size={10} /> Pending
                </span>
              )}
            </>
          )}

          {unavailable
            ? (
              <span
                className="inbox-row-unavailable flex items-center gap-1.5 text-[12px] italic text-[var(--nim-text-faint)]"
                data-testid="inbox-row-unavailable"
              >
                <MaterialSymbol icon="lock" size={12} />
                {row.unavailableLabel}
              </span>
            )
            : row.preview
              ? (
                <span className="inbox-row-preview min-w-0 select-text truncate text-[12px] text-[var(--nim-text-muted)]">
                  {row.previewStale && (
                    <span
                      className="inbox-row-stale-label mr-1.5 rounded bg-[var(--nim-bg-tertiary)] px-1 py-px text-[10px] uppercase tracking-wide text-[var(--nim-text-faint)]"
                      data-testid="inbox-row-stale-label"
                    >
                      Stale
                    </span>
                  )}
                  {row.preview}
                </span>
              )
              : null}

          {row.readOnlyReason && (
            <span
              className="inbox-row-read-only shrink-0 text-[var(--nim-text-faint)]"
              title="Read-only"
            >
              <MaterialSymbol icon="visibility_lock" size={12} />
            </span>
          )}
        </div>
      </div>

      <div className="inbox-row-actions absolute right-2 top-1.5 hidden items-center gap-0.5 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-selected)] p-0.5 group-focus-within:flex group-hover:flex">
        {!unavailable && (
          <button
            type="button"
            className="inbox-row-open rounded p-1 text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-active)] hover:text-[var(--nim-text)]"
            data-testid={`inbox-row-open-${row.id}`}
            aria-label="Open"
            title="Open (Enter)"
            onClick={(event) => { event.stopPropagation(); onOpen(row); }}
          >
            <MaterialSymbol icon="open_in_new" size={14} />
          </button>
        )}
        {row.dismissible && (
          <button
            type="button"
            className="inbox-row-dismiss rounded p-1 text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-active)] hover:text-[var(--nim-text)]"
            data-testid={`inbox-row-dismiss-${row.id}`}
            aria-label="Dismiss"
            title="Dismiss"
            onClick={(event) => { event.stopPropagation(); onDismiss(row); }}
          >
            <MaterialSymbol icon="close" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
