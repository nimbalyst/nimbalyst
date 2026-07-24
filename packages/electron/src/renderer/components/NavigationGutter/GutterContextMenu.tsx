import React, { useMemo } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../../hooks/useFloatingMenu';
import type { GutterItemMeta } from './navGutterItems';

interface GutterContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  /** Id of the item right-clicked, if any (offers "Hide <label>"). */
  targetButton?: string;
  /** Available gutter items, for labels. */
  items: GutterItemMeta[];
  /** Currently hidden ids (offers "Show <label>"). */
  hiddenIds: string[];
  /** Guard: whether an item may be hidden right now. */
  canHide: (id: string) => boolean;
  /** Toggle hidden state for an id (already guarded by the caller). */
  onToggleHidden: (id: string) => void;
  /** Show everything / clear customization. */
  onReset: () => void;
  /** Open the full "Customize Gutter" popover. */
  onOpenCustomize: () => void;
}

export function GutterContextMenu({
  x,
  y,
  onClose,
  targetButton,
  items,
  hiddenIds,
  canHide,
  onToggleHidden,
  onReset,
  onOpenCustomize,
}: GutterContextMenuProps) {
  const vRef = useMemo(() => virtualElement(x, y), [x, y]);
  const labelOf = useMemo(() => {
    const map = new Map(items.map((it) => [it.id, it.label]));
    return (id: string) => map.get(id) ?? id;
  }, [items]);

  const menu = useFloatingMenu({
    placement: 'right-start',
    reference: vRef,
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

  // Only offer to restore items that are still in the available registry.
  const restorableHidden = hiddenIds.filter((id) => items.some((it) => it.id === id));
  const hasHidden = restorableHidden.length > 0;
  const showHideTarget = !!targetButton && !hiddenIds.includes(targetButton) && canHide(targetButton);

  const itemClass =
    'w-full flex items-center gap-2 px-2.5 py-1.5 text-nim hover:bg-nim-tertiary cursor-pointer border-none bg-transparent text-left rounded-sm transition-colors duration-75';

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="gutter-context-menu p-1 min-w-[180px] rounded-md z-[10000] text-[13px] backdrop-blur-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.15)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)] overflow-hidden bg-nim border border-nim"
        data-testid="gutter-context-menu"
      >
        {/* Hide the right-clicked item */}
        {showHideTarget && (
          <>
            <button
              className={itemClass}
              onClick={() => { onToggleHidden(targetButton!); onClose(); }}
            >
              <MaterialSymbol icon="visibility_off" size={16} className="text-nim-muted" />
              <span>Hide {labelOf(targetButton!)}</span>
            </button>
            <div className="my-1 border-t border-nim" />
          </>
        )}

        {/* Restore hidden items */}
        {hasHidden && (
          <>
            {restorableHidden.map((id) => (
              <button
                key={id}
                className={itemClass}
                onClick={() => { onToggleHidden(id); onClose(); }}
              >
                <MaterialSymbol icon="visibility" size={16} className="text-nim-muted" />
                <span>Show {labelOf(id)}</span>
              </button>
            ))}
            <div className="my-1 border-t border-nim" />
          </>
        )}

        {/* Full management surface */}
        <button
          className={itemClass}
          onClick={() => { onOpenCustomize(); }}
          data-testid="gutter-customize-button"
        >
          <MaterialSymbol icon="tune" size={16} className="text-nim-muted" />
          <span>Customize Gutter…</span>
        </button>

        {hasHidden && (
          <button
            className={itemClass}
            onClick={() => { onReset(); onClose(); }}
          >
            <MaterialSymbol icon="restart_alt" size={16} className="text-nim-muted" />
            <span>Show All</span>
          </button>
        )}
      </div>
    </FloatingPortal>
  );
}
