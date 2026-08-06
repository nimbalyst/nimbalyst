import { useLayoutEffect, useMemo, useState } from 'react';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  type Placement,
  type ReferenceElement,
  type Strategy,
  type UseDismissProps,
  type UseFloatingReturn,
} from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';

export { FloatingPortal } from '@floating-ui/react';

export interface UseFloatingMenuOptions {
  placement?: Placement;
  offsetPx?: number;
  viewportPadding?: number;
  strategy?: Strategy;
  constrainHeight?: boolean;
  reference?: ReferenceElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  dismiss?: UseDismissProps;
}

export interface UseFloatingMenuReturn {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  refs: UseFloatingReturn['refs'];
  floatingStyles: UseFloatingReturn['floatingStyles'];
  getReferenceProps: () => Record<string, unknown>;
  getFloatingProps: () => Record<string, unknown>;
  context: UseFloatingReturn['context'];
}

export function virtualElement(x: number, y: number): ReferenceElement {
  return {
    getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }),
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
    onOpenChange,
    dismiss: dismissOptions,
  } = options;
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen ?? internalOpen;
  const setIsOpen = controlledOpen === undefined ? setInternalOpen : (onOpenChange ?? (() => undefined));
  const middleware = useMemo(() => {
    const result = [
      offset(offsetPx),
      flip({ padding: viewportPadding }),
      shift({ padding: viewportPadding }),
      windowControlsClearance(),
    ];
    if (constrainHeight) {
      result.push(size({
        padding: viewportPadding,
        apply({ availableHeight, elements, middlewareData }) {
          const pushed = middlewareData.windowControlsClearance?.pushed ?? 0;
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight - pushed)}px`;
        },
      }));
    }
    return result;
  }, [constrainHeight, offsetPx, viewportPadding]);
  const floating = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement,
    strategy,
    middleware,
    whileElementsMounted: autoUpdate,
  });
  useLayoutEffect(() => {
    if (reference) floating.refs.setPositionReference(reference);
  }, [floating.refs, reference]);
  const dismiss = useDismiss(floating.context, dismissOptions);
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
