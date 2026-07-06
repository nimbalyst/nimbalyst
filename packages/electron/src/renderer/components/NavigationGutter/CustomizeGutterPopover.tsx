import React, { useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../../hooks/useFloatingMenu';
import {
  type GutterItemMeta,
  type GutterSection,
  GUTTER_SECTION_ORDER,
  GUTTER_SECTION_LABELS,
  sortBySavedOrder,
} from './navGutterItems';

interface CustomizeGutterPopoverProps {
  x: number;
  y: number;
  /** All available gutter items (already capability-filtered). */
  items: GutterItemMeta[];
  hiddenIds: string[];
  sectionOrder: Partial<Record<GutterSection, string[]>>;
  /** Guard: whether an item may be hidden right now (keep-one-mode). */
  canHide: (id: string) => boolean;
  onToggleHidden: (id: string) => void;
  onReorder: (section: GutterSection, order: string[]) => void;
  onReset: () => void;
  onClose: () => void;
}

export function CustomizeGutterPopover({
  x,
  y,
  items,
  hiddenIds,
  sectionOrder,
  canHide,
  onToggleHidden,
  onReorder,
  onReset,
  onClose,
}: CustomizeGutterPopoverProps) {
  const vRef = useMemo(() => virtualElement(x, y), [x, y]);
  const menu = useFloatingMenu({
    placement: 'right-start',
    reference: vRef,
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

  // Items grouped + ordered per section.
  const sections = useMemo(() => {
    return GUTTER_SECTION_ORDER.map((section) => {
      const secItems = items.filter((it) => it.section === section);
      return { section, items: sortBySavedOrder(secItems, sectionOrder[section]) };
    }).filter((s) => s.items.length > 0);
  }, [items, sectionOrder]);

  // Drag-to-reorder state (within a single section).
  const [drag, setDrag] = useState<{ section: GutterSection; id: string } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const handleDrop = (section: GutterSection, targetId: string | null, currentOrder: string[]) => {
    if (!drag || drag.section !== section) { setDrag(null); setDragOverId(null); return; }
    const without = currentOrder.filter((id) => id !== drag.id);
    let insertAt = without.length;
    if (targetId && targetId !== drag.id) {
      const idx = without.indexOf(targetId);
      if (idx !== -1) insertAt = idx;
    }
    const next = [...without.slice(0, insertAt), drag.id, ...without.slice(insertAt)];
    onReorder(section, next);
    setDrag(null);
    setDragOverId(null);
  };

  const rowBase =
    'group flex items-center gap-2 px-2 py-1 mx-1 rounded-md hover:bg-nim-tertiary transition-colors duration-75';

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="customize-gutter-popover w-[300px] rounded-lg z-[10000] text-[13px] backdrop-blur-[10px] shadow-[0_8px_28px_rgba(0,0,0,0.35)] dark:shadow-[0_12px_40px_rgba(0,0,0,0.55)] overflow-hidden bg-nim border border-nim flex flex-col"
        data-testid="customize-gutter-popover"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-nim">
          <span className="font-semibold text-nim">Customize Gutter</span>
          <MaterialSymbol icon="tune" size={18} className="text-nim-faint" />
        </div>

        {/* Body */}
        <div className="py-1 overflow-y-auto max-h-[60vh]">
          {sections.map(({ section, items: secItems }) => {
            const orderIds = secItems.map((it) => it.id);
            return (
              <div key={section}>
                <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-nim-faint">
                  {GUTTER_SECTION_LABELS[section]}
                </div>
                {secItems.map((it) => {
                  const isHidden = hiddenIds.includes(it.id);
                  const lockedVisible = !isHidden && !canHide(it.id); // last mode: can't hide
                  const isDragOver = dragOverId === it.id && drag?.section === section;
                  return (
                    <div
                      key={it.id}
                      className={`${rowBase} ${isHidden ? 'opacity-55' : ''} ${isDragOver ? 'outline outline-1 outline-[var(--nim-primary)]' : ''} ${drag?.id === it.id ? 'opacity-40' : ''}`}
                      draggable
                      data-testid={`customize-gutter-row-${it.id}`}
                      onDragStart={() => { setDrag({ section, id: it.id }); }}
                      onDragOver={(e) => {
                        if (drag?.section === section) { e.preventDefault(); setDragOverId(it.id); }
                      }}
                      onDrop={(e) => { e.preventDefault(); handleDrop(section, it.id, orderIds); }}
                      onDragEnd={() => { setDrag(null); setDragOverId(null); }}
                    >
                      <span className="cursor-grab text-nim-faint active:cursor-grabbing" aria-hidden>
                        <MaterialSymbol icon="drag_indicator" size={18} />
                      </span>
                      <span className="w-6 h-6 flex items-center justify-center rounded text-nim-muted bg-nim-tertiary">
                        <MaterialSymbol icon={it.icon} size={17} />
                      </span>
                      <span className="flex-1 truncate text-nim">{it.label}</span>
                      <button
                        className={`w-7 h-6 flex items-center justify-center rounded text-nim-muted ${lockedVisible ? 'opacity-40 cursor-not-allowed' : 'hover:bg-nim-tertiary hover:text-nim cursor-pointer'}`}
                        disabled={lockedVisible}
                        title={lockedVisible ? 'At least one mode must stay visible' : isHidden ? 'Show' : 'Hide'}
                        aria-label={isHidden ? `Show ${it.label}` : `Hide ${it.label}`}
                        aria-pressed={!isHidden}
                        data-testid={`customize-gutter-toggle-${it.id}`}
                        onClick={() => { if (!lockedVisible) onToggleHidden(it.id); }}
                      >
                        <MaterialSymbol icon={isHidden ? 'visibility_off' : 'visibility'} size={18} />
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Always-visible note */}
          <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[11px] text-nim-faint">
            <MaterialSymbol icon="lock" size={14} />
            <span>Account &amp; Settings is always visible</span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-2 py-2 border-t border-nim bg-nim-secondary">
          <button
            className="flex items-center gap-1.5 px-2 py-1 rounded text-nim-muted hover:bg-nim-tertiary hover:text-nim text-[12px]"
            onClick={onReset}
            data-testid="customize-gutter-reset"
          >
            <MaterialSymbol icon="restart_alt" size={15} />
            <span>Reset to defaults</span>
          </button>
          <button
            className="px-3.5 py-1 rounded-md text-[12px] font-semibold bg-nim-selected text-nim-primary hover:bg-nim-active"
            onClick={onClose}
            data-testid="customize-gutter-done"
          >
            Done
          </button>
        </div>
      </div>
    </FloatingPortal>
  );
}
