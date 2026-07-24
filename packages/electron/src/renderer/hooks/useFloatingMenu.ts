/**
 * useFloatingMenu - Shared hook for positioning dropdown menus and popovers.
 *
 * Wraps @floating-ui/react with standard defaults:
 * - flip() to avoid viewport overflow
 * - shift() to keep menu within viewport bounds
 * - offset() for spacing from trigger
 * - useDismiss() for click-outside and Escape key handling
 * - FloatingPortal for escaping overflow:hidden ancestors
 *
 * Usage (trigger-based dropdown):
 *   const menu = useFloatingMenu({ placement: 'bottom-start' });
 *   <button ref={menu.refs.setReference} {...menu.getReferenceProps()} onClick={() => menu.setIsOpen(!menu.isOpen)}>
 *   {menu.isOpen && <FloatingPortal><div ref={menu.refs.setFloating} style={menu.floatingStyles} {...menu.getFloatingProps()}>...</div></FloatingPortal>}
 *
 * Usage (context menu at click coordinates):
 *   const menu = useFloatingMenu({ placement: 'right-start' });
 *   const handleContextMenu = (e) => {
 *     menu.refs.setPositionReference(virtualElement(e.clientX, e.clientY));
 *     menu.setIsOpen(true);
 *   };
 */

import { useState, useMemo, useLayoutEffect } from 'react';
import {
  useFloating,
  useInteractions,
  useDismiss,
  useRole,
  offset,
  flip,
  shift,
  size,
  autoUpdate,
  type Placement,
  type ReferenceElement,
  type UseFloatingReturn,
  type Strategy,
} from '@floating-ui/react';

export { FloatingPortal } from '@floating-ui/react';

export interface UseFloatingMenuOptions {
  /** Where to place the menu relative to the trigger. Default: 'bottom-start' */
  placement?: Placement;
  /** Offset distance from trigger in px. Default: 4 */
  offsetPx?: number;
  /** Padding from viewport edges in px. Default: 8 */
  viewportPadding?: number;
  /** Positioning strategy. Default: 'fixed' (works with portals) */
  strategy?: Strategy;
  /** Whether to constrain max-height to available space. Default: true */
  constrainHeight?: boolean;
  /** Optional precomputed reference element for initial positioning. */
  reference?: ReferenceElement | null;
  /** External open state control. If provided, the hook uses this instead of internal state. */
  open?: boolean;
  /** External open state setter. Required when `open` is provided. */
  onOpenChange?: (open: boolean) => void;
}

export interface UseFloatingMenuReturn {
  /** Whether the menu is open */
  isOpen: boolean;
  /** Toggle or set open state */
  setIsOpen: (open: boolean) => void;
  /** Ref setters for trigger (setReference) and menu (setFloating) elements */
  refs: UseFloatingReturn['refs'];
  /** Inline styles to apply to the floating menu element */
  floatingStyles: UseFloatingReturn['floatingStyles'];
  /** Props to spread on the trigger element */
  getReferenceProps: () => Record<string, unknown>;
  /** Props to spread on the floating menu element */
  getFloatingProps: () => Record<string, unknown>;
  /** The floating-ui context (needed for advanced use cases) */
  context: UseFloatingReturn['context'];
}

/**
 * Create a virtual reference element from x/y coordinates.
 * Use this for context menus positioned at the click point.
 */
export function virtualElement(x: number, y: number) {
  return {
    getBoundingClientRect: () => ({
      x,
      y,
      width: 0,
      height: 0,
      top: y,
      left: x,
      right: x,
      bottom: y,
    }),
  };
}

export function useFloatingMenu(options: UseFloatingMenuOptions = {}): UseFloatingMenuReturn {
  const {
    placement = 'bottom-start',
    offsetPx = 4,
    viewportPadding = 8,
    strategy = 'fixed',
    constrainHeight = true,
    reference = null,
    open: controlledOpen,
    onOpenChange: controlledOnOpenChange,
  } = options;

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;
  const setIsOpen = isControlled ? controlledOnOpenChange! : setInternalOpen;

  const middleware = useMemo(() => {
    const mw = [
      offset(offsetPx),
      flip({ padding: viewportPadding }),
      shift({ padding: viewportPadding }),
    ];
    if (constrainHeight) {
      mw.push(
        size({
          padding: viewportPadding,
          apply({ availableHeight, elements }) {
            elements.floating.style.maxHeight = `${availableHeight}px`;
          },
        })
      );
    }
    return mw;
  }, [offsetPx, viewportPadding, constrainHeight]);

  const floating = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement,
    strategy,
    middleware,
    whileElementsMounted: autoUpdate,
  });

  useLayoutEffect(() => {
    if (reference) {
      floating.refs.setPositionReference(reference);
    }
  }, [reference, floating.refs]);

  const dismiss = useDismiss(floating.context);
  const role = useRole(floating.context, { role: 'menu' });

  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);

  return {
    isOpen,
    setIsOpen,
    refs: floating.refs,
    floatingStyles: floating.floatingStyles,
    getReferenceProps,
    getFloatingProps,
    context: floating.context,
  };
}
