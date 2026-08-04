import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import { INBOX_FILTERS, SOURCE_KIND_LABELS, toggleScopeValue, typeIdentity } from './inboxViewModel';
import { InboxScopeMenu } from './InboxScopeMenu';
import type { InboxFilterId, InboxScope, InboxScopeOptions, InboxSourceKind } from './inboxTypes';

/**
 * Three independent axes, all visible, all composable.
 *
 * - **Reason** — single-select, because a delivery arrives for exactly one.
 * - **Unread** — its own toggle. It used to be a fifth reason chip, which made
 *   read state mutually exclusive with the reason you were reading: choosing
 *   "Unread" silently threw away "Mentions". "Unread mentions" is the single
 *   most useful triage query on this surface and it was unexpressible.
 * - **Type** — multi-select chips over the source kinds actually present.
 *
 * Reason counts are unread-within-reason, taken from the same normalized rows
 * the list renders (inside the active scope, independent of the search query
 * and of the unread toggle — both refine a filter; neither changes how much is
 * waiting in it).
 */
export function InboxFilterBar({
  filter,
  counts,
  unreadOnly,
  unreadCount,
  typeCounts,
  scope,
  scopeOptions,
  disabled,
  onFilterChange,
  onUnreadOnlyChange,
  onScopeChange,
}: {
  filter: InboxFilterId;
  counts: Record<InboxFilterId, number>;
  unreadOnly: boolean;
  unreadCount: number;
  typeCounts: Partial<Record<InboxSourceKind, number>>;
  scope: InboxScope;
  scopeOptions: InboxScopeOptions;
  disabled: boolean;
  onFilterChange: (filter: InboxFilterId) => void;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  onScopeChange: (scope: InboxScope) => void;
}) {
  const kinds = scopeOptions.sourceKinds;

  return (
    <div className="inbox-filter-bar flex flex-col gap-2" data-component="InboxFilterBar">
      <div
        className="inbox-filter-reasons flex flex-wrap items-center gap-2"
        data-testid="inbox-filter-bar"
        role="tablist"
        aria-label="Inbox filters"
      >
        {INBOX_FILTERS.map(({ id, label }) => {
          const isActive = filter === id;
          const count = counts[id] ?? 0;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              disabled={disabled}
              aria-selected={isActive}
              data-testid={`inbox-filter-${id}`}
              onClick={() => onFilterChange(id)}
              className={`inbox-filter-chip org-window-no-drag flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] ${
                disabled
                  ? 'cursor-not-allowed bg-transparent text-[var(--nim-text-disabled)]'
                  : isActive
                    ? 'bg-[var(--nim-primary)] font-medium text-[var(--nim-on-primary)]'
                    : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
              }`}
            >
              {label}
              {count > 0 && (
                <span
                  className={`inbox-filter-count rounded-full px-1.5 text-[10px] font-semibold leading-4 ${
                    isActive
                      ? 'bg-[color-mix(in_srgb,var(--nim-on-primary)_25%,transparent)] text-[var(--nim-on-primary)]'
                      : 'bg-[var(--nim-bg-active)] text-[var(--nim-text-muted)]'
                  }`}
                  data-testid={`inbox-filter-count-${id}`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}

        <span className="inbox-filter-divider mx-1 h-5 w-px shrink-0 bg-[var(--nim-border)]" aria-hidden="true" />

        <button
          type="button"
          role="switch"
          disabled={disabled}
          aria-checked={unreadOnly}
          data-testid="inbox-unread-toggle"
          onClick={() => onUnreadOnlyChange(!unreadOnly)}
          className={`inbox-unread-toggle org-window-no-drag flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${
            disabled
              ? 'cursor-not-allowed border-[var(--nim-border)] text-[var(--nim-text-disabled)]'
              : unreadOnly
                ? 'border-[var(--nim-primary)] bg-[color-mix(in_srgb,var(--nim-primary)_14%,transparent)] font-medium text-[var(--nim-primary)]'
                : 'border-[var(--nim-border)] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
          }`}
        >
          <MaterialSymbol icon={unreadOnly ? 'toggle_on' : 'toggle_off'} size={16} />
          Unread only
          {unreadCount > 0 && (
            <span className="inbox-unread-toggle-count text-[10px] font-semibold" data-testid="inbox-unread-toggle-count">
              {unreadCount}
            </span>
          )}
        </button>
      </div>

      {kinds.length > 1 && (
        <div className="inbox-filter-types flex flex-wrap items-center gap-1.5" data-testid="inbox-type-filters">
          <span className="inbox-filter-types-label mr-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">
            Types
          </span>
          {kinds.map((kind) => {
            // An unrestricted axis means every type is showing, so every chip
            // reads as on — the first click has to turn one off, which is what
            // `toggleScopeValue` does.
            const on = !scope.sourceKinds || scope.sourceKinds.includes(kind);
            const identity = typeIdentity(kind);
            const count = typeCounts[kind] ?? 0;
            return (
              <button
                key={kind}
                type="button"
                role="checkbox"
                disabled={disabled}
                aria-checked={on}
                aria-label={SOURCE_KIND_LABELS[kind]}
                data-testid={`inbox-type-filter-${kind}`}
                onClick={() => onScopeChange({
                  ...scope,
                  sourceKinds: toggleScopeValue(scope.sourceKinds, kind, kinds),
                })}
                className={`inbox-type-chip org-window-no-drag flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] ${
                  disabled
                    ? 'cursor-not-allowed border-[var(--nim-border)] text-[var(--nim-text-disabled)]'
                    : on
                      ? 'text-[var(--nim-text)]'
                      : 'border-[var(--nim-border)] text-[var(--nim-text-faint)] hover:bg-[var(--nim-bg-hover)]'
                }`}
                style={on && !disabled ? { borderColor: identity.accent } : undefined}
              >
                <MaterialSymbol
                  icon={identity.icon}
                  size={13}
                  className={on && !disabled ? undefined : 'opacity-60'}
                  style={on && !disabled ? { color: identity.accent } : undefined}
                />
                {SOURCE_KIND_LABELS[kind]}
                {count > 0 && (
                  <span className="inbox-type-chip-count text-[10px] font-semibold text-[var(--nim-text-faint)]">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
          <div className="inbox-filter-bar-spacer ml-auto" />
          <InboxScopeMenu scope={scope} options={scopeOptions} disabled={disabled} onChange={onScopeChange} />
        </div>
      )}

      {kinds.length <= 1 && (
        <div className="inbox-filter-scope flex items-center">
          <div className="inbox-filter-bar-spacer ml-auto" />
          <InboxScopeMenu scope={scope} options={scopeOptions} disabled={disabled} onChange={onScopeChange} />
        </div>
      )}
    </div>
  );
}
