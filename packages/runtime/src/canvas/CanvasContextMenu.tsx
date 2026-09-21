/**
 * The board's right-click menu, in two shapes.
 *
 * Both shapes are read out of the same command registry the selection bar and
 * the keyboard map read, so an action appears here with the same label,
 * shortcut, and `enabled` rule it has everywhere else. A disabled command is
 * not rendered: a menu of greyed lines is a worse answer than a short menu.
 *
 * Positioning is a floating-ui virtual reference at the pointer rather than a
 * `position: fixed` div. The board sits under a CSS transform and inside a
 * scrolling tab, and hand-computed coordinates break at both -- the same
 * reason the selection bar lives outside the viewport transform.
 *
 * The items are built as a flat description list and only then rendered into
 * separator-delimited sections. Roving focus needs one contiguous index space
 * across the whole menu, and a tree of nested JSX groups cannot supply one
 * without every group knowing how many items came before it.
 *
 * Clipboard is deliberately absent from this slice. `onCopy` / `onCut` /
 * `onPaste` are optional and their items hide when the host does not pass
 * them; nothing in the canvas implements a clipboard yet. Cut and Paste are
 * additionally gated on `readOnly` -- they mutate the board, and a host that
 * supplies the callbacks once must not keep offering them after the board
 * turns read-only. Copy is safe either way.
 */
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
} from 'react';
import {
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useMergeRefs,
  useRole,
  type VirtualElement,
} from '@floating-ui/react';

import {
  getCommand,
  type CanvasCommandContext,
  type CanvasCommandId,
  type CanvasCommandRunner,
} from './canvasCommands';
import {
  CANVAS_MENU_NAVIGATION,
  useCanvasMenuNavigation,
} from './CanvasSelectionBar';
import './CanvasSelectionBar.css';

/** A point in client (viewport) coordinates -- what a pointer event reports. */
export interface CanvasContextMenuAnchor {
  x: number;
  y: number;
}

export type CanvasContextMenuKind = 'selection' | 'canvas';

export interface CanvasContextMenuProps {
  /** Null closes the menu. */
  anchor: CanvasContextMenuAnchor | null;
  kind: CanvasContextMenuKind;
  ctx: CanvasCommandContext;
  run: CanvasCommandRunner;
  onClose(): void;
  onCopy?(): void;
  /** Mutates the board, so it is also gated on `ctx.readOnly`. */
  onCut?(): void;
  /** Mutates the board, so it is also gated on `ctx.readOnly`. */
  onPaste?(): void;
  onOpenScreenshot?(path: string): void;
  /** Create a sticky at the right-clicked point (client coordinates). */
  onAddSticky(at: CanvasContextMenuAnchor): void;
  /** Drop a comment pin at the right-clicked point (client coordinates). */
  onAddComment(at: CanvasContextMenuAnchor): void;
}

const ALIGN_ITEMS: ReadonlyArray<{ id: CanvasCommandId; label: string }> = [
  { id: 'align-left', label: 'Left' },
  { id: 'align-center-x', label: 'Center' },
  { id: 'align-right', label: 'Right' },
  { id: 'align-top', label: 'Top' },
  { id: 'align-center-y', label: 'Middle' },
  { id: 'align-bottom', label: 'Bottom' },
];

const DISTRIBUTE_ITEMS: ReadonlyArray<{ id: CanvasCommandId; label: string }> =
  [
    { id: 'distribute-x', label: 'Horizontally' },
    { id: 'distribute-y', label: 'Vertically' },
  ];

/** One rendered line, described before it is placed in the index space. */
type MenuEntry =
  | {
      kind: 'item';
      key: string;
      label: string;
      shortcut?: string;
      danger?: boolean;
      onSelect(): void;
    }
  | {
      kind: 'submenu';
      key: string;
      label: string;
      items: ReadonlyArray<{ id: CanvasCommandId; label: string }>;
      onSelect(id: CanvasCommandId): void;
    };

/**
 * Menu open/close state, so the surface wires two React Flow handlers in one
 * line each rather than repeating the pointer bookkeeping.
 */
export interface CanvasContextMenuState {
  anchor: CanvasContextMenuAnchor;
  kind: CanvasContextMenuKind;
}

export function useCanvasContextMenu(): {
  menu: CanvasContextMenuState | null;
  open(
    event: { clientX: number; clientY: number; preventDefault(): void },
    kind: CanvasContextMenuKind
  ): void;
  close(): void;
} {
  const [menu, setMenu] = useState<CanvasContextMenuState | null>(null);
  const open = useCallback(
    (
      event: { clientX: number; clientY: number; preventDefault(): void },
      kind: CanvasContextMenuKind
    ) => {
      event.preventDefault();
      setMenu({ anchor: { x: event.clientX, y: event.clientY }, kind });
    },
    []
  );
  const close = useCallback(() => setMenu(null), []);
  return { menu, open, close };
}

export function CanvasContextMenu({
  anchor,
  kind,
  ctx,
  run,
  onClose,
  onCopy,
  onCut,
  onPaste,
  onOpenScreenshot,
  onAddSticky,
  onAddComment,
}: CanvasContextMenuProps) {
  const open = anchor !== null;
  const screen = ctx.selection.length === 1 ? ctx.selection[0]['x-nimbalyst']?.screen : null;
  const sourcePath = screen && typeof screen === 'object' && 'sourcePath' in screen && typeof screen.sourcePath === 'string' ? screen.sourcePath.trim() : '';

  const reference = useMemo<VirtualElement | null>(
    () =>
      anchor === null
        ? null
        : {
            getBoundingClientRect: () =>
              DOMRect.fromRect({
                x: anchor.x,
                y: anchor.y,
                width: 0,
                height: 0,
              }),
          },
    [anchor]
  );

  const { listRef, activeIndex, setActiveIndex } = useCanvasMenuNavigation();

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next) => {
      if (!next) onClose();
    },
    placement: 'right-start',
    middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  // A `VirtualElement` goes through `setPositionReference`, not `elements`:
  // `elements.reference` is typed for a real DOM node, and there is no element
  // at a right-click point to hand it. Layout effect rather than effect so the
  // reference is in place before the browser paints the menu at the origin.
  useLayoutEffect(() => {
    refs.setPositionReference(reference);
  }, [refs, reference]);

  const { getFloatingProps, getItemProps } = useInteractions([
    useDismiss(context),
    useRole(context, { role: 'menu' }),
    useListNavigation(context, {
      listRef,
      activeIndex,
      onNavigate: setActiveIndex,
      ...CANVAS_MENU_NAVIGATION,
    }),
  ]);

  const enabled = useCallback(
    (id: CanvasCommandId): boolean => getCommand(id).enabled(ctx),
    [ctx]
  );

  if (anchor === null) return null;

  const at = anchor;

  const command = (id: CanvasCommandId, danger = false): MenuEntry | null => {
    if (!enabled(id)) return null;
    const entry = getCommand(id);
    return {
      kind: 'item',
      key: id,
      label: entry.label,
      shortcut: entry.shortcut,
      danger,
      onSelect: () => {
        onClose();
        run(id);
      },
    };
  };

  const callback = (
    key: string,
    label: string,
    handler: (() => void) | undefined,
    shortcut?: string
  ): MenuEntry | null =>
    handler === undefined
      ? null
      : {
          kind: 'item',
          key,
          label,
          shortcut,
          onSelect: () => {
            onClose();
            handler();
          },
        };

  const submenu = (
    key: string,
    label: string,
    items: ReadonlyArray<{ id: CanvasCommandId; label: string }>
  ): MenuEntry | null => {
    const available = items.filter((entry) => enabled(entry.id));
    if (available.length === 0) return null;
    return {
      kind: 'submenu',
      key,
      label,
      items: available,
      onSelect: (id) => {
        onClose();
        run(id);
      },
    };
  };

  const sections: Array<Array<MenuEntry | null>> =
    kind === 'selection'
      ? [
          [callback('open-screenshot', 'Open original screenshot', sourcePath && onOpenScreenshot ? () => onOpenScreenshot(sourcePath) : undefined)],
          [
            callback('copy', 'Copy', onCopy, 'Cmd+C'),
            callback('cut', 'Cut', ctx.readOnly ? undefined : onCut, 'Cmd+X'),
            command('duplicate'),
          ],
          [
            command('group'),
            command('ungroup'),
            submenu('align', 'Align', ALIGN_ITEMS),
            submenu('distribute', 'Distribute', DISTRIBUTE_ITEMS),
            command('tidy'),
          ],
          [
            command('bring-front'),
            command('send-back'),
            command('lock'),
            command('unlock'),
          ],
          [command('delete', true)],
        ]
      : [
          [
            callback(
              'paste',
              'Paste',
              ctx.readOnly ? undefined : onPaste,
              'Cmd+V'
            ),
            ctx.readOnly
              ? null
              : callback('add-sticky', 'Add sticky', () => onAddSticky(at)),
            ctx.readOnly
              ? null
              : callback('add-comment', 'Add comment', () => onAddComment(at)),
          ],
          [command('select-all'), command('fit-all')],
        ];

  // Drop empty groups so a menu never shows a leading or doubled separator,
  // then hand every surviving entry its slot in the one index space.
  const groups = sections
    .map((section) => section.filter((entry): entry is MenuEntry => entry !== null))
    .filter((section) => section.length > 0);

  let cursor = 0;
  const rendered: ReactElement[] = [];
  groups.forEach((section, sectionIndex) => {
    if (sectionIndex > 0) {
      rendered.push(
        <div
          key={`separator-${sectionIndex}`}
          className="canvas-context-menu__separator"
          aria-hidden
        />
      );
    }
    section.forEach((entry) => {
      const index = cursor;
      cursor += 1;
      const register = (element: HTMLElement | null) => {
        listRef.current[index] = element;
      };
      const active = activeIndex === index;
      rendered.push(
        entry.kind === 'submenu' ? (
          <Submenu
            key={entry.key}
            label={entry.label}
            items={entry.items}
            onSelect={entry.onSelect}
            register={register}
            tabIndex={active ? 0 : -1}
            itemProps={getItemProps}
          />
        ) : (
          <MenuItem
            key={entry.key}
            label={entry.label}
            shortcut={entry.shortcut}
            danger={entry.danger}
            register={register}
            tabIndex={active ? 0 : -1}
            {...getItemProps({ onClick: entry.onSelect })}
          />
        )
      );
    });
  });

  return (
    <FloatingPortal>
      {/* `initialFocus={-1}` because `useListNavigation` places focus on the
    first item; letting the manager also pick would race it. */}
      <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
        <div
          ref={refs.setFloating}
          className="canvas-context-menu"
          style={floatingStyles}
          data-canvas-context-menu-kind={kind}
          {...getFloatingProps()}
        >
          {rendered}
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}

function MenuItem({
  label,
  shortcut,
  danger = false,
  register,
  tabIndex,
  ...rest
}: {
  label: string;
  shortcut?: string;
  danger?: boolean;
  register?(element: HTMLElement | null): void;
  tabIndex?: number;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      role="menuitem"
      ref={register}
      tabIndex={tabIndex}
      className={`canvas-context-menu__item${
        danger ? ' canvas-context-menu__item--danger' : ''
      }`}
      {...rest}
    >
      <span>{label}</span>
      {shortcut !== undefined && (
        <span className="canvas-context-menu__shortcut">{shortcut}</span>
      )}
    </button>
  );
}

/**
 * A nested list, e.g. the six align edges.
 *
 * `nested: true` on the submenu's own list navigation is what makes ArrowRight
 * open it and ArrowLeft close it without those keys also driving the parent's
 * roving focus.
 */
function Submenu({
  label,
  items,
  onSelect,
  register,
  tabIndex,
  itemProps,
}: {
  label: string;
  items: ReadonlyArray<{ id: CanvasCommandId; label: string }>;
  onSelect(id: CanvasCommandId): void;
  register(element: HTMLElement | null): void;
  tabIndex: number;
  itemProps: (user?: Record<string, unknown>) => Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const { listRef, activeIndex, setActiveIndex } = useCanvasMenuNavigation();
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'right-start',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const {
    getReferenceProps,
    getFloatingProps,
    getItemProps: getSubItemProps,
  } = useInteractions([
    useDismiss(context),
    useRole(context, { role: 'menu' }),
    useListNavigation(context, {
      listRef,
      activeIndex,
      onNavigate: setActiveIndex,
      nested: true,
      // Without this, `getParentOrientation()` is undefined and floating-ui
      // falls back to "either axis opens me" -- so ArrowDown on the Align row
      // would open the submenu instead of moving to the next root item. The
      // alternative is registering a FloatingTree, which buys nothing else
      // here: one level of nesting, and dismissal already propagates.
      parentOrientation: 'vertical',
      ...CANVAS_MENU_NAVIGATION,
    }),
  ]);

  const triggerRef = useMergeRefs([refs.setReference, register]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={tabIndex}
        className="canvas-context-menu__item"
        {...getReferenceProps(
          itemProps({ onClick: () => setOpen((was) => !was) })
        )}
      >
        <span>{label}</span>
        <span className="canvas-context-menu__shortcut">&rsaquo;</span>
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
              className="canvas-context-menu"
              style={floatingStyles}
              {...getFloatingProps()}
            >
              {items.map((entry, index) => (
                <MenuItem
                  key={entry.id}
                  label={entry.label}
                  shortcut={getCommand(entry.id).shortcut}
                  register={(element) => {
                    listRef.current[index] = element;
                  }}
                  tabIndex={activeIndex === index ? 0 : -1}
                  {...getSubItemProps({ onClick: () => onSelect(entry.id) })}
                />
              ))}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
