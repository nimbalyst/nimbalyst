import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

interface HeaderCreateButtonProps {
  /** Material Symbol ligature name shown before the label (e.g. `add`, `note_add`, `create_new_folder`). */
  icon: string;
  /** Button text, e.g. "New", "New File", "New Folder". */
  label: string;
  onClick: () => void;
  title?: string;
  ariaLabel?: string;
  testId?: string;
  /** Show a trailing chevron to signal the button opens a menu. */
  showCaret?: boolean;
  /** `primary` fills the button with the accent colour (used in the chrome). */
  tone?: 'default' | 'primary';
  /** Extra classes appended to the root (kept for legacy selector hooks / E2E). */
  className?: string;
}

const TONE_CLASSES: Record<'default' | 'primary', string> = {
  default:
    'bg-[var(--nim-bg-secondary)] border-[var(--nim-border)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)] active:bg-[var(--nim-bg-tertiary)]',
  primary:
    'bg-[var(--nim-primary)] border-[var(--nim-primary)] text-white hover:bg-[var(--nim-primary-hover)] hover:border-[var(--nim-primary-hover)] active:opacity-90',
};

/**
 * Shared "+ New" pill used across workspace panel headers (Agent sessions,
 * Files) so every create action reads the same: a type icon plus a "New …"
 * label. Forwards its ref to the underlying button so callers can anchor a
 * floating menu to it.
 */
export const HeaderCreateButton = React.forwardRef<HTMLButtonElement, HeaderCreateButtonProps>(
  function HeaderCreateButton(
    { icon, label, onClick, title, ariaLabel, testId, showCaret = false, tone = 'default', className = '' },
    ref
  ) {
    return (
      <button
        ref={ref}
        type="button"
        data-testid={testId}
        className={`header-create-button flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold rounded border cursor-pointer transition-colors duration-150 shrink-0 whitespace-nowrap ${TONE_CLASSES[tone]} ${className}`.trim()}
        onClick={onClick}
        title={title ?? label}
        aria-label={ariaLabel ?? label}
      >
        <MaterialSymbol icon={icon} size={16} className="shrink-0" />
        <span>{label}</span>
        {showCaret && (
          <MaterialSymbol icon="expand_more" size={14} className="shrink-0 -ml-0.5 opacity-70" />
        )}
      </button>
    );
  }
);
