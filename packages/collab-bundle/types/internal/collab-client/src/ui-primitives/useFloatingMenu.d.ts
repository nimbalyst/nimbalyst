import { type Placement, type ReferenceElement, type Strategy, type UseDismissProps, type UseFloatingReturn } from '@floating-ui/react';
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
export declare function virtualElement(x: number, y: number): ReferenceElement;
export declare function useFloatingMenu(options?: UseFloatingMenuOptions): UseFloatingMenuReturn;
