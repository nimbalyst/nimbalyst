import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import type { FeedbackListRowView, FeedbackListStatus } from './feedbackListModel';

const STATUS_CLASS: Record<FeedbackListStatus, string> = {
  open: 'bg-[color-mix(in_srgb,var(--nim-primary)_16%,transparent)] text-[var(--nim-primary)]',
  answered: 'bg-[color-mix(in_srgb,var(--nim-success)_16%,transparent)] text-[var(--nim-success)]',
  closed: 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]',
  expired: 'bg-[color-mix(in_srgb,var(--nim-warning)_16%,transparent)] text-[var(--nim-warning)]',
  cancelled: 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]',
};

/**
 * One request in the list.
 *
 * Pure: it renders a row view built by `feedbackListModel` and holds no state
 * of its own, so the list can re-derive every row from one index change without
 * anything here needing to subscribe.
 */
export function FeedbackRow({
  row,
  selected,
  onSelect,
}: {
  row: FeedbackListRowView;
  selected: boolean;
  onSelect: (requestId: string) => void;
}) {
  return (
    <button
      type="button"
      role="listitem"
      className={`feedback-row flex w-full items-start gap-2.5 border-b border-[var(--nim-border)] px-3 py-2.5 text-left ${
        selected
          ? 'bg-[color-mix(in_srgb,var(--nim-primary)_12%,transparent)] shadow-[inset_2px_0_0_var(--nim-primary)]'
          : 'hover:bg-[var(--nim-bg-hover)]'
      }`}
      data-testid="feedback-row"
      data-request-id={row.id}
      data-status={row.status}
      data-selected={selected || undefined}
      aria-current={selected || undefined}
      onClick={() => onSelect(row.id)}
    >
      <span className="feedback-row-glyph mt-px flex size-6 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--nim-purple)_16%,transparent)] text-[var(--nim-purple)]">
        <MaterialSymbol icon="ballot" size={14} />
      </span>
      <span className="feedback-row-body min-w-0 flex-1">
        <span className="feedback-row-headline flex min-w-0 items-center gap-2">
          <span
            className={`feedback-row-title min-w-0 flex-1 truncate text-[13px] ${
              row.dimmed
                ? 'font-normal text-[var(--nim-text-muted)]'
                : 'font-semibold text-[var(--nim-text)]'
            }`}
          >
            {row.title}
          </span>
          <span className="feedback-row-time shrink-0 text-[11px] text-[var(--nim-text-faint)]">
            {row.timeLabel}
          </span>
        </span>

        <span className="feedback-row-meta mt-1 flex flex-wrap items-center gap-2">
          <span className="feedback-row-author text-[12px] text-[var(--nim-text-muted)]">
            {row.authorLabel}
          </span>
          <span
            className={`feedback-row-status rounded-full px-2 text-[10px] font-bold uppercase leading-4 tracking-wide ${STATUS_CLASS[row.status]}`}
            data-testid="feedback-row-status"
          >
            {row.statusLabel}
          </span>
          <span className="feedback-row-progress flex items-center gap-1 text-[11px] text-[var(--nim-text-faint)]">
            <MaterialSymbol
              icon={row.awaitingFirstResponse ? 'schedule' : 'check'}
              size={11}
            />
            {row.progressLabel}
          </span>
          {row.needsViewerResponse && (
            <span
              className="feedback-row-needs-response rounded-full bg-[color-mix(in_srgb,var(--nim-primary)_18%,transparent)] px-2 text-[10px] font-semibold leading-4 text-[var(--nim-primary)]"
              data-testid="feedback-row-needs-response"
            >
              Your answer
            </span>
          )}
        </span>

        {/* Absent for an isolated question, which is a first-class shape: the
            row simply ends after its meta line rather than reserving space. */}
        {row.subjects.length > 0 && (
          <span className="feedback-row-subjects mt-1.5 flex flex-wrap items-center gap-1.5">
            {row.subjects.map((subject) => (
              <span
                key={subject.key}
                className="feedback-row-subject flex max-w-[240px] items-center gap-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] px-1.5 py-px text-[10.5px] text-[var(--nim-text-muted)]"
                data-testid="feedback-row-subject"
                title={subject.label}
              >
                <MaterialSymbol icon={subject.icon} size={11} className="shrink-0" />
                <span className="truncate">{subject.label}</span>
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  );
}
