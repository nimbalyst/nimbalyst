/**
 * ContextMenu Component
 *
 * Right-click context menu for spreadsheet cells with common actions.
 */

import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    // Add listeners after a small delay to prevent immediate close
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position to keep menu within viewport
  useEffect(() => {
    if (menuRef.current) {
      const menu = menuRef.current;
      const rect = menu.getBoundingClientRect();
      const parent = menu.parentElement?.getBoundingClientRect();

      if (parent) {
        // Adjust horizontal position
        if (rect.right > parent.right) {
          menu.style.left = `${x - rect.width}px`;
        }
        // Adjust vertical position
        if (rect.bottom > parent.bottom) {
          menu.style.top = `${y - rect.height}px`;
        }
      }
    }
  }, [x, y]);

  const handleItemClick = (item: ContextMenuItem) => {
    if (!item.disabled) {
      item.action();
      onClose();
    }
  };

  return (
    <div
      ref={menuRef}
      className="absolute z-[1000] min-w-[160px] py-1 bg-nim border border-nim rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.15)] text-[13px]"
      style={{ left: x, top: y }}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={index} className="h-px my-1 bg-[var(--nim-border)]" />
        ) : (
          <button
            key={index}
            className={`block w-full px-3 py-2 text-left bg-none border-none cursor-pointer transition-colors ${item.disabled ? 'text-nim-faint cursor-not-allowed' : 'text-nim hover:bg-nim-hover active:bg-nim-tertiary'}`}
            onClick={() => handleItemClick(item)}
            disabled={item.disabled}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
