/**
 * A toolbar button that opens a floating panel: menus, the color palette and
 * the border picker. Positioned with @floating-ui and portalled, so it escapes
 * the toolbar's overflow and flips at the viewport edge.
 */

import { useState, type ReactNode } from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { Caret } from './toolbarIcons';

export interface ToolbarMenuProps {
  label: ReactNode;
  title: string;
  /** Stable hook for tests and devtools, e.g. `number-format`. */
  name: string;
  disabled?: boolean;
  active?: boolean;
  /** Rendered with a `close` callback, so an item can dismiss the panel. */
  children: (close: () => void) => ReactNode;
}

export function ToolbarMenu({ label, title, name, disabled, active, children }: ToolbarMenuProps) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context, { enabled: !disabled }),
    useDismiss(context),
    useRole(context, { role: 'menu' }),
  ]);
  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        className={`sheet-toolbar-button ${active || open ? 'sheet-toolbar-button-on' : ''}`}
        title={title}
        aria-label={title}
        disabled={disabled}
        data-toolbar={name}
        // Keep focus (and the selection) on the grid.
        onMouseDown={(event) => event.preventDefault()}
        {...getReferenceProps()}
      >
        {label}
        <Caret />
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="sheet-toolbar-menu"
            data-toolbar-menu={name}
            onMouseDown={(event) => {
              // Inputs inside the panel need focus; everything else keeps the grid's.
              if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) event.preventDefault();
            }}
            {...getFloatingProps()}
          >
            {children(close)}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

export interface MenuItemProps {
  label: ReactNode;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function MenuItem({ label, hint, checked, disabled, onSelect }: MenuItemProps) {
  return (
    <button type="button" role="menuitem" className="sheet-toolbar-menu-item" disabled={disabled} onClick={onSelect}>
      <span className="sheet-toolbar-menu-check">{checked ? '✓' : ''}</span>
      <span className="sheet-toolbar-menu-label">{label}</span>
      {hint && <span className="sheet-toolbar-menu-hint">{hint}</span>}
    </button>
  );
}

export const MenuSeparator = () => <div className="sheet-toolbar-menu-separator" role="separator" />;
