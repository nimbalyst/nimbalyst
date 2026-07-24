/**
 * TerminalTabContextMenu - Context menu for terminal tabs
 *
 * Provides options to close the tab, close other tabs, close all tabs,
 * and close tabs to the right.
 */

import React, { useMemo } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../../hooks/useFloatingMenu';

interface TerminalTabContextMenuProps {
  x: number;
  y: number;
  terminalId: string;
  terminalCount: number;
  terminalIndex: number;
  onClose: () => void;
  onCloseTab: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onCloseToRight: () => void;
}

export function TerminalTabContextMenu({
  x,
  y,
  terminalId,
  terminalCount,
  terminalIndex,
  onClose,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
  onCloseToRight,
}: TerminalTabContextMenuProps) {
  const reference = useMemo(() => virtualElement(x, y), [x, y]);
  const menu = useFloatingMenu({
    placement: 'right-start',
    reference,
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

  // Calculate how many tabs are to the right
  const tabsToRight = terminalCount - terminalIndex - 1;
  const hasOtherTabs = terminalCount > 1;

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };

  const menuItemClasses =
    'flex items-center gap-2.5 px-3 py-1.5 rounded cursor-pointer transition-colors text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]';
  const disabledMenuItemClasses =
    'flex items-center gap-2.5 px-3 py-1.5 rounded text-[var(--nim-text-disabled)] cursor-not-allowed';

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
        className="p-1 min-w-[160px] rounded-md z-[10000] text-[13px] backdrop-blur-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.15)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)]"
        data-testid="terminal-tab-context-menu"
      >
        <div
          className={menuItemClasses}
          onClick={() => handleAction(onCloseTab)}
        >
          <MaterialSymbol icon="close" size={18} />
          <span>Close</span>
        </div>

        <div
          className={hasOtherTabs ? menuItemClasses : disabledMenuItemClasses}
          onClick={hasOtherTabs ? () => handleAction(onCloseOthers) : undefined}
        >
          <MaterialSymbol icon="tab_close" size={18} />
          <span>Close Others</span>
        </div>

        <div
          className={tabsToRight > 0 ? menuItemClasses : disabledMenuItemClasses}
          onClick={tabsToRight > 0 ? () => handleAction(onCloseToRight) : undefined}
        >
          <MaterialSymbol icon="tab_close_right" size={18} />
          <span>Close to the Right</span>
        </div>

        <div className="h-px my-1 bg-[var(--nim-border)]" />

        <div
          className={menuItemClasses}
          onClick={() => handleAction(onCloseAll)}
        >
          <MaterialSymbol icon="cancel" size={18} />
          <span>Close All</span>
        </div>
      </div>
    </FloatingPortal>
  );
}
