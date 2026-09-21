/**
 * The board's zoom control, bottom right.
 *
 * Replaces React Flow's stock `<Controls>`, which offers zoom in, zoom out, fit
 * and a lock button and no way to say "100%". The readout is the interesting
 * part: it is a live percentage *and* the button that opens the preset menu, so
 * the number a user reads and the control they reach for are the same target.
 *
 * The zoom is read from React Flow's store rather than passed in as a prop.
 * The surface only keeps a *bucketed* zoom (see `canvasZoomBucket`) because
 * that is all level-of-detail needs, and a readout fed from buckets would sit at
 * "75%" through half a pinch. Subscribing here also keeps every wheel tick to a
 * re-render of this widget instead of the whole board.
 *
 * The menu is `@floating-ui/react` through a `FloatingPortal`: a React Flow
 * `Panel` sits inside the surface's clipping box, so a menu that opens upward
 * from the bottom-right corner would be cut off if it rendered in place.
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import {
  FloatingFocusManager,
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
import { Panel, useStore } from '@xyflow/react';

import { MaterialSymbol } from '../ui/icons/MaterialSymbol';
import type { CanvasPanelToggle } from './canvasPanelState';

export interface CanvasZoomWidgetProps {
  navigation?: ReactNode;
  minimap: boolean;
  gridSnap: boolean;
  smartGuides: boolean;
  onToggle(pref: CanvasPanelToggle): void;
  /** Absolute scale, already clamped by the caller to the board's limits. */
  onZoomTo(scale: number): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onFitAll(): void;
  onFitSelection(): void;
  /** Jump to the board's saved home view, when it has one. */
  onSavedView(): void;
  hasSavedView: boolean;
}

const PRESETS: readonly { scale: number; shortcut?: string }[] = [
  { scale: 0.25 },
  { scale: 0.5 },
  { scale: 1, shortcut: 'Mod+0' },
  { scale: 2 },
];

function MenuItem({
  label,
  shortcut,
  checked,
  onSelect,
}: {
  label: string;
  shortcut?: string;
  checked?: boolean;
  onSelect(): void;
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      className="canvas-zoom-widget__item"
      aria-checked={checked}
      onClick={onSelect}
    >
      <span className="canvas-zoom-widget__item-check" aria-hidden>
        {checked === true ? <MaterialSymbol icon="check" size={14} /> : null}
      </span>
      <span className="canvas-zoom-widget__item-label">{label}</span>
      {shortcut !== undefined && (
        <span className="canvas-zoom-widget__item-shortcut">{shortcut}</span>
      )}
    </button>
  );
}

function IconButton({
  icon,
  label,
  pressed,
  onClick,
}: {
  icon: string;
  label: string;
  pressed?: boolean;
  onClick(): void;
}): ReactElement {
  return (
    <button
      type="button"
      className={
        pressed === true
          ? 'canvas-zoom-widget__button canvas-zoom-widget__button--on'
          : 'canvas-zoom-widget__button'
      }
      data-canvas-help={`canvas-zoom-${icon.replace(/_/g, '-')}`}
      data-testid={`canvas-zoom-${icon.replace(/_/g, '-')}`}
      aria-label={label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      onClick={onClick}
    >
      <MaterialSymbol icon={icon} size={16} />
    </button>
  );
}

export function CanvasZoomWidget({
  minimap,
  gridSnap,
  smartGuides,
  onToggle,
  onZoomTo,
  onZoomIn,
  onZoomOut,
  onFitAll,
  onFitSelection,
  onSavedView,
  hasSavedView,
  navigation,
}: CanvasZoomWidgetProps): ReactElement {
  const zoom = useStore((state) => state.transform[2]);
  const [open, setOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context),
    useDismiss(context),
    useRole(context, { role: 'menu' }),
  ]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  const percent = `${Math.round(zoom * 100)}%`;

  return (
    <Panel
      position={navigation ? 'bottom-center' : 'bottom-right'}
      className="canvas-zoom-widget"
    >
      {navigation}
      <IconButton
        icon="map"
        label="Minimap"
        pressed={minimap}
        onClick={() => onToggle('minimap')}
      />
      <span className="canvas-zoom-widget__separator" aria-hidden />
      <IconButton icon="remove" label="Zoom out" onClick={onZoomOut} />
      <button
        type="button"
        ref={refs.setReference}
        className="canvas-zoom-widget__readout"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Zoom ${percent}`}
        data-canvas-help="canvas-zoom-options"
        data-testid="canvas-zoom-options"
        {...getReferenceProps()}
      >
        {percent}
      </button>
      <IconButton icon="add" label="Zoom in" onClick={onZoomIn} />
      <IconButton icon="fit_screen" label="Fit board" onClick={onFitAll} />

      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              className="canvas-zoom-widget__menu"
              style={floatingStyles}
              {...getFloatingProps()}
            >
              {PRESETS.map((preset) => (
                <MenuItem
                  key={preset.scale}
                  label={`${Math.round(preset.scale * 100)}%`}
                  {...(preset.shortcut === undefined
                    ? {}
                    : { shortcut: preset.shortcut })}
                  onSelect={choose(() => onZoomTo(preset.scale))}
                />
              ))}
              <Separator />
              <MenuItem
                label="Fit all"
                shortcut="Shift+1"
                onSelect={choose(onFitAll)}
              />
              <MenuItem
                label="Zoom to selection"
                shortcut="Shift+2"
                onSelect={choose(onFitSelection)}
              />
              {hasSavedView && (
                <MenuItem
                  label="Saved view"
                  shortcut="Shift+0"
                  onSelect={choose(onSavedView)}
                />
              )}
              <Separator />
              <MenuItem
                label="Snap to grid"
                checked={gridSnap}
                onSelect={choose(() => onToggle('gridSnap'))}
              />
              <MenuItem
                label="Smart guides"
                checked={smartGuides}
                onSelect={choose(() => onToggle('smartGuides'))}
              />
              <MenuItem
                label="Minimap"
                checked={minimap}
                onSelect={choose(() => onToggle('minimap'))}
              />
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </Panel>
  );
}

function Separator(): ReactNode {
  return (
    <div className="canvas-zoom-widget__menu-separator" role="separator" />
  );
}
