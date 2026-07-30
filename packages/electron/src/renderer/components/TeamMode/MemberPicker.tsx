import React, { useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import type { OrgRosterMember } from './useOrgRoster';

/**
 * A searchable multi-select over the organization roster.
 *
 * Shared by the create-room initial-members field and the new-direct-message
 * picker so "who is in this org" looks and filters the same in both, and the
 * roster's own shape (`name` may be blank, `email` is the reliable label) is
 * handled in one place.
 */
export function MemberPicker({
  members,
  selectedIds,
  excludeIds = [],
  disabledIds = [],
  maxSelected,
  emptyLabel = 'No other members in this organization yet.',
  testId,
  onToggle,
}: {
  members: readonly OrgRosterMember[];
  selectedIds: readonly string[];
  /** Never offered — typically the viewer, who is implied. */
  excludeIds?: readonly string[];
  /** Offered but not togglable, e.g. once a participant cap is reached. */
  disabledIds?: readonly string[];
  maxSelected?: number;
  emptyLabel?: string;
  testId: string;
  onToggle: (memberId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const excluded = useMemo(() => new Set(excludeIds), [excludeIds]);
  const disabled = useMemo(() => new Set(disabledIds), [disabledIds]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return members
      .filter((member) => !excluded.has(member.memberId))
      .map((member) => ({
        memberId: member.memberId,
        label: member.name?.trim() || member.email || member.memberId,
        email: member.email || '',
      }))
      .filter((row) => !needle
        || row.label.toLowerCase().includes(needle)
        || row.email.toLowerCase().includes(needle))
      .sort((left, right) => left.label.localeCompare(right.label, undefined, {
        sensitivity: 'base',
      }));
  }, [excluded, members, query]);

  const capped = maxSelected !== undefined && selected.size >= maxSelected;

  return (
    <div className="member-picker" data-testid={testId} data-component="MemberPicker">
      <div className="member-picker-search relative mb-2">
        <MaterialSymbol
          icon="search"
          size={15}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--nim-text-faint)]"
        />
        <input
          type="text"
          className="w-full rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] py-1.5 pl-8 pr-3 text-[12px] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
          data-testid={`${testId}-search`}
          placeholder="Search people"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="member-picker-list max-h-[200px] overflow-y-auto rounded-md border border-[var(--nim-border)]">
        {rows.length === 0 && (
          <p
            className="m-0 px-3 py-2 text-[12px] text-[var(--nim-text-muted)]"
            data-testid={`${testId}-empty`}
          >
            {query ? 'No matching members.' : emptyLabel}
          </p>
        )}
        {rows.map((row) => {
          const isSelected = selected.has(row.memberId);
          const isDisabled = disabled.has(row.memberId) || (capped && !isSelected);
          return (
            <label
              key={row.memberId}
              className={`member-picker-option flex items-center gap-2.5 px-3 py-1.5 text-[12px] ${
                isDisabled
                  ? 'cursor-not-allowed text-[var(--nim-text-disabled)]'
                  : 'cursor-pointer text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
              }`}
              data-testid={`${testId}-option-${row.memberId}`}
            >
              <input
                type="checkbox"
                checked={isSelected}
                disabled={isDisabled}
                onChange={() => onToggle(row.memberId)}
              />
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.email && row.email !== row.label && (
                <span className="min-w-0 shrink truncate text-[11px] text-[var(--nim-text-faint)]">
                  {row.email}
                </span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
