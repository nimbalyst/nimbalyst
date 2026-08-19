import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

/**
 * Opens the shared area's Feedback list.
 *
 * Sits in the shared-documents sidebar header next to Discovery home, through
 * the sidebar's existing `headerActions` slot — the host-owned corner of a
 * component the browser console shares. No new mode, gutter icon or nav level:
 * feedback is another surface of the shared area, reached the same way its
 * discovery home is.
 */
export function SharedFeedbackTabButton({
  active,
  onOpen,
}: {
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`shared-feedback-tab-button workspace-action-button relative flex cursor-pointer items-center justify-center rounded border-none bg-transparent p-1.5 transition-all duration-200 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] ${
        active ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-faint)]'
      }`}
      title="Feedback requests"
      aria-label="Feedback requests"
      aria-pressed={active}
      data-testid="shared-feedback-tab-button"
      onClick={onOpen}
    >
      <MaterialSymbol icon="ballot" size={16} />
    </button>
  );
}
