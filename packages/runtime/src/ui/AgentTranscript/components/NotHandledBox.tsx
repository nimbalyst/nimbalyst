import React from 'react';
import { MaterialSymbol } from '../../icons/MaterialSymbol';

interface NotHandledBoxProps {
  type: string;
  description?: string;
}

/**
 * NotHandledBox - Shows a placeholder for output types that aren't yet fully supported
 *
 * Used for Codex outputs that don't have custom rendering yet (e.g., thinking output,
 * since Claude Code doesn't have visible thinking output to compare with).
 */
export const NotHandledBox: React.FC<NotHandledBoxProps> = ({ type, description }) => {
  return (
    <div className="not-handled-box border border-[var(--nim-border)] rounded-md bg-[var(--nim-bg-secondary)] p-3">
      <div className="flex items-center gap-2 mb-2">
        <MaterialSymbol icon="info" size={16} className="text-[var(--nim-text-muted)]" />
        <span className="text-sm font-medium text-[var(--nim-text)]">
          {type}
        </span>
        <span className="ml-auto text-xs text-[var(--nim-text-faint)] uppercase tracking-wide">
          Not Handled
        </span>
      </div>
      {description && (
        <p className="text-xs text-[var(--nim-text-muted)] leading-relaxed">
          {description}
        </p>
      )}
    </div>
  );
};
