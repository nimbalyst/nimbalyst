/**
 * In-window menu bar for Windows/Linux.
 *
 * Workspace windows are frameless there (see `main/window/windowChrome.ts`), so
 * the native File/Edit/View strip is hidden. This renders the same menu inside
 * the custom title bar, driven by the serialized model in `windowMenuBarAtom`
 * — `main/menu/ApplicationMenu.ts` remains the only place the menu is defined.
 *
 * macOS serves an empty model (the system menu bar already shows it), so this
 * renders nothing there.
 *
 * Nesting uses @floating-ui/react's FloatingTree so a click inside a submenu
 * portal doesn't read as an outside-press on its parent.
 */

import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  FloatingFocusManager,
  FloatingList,
  FloatingNode,
  FloatingPortal,
  FloatingTree,
  autoUpdate,
  flip,
  offset,
  safePolygon,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useFloatingNodeId,
  useHover,
  useInteractions,
  useListItem,
  useListNavigation,
  useMergeRefs,
  useRole,
} from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { SerializedMenuItem } from '../../../shared/menuBar';
import { windowMenuBarAtom } from '../../store/atoms/windowMenu';
import { NO_DRAG_REGION } from './dragRegion';
import './WindowMenuBar.css';

interface MenuBarContextValue {
  revision: number;
  closeAll: () => void;
}

const MenuBarContext = createContext<MenuBarContextValue>({
  revision: 0,
  closeAll: () => {},
});

interface MenuListContextValue {
  getItemProps: (props?: React.HTMLProps<HTMLElement>) => Record<string, unknown>;
  activeIndex: number | null;
}

/** Per-list interaction props, so items don't have to be prop-drilled. */
const MenuListContext = createContext<MenuListContextValue>({
  getItemProps: () => ({}),
  activeIndex: null,
});

function menuMiddleware(placement: 'bottom-start' | 'right-start') {
  return [
    offset(placement === 'bottom-start' ? 2 : { mainAxis: 0, alignmentAxis: -4 }),
    flip({ padding: 8 }),
    shift({ padding: 8 }),
    windowControlsClearance(),
    size({
      padding: 8,
      apply({ availableHeight, elements, middlewareData }) {
        const pushed = middlewareData.windowControlsClearance?.pushed ?? 0;
        elements.floating.style.maxHeight = `${Math.max(160, availableHeight - pushed)}px`;
      },
    }),
  ];
}

function MenuSeparator() {
  return <div className="window-menu-bar__separator" role="separator" />;
}

function ItemAffordances({ item }: { item: SerializedMenuItem }) {
  return (
    <>
      <span className="window-menu-bar__item-check" aria-hidden="true">
        {item.checked === true && <MaterialSymbol icon="check" size={15} />}
      </span>
      <span className="window-menu-bar__item-label">{item.label}</span>
      {item.acceleratorLabel && (
        <span className="window-menu-bar__item-accelerator">{item.acceleratorLabel}</span>
      )}
    </>
  );
}

function CommandItem({ item }: { item: SerializedMenuItem }) {
  const { revision, closeAll } = useContext(MenuBarContext);
  const { ref, index } = useListItem();
  const { getItemProps, activeIndex } = useContext(MenuListContext);

  const disabled = !item.enabled;

  return (
    <button
      ref={ref}
      type="button"
      role={item.type === 'checkbox' || item.type === 'radio' ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={item.type === 'normal' ? undefined : item.checked === true}
      aria-disabled={disabled || undefined}
      tabIndex={activeIndex === index ? 0 : -1}
      className="window-menu-bar__item"
      data-testid={`window-menu-item-${item.id}`}
      data-disabled={disabled}
      {...getItemProps({
        onClick: () => {
          if (disabled) return;
          void window.electronAPI?.invokeWindowMenuItem?.(item.id, revision);
          closeAll();
        },
      })}
    >
      <ItemAffordances item={item} />
    </button>
  );
}

function MenuItems({ items }: { items: SerializedMenuItem[] }) {
  return (
    <>
      {items.map((item) => {
        if (item.type === 'separator') return <MenuSeparator key={item.id} />;
        if (item.type === 'submenu') return <SubMenu key={item.id} item={item} />;
        return <CommandItem key={item.id} item={item} />;
      })}
    </>
  );
}

function SubMenu({ item }: { item: SerializedMenuItem }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const nodeId = useFloatingNodeId();
  const elementsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const parentList = useContext(MenuListContext);
  const { ref: itemRef, index: itemIndex } = useListItem();

  const { refs, floatingStyles, context } = useFloating({
    nodeId,
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'right-start',
    strategy: 'fixed',
    middleware: menuMiddleware('right-start'),
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, { handleClose: safePolygon({ blockPointerEvents: true }) });
  const click = useClick(context, { toggle: true, ignoreMouse: true });
  const dismiss = useDismiss(context, { bubbles: true });
  const role = useRole(context, { role: 'menu' });
  const listNavigation = useListNavigation(context, {
    listRef: elementsRef,
    activeIndex,
    nested: true,
    onNavigate: setActiveIndex,
    loop: true,
  });

  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    hover,
    click,
    dismiss,
    role,
    listNavigation,
  ]);

  const mergedTriggerRef = useMergeRefs([refs.setReference, itemRef]);
  const disabled = !item.enabled;

  return (
    <FloatingNode id={nodeId}>
      <button
        ref={mergedTriggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-disabled={disabled || undefined}
        tabIndex={parentList.activeIndex === itemIndex ? 0 : -1}
        className="window-menu-bar__item"
        data-testid={`window-menu-item-${item.id}`}
        data-disabled={disabled}
        data-submenu-open={isOpen}
        {...parentList.getItemProps(getReferenceProps())}
      >
        <ItemAffordances item={item} />
        <MaterialSymbol icon="chevron_right" size={16} />
      </button>
      {isOpen && !disabled && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1} returnFocus>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              className="window-menu-bar__menu"
              data-testid={`window-menu-submenu-${item.id}`}
              {...getFloatingProps()}
            >
              <MenuListContext.Provider value={{ getItemProps, activeIndex }}>
                <FloatingList elementsRef={elementsRef}>
                  <MenuItems items={item.submenu ?? []} />
                </FloatingList>
              </MenuListContext.Provider>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </FloatingNode>
  );
}

function TopLevelMenu({
  item,
  isOpen,
  onOpenChange,
  onHoverWhileBarActive,
}: {
  item: SerializedMenuItem;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onHoverWhileBarActive: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const nodeId = useFloatingNodeId();
  const elementsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const { refs, floatingStyles, context } = useFloating({
    nodeId,
    open: isOpen,
    onOpenChange,
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: menuMiddleware('bottom-start'),
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context, { toggle: true });
  const dismiss = useDismiss(context, { bubbles: false });
  const role = useRole(context, { role: 'menu' });
  const listNavigation = useListNavigation(context, {
    listRef: elementsRef,
    activeIndex,
    onNavigate: setActiveIndex,
    loop: true,
  });

  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    click,
    dismiss,
    role,
    listNavigation,
  ]);

  return (
    <FloatingNode id={nodeId}>
      <button
        ref={refs.setReference}
        type="button"
        className={`window-menu-bar__top-item ${NO_DRAG_REGION}`}
        data-testid={`window-menu-top-${item.id}`}
        data-open={isOpen}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        {...getReferenceProps({
          // Classic menu-bar behavior: once a menu is open, sliding across the
          // bar switches menus without another click.
          onMouseEnter: onHoverWhileBarActive,
        })}
      >
        {item.label}
      </button>
      {isOpen && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1} returnFocus>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              className="window-menu-bar__menu"
              data-testid={`window-menu-dropdown-${item.id}`}
              {...getFloatingProps()}
            >
              <MenuListContext.Provider value={{ getItemProps, activeIndex }}>
                <FloatingList elementsRef={elementsRef}>
                  <MenuItems items={item.submenu ?? []} />
                </FloatingList>
              </MenuListContext.Provider>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </FloatingNode>
  );
}

export function WindowMenuBar() {
  const menuBar = useAtomValue(windowMenuBarAtom);
  const [openId, setOpenId] = useState<string | null>(null);

  const closeAll = useCallback(() => setOpenId(null), []);

  if (!menuBar.inWindow || menuBar.items.length === 0) return null;

  return (
    <MenuBarContext.Provider value={{ revision: menuBar.revision, closeAll }}>
      <nav
        className="window-menu-bar"
        data-component="WindowMenuBar"
        data-testid="window-menu-bar"
        aria-label="Application menu"
      >
        <FloatingTree>
          {menuBar.items.map((item) => (
            <TopLevelMenu
              key={item.id}
              item={item}
              isOpen={openId === item.id}
              onOpenChange={(open) => setOpenId(open ? item.id : null)}
              onHoverWhileBarActive={() => {
                setOpenId((current) => (current === null ? current : item.id));
              }}
            />
          ))}
        </FloatingTree>
      </nav>
    </MenuBarContext.Provider>
  );
}
