import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import type { InboxRowView } from './inboxTypes';

/**
 * One delivery row.
 *
 * Renders only what `toRowView` allowed through, so an unavailable row cannot
 * leak its former source no matter what this component asks for.
 */
export function InboxRow({
  row,
  selected,
  onActivate,
  onDismiss,
}: {
  row: InboxRowView;
  selected: boolean;
  onActivate: (row: InboxRowView) => void;
  onDismiss: (row: InboxRowView) => void;
}) {
  const unavailable = row.availability !== 'available';

  return (
    <div
      className={`inbox-row group relative flex cursor-pointer items-start gap-3 border-b border-[var(--nim-border)] px-4 py-3 text-left last:border-b-0 ${
        selected
          ? 'bg-[var(--nim-bg-selected)]'
          : 'bg-transparent hover:bg-[var(--nim-bg-hover)]'
      }`}
      data-testid={`inbox-row-${row.id}`}
      data-availability={row.availability}
      data-reason={row.reason}
      data-unread={row.unread ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={() => onActivate(row)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate(row);
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
        className={`inbox-row-source-icon mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md ${
          unavailable
            ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)]'
            : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]'
        }`}
      >
        <MaterialSymbol icon={row.sourceIcon} size={16} />
      </span>

      <div className="inbox-row-body min-w-0 flex-1">
        <div className="inbox-row-meta flex items-baseline gap-2">
          <span className={`inbox-row-reason truncate text-[11px] font-semibold uppercase tracking-wide ${
            row.reason === 'mention' || row.reason === 'agentMention'
              ? 'text-[var(--nim-primary)]'
              : 'text-[var(--nim-text-faint)]'
          }`}
          >
            {row.reasonLabel}
          </span>
          {row.subscription === 'muted' && (
            <span className="inbox-row-muted flex items-center gap-1 text-[11px] text-[var(--nim-text-faint)]" title="Muted">
              <MaterialSymbol icon="notifications_off" size={12} /> Muted
            </span>
          )}
          {row.subscription === 'following' && (
            <span className="inbox-row-following flex items-center gap-1 text-[11px] text-[var(--nim-text-faint)]" title="Following">
              <MaterialSymbol icon="visibility" size={12} /> Following
            </span>
          )}
          <span className="inbox-row-timestamp ml-auto shrink-0 text-[11px] text-[var(--nim-text-faint)]">
            {row.timestampLabel}
          </span>
        </div>

        <div className="inbox-row-headline mt-0.5 flex min-w-0 items-center gap-1.5">
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
              <span className="inbox-row-actor truncate text-[13px] font-medium text-[var(--nim-text)]">
                {row.actor.displayName}
              </span>
              {row.actor.onBehalfOfDisplayName && (
                <span className="inbox-row-actor-owner shrink-0 text-[12px] text-[var(--nim-text-faint)]">
                  for {row.actor.onBehalfOfDisplayName}
                </span>
              )}
              {row.actor.pending && (
                <span
                  className="inbox-row-agent-pending flex shrink-0 items-center gap-1 rounded-full bg-[var(--nim-bg-tertiary)] px-1.5 text-[10px] text-[var(--nim-text-muted)]"
                  data-testid="inbox-row-agent-pending"
                  title="Dispatched to your agent; waiting for the session to pick it up"
                >
                  <MaterialSymbol icon="hourglass_top" size={10} /> Pending
                </span>
              )}
            </>
          )}
          {row.sourceTitle && (
            <>
              {row.actor && <span className="text-[12px] text-[var(--nim-text-faint)]">in</span>}
              <span className="inbox-row-source-title truncate text-[13px] text-[var(--nim-text-muted)]">
                {row.sourceTitle}
              </span>
            </>
          )}
        </div>

        {unavailable
          ? (
            <p
              className="inbox-row-unavailable m-0 mt-1 flex items-center gap-1.5 text-[12px] italic text-[var(--nim-text-faint)]"
              data-testid="inbox-row-unavailable"
            >
              <MaterialSymbol icon="lock" size={12} />
              {row.unavailableLabel}
            </p>
          )
          : row.preview
            ? (
              <p className="inbox-row-preview m-0 mt-1 line-clamp-2 select-text text-[12px] leading-snug text-[var(--nim-text-muted)]">
                {row.previewStale && (
                  <span
                    className="inbox-row-stale-label mr-1.5 rounded bg-[var(--nim-bg-tertiary)] px-1 py-px text-[10px] uppercase tracking-wide text-[var(--nim-text-faint)]"
                    data-testid="inbox-row-stale-label"
                  >
                    Stale
                  </span>
                )}
                {row.preview}
              </p>
            )
            : null}

        {row.readOnlyReason && (
          <p className="inbox-row-read-only m-0 mt-1 flex items-center gap-1.5 text-[11px] text-[var(--nim-text-faint)]">
            <MaterialSymbol icon="visibility_lock" size={12} /> Read-only
          </p>
        )}

        <div className="inbox-row-footer mt-1 flex items-center gap-2 text-[11px] text-[var(--nim-text-faint)]">
          <span className="inbox-row-org">{row.orgName}</span>
          {row.projectName && (
            <>
              <span aria-hidden="true">·</span>
              <span className="inbox-row-project">{row.projectName}</span>
            </>
          )}
        </div>
      </div>

      {row.dismissible && (
        <button
          type="button"
          className="inbox-row-dismiss absolute right-2 top-2 rounded p-1 text-[var(--nim-text-faint)] opacity-0 hover:bg-[var(--nim-bg-active)] hover:text-[var(--nim-text)] focus:opacity-100 group-hover:opacity-100"
          data-testid={`inbox-row-dismiss-${row.id}`}
          aria-label="Dismiss"
          title="Dismiss"
          onClick={(event) => { event.stopPropagation(); onDismiss(row); }}
        >
          <MaterialSymbol icon="close" size={14} />
        </button>
      )}
    </div>
  );
}
