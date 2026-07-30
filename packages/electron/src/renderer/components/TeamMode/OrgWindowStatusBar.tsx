/**
 * The org window's slim bottom status bar.
 *
 * Replaces the two-line alpha banner that used to sit inside the Inbox and the
 * admin panels (2026-07-28 layout decision): one muted line, always present so
 * nobody administers an organization without the disclosure, and never
 * dismissible. The full pricing sentence is one hover away rather than spending
 * two lines of every surface — see the `org-window-status-bar` help entry.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import { HelpTooltip } from '../../help';

export const ORG_WINDOW_ALPHA_STATUS =
  'Nimbalyst Teams alpha — expect bugs; organizations are free during alpha.';

/** Fixed content, so it is memoized and never repaints with a navigation. */
export const OrgWindowStatusBar = React.memo(function OrgWindowStatusBar() {
  return (
    <HelpTooltip testId="org-window-status-bar">
      <footer
        className="org-window-status-bar flex shrink-0 items-center gap-1.5 border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-1 text-[11px] leading-5 text-[var(--nim-text-faint)]"
        data-testid="org-window-status-bar"
        data-component="OrgWindowStatusBar"
      >
        <MaterialSymbol icon="info" size={12} className="shrink-0" />
        <span className="min-w-0 truncate">{ORG_WINDOW_ALPHA_STATUS}</span>
      </footer>
    </HelpTooltip>
  );
});
