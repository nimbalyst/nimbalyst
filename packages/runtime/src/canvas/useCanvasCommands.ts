/**
 * One place where a canvas command id becomes a board edit.
 *
 * The registry in `canvasCommands.ts` says what a command *is* and when it is
 * available; the arrange module says what a geometry command *computes*. This
 * is the third piece: the only thing in the canvas that knows how to turn
 * either of them into a document. The keyboard map, the selection bar, and the
 * context menu all reach the board through `run`, so a command behaves the same
 * whichever of the three the user touched.
 *
 * **Every arrange lands as one write.** `alignNodes` and friends return a batch
 * of patches, and the batch is folded into a single `CanvasDocument` handed to
 * a single `commit`. `CanvasBinding.applyLocalDocument` wraps one document diff
 * in one `Y.Doc.transact`, and `commit` closes the previous undo step first, so
 * "align six cards" is one transaction, one outbox row, and one Cmd+Z --
 * complication 4 in the plan. Committing per patch would have been six of each,
 * and undo would walk backwards through an arrangement one card at a time.
 *
 * **Locked cards are skipped, not refused.** `canvasArrange` filters them out of
 * its own geometry, and delete does the same here: locking is an editing
 * convenience, so a marquee that happens to include a locked card still acts on
 * everything else rather than doing nothing.
 */
import { useCallback, useMemo } from 'react';

import {
  NIMBALYST_CANVAS_NAMESPACE,
  type CanvasAnyNode,
  type CanvasDocument,
  type CanvasNodeNimbalystExtension,
} from './CanvasDocument';
import {
  alignNodes,
  distributeNodes,
  nudgeNodes,
  tidyNodes,
  type CanvasAlignment,
  type CanvasGeometryNode,
  type CanvasGeometryPatch,
} from './canvasArrange';
import type {
  CanvasCommandContext,
  CanvasCommandId,
  CanvasCommandRunner,
} from './canvasCommands';
import { resolveCanvasKey, type CanvasKeyEvent } from './canvasKeymap';
import {
  addCanvasNode,
  applyCanvasEdgeChanges,
  applyCanvasNodeChanges,
  containedCanvasNodeIds,
  createCanvasId,
  reorderCanvasNode,
  updateCanvasNode,
} from './canvasFlowMapping';
import type { CanvasPanelToggle, CanvasPointerTool } from './canvasPanelState';

/** How far a duplicate lands from its original, in canvas units. */
const DUPLICATE_OFFSET = 24;

/** One grid step, and the coarse step Shift asks for. */
const NUDGE_STEP = 1;
const NUDGE_STEP_COARSE = 10;

export interface CanvasCameraCommands {
  fitAll(): void;
  fitSelection(): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomTo(scale: number): void;
  savedView(): void;
}

/**
 * The steps Escape walks, in order, each reporting whether it did anything.
 *
 * Escape was already taken by "deactivate the hot card" and it stays first:
 * a user with a card open is talking to the card. Everything after it is the
 * chain from complication 6.
 */
export interface CanvasEscapeActions {
  deactivateCard(): boolean;
  cancelDrag(): boolean;
  clearSelection(): boolean;
  returnToSelectTool(): boolean;
  closePanel(): boolean;
}

/**
 * Walk the chain and stop at the first step that did something.
 *
 * Pure, and exported for the test: the ordering is the whole behaviour, and the
 * failure it guards against -- one Escape closing the comment composer *and*
 * clearing the selection -- is invisible in a screenshot.
 */
export function runCanvasEscape(actions: CanvasEscapeActions): boolean {
  const chain = [
    actions.deactivateCard,
    actions.cancelDrag,
    actions.clearSelection,
    actions.returnToSelectTool,
    actions.closePanel,
  ];
  for (const step of chain) {
    if (step()) return true;
  }
  return false;
}

export interface CanvasCommandDeps {
  /**
   * The board as it is, not as it is painted mid-gesture. Read inside `run`,
   * where "what would this command act on right now" is the question.
   */
  documentRef: { readonly current: CanvasDocument };
  /**
   * The board as the surface is rendering it. `ctx` is built from this rather
   * than from the ref: the ref only catches up in a layout effect, so a bar
   * built from it would describe the previous document for one frame after
   * every edit.
   */
  document: CanvasDocument;
  selectedIds: ReadonlySet<string>;
  setSelectedIds(next: ReadonlySet<string>): void;
  readOnly: boolean;
  activeNodeId: string | null;
  tool: CanvasPointerTool;
  setTool(tool: CanvasPointerTool): void;
  /** A discrete edit: closes the previous undo step, then writes. */
  commit(next: CanvasDocument): void;
  camera: CanvasCameraCommands;
  /** The rail's creation actions, so N/T/F do what the rail's buttons do. */
  addCard(kind: 'sticky' | 'text' | 'image' | 'group'): void;
  /** Absent on a board with no comment room. */
  togglePin?: (() => void) | undefined;
  togglePanelPref(pref: CanvasPanelToggle): void;
  escape: CanvasEscapeActions;
}

function extensionOf(node: CanvasAnyNode) {
  return node[NIMBALYST_CANVAS_NAMESPACE] ?? {};
}

function isLocked(node: CanvasAnyNode): boolean {
  return extensionOf(node).locked === true;
}

function geometryOf(node: CanvasAnyNode): CanvasGeometryNode {
  return {
    id: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    locked: isLocked(node),
  };
}

/** Fold a batch of positions into one document. One write, one undo step. */
function withGeometryPatches(
  document: CanvasDocument,
  patches: readonly CanvasGeometryPatch[]
): CanvasDocument {
  if (patches.length === 0) return document;
  const byId = new Map(patches.map((patch) => [patch.id, patch]));
  return {
    ...document,
    nodes: (document.nodes ?? []).map((node) => {
      const patch = byId.get(node.id);
      return patch === undefined ? node : { ...node, x: patch.x, y: patch.y };
    }),
  };
}

/**
 * Write one `x-nimbalyst` field across a set of nodes, in one document.
 *
 * Two typed entry points rather than one generic `(field, value)` pair: a
 * union-keyed write loses the pairing between the field and what it may hold,
 * so `locked: 'group-7'` would compile. Undefined clears the field rather than
 * storing it, which keeps an unlocked card's JSON identical to one that was
 * never locked.
 */
function withExtensionPatch(
  document: CanvasDocument,
  ids: readonly string[],
  patch: (
    extension: CanvasNodeNimbalystExtension
  ) => CanvasNodeNimbalystExtension
): CanvasDocument {
  return ids.reduce((next, id) => {
    const node = (next.nodes ?? []).find((candidate) => candidate.id === id);
    if (!node) return next;
    return updateCanvasNode(next, id, {
      [NIMBALYST_CANVAS_NAMESPACE]: patch({ ...extensionOf(node) }),
    });
  }, document);
}

function writeLocked(
  document: CanvasDocument,
  ids: readonly string[],
  locked: boolean | undefined
): CanvasDocument {
  return withExtensionPatch(document, ids, (extension) => {
    if (locked === true) extension.locked = true;
    else delete extension.locked;
    return extension;
  });
}

function writeGroup(
  document: CanvasDocument,
  ids: readonly string[],
  group: string | undefined
): CanvasDocument {
  return withExtensionPatch(document, ids, (extension) => {
    if (group === undefined) delete extension.group;
    else extension.group = group;
    return extension;
  });
}

/**
 * Everything a group command should act on, given what the user selected.
 *
 * Group membership is flat and symmetric (complication 3): selecting one member
 * selects all of them, so that a drag, a nudge, or a delete treats the group as
 * the one thing the user thinks it is. Exported for the test -- the failure is
 * "I dragged a group and half of it stayed behind", which nothing about the
 * screen makes obvious until it has already happened.
 */
export function expandCanvasGroupSelection(
  selected: ReadonlySet<string>,
  nodes: readonly CanvasAnyNode[]
): ReadonlySet<string> {
  const groups = new Set<string>();
  for (const node of nodes) {
    if (!selected.has(node.id)) continue;
    const group = extensionOf(node).group;
    if (typeof group === 'string' && group !== '') groups.add(group);
  }
  if (groups.size === 0) return selected;

  let next: Set<string> | null = null;
  for (const node of nodes) {
    if (selected.has(node.id)) continue;
    const group = extensionOf(node).group;
    if (typeof group !== 'string' || !groups.has(group)) continue;
    next ??= new Set(selected);
    next.add(node.id);
  }
  return next ?? selected;
}

/**
 * Carry a frame's contents along with the frame.
 *
 * Dragging a frame already moves what it geometrically contains -- that is
 * `applyCanvasNodeChanges`, and it is the behaviour a frame *has*. A nudge, an
 * align, or a tidy that moved the frame and left its cards behind would be the
 * same gesture with a different answer, so every geometry command routes its
 * patches through here. Containment is read from the pre-move board, and an
 * explicitly selected card keeps its own patch: it was aimed at directly.
 *
 * Locked cards are skipped, exactly as they are when they are selected.
 */
export function expandCanvasFramePatches(
  patches: readonly CanvasGeometryPatch[],
  nodes: readonly CanvasAnyNode[]
): readonly CanvasGeometryPatch[] {
  if (patches.length === 0) return patches;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const claimed = new Set(patches.map((patch) => patch.id));
  const extra: CanvasGeometryPatch[] = [];

  for (const patch of patches) {
    const frame = byId.get(patch.id);
    if (!frame || frame.type !== 'group') continue;
    const dx = patch.x - frame.x;
    const dy = patch.y - frame.y;
    if (dx === 0 && dy === 0) continue;
    for (const id of containedCanvasNodeIds(nodes, frame)) {
      if (claimed.has(id)) continue;
      const child = byId.get(id);
      if (!child || isLocked(child)) continue;
      claimed.add(id);
      extra.push({ id, x: child.x + dx, y: child.y + dy });
    }
  }
  return extra.length === 0 ? patches : [...patches, ...extra];
}

/** The selection plus everything the selected frames contain. */
function withFrameContents(
  selection: readonly CanvasAnyNode[],
  nodes: readonly CanvasAnyNode[]
): readonly CanvasAnyNode[] {
  const frames = selection.filter((node) => node.type === 'group');
  if (frames.length === 0) return selection;
  const ids = new Set(selection.map((node) => node.id));
  const extra: CanvasAnyNode[] = [];
  for (const frame of frames) {
    for (const id of containedCanvasNodeIds(nodes, frame)) {
      if (ids.has(id)) continue;
      const child = nodes.find((candidate) => candidate.id === id);
      if (!child) continue;
      ids.add(id);
      extra.push(child);
    }
  }
  return extra.length === 0 ? selection : [...selection, ...extra];
}

/**
 * The command a key press means, including two fallbacks the registry cannot
 * express today.
 *
 * `resolveCanvasKey` only returns a command its `enabled` predicate accepts, so
 * a command that is disabled for a reason the *caller* can answer resolves to
 * nothing at all. Two of those matter:
 *
 * - **Shift+2 with nothing selected.** `fit-selection` is disabled on an empty
 *   selection, so the key died rather than reaching its documented "fit all"
 *   fallback.
 * - **Backspace with only edges selected.** `delete` is gated on selected
 *   *nodes*, and deleting a selected edge with the keyboard is behaviour the
 *   board had before the registry existed.
 *
 * Both are answered by re-resolving against a probe context rather than by
 * re-implementing the guards: typing into a card, a hot card, and Alt are all
 * still `canvasKeymap`'s decision, and this only reads which command the key
 * *would* have meant.
 */
const PROBE_NODE = {
  id: 'nimbalyst:canvas-probe',
  type: 'text',
  x: 0,
  y: 0,
  width: 0,
  height: 0,
} as unknown as CanvasAnyNode;

export function resolveCanvasCommand(
  event: CanvasKeyEvent,
  ctx: CanvasCommandContext,
  selectedEdgeCount: number
): CanvasCommandId | null {
  const direct = resolveCanvasKey(event, ctx);
  if (direct !== null) return direct;

  const probed = resolveCanvasKey(event, { ...ctx, selection: [PROBE_NODE] });
  if (probed === 'fit-selection') return ctx.nodes.length > 0 ? 'fit-all' : null;
  if (probed === 'delete' && selectedEdgeCount > 0) return 'delete';
  return null;
}

const ALIGNMENTS: Record<string, CanvasAlignment> = {
  'align-left': 'left',
  'align-center-x': 'center-x',
  'align-right': 'right',
  'align-top': 'top',
  'align-center-y': 'center-y',
  'align-bottom': 'bottom',
};

const NUDGES: Record<string, { dx: number; dy: number }> = {
  'nudge-left': { dx: -NUDGE_STEP, dy: 0 },
  'nudge-right': { dx: NUDGE_STEP, dy: 0 },
  'nudge-up': { dx: 0, dy: -NUDGE_STEP },
  'nudge-down': { dx: 0, dy: NUDGE_STEP },
  'nudge-left-10': { dx: -NUDGE_STEP_COARSE, dy: 0 },
  'nudge-right-10': { dx: NUDGE_STEP_COARSE, dy: 0 },
  'nudge-up-10': { dx: 0, dy: -NUDGE_STEP_COARSE },
  'nudge-down-10': { dx: 0, dy: NUDGE_STEP_COARSE },
};

export function useCanvasCommands(deps: CanvasCommandDeps): {
  ctx: CanvasCommandContext;
  run: CanvasCommandRunner;
} {
  const {
    documentRef,
    document,
    selectedIds,
    setSelectedIds,
    readOnly,
    activeNodeId,
    tool,
    setTool,
    commit,
    camera,
    addCard,
    togglePin,
    togglePanelPref,
    escape,
  } = deps;

  const nodes = document.nodes ?? [];

  const ctx = useMemo<CanvasCommandContext>(
    () => ({
      nodes,
      selection: nodes.filter((node) => selectedIds.has(node.id)),
      readOnly,
      activeCardId: activeNodeId,
      tool,
    }),
    [nodes, selectedIds, readOnly, activeNodeId, tool]
  );

  const run = useCallback<CanvasCommandRunner>(
    (id: CanvasCommandId) => {
      const document = documentRef.current;
      const all = document.nodes ?? [];
      const selection = all.filter((node) => selectedIds.has(node.id));
      const movable = selection.filter((node) => !isLocked(node));

      // Camera and chrome first: they are the commands that stay available on a
      // read-only board, because looking is not editing.
      switch (id) {
        case 'fit-all':
          camera.fitAll();
          return;
        case 'fit-selection':
          camera.fitSelection();
          return;
        case 'zoom-in':
          camera.zoomIn();
          return;
        case 'zoom-out':
          camera.zoomOut();
          return;
        case 'zoom-100':
          camera.zoomTo(1);
          return;
        case 'saved-view':
          camera.savedView();
          return;
        case 'toggle-minimap':
          togglePanelPref('minimap');
          return;
        case 'toggle-grid-snap':
          togglePanelPref('gridSnap');
          return;
        case 'tool-select':
          setTool('select');
          return;
        case 'tool-hand':
          setTool('hand');
          return;
        case 'escape':
          runCanvasEscape(escape);
          return;
        case 'select-all':
          // Frames are excluded here for the same reason they are excluded from
          // a marquee: select-all is followed by a drag often enough that
          // sweeping the frames up would carry the board's own furniture.
          setSelectedIds(
            new Set(
              all
                .filter((node) => node.type !== 'group')
                .map((node) => node.id)
            )
          );
          return;
        default:
          break;
      }

      if (readOnly) return;

      // The rail's creation tools are one-shot actions rather than armed modes,
      // so the key does what the button does: drop a card at the middle of the
      // board. An armed creation mode is Phase 2 work.
      switch (id) {
        case 'tool-sticky':
          addCard('sticky');
          return;
        case 'tool-text':
          addCard('text');
          return;
        case 'tool-frame':
          addCard('group');
          return;
        case 'tool-pin':
          togglePin?.();
          return;
        case 'tool-edge':
          return;
        default:
          break;
      }

      /**
       * Every geometry command lands the same way: compute patches from the
       * selection, carry each moved frame's contents along with it, then write
       * once. The frame expansion is deliberately outside the arrange module,
       * which is plain rectangles and has no idea what a frame contains.
       */
      const commitGeometry = (patches: readonly CanvasGeometryPatch[]) => {
        const expanded = expandCanvasFramePatches(patches, all);
        if (expanded.length === 0) return;
        commit(withGeometryPatches(document, expanded));
      };

      const alignment = ALIGNMENTS[id];
      if (alignment !== undefined) {
        commitGeometry(alignNodes(selection.map(geometryOf), alignment));
        return;
      }

      const nudge = NUDGES[id];
      if (nudge !== undefined) {
        commitGeometry(
          nudgeNodes(selection.map(geometryOf), nudge.dx, nudge.dy)
        );
        return;
      }

      switch (id) {
        case 'distribute-x':
        case 'distribute-y':
          commitGeometry(
            distributeNodes(
              selection.map(geometryOf),
              id === 'distribute-x' ? 'x' : 'y'
            )
          );
          return;

        case 'tidy':
          commitGeometry(tidyNodes(selection.map(geometryOf)));
          return;

        case 'delete': {
          // Edges are selected through the same set as nodes -- both go through
          // `applyCanvasSelection` -- so Delete has always removed a selected
          // edge, and it has to keep doing that now that the command owns the
          // key. Cards first, then edges, folded into one write.
          const doomedEdges = (document.edges ?? []).filter((edge) =>
            selectedIds.has(edge.id)
          );
          if (movable.length === 0 && doomedEdges.length === 0) return;
          let next = document;
          if (movable.length > 0) {
            next = applyCanvasNodeChanges(
              next,
              movable.map((node) => ({ id: node.id, type: 'remove' as const }))
            );
          }
          if (doomedEdges.length > 0) {
            next = applyCanvasEdgeChanges(
              next,
              doomedEdges.map((edge) => ({
                id: edge.id,
                type: 'remove' as const,
              }))
            );
          }
          commit(next);
          return;
        }

        case 'bring-front':
        case 'send-back': {
          const placement = id === 'bring-front' ? 'front' : 'back';
          commit(
            movable.reduce(
              (next, node) => reorderCanvasNode(next, node.id, placement),
              document
            )
          );
          return;
        }

        case 'lock':
          commit(
            writeLocked(
              document,
              movable.map((node) => node.id),
              true
            )
          );
          return;

        case 'unlock':
          commit(
            writeLocked(
              document,
              selection.filter(isLocked).map((node) => node.id),
              undefined
            )
          );
          return;

        case 'group': {
          if (selection.length < 2) return;
          const groupId = createCanvasId(
            'group',
            new Set(all.map((node) => node.id))
          );
          commit(
            writeGroup(
              document,
              selection.map((node) => node.id),
              groupId
            )
          );
          return;
        }

        case 'ungroup': {
          // Ungrouping one member ungroups the whole group: membership is flat
          // and symmetric, so leaving the others pointing at a group with one
          // card left in it is not a state the user asked for.
          const groups = new Set(
            selection
              .map((node) => extensionOf(node).group)
              .filter((value): value is string => typeof value === 'string')
          );
          if (groups.size === 0) return;
          commit(
            writeGroup(
              document,
              all
                .filter((node) => {
                  const value = extensionOf(node).group;
                  return typeof value === 'string' && groups.has(value);
                })
                .map((node) => node.id),
              undefined
            )
          );
          return;
        }

        case 'duplicate': {
          if (selection.length === 0) return;
          // A duplicated frame brings its contents, for the same reason a
          // dragged one does: the frame is the thing the user pointed at, and a
          // copy of an empty box is not a copy of what they were looking at.
          const copied = withFrameContents(selection, all);
          const taken = new Set(all.map((node) => node.id));
          // Group ids are remapped rather than copied: a duplicate of a whole
          // group is a *new* group, and sharing the id would make selecting one
          // copy select the original too.
          const groupMap = new Map<string, string>();
          let next = document;
          const copies: string[] = [];
          for (const node of copied) {
            const copyId = createCanvasId('node', taken);
            taken.add(copyId);
            copies.push(copyId);
            const extension = { ...extensionOf(node) };
            const group = extension.group;
            if (typeof group === 'string') {
              const mapped =
                groupMap.get(group) ?? createCanvasId('group', taken);
              groupMap.set(group, mapped);
              taken.add(mapped);
              extension.group = mapped;
            }
            next = addCanvasNode(next, {
              ...node,
              id: copyId,
              x: node.x + DUPLICATE_OFFSET,
              y: node.y + DUPLICATE_OFFSET,
              [NIMBALYST_CANVAS_NAMESPACE]: extension,
            } as CanvasAnyNode);
          }
          commit(next);
          setSelectedIds(new Set(copies));
          return;
        }

        default:
          return;
      }
    },
    [
      addCard,
      camera,
      commit,
      documentRef,
      escape,
      readOnly,
      selectedIds,
      setSelectedIds,
      setTool,
      togglePanelPref,
      togglePin,
    ]
  );

  return { ctx, run };
}
