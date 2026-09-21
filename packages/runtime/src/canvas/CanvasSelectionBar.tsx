/**
 * The board's one contextual action bar.
 *
 * It replaces the per-card `NodeToolbar` outright. Two reasons that matter
 * beyond tidiness:
 *
 * 1. **A per-card toolbar cannot describe a multi-card selection.** Align,
 *    distribute, tidy, and group only mean anything against a set, and a
 *    toolbar anchored to one card has nowhere to put them.
 * 2. **It is outside the viewport transform.** The bar renders through React
 *    Flow's `Panel`, which sits in the flow's untransformed chrome layer, so
 *    its own popovers are positioned in screen pixels. Anchoring chrome inside
 *    the transform gives scaled coordinates -- the same hazard that keeps a
 *    card's content pointer-inert until it is activated at scale 1.0.
 *
 * Every button is derived from the command registry's `enabled` predicate: a
 * command that cannot run is not rendered at all, so the bar's width tracks
 * what the selection can actually do rather than showing a row of dead
 * buttons. Colour, comment, and history are the exceptions -- they are not
 * registry commands because they take an argument or open a host surface, so
 * they arrive as callbacks and gate on the selection's own shape.
 */
import { useMemo, useRef, useState } from 'react';
import { Panel } from '@xyflow/react';
import {
  FloatingFocusManager,
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole,
} from '@floating-ui/react';

import {
  getCommand,
  type CanvasCommandContext,
  type CanvasCommandId,
  type CanvasCommandRunner,
} from './canvasCommands';
import { canvasCardKind } from './canvasFlowMapping';
import { CANVAS_PRESET_COLORS, canvasColorValue } from './CanvasCardNode';
import type { CanvasAnyNode } from './CanvasDocument';
import './CanvasSelectionBar.css';

export interface CanvasSelectionBarProps {
  /** The selected nodes, in board order. Duplicated in `ctx` for the registry. */
  selection: readonly CanvasAnyNode[];
  ctx: CanvasCommandContext;
  run: CanvasCommandRunner;
  /** Write `color` onto every selected card; `null` clears it. */
  onColor(color: string | null): void;
  /**
   * Open a comment thread on the single selected card. Omitted by hosts that
   * cannot comment -- the button hides rather than opening an empty thread.
   */
  onComment?(): void;
  /**
   * Reveal the single selected reference card's revision rail. Omitted when the
   * host has no revisions source, for the same reason.
   */
  onHistory?(): void;
}

/** The cards whose colour the bar offers to change. */
const COLORABLE_KINDS = new Set(['sticky', 'text', 'group']);

/** Must match `grid-template-columns` on `.canvas-selection-bar__colors`. */
const COLOR_GRID_COLUMNS = 4;

const ALIGN_COMMANDS: ReadonlyArray<{ id: CanvasCommandId; label: string }> = [
  { id: 'align-left', label: 'Left' },
  { id: 'align-center-x', label: 'Center' },
  { id: 'align-right', label: 'Right' },
  { id: 'align-top', label: 'Top' },
  { id: 'align-center-y', label: 'Middle' },
  { id: 'align-bottom', label: 'Bottom' },
];

const DISTRIBUTE_COMMANDS: ReadonlyArray<{
  id: CanvasCommandId;
  label: string;
}> = [
  { id: 'distribute-x', label: 'Horizontally' },
  { id: 'distribute-y', label: 'Vertically' },
];

export function CanvasSelectionBar({
  selection,
  ctx,
  run,
  onColor,
  onComment,
  onHistory,
}: CanvasSelectionBarProps) {
  const enabled = useMemo(() => {
    const cache = new Map<CanvasCommandId, boolean>();
    return (id: CanvasCommandId): boolean => {
      const hit = cache.get(id);
      if (hit !== undefined) return hit;
      const result = getCommand(id).enabled(ctx);
      cache.set(id, result);
      return result;
    };
  }, [ctx]);

  if (selection.length === 0 || ctx.readOnly || ctx.activeCardId !== null) {
    return null;
  }

  const single = selection.length === 1 ? selection[0] : null;
  const colorable =
    selection.length > 0 &&
    selection.every((node) => COLORABLE_KINDS.has(canvasCardKind(node)));
  const alignable = ALIGN_COMMANDS.some((entry) => enabled(entry.id));
  const distributable = DISTRIBUTE_COMMANDS.some((entry) => enabled(entry.id));
  const singleKind = single === null ? null : canvasCardKind(single);

  return (
    <Panel position="top-center" className="canvas-selection-bar">
      {selection.length > 1 && (
        <span className="canvas-selection-bar__count">
          {selection.length} selected
        </span>
      )}

      {colorable && (
        <>
          {selection.length > 1 && <Separator />}
          <ColorControl
            current={
              single !== null
                ? (single.color as string | undefined) ?? null
                : null
            }
            onColor={onColor}
          />
        </>
      )}

      {(alignable || distributable || enabled('tidy')) && <Separator />}
      {alignable && (
        <MenuButton
          label="Align"
          items={ALIGN_COMMANDS.filter((entry) => enabled(entry.id))}
          run={run}
        />
      )}
      {distributable && (
        <MenuButton
          label="Distribute"
          items={DISTRIBUTE_COMMANDS.filter((entry) => enabled(entry.id))}
          run={run}
        />
      )}
      <CommandButton id="tidy" enabled={enabled} run={run} />
      <CommandButton id="group" enabled={enabled} run={run} />
      <CommandButton id="ungroup" enabled={enabled} run={run} />

      <Separator />
      <CommandButton id="lock" enabled={enabled} run={run} />
      <CommandButton id="unlock" enabled={enabled} run={run} />
      <CommandButton id="duplicate" enabled={enabled} run={run} />
      <CommandButton id="bring-front" enabled={enabled} run={run} />
      <CommandButton id="send-back" enabled={enabled} run={run} />

      {single !== null && onComment !== undefined && (
        <button
          type="button"
          className="canvas-selection-bar__button"
          onClick={() => onComment()}
          data-canvas-help="canvas-selection-comment"
          data-testid="canvas-selection-comment"
        >
          Comment
        </button>
      )}
      {single !== null && singleKind === 'reference' && onHistory !== undefined && (
        <button
          type="button"
          className="canvas-selection-bar__button"
          onClick={() => onHistory()}
          data-canvas-help="canvas-selection-history"
          data-testid="canvas-selection-history"
        >
          History
        </button>
      )}

      {enabled('delete') && (
        <>
          <Separator />
          <CommandButton id="delete" enabled={enabled} run={run} danger />
        </>
      )}
    </Panel>
  );
}

function Separator() {
  return <span className="canvas-selection-bar__separator" aria-hidden />;
}

/**
 * Roving-focus bookkeeping shared by every menu on the board, including the
 * context menu's.
 *
 * A menu that opens without moving focus is a menu a keyboard cannot reach:
 * the trigger keeps focus, arrows do nothing, and Tab walks the rest of the
 * toolbar before it ever arrives at the portalled list. The `focusItemOnOpen`
 * option below is what fixes that, and it is `true` rather than the default
 * `'auto'` on purpose -- `'auto'` only moves focus for keyboard-opened menus,
 * which would make a clicked menu behave differently from an Enter-opened one.
 *
 * The list itself owns focus, so nothing here calls `.focus()`: doing both
 * races floating-ui's own effect, which runs after this hook's and wins.
 */
export function useCanvasMenuNavigation() {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const listRef = useRef<Array<HTMLElement | null>>([]);
  return { listRef, activeIndex, setActiveIndex };
}

/** Shared `useListNavigation` options; see {@link useCanvasMenuNavigation}. */
export const CANVAS_MENU_NAVIGATION = {
  loop: true,
  focusItemOnOpen: true,
} as const;

/**
 * One registry-backed button. Renders nothing when the command is disabled --
 * the bar shows what the selection can do, not what it cannot.
 */
function CommandButton({
  id,
  enabled,
  run,
  danger = false,
}: {
  id: CanvasCommandId;
  enabled: (id: CanvasCommandId) => boolean;
  run: CanvasCommandRunner;
  danger?: boolean;
}) {
  if (!enabled(id)) return null;
  const command = getCommand(id);
  return (
    <button
      type="button"
      className={`canvas-selection-bar__button${
        danger ? ' canvas-selection-bar__button--danger' : ''
      }`}
      data-canvas-help={`canvas-command-${id}`}
      data-testid={`canvas-command-${id}`}
      onClick={() => run(id)}
    >
      {command.label}
    </button>
  );
}

function commandTitle(label: string, shortcut?: string): string {
  return shortcut === undefined ? label : `${label} (${shortcut})`;
}

/** A dropdown of registry commands, e.g. the six align edges. */
function MenuButton({
  label,
  items,
  run,
}: {
  label: string;
  items: ReadonlyArray<{ id: CanvasCommandId; label: string }>;
  run: CanvasCommandRunner;
}) {
  const [open, setOpen] = useState(false);
  const { listRef, activeIndex, setActiveIndex } = useCanvasMenuNavigation();
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    useDismiss(context),
    useRole(context, { role: 'menu' }),
    useListNavigation(context, {
      listRef,
      activeIndex,
      onNavigate: setActiveIndex,
      ...CANVAS_MENU_NAVIGATION,
    }),
  ]);

  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        className={`canvas-selection-bar__button${
          open ? ' canvas-selection-bar__button--open' : ''
        }`}
        aria-expanded={open}
        aria-haspopup="menu"
        data-canvas-help={`canvas-selection-${label.toLowerCase()}`}
        data-testid={`canvas-selection-${label.toLowerCase()}`}
        {...getReferenceProps({ onClick: () => setOpen((was) => !was) })}
      >
        {label}
      </button>
      {open && (
        <FloatingPortal>
          {/* `initialFocus={-1}` because the hook above places focus itself;
              letting the manager also pick would race it. `returnFocus` is
              what sends Escape back to the trigger. */}
          <FloatingFocusManager
            context={context}
            modal={false}
            initialFocus={-1}
          >
            <div
              ref={refs.setFloating}
              className="canvas-selection-bar__menu"
              style={floatingStyles}
              {...getFloatingProps()}
            >
              {items.map((item, index) => {
                const command = getCommand(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    ref={(element) => {
                      listRef.current[index] = element;
                    }}
                    tabIndex={activeIndex === index ? 0 : -1}
                    className="canvas-selection-bar__menu-item"
                    {...getItemProps({
                      onClick: () => {
                        setOpen(false);
                        run(item.id);
                      },
                    })}
                  >
                    <span>{item.label}</span>
                    {command.shortcut !== undefined && (
                      <span className="canvas-selection-bar__menu-shortcut">
                        {command.shortcut}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

/**
 * The swatch plus its preset popover.
 *
 * The six JSON Canvas presets are written back as the index strings the spec
 * defines ("1".."6"), not as hex, so a board edited here still reads as spec
 * colours in another tool. A card already carrying a custom hex keeps that hex
 * as a seventh swatch so re-picking it is not a trip through a colour input.
 */
function ColorControl({
  current,
  onColor,
}: {
  current: string | null;
  onColor(color: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const { listRef, activeIndex, setActiveIndex } = useCanvasMenuNavigation();
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    useDismiss(context),
    useRole(context, { role: 'menu' }),
    // The swatches are laid out as a four-column grid, so arrows have to move
    // by a row vertically rather than one item at a time.
    useListNavigation(context, {
      listRef,
      activeIndex,
      onNavigate: setActiveIndex,
      cols: COLOR_GRID_COLUMNS,
      orientation: 'both',
      ...CANVAS_MENU_NAVIGATION,
    }),
  ]);

  const custom =
    current !== null && CANVAS_PRESET_COLORS[current] === undefined
      ? current
      : null;
  const swatch = canvasColorValue(current);

  const chips: Array<{
    key: string;
    label: string;
    background: string | null;
    selected: boolean;
    onSelect(): void;
  }> = [
    ...Object.entries(CANVAS_PRESET_COLORS).map(([preset, hex]) => ({
      key: preset,
      label: `Color ${preset}`,
      background: hex,
      selected: current === preset,
      onSelect: () => onColor(preset),
    })),
    ...(custom !== null
      ? [
          {
            key: 'custom',
            label: `Custom color ${custom}`,
            background: custom,
            selected: true,
            onSelect: () => undefined,
          },
        ]
      : []),
    {
      key: 'none',
      label: 'No color',
      background: null,
      selected: current === null,
      onSelect: () => onColor(null),
    },
  ];

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        className="canvas-selection-bar__button canvas-selection-bar__color"
        aria-expanded={open}
        aria-haspopup="menu"
        data-canvas-help="canvas-selection-color"
        data-testid="canvas-selection-color"
        {...getReferenceProps({ onClick: () => setOpen((was) => !was) })}
      >
        <span
          className="canvas-selection-bar__swatch"
          style={
            swatch !== null ? { background: swatch } : undefined
          }
        />
        Color
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager
            context={context}
            modal={false}
            initialFocus={-1}
          >
            <div
              ref={refs.setFloating}
              className="canvas-selection-bar__colors"
              style={floatingStyles}
              {...getFloatingProps()}
            >
              {chips.map((chip, index) => (
                <button
                  key={chip.key}
                  type="button"
                  role="menuitem"
                  ref={(element) => {
                    listRef.current[index] = element;
                  }}
                  tabIndex={activeIndex === index ? 0 : -1}
                  className={[
                    'canvas-selection-bar__color-chip',
                    chip.selected
                      ? 'canvas-selection-bar__color-chip--current'
                      : '',
                    chip.background === null
                      ? 'canvas-selection-bar__color-chip--none'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={
                    chip.background !== null
                      ? { background: chip.background }
                      : undefined
                  }
                  aria-label={chip.label}
                  {...getItemProps({
                    onClick: () => {
                      setOpen(false);
                      chip.onSelect();
                    },
                  })}
                />
              ))}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
