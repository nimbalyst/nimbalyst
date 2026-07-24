/**
 * The single source of the "Nimbalyst Teams is in alpha" disclosure.
 *
 * Every surface that lets someone create, join, or administer an organization
 * shows this (or the matching `AlphaBadge` tooltip) so nobody adopts team
 * collaboration without knowing it is alpha-quality and will be paid after
 * launch. Keep the wording in `TEAM_ALPHA_TOOLTIP` and the notice in sync.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

/** Tooltip copy for `AlphaBadge` on organization surfaces. */
export const TEAM_ALPHA_TOOLTIP =
  'Nimbalyst Teams is in alpha. Expect bugs, and do not treat shared organization data as your only copy.\n\nOrganizations are free during alpha and will require a paid Nimbalyst Teams subscription after launch.';

export function TeamAlphaNotice({ className = '' }: { className?: string }) {
  return (
    <div
      className={`team-alpha-notice flex items-start gap-1.5 text-[12px] leading-relaxed text-[var(--nim-text-faint)] ${className}`.trim()}
      data-testid="team-alpha-notice"
    >
      <MaterialSymbol icon="info" size={13} className="mt-[2px] shrink-0" />
      <span>
        <span className="text-[var(--nim-text-muted)]">Nimbalyst Teams is in alpha</span> — expect bugs,
        and keep your own copy of anything important. Organizations are free during alpha and will require a
        paid Nimbalyst Teams subscription after launch; existing organizations get advance notice before any
        pricing change.
      </span>
    </div>
  );
}
