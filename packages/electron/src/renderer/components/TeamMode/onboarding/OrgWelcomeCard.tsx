/**
 * The one-time welcome card an invited member sees the first time they open the
 * organization window. Presentational: `useOrgWelcome` decides whether it shows
 * and owns the persisted dismissal.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import type { OrgWelcomeCardView } from './orgWelcomeModel';

export function OrgWelcomeCard({
  card,
  onDismiss,
}: {
  card: OrgWelcomeCardView;
  onDismiss: () => void;
}) {
  return (
    <aside
      className="org-welcome-card mx-5 mt-3 flex items-start gap-3 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-2.5"
      data-testid="org-welcome-card"
      data-component="OrgWelcomeCard"
    >
      <MaterialSymbol icon="waving_hand" size={18} className="mt-0.5 shrink-0 text-[var(--nim-primary)]" />
      <div className="min-w-0 flex-1 select-text">
        <div className="text-[13px] font-semibold text-[var(--nim-text)]">{card.title}</div>
        <div className="mt-0.5 text-[11px] text-[var(--nim-text-muted)]">{card.subtitle}</div>
        <ul className="org-welcome-points m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
          {card.points.map((point) => (
            <li key={point} className="flex items-start gap-1.5 text-[11px] text-[var(--nim-text-muted)]">
              <MaterialSymbol icon="chevron_right" size={12} className="mt-0.5 shrink-0 text-[var(--nim-text-disabled)]" />
              {point}
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        aria-label="Dismiss welcome"
        className="org-welcome-dismiss shrink-0 rounded p-1 text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
        data-testid="org-welcome-dismiss"
        onClick={onDismiss}
      >
        <MaterialSymbol icon="close" size={14} />
      </button>
    </aside>
  );
}
