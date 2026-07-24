/**
 * FloatingEditorActions - Floating action buttons for custom editors
 *
 * Provides consistent floating buttons (like "View Source") for custom editors.
 * Positioned in the top-right corner of the editor area.
 *
 * Usage:
 * ```tsx
 * <FloatingEditorActions>
 *   <FloatingEditorButton
 *     icon="code"
 *     label="View Source"
 *     onClick={() => host.toggleSourceMode?.()}
 *   />
 * </FloatingEditorActions>
 * ```
 */

import React from 'react';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';

interface FloatingEditorActionsProps {
  children: React.ReactNode;
}

/**
 * Container for floating action buttons in custom editors.
 * Positioned in the top-right corner with proper z-index.
 */
export const FloatingEditorActions: React.FC<FloatingEditorActionsProps> = ({
  children,
}) => {
  return (
    <div className="floating-editor-actions absolute top-1.5 right-3 flex gap-2 z-[100] pointer-events-none">
      {children}
    </div>
  );
};

interface FloatingEditorButtonProps {
  /** Icon name (uses Material Symbols) or custom icon element */
  icon?: string | React.ReactNode;
  /** Button label (shown in tooltip) */
  label: string;
  /** Click handler */
  onClick: () => void;
  /** Whether button is active/pressed */
  isActive?: boolean;
  /** Whether button is disabled */
  disabled?: boolean;
}

/**
 * A floating action button for custom editors.
 * Consistent with the editor's FloatingDocumentActionsPlugin styling.
 */
export const FloatingEditorButton: React.FC<FloatingEditorButtonProps> = ({
  icon,
  label,
  onClick,
  isActive = false,
  disabled = false,
}) => {
  return (
    <button
      className={`floating-editor-button pointer-events-auto w-9 h-9 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] cursor-pointer flex items-center justify-center transition-all duration-200 p-0 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${isActive ? 'active bg-[var(--nim-primary)] text-white border-[var(--nim-primary)]' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {typeof icon === 'string' ? (
        <span className="material-symbols-outlined text-xl opacity-80 group-hover:opacity-100">{icon}</span>
      ) : (
        icon
      )}
    </button>
  );
};

/**
 * A dropdown menu that appears when clicking a floating button.
 */
interface FloatingEditorMenuProps {
  children: React.ReactNode;
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement>;
}

export const FloatingEditorMenu: React.FC<FloatingEditorMenuProps> = ({
  children,
  isOpen,
  onClose,
  anchorRef,
}) => {
  const menu = useFloatingMenu({
    placement: 'bottom-end',
    offsetPx: 8,
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) {
        onClose();
      }
    },
    reference: anchorRef.current,
  });

  if (!isOpen) return null;

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        className="floating-editor-menu min-w-[180px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.15)] z-[1000] pointer-events-auto py-1"
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
      >
        {children}
      </div>
    </FloatingPortal>
  );
};

interface FloatingEditorMenuItemProps {
  label: string;
  onClick: () => void;
  icon?: string;
  isActive?: boolean;
}

export const FloatingEditorMenuItem: React.FC<FloatingEditorMenuItemProps> = ({
  label,
  onClick,
  icon,
  isActive = false,
}) => {
  return (
    <button
      className={`floating-editor-menu-item w-full px-4 py-2.5 border-none bg-transparent text-[var(--nim-text)] text-sm text-left cursor-pointer transition-colors duration-150 flex items-center gap-2.5 hover:bg-[var(--nim-bg-hover)] active:bg-[var(--nim-bg-secondary)] ${isActive ? 'active text-[var(--nim-primary)]' : ''}`}
      onClick={onClick}
    >
      {icon && <span className="material-symbols-outlined text-lg opacity-80">{icon}</span>}
      <span>{label}</span>
      {isActive && <span className="checkmark ml-auto text-[var(--nim-primary)]">✓</span>}
    </button>
  );
};
