import React, { useMemo } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../../hooks/useFloatingMenu';

interface TerminalContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onClear: () => void;
}

export function TerminalContextMenu({
  x,
  y,
  onClose,
  onClear,
}: TerminalContextMenuProps) {
  const reference = useMemo(() => virtualElement(x, y), [x, y]);
  const menu = useFloatingMenu({
    placement: 'right-start',
    reference,
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

  const handleClear = () => {
    onClear();
    onClose();
  };

  const menuItemClasses =
    'flex items-center gap-2.5 px-3 py-1.5 rounded cursor-pointer transition-colors text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]';

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={{
          ...menu.floatingStyles,
          background: 'var(--nim-bg)',
          border: '1px solid var(--nim-border)',
        }}
        {...menu.getFloatingProps()}
        className="p-1 min-w-[140px] rounded-md z-[10000] text-[13px] backdrop-blur-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.15)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)]"
        data-testid="terminal-context-menu"
      >
        <div className={menuItemClasses} onClick={handleClear}>
          <MaterialSymbol icon="backspace" size={18} />
          <span>Clear</span>
        </div>
      </div>
    </FloatingPortal>
  );
}
