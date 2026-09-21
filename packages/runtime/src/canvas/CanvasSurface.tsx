/**
 * Project Canvas surface: React Flow over a `CanvasDocument`.
 *
 * Host-agnostic on purpose -- nothing here reaches for Electron, the
 * filesystem, or a collab room, because Slice 6 publishes this same module to
 * the web console through `@nimbalyst/collab-bundle`. The document comes in as
 * a prop and every edit goes back out through `onDocumentChange`; the host
 * decides what a change means (mark dirty, save, push into a Y.Doc).
 *
 * Three decisions worth reading before changing anything here:
 *
 * **`zIndexMode="manual"` and groups are plain rank-ordered rectangles.** JSON
 * Canvas defines z-order as node array position and gives a `group` node no
 * containment semantics at all -- membership is purely geometric and children
 * keep absolute coordinates. Modelling groups as React Flow `parentId`
 * sub-flows would require `zIndexMode="auto"`, which forces every child above
 * its parent and makes the board paint in a different order than it saves; it
 * would also invent parent-relative coordinates the format does not have. So a
 * frame is just another node, its z-index is its position in rank order, and
 * `"manual"` hands that number to React Flow verbatim. The cost is that
 * "dragging a frame carries its contents" is our code rather than React Flow's
 * -- see `applyCanvasNodeChanges`.
 *
 * **`autoPanOnSelection` is off.** It defaults to `true` as of React Flow
 * 12.11. On a board where a rubber-band selection routinely runs to the edge of
 * the viewport, an automatic pan moves the cards out from under the box the
 * user is still drawing. It also collides with the activation model below,
 * which owns viewport animation. `autoPanOnNodeDrag` stays on: dragging a card
 * past the edge to move it further is what the user meant.
 *
 * **Activation is zoom-to-100** ([NIM-3845](nimbalyst://NIM-3845)).
 * *Double*-clicking a card animates the viewport to scale 1.0 centred on that
 * card and then activates it; when the viewport is already within 2% of 1.0 it
 * activates in place with no animation. Escape deactivates. Cards are
 * pointer-inert until activated -- see the header of CanvasCardNode for why
 * that is not optional.
 *
 * A single click only *selects*, and the split is not cosmetic: the resize
 * handles and the card toolbar are hidden while a card is active, because an
 * active card owns the pointer. When one click did both, every card on the
 * board was unresizable -- the handles appeared and vanished in the same frame.
 *
 * **Trackpad gestures follow the design-tool convention.** Two-finger drag
 * pans (`panOnScroll`), pinch zooms (React Flow reads the `ctrlKey` macOS
 * synthesises for a pinch), and Cmd/Ctrl + wheel zooms about the pointer. That
 * last one is ours: `createPanOnScrollHandler` only understands `ctrlKey`, and
 * its pinch branch multiplies the delta by ten, which is right for the tiny
 * deltas a pinch emits and wildly wrong for a scroll. See `onZoomWheel`.
 * `zoomOnDoubleClick` is off because double-click is now the activation
 * gesture, and a dblclick on a node bubbles to the pane.
 *
 * **The viewport is per-user view state and never enters the document.** Where
 * you are looking is not something a teammate should inherit: activation alone
 * moves the viewport on every card click, so writing it into the shared board
 * meant one person clicking a card yanked everyone else's saved view to theirs.
 * `meta.viewport` survives as the board's deliberate *home* view -- what the
 * "Save view" button writes, and what a converted `.mockupproject` carries over
 * -- while a user's own last position rides out through `onViewportChange` for
 * the host to keep locally. The channel for "where is Sam looking" is awareness,
 * which is a different thing again and belongs to Slice 4a.
 *
 * The React Flow attribution is left visible. Hiding it is a licensing choice
 * rather than a styling one, and it also trips a development warning as of
 * 12.11.4.
 */
import { CanvasCommandTooltips } from './CanvasCommandTooltips';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
  type EdgeTypes,
  type Viewport,
} from '@xyflow/react';

import '@xyflow/react/dist/style.css';
import './CanvasSurface.css';

import {
  toCanvasCoordinate,
  type CanvasAnyNode,
  type CanvasDocument,
  type CanvasViewport,
} from './CanvasDocument';
import type {
  CanvasAwarenessEntry,
  CanvasAwarenessPatch,
} from './canvasBinding';
import {
  CanvasCardCallbacksContext,
  CanvasCardClaimsContext,
  CanvasCardNode,
  CanvasCardRevisionsContext,
  type CanvasCardCallbacks,
  type CanvasCardRevisionsAccess,
} from './CanvasCardNode';
import {
  effectiveCanvasCardReference,
  pinCanvasRevisionCard,
  type CanvasRevisionEntry,
} from './canvasRevisions';
import {
  CanvasCardCommentsContext,
  CanvasCommentPins,
  type CanvasCardCommentsAccess,
} from './CanvasCommentsLayer';
import {
  canvasCommentTargetLabel,
  type CanvasCommentTarget,
} from './canvasComments';
import { CanvasAgentRequestPanel } from './CanvasAgentRequestPanel';
import { getCanvasCallbacks } from './canvasCallbacks';
import type { CanvasCommentsModel } from './useCanvasComments';
import {
  CanvasPresenceLayer,
  CanvasPresenceRoster,
} from './CanvasPresenceLayer';
import {
  canvasCardClaimants,
  canvasPresenceParticipants,
  sameCanvasCardClaimants,
  type CanvasCardClaimant,
  type CanvasPresenceParticipant,
} from './canvasPresence';
import { CanvasEdgeView } from './CanvasEdgeView';
import { CanvasEdgeMarkers } from './CanvasEdgeMarkers';
import {
  CANVAS_FLOW_EDGE_TYPE,
  CANVAS_FLOW_NODE_TYPE,
  EMPTY_CANVAS_GEOMETRY,
  addCanvasNode,
  applyCanvasEdgeChanges,
  applyCanvasSelection,
  canvasCardLabel,
  canvasCardReference,
  canvasReferenceNodeIds,
  connectCanvasEdge,
  canvasClickSelection,
  createNativeCanvasNode,
  createReferenceCanvasNode,
  readCanvasViewport,
  toFlowEdges,
  stepCanvasGesture,
  toFlowNodes,
  updateCanvasNode,
  withCanvasNodeGeometry,
  withCanvasViewport,
  type CanvasNodeGeometry,
} from './canvasFlowMapping';
import { useCanvasPanelState, type CanvasPanelState } from './canvasPanelState';
import { CanvasToolRail } from './CanvasToolRail';
import { CanvasZoomWidget } from './CanvasZoomWidget';
import { CanvasNavigationPanel } from './CanvasNavigationPanel';
import { useCanvasAwarenessPublisher } from './useCanvasAwarenessPublisher';
import { useCanvasDropTarget } from './useCanvasDropTarget';
import { useCanvasWheelZoom } from './useCanvasWheelZoom';
import { useCanvasCamera } from './useCanvasCamera';
import {
  expandCanvasGroupSelection,
  resolveCanvasCommand,
  useCanvasCommands,
} from './useCanvasCommands';
import { CanvasSelectionBar } from './CanvasSelectionBar';
import { CanvasContextMenu, useCanvasContextMenu } from './CanvasContextMenu';
import {
  CANVAS_ACTIVATION_ZOOM,
  canvasZoomBucket,
  isCanvasActivationZoom,
} from './canvasCardLod';
import { useCanvasCardLod } from './useCanvasCardLod';
import {
  CANVAS_SNAP_GRID,
  snapCanvasNodeToGrid,
  type CanvasGuide,
} from './canvasSnapping';
import {
  applyCanvasDragCancellation,
  snapCanvasDragChanges,
} from './canvasDragSnapping';

/**
 * The composer is the board's only late-fetched module.
 *
 * It carries `CommentComposer`, the mention picker, and `@floating-ui/react`,
 * which together were ~42 kB gzip of the `./canvas` browser entry's eager
 * graph -- paid by every reader who opens a board, spent by the few who write
 * a comment. It mounts only after "comment on this card" or a click with the
 * comment tool armed, so the fetch lands inside a gesture the user has already
 * committed to. Pins and badges stay eager: a card paints its badge on arrival.
 */
const CanvasCommentComposer = lazy(() =>
  import('./CanvasCommentComposer').then((module) => ({
    default: module.CanvasCommentComposer,
  }))
);

/** Same bargain as the composer: nobody pays for history until they open it. */
const CanvasRevisionRail = lazy(() =>
  import('./CanvasRevisionRail').then((module) => ({
    default: module.CanvasRevisionRail,
  }))
);

const ACTIVATION_DURATION_MS = 220;

const SNAP_GRID: [number, number] = [CANVAS_SNAP_GRID, CANVAS_SNAP_GRID];

const EMPTY_GUIDES: readonly CanvasGuide[] = [];

/**
 * Everyone else's in-flight boxes, as one overlay.
 *
 * This client's own entry is skipped: its frames are already painted from local
 * state, and taking the round trip back through awareness would make a card the
 * user is holding stutter between two versions of itself.
 */
function remoteMovingGeometry(
  entries: ReadonlyMap<number, CanvasAwarenessEntry> | undefined,
  localClientId: number | null
): ReadonlyMap<string, CanvasNodeGeometry> {
  if (!entries || entries.size === 0) return EMPTY_CANVAS_GEOMETRY;
  const overlay = new Map<string, CanvasNodeGeometry>();
  for (const [clientId, entry] of entries) {
    if (clientId === localClientId) continue;
    for (const geometry of entry.moving ?? []) {
      overlay.set(geometry.nodeId, {
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
      });
    }
  }
  return overlay.size === 0 ? EMPTY_CANVAS_GEOMETRY : overlay;
}

function sameCanvasGeometry(
  left: ReadonlyMap<string, CanvasNodeGeometry>,
  right: ReadonlyMap<string, CanvasNodeGeometry>
): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [nodeId, geometry] of left) {
    const other = right.get(nodeId);
    if (
      other === undefined ||
      other.x !== geometry.x ||
      other.y !== geometry.y ||
      other.width !== geometry.width ||
      other.height !== geometry.height
    ) {
      return false;
    }
  }
  return true;
}

function sameGuides(
  left: readonly CanvasGuide[],
  right: readonly CanvasGuide[]
): boolean {
  return (
    left.length === right.length &&
    left.every((guide, index) => {
      const other = right[index];
      return (
        guide.kind === other.kind &&
        guide.x1 === other.x1 &&
        guide.y1 === other.y1 &&
        guide.x2 === other.x2 &&
        guide.y2 === other.y2
      );
    })
  );
}

const EMPTY_AWARENESS: ReadonlyMap<number, CanvasAwarenessEntry> = new Map();

const EMPTY_CLAIMS: ReadonlyMap<string, readonly CanvasCardClaimant[]> =
  new Map();

export interface CanvasSurfaceProps {
  document: CanvasDocument;
  onDocumentChange(next: CanvasDocument): void;
  /**
   * Ends the current undo step. Called at every gesture boundary -- a drag
   * starting or stopping, and each discrete edit -- so that two gestures inside
   * the undo manager's capture window do not collapse into one.
   */
  onEditBoundary?(): void;
  /**
   * Where this user is looking, after every pan or zoom. Per-user view state:
   * the host keeps it locally and hands it back as `initialViewport`. It is not
   * the board's `meta.viewport`, which only the "Save view" button writes.
   */
  onViewportChange?(viewport: CanvasViewport): void;
  /** This user's last view of this board, if the host remembers one. */
  initialViewport?: CanvasViewport | null;
  /**
   * This user's chrome preferences for this board, as the host stored them --
   * whatever shape that turned out to be. Merged against the current defaults;
   * see `canvasPanelStateFrom`.
   */
  initialPanelState?: unknown;
  /** Every change to those preferences, for the host to persist per user. */
  onPanelStateChange?(next: CanvasPanelState): void;
  /** Outbound presence: this user's cursor, viewport, and selection. */
  onAwarenessChange?(patch: CanvasAwarenessPatch): void;
  /** Inbound presence: everyone on the board, including this client's entry. */
  awarenessEntries?: ReadonlyMap<number, CanvasAwarenessEntry>;
  /** This client's awareness id, so its own cursor is not drawn back to it. */
  localClientId?: number | null;
  /** Shared parents resolve a file card's `sharedAs` child binding. */
  collaborative?: boolean;
  /**
   * Comment threads anchored to this board. Absent on a board with no comment
   * room, which is every private `.canvas` file -- the affordances disappear
   * rather than pretending to write somewhere.
   */
  comments?: CanvasCommentsModel;
  readOnly?: boolean;
}

const NODE_TYPES: NodeTypes = { [CANVAS_FLOW_NODE_TYPE]: CanvasCardNode };
const EDGE_TYPES: EdgeTypes = { [CANVAS_FLOW_EDGE_TYPE]: CanvasEdgeView };

/**
 * Zoom bounds. Named because `onZoomWheel` has to clamp to exactly the same
 * pair React Flow is given -- a hand-rolled zoom that overshoots `maxZoom`
 * leaves d3's transform and the flow's own limits disagreeing.
 */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;

export function CanvasSurface(props: CanvasSurfaceProps): ReactElement {
  return (
    <ReactFlowProvider>
      <CanvasSurfaceInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasSurfaceInner({
  document,
  onDocumentChange,
  onEditBoundary,
  onViewportChange,
  initialViewport = null,
  initialPanelState,
  onPanelStateChange,
  onAwarenessChange,
  awarenessEntries,
  localClientId = null,
  collaborative = false,
  comments,
  readOnly = false,
}: CanvasSurfaceProps): ReactElement {
  const flow = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef(document);
  // Event handlers must use the projection that is actually painted. Updating
  // this during render would let an old DOM event observe a remote projection
  // that React has not committed yet and manufacture a stale whole-document
  // edit from two different snapshots.
  useLayoutEffect(() => {
    documentRef.current = document;
  }, [document]);

  // Chrome preferences: minimap, grid snap, smart guides, and the armed
  // pointer tool. Per user and per board, never in the document.
  const {
    state: panel,
    toggle: togglePanelPref,
    setTool,
  } = useCanvasPanelState(initialPanelState, onPanelStateChange);
  const handTool = panel.tool === 'hand';

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const activationToken = useRef(0);

  // Alignment guides are transient view state: they are recomputed from every
  // drag frame and thrown away when the drag ends. Nothing here is ever handed
  // to `onDocumentChange`, so no path exists by which a guide reaches the file,
  // the Y.Doc, or undo history.
  const [guides, setGuides] = useState<readonly CanvasGuide[]>(EMPTY_GUIDES);

  /**
   * Alt/Option held suspends the grid, alignment, and spacing snaps together.
   *
   * The other obvious modifiers are already spoken for by React Flow: Shift
   * draws a selection box, Meta/Control multi-selects and gates zoom, Space
   * activates panning. Alt is free, and "hold this to put the thing exactly
   * where the pointer is" is the meaning it usually carries anyway.
   */
  const [snapDefeated, setSnapDefeated] = useState(false);
  const snapDefeatedRef = useRef(false);
  snapDefeatedRef.current = snapDefeated;

  // Bucketed, not raw: see `canvasZoomBucket`. Subscribing here rather than
  // reading `flow.getZoom()` imperatively is what makes a card go inert the
  // instant the band is crossed, whichever of React Flow's many zoom paths did
  // it -- the Controls buttons, ctrl+wheel, the minimap, `fitView`.
  const zoom = useStore((state) => canvasZoomBucket(state.transform[2]));

  // `toFlowNodes` gates on the same rule, and it is the gate that matters; this
  // only keeps the surface's own state from disagreeing with what it painted.
  const hotNodeId = isCanvasActivationZoom(zoom) ? activeNodeId : null;

  // Mount and unmount are the only expensive thing a card does, so neither
  // happens while the user is still moving. See `CanvasLodInput.gestureActive`.
  const [gestureActive, setGestureActive] = useState(false);

  const referenceIds = useMemo(
    () => canvasReferenceNodeIds(document),
    [document]
  );
  const { lod, observeCard } = useCanvasCardLod({
    referenceIds,
    hotId: hotNodeId,
    zoom,
    gestureActive,
    surfaceRef: wrapperRef,
  });

  /**
   * Boxes that are moving under a pointer right now -- this user's or anyone
   * else's -- painted over the document without being written to it.
   *
   * Held apart from `document` for two different reasons at once. Locally, it is
   * what keeps a drag from spending a Y.Doc transaction, an outbox row, and a
   * renderer-to-main IPC call on every pointer frame (`canvasGestureKind`).
   * Remotely, it is how a teammate's drag is drawn live: their frames arrive as
   * awareness, so a card slides across everyone's board without any client
   * persisting a position the person dragging has not settled on yet.
   */
  const [localGeometry, setLocalGeometry] = useState<
    ReadonlyMap<string, CanvasNodeGeometry>
  >(EMPTY_CANVAS_GEOMETRY);
  const localGeometryRef = useRef(localGeometry);
  localGeometryRef.current = localGeometry;

  // Cached by value, for the same reason `claims` below is: a teammate moving
  // their pointer republishes their whole awareness entry many times a second,
  // and a fresh map each time would repaint every card on the board even when
  // nobody is dragging anything.
  const remoteGeometryRef = useRef(EMPTY_CANVAS_GEOMETRY);
  const remoteGeometry = useMemo(() => {
    const next = remoteMovingGeometry(awarenessEntries, localClientId);
    if (sameCanvasGeometry(remoteGeometryRef.current, next)) {
      return remoteGeometryRef.current;
    }
    remoteGeometryRef.current = next;
    return next;
  }, [awarenessEntries, localClientId]);

  // Local wins: this user's own frames are ahead of the round trip that would
  // bring them back through awareness, and a card must never stutter between
  // the two.
  const liveGeometry = useMemo(() => {
    if (localGeometry.size === 0) return remoteGeometry;
    if (remoteGeometry.size === 0) return localGeometry;
    return new Map([...remoteGeometry, ...localGeometry]);
  }, [localGeometry, remoteGeometry]);

  /**
   * The board as painted: the document plus whatever is mid-gesture.
   *
   * Only React Flow, the edges, and presence read this. Everything that acts on
   * the board -- activation, comment anchoring, adding a card, saving the home
   * view -- goes through `documentRef`, because those are answers about what the
   * board *is*, and a box somebody is still holding is not that yet.
   */
  const paintedDocument = useMemo(
    () => withCanvasNodeGeometry(document, liveGeometry),
    [document, liveGeometry]
  );

  const committedNodes = useRef<ReturnType<typeof toFlowNodes>>([]);
  const nodes = useMemo(
    () =>
      toFlowNodes(
        paintedDocument,
        {
          activeNodeId,
          zoom,
          lod,
          selectedIds,
          readOnly,
          tool: panel.tool,
        },
        committedNodes.current
      ),
    [
      paintedDocument,
      activeNodeId,
      zoom,
      lod,
      selectedIds,
      readOnly,
      panel.tool,
    ]
  );
  useLayoutEffect(() => {
    committedNodes.current = nodes;
  }, [nodes]);
  const edges = useMemo(
    () => toFlowEdges(paintedDocument, { selectedIds, readOnly }),
    [paintedDocument, selectedIds, readOnly]
  );

  const participants = useMemo(
    () =>
      canvasPresenceParticipants(awarenessEntries ?? EMPTY_AWARENESS, {
        ...(localClientId === null ? {} : { localClientId }),
      }),
    [awarenessEntries, localClientId]
  );

  // Claims are cached by value, not by the identity of the awareness map that
  // produced them: a teammate moving their pointer republishes their whole
  // entry many times a second, and every one of those ticks would otherwise
  // hand the card context a new object and re-render every card on the board.
  const claimsRef =
    useRef<ReadonlyMap<string, readonly CanvasCardClaimant[]>>(EMPTY_CLAIMS);
  const claims = useMemo(() => {
    const next = canvasCardClaimants(participants);
    if (sameCanvasCardClaimants(claimsRef.current, next)) {
      return claimsRef.current;
    }
    claimsRef.current = next;
    return next;
  }, [participants]);

  const jumpToParticipant = useCallback(
    (participant: CanvasPresenceParticipant) => {
      const rect = participant.viewport;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      // Cancels any in-flight activation for the same reason a pane click does:
      // the user just asked to look somewhere else.
      activationToken.current += 1;
      void flow.fitBounds(rect, {
        padding: 0.02,
        duration: ACTIVATION_DURATION_MS,
      });
    },
    [flow]
  );

  const deactivate = useCallback(() => {
    activationToken.current += 1;
    setActiveNodeId(null);
  }, []);

  const navigationOverview = useRef<Viewport | null>(null);
  const navigateScreen = useCallback(
    (nodeId: string) => {
      if (!(documentRef.current.nodes ?? []).some((node) => node.id === nodeId))
        return;
      navigationOverview.current ??= flow.getViewport();
      deactivate();
      void flow.fitView({
        nodes: [{ id: nodeId }],
        padding: 0.35,
        maxZoom: 1,
        duration: ACTIVATION_DURATION_MS,
      });
    },
    [deactivate, flow]
  );
  const returnToNavigationOverview = useCallback(() => {
    deactivate();
    const previous = navigationOverview.current;
    navigationOverview.current = null;
    if (previous)
      void flow.setViewport(previous, { duration: ACTIVATION_DURATION_MS });
    else
      void flow.fitView({
        padding: 0.2,
        maxZoom: 1,
        duration: ACTIVATION_DURATION_MS,
      });
  }, [deactivate, flow]);

  const activate = useCallback(
    (nodeId: string) => {
      const node = (documentRef.current.nodes ?? []).find(
        (candidate) => candidate.id === nodeId
      );
      if (!node) return;
      if (isCanvasActivationZoom(flow.getZoom())) {
        setActiveNodeId(nodeId);
        return;
      }
      const token = (activationToken.current += 1);
      void flow
        .setCenter(node.x + node.width / 2, node.y + node.height / 2, {
          zoom: CANVAS_ACTIVATION_ZOOM,
          duration: ACTIVATION_DURATION_MS,
        })
        .then(() => {
          // A second click, a pane click, or Escape during the animation bumps
          // the token; activating then would fight whatever the user just did.
          if (activationToken.current === token) setActiveNodeId(nodeId);
        });
    },
    [flow]
  );

  // ---------------------------------------------------------------------
  // Comments: where a thread sits on the board, and how to get to it.
  // ---------------------------------------------------------------------

  /** The target a composer is open for, or null. */
  const [pendingComment, setPendingComment] =
    useState<CanvasCommentTarget | null>(null);
  /** Armed by the toolbar; the next pane click drops a pin there. */
  const [pinPlacement, setPinPlacement] = useState(false);

  const nodeLabelOf = useCallback((nodeId: string): string | null => {
    const node = (documentRef.current.nodes ?? []).find(
      (candidate) => candidate.id === nodeId
    );
    return node === undefined ? null : canvasCardLabel(node);
  }, []);

  /**
   * Bring a thread's target into view. Registered with the comment wiring, so
   * clicking a thread in the host's panel moves this board -- the one thing the
   * panel cannot do for itself.
   */
  const focusCommentTarget = useCallback(
    (target: CanvasCommentTarget): boolean => {
      activationToken.current += 1;
      if (target.kind === 'point') {
        void flow.setCenter(target.point.x, target.point.y, {
          zoom: flow.getZoom(),
          duration: ACTIVATION_DURATION_MS,
        });
        return true;
      }
      const node = (documentRef.current.nodes ?? []).find(
        (candidate) => candidate.id === target.nodeId
      );
      if (!node) return false;
      setSelectedIds(new Set([node.id]));
      void flow.setCenter(node.x + node.width / 2, node.y + node.height / 2, {
        zoom: flow.getZoom(),
        duration: ACTIVATION_DURATION_MS,
      });
      return true;
    },
    [flow]
  );

  useEffect(() => {
    if (!comments) return;
    comments.registerFocus(focusCommentTarget);
    return () => comments.registerFocus(null);
  }, [comments, focusCommentTarget]);

  const openCardThread = useCallback(
    (nodeId: string) => {
      const thread = comments?.threads.find(
        (candidate) =>
          candidate.target.kind === 'node' &&
          candidate.target.nodeId === nodeId &&
          !candidate.resolved
      );
      if (thread) comments?.openThread(thread.threadId);
    },
    [comments]
  );

  /**
   * The `@agent` ask this user is being asked about, one at a time.
   *
   * Oldest first, and one at a time on purpose: this is a consent prompt, and a
   * stack of them is how consent turns into a "yes" button people learn to hit
   * without reading. Anyone in the room can put one here -- see
   * `canvasPendingAgentRequests` -- so the queue has to stay a queue.
   */
  const agentRequest = comments?.agentRequests[0];

  const cardComments = useMemo<CanvasCardCommentsAccess | null>(
    () =>
      comments?.enabled === true
        ? {
            counts: comments.counts,
            canComment: comments.canComment,
            onOpenCardThread: openCardThread,
            onCommentOnCard: (nodeId) => {
              setPinPlacement(false);
              setPendingComment({ kind: 'node', nodeId });
            },
          }
        : null,
    [comments, openCardThread]
  );

  // ---------------------------------------------------------------------
  // Revisions: one card's history at a time, and pinning one as a new card.
  // ---------------------------------------------------------------------

  /** The card whose rail is open, or null. */
  const [revisionsNodeId, setRevisionsNodeId] = useState<string | null>(null);

  const revisionSource = getCanvasCallbacks().revisions;
  const pickCardReference = getCanvasCallbacks().pickCardReference;

  const cardRevisions = useMemo<CanvasCardRevisionsAccess | null>(
    () =>
      revisionSource === undefined
        ? null
        : { onOpenRevisions: (nodeId) => setRevisionsNodeId(nodeId) },
    [revisionSource]
  );

  /**
   * The open rail's card, re-derived from the live document rather than
   * captured when it opened: the card can be moved, relabelled, or deleted by a
   * teammate while the rail is up, and a rail pointing at a node that no longer
   * exists must close rather than describe it.
   */
  const revisionCard = useMemo(() => {
    if (revisionsNodeId === null) return null;
    const node = (document.nodes ?? []).find(
      (candidate) => candidate.id === revisionsNodeId
    );
    if (!node) return null;
    const reference = effectiveCanvasCardReference(canvasCardReference(node), {
      preferShared: collaborative,
    });
    return reference === null
      ? null
      : { nodeId: node.id, reference, label: canvasCardLabel(node) };
  }, [collaborative, document, revisionsNodeId]);

  useEffect(() => {
    if (revisionsNodeId !== null && revisionCard === null) {
      setRevisionsNodeId(null);
    }
  }, [revisionCard, revisionsNodeId]);

  const submitPendingComment = useCallback(
    (text: string, mentionedUserIds: string[]) => {
      const target = pendingComment;
      if (!target || !comments) return;
      setPendingComment(null);
      void comments.createThread(target, text, mentionedUserIds);
    },
    [comments, pendingComment]
  );

  /**
   * A pane click either drops a pin or deactivates the hot card.
   *
   * Placement is a one-shot mode rather than a persistent tool: dropping a pin
   * disarms it, so a user who came to leave one remark does not then have to
   * remember to turn the tool off before they can click the board again.
   */
  const onPaneClick = useCallback(
    (event: ReactMouseEvent) => {
      if (!pinPlacement || !comments?.canComment) {
        deactivate();
        return;
      }
      setPinPlacement(false);
      const point = flow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      setPendingComment({
        kind: 'point',
        point: {
          x: toCanvasCoordinate(point.x),
          y: toCanvasCoordinate(point.y),
        },
      });
    },
    [comments, deactivate, flow, pinPlacement]
  );

  // Zooming away from 1.0 while a card is hot drops the activation entirely
  // rather than leaving state pointing at a card the mapping has already turned
  // inert. Deliberately not a re-activation on the way back: the user zoomed
  // out to look at the board, and having a card silently grab the keyboard again
  // when they zoom back in is not what they asked for.
  useEffect(() => {
    if (activeNodeId !== null && hotNodeId === null) deactivate();
  }, [activeNodeId, hotNodeId, deactivate]);

  // A discrete edit closes the previous undo step before opening its own; a
  // continuous one (dragging, typing into a card) deliberately does not, so a
  // gesture stays a single undo.
  const commit = useCallback(
    (next: CanvasDocument) => {
      if (next === documentRef.current) return;
      onEditBoundary?.();
      onDocumentChange(next);
    },
    [onDocumentChange, onEditBoundary]
  );

  /**
   * Pin a revision as its own card.
   *
   * The entire write is `pinCanvasRevisionCard`, which only ever appends -- the
   * card the rail was opened from is returned untouched. There is deliberately
   * no counterpart that writes a revision back over head; see the header of
   * `canvasRevisions.ts`.
   */
  const pinRevision = useCallback(
    (entry: CanvasRevisionEntry) => {
      if (revisionsNodeId === null || readOnly) return;
      commit(
        pinCanvasRevisionCard(documentRef.current, {
          sourceNodeId: revisionsNodeId,
          revisionId: entry.revisionId,
          sequence: entry.sequence,
        })
      );
    },
    [commit, readOnly, revisionsNodeId]
  );

  /**
   * Outbound presence: cursor, viewport rectangle, and selection.
   *
   * Ephemeral by construction -- see useCanvasAwarenessPublisher, which owns
   * the coalescing and the unmount sweep as well.
   */
  const {
    publishMovingAwareness,
    publishViewportAwareness,
    onPointerMove,
    onPointerLeave,
  } = useCanvasAwarenessPublisher({
    flow,
    surfaceRef: wrapperRef,
    onAwarenessChange,
    document,
    selectedIds,
    localGeometryRef,
  });

  const guidesRef = useRef(guides);
  guidesRef.current = guides;
  const showGuides = useCallback((next: readonly CanvasGuide[]) => {
    // Compared before setting: this runs on every frame of a drag, and an
    // unchanged guide set must not cost the board a second render.
    if (sameGuides(guidesRef.current, next)) return;
    guidesRef.current = next;
    setGuides(next);
  }, []);

  /** See canvasDragSnapping: the batch in, the snapped batch and guides out. */
  const withDragSnapping = useCallback(
    (
      changes: readonly NodeChange[],
      base: CanvasDocument
    ): readonly NodeChange[] => {
      const result = snapCanvasDragChanges(changes, base, {
        enabled: panel.smartGuides && !snapDefeatedRef.current,
        zoom: flow.getZoom(),
      });
      if (result.guides !== null) showGuides(result.guides);
      return result.changes;
    },
    [flow, panel.smartGuides, showGuides]
  );

  /**
   * React Flow's change stream, routed by what it costs to keep.
   *
   * Every judgement in here is `stepCanvasGesture`'s, deliberately: mid-gesture
   * frames become held geometry and an awareness broadcast, and only the frame
   * that ends the gesture is folded into the document, so one drag is one
   * durable write rather than sixty. This handler is the wiring around that
   * decision and should stay that way -- read that function before changing the
   * shape of anything here.
   */
  /** Set by Escape mid-drag; cleared by the frame that ends the gesture. */
  const dragCancelledRef = useRef(false);

  const onNodesChange = useCallback(
    (incoming: NodeChange[]) => {
      // A cancelled drag must not be *written*, not merely un-painted: React
      // Flow keeps delivering the gesture -- including the `dragging: false`
      // frame that ends it -- and that last frame is the one the commit path
      // turns into a document edit. Dropping the position changes leaves the
      // painted board derived from the document, so the cards snap back.
      const cancellation = applyCanvasDragCancellation(
        incoming,
        dragCancelledRef.current
      );
      dragCancelledRef.current = cancellation.stillCancelled;
      const changes = cancellation.changes;

      setSelectedIds((current) =>
        expandCanvasGroupSelection(
          applyCanvasSelection(current, changes),
          documentRef.current.nodes ?? []
        )
      );
      if (readOnly) return;

      const step = stepCanvasGesture(
        documentRef.current,
        localGeometryRef.current,
        changes,
        withDragSnapping
      );

      if (step.commit !== null) {
        if (changes.some((change) => change.type === 'remove')) {
          onEditBoundary?.();
        }
        onDocumentChange(step.commit);
      }
      if (step.held !== localGeometryRef.current) {
        // Written straight to the ref as well as to state: two change batches
        // can land in one tick, and the second must fold against the first
        // rather than against whatever the last render happened to see. Both
        // updates batch with the commit above, so the document arrives in the
        // same render the overlay is dropped in and a card that has just been
        // let go never flashes back to where the gesture started.
        localGeometryRef.current = step.held;
        setLocalGeometry(step.held);
        publishMovingAwareness(step.held);
      }
      if (step.kind === 'boundary') {
        showGuides(EMPTY_GUIDES);
        onEditBoundary?.();
      }
    },
    [
      onDocumentChange,
      onEditBoundary,
      publishMovingAwareness,
      readOnly,
      showGuides,
      withDragSnapping,
    ]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setSelectedIds((current) => applyCanvasSelection(current, changes));
      if (readOnly) return;
      commit(applyCanvasEdgeChanges(documentRef.current, changes));
    },
    [commit, readOnly]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      commit(connectCanvasEdge(documentRef.current, connection));
    },
    [commit, readOnly]
  );

  // Pan and zoom go to the host as this user's view, never into the document.
  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      setGestureActive(false);
      onViewportChange?.(viewport);
      publishViewportAwareness();
    },
    [onViewportChange, publishViewportAwareness]
  );

  /**
   * Publish the live zoom so the resize affordances can cancel it out.
   *
   * A DOM write rather than React state, and guarded so a pan (which fires this
   * on every frame without changing the scale) costs nothing. Putting the zoom
   * in state would re-render every card on the board sixty times a second, to
   * move four handles.
   */
  const publishedZoomRef = useRef<number | null>(null);
  const publishZoom = useCallback((zoomLevel: number) => {
    if (publishedZoomRef.current === zoomLevel) return;
    publishedZoomRef.current = zoomLevel;
    wrapperRef.current?.style.setProperty(
      '--nim-canvas-resize-scale',
      String(1 / zoomLevel)
    );
  }, []);

  const onMove = useCallback(
    (_event: unknown, viewport: Viewport) => publishZoom(viewport.zoom),
    [publishZoom]
  );

  // The opening value. `onMove` covers every change after mount, but nothing
  // fires for the viewport the board *opens* on -- a restored view at 40% would
  // start with pointer-sized handles until the user happened to pan.
  useEffect(() => {
    publishZoom(flow.getViewport().zoom);
  }, [flow, publishZoom]);

  /** Write the current view into the board as its home view. A real edit. */
  const saveHomeView = useCallback(() => {
    commit(withCanvasViewport(documentRef.current, flow.getViewport()));
  }, [commit, flow]);

  // Camera commands, shared by the zoom widget, the keyboard map, and the
  // context menu. See useCanvasCamera for why each one cancels activation.
  const { camera, savedHomeView } = useCanvasCamera({
    flow,
    surfaceRef: wrapperRef,
    activationToken,
    selectedIds,
    documentRef,
    document,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    durationMs: ACTIVATION_DURATION_MS,
  });

  const cardCallbacks = useMemo<CanvasCardCallbacks>(
    () => ({
      observeCard,
      preferSharedReferences: collaborative,
      onPatchNode: (id, patch) => {
        if (readOnly) return;
        // Continuous: typing into a card undoes as a sentence, not a letter.
        const next = updateCanvasNode(documentRef.current, id, patch);
        if (next !== documentRef.current) onDocumentChange(next);
      },
      // Front, back, and delete used to live here, for the per-card toolbar.
      // They are registry commands now -- `bring-front`, `send-back`, `delete`
      // in useCanvasCommands -- so the card no longer needs a way to ask.
    }),
    [collaborative, observeCard, onDocumentChange, readOnly]
  );

  /** Canvas coordinates of the middle of what the user is currently looking at. */
  const viewportCenter = useCallback(() => {
    const bounds = wrapperRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return flow.screenToFlowPosition({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    });
  }, [flow]);

  /**
   * Place `node` on the board and select it.
   *
   * The card's *origin* is what has to land on the grid, so snapping the
   * pointer instead -- `screenToFlowPosition`'s own `snapGrid` -- would not do
   * it: a new card is centred on that point, and half of 180 is not a multiple
   * of 20.
   */
  const place = useCallback(
    (node: CanvasAnyNode) => {
      const placed =
        snapDefeated || !panel.gridSnap ? node : snapCanvasNodeToGrid(node);
      commit(addCanvasNode(documentRef.current, placed));
      setSelectedIds(new Set([placed.id]));
    },
    [commit, panel.gridSnap, snapDefeated]
  );

  const addCard = useCallback(
    (kind: 'sticky' | 'text' | 'image' | 'group') => {
      const center = viewportCenter();
      if (!center) return;
      place(createNativeCanvasNode(documentRef.current, kind, center));
    },
    [place, viewportCenter]
  );

  // Dropping a card in from the host's tree; see useCanvasDropTarget.
  const { dropActive, onDragOver, onDragLeave, onDrop } = useCanvasDropTarget({
    flow,
    documentRef,
    readOnly,
    place,
  });

  /**
   * Put an existing file or shared document on the board.
   *
   * The center is read *after* the picker resolves, not before: the dialog is
   * modal but the board underneath is not frozen -- a teammate's edit or a
   * restored viewport can move it while the user is choosing -- and a card
   * dropped at where the board used to be is a card the user has to go find.
   */
  const addReferenceCard = useCallback(async () => {
    const pick = await pickCardReference?.();
    if (!pick) return;
    const center = viewportCenter();
    if (!center) return;
    place(
      createReferenceCanvasNode(
        documentRef.current,
        pick.reference,
        center,
        pick.label
      )
    );
  }, [pickCardReference, place, viewportCenter]);

  // ---------------------------------------------------------------------
  // Commands: one runner behind the keyboard, the selection bar, and the menu.
  // ---------------------------------------------------------------------

  const escapeActions = useMemo(
    () => ({
      deactivateCard: () => {
        if (activeNodeId === null) return false;
        deactivate();
        return true;
      },
      /**
       * Drop the held geometry without writing it.
       *
       * Best effort by construction: React Flow owns the pointer capture, so a
       * drag whose button is still down carries on. What Escape can do is
       * refuse to *keep* the frames -- nothing has been committed yet, so the
       * cards snap back to where the document still has them.
       */
      cancelDrag: () => {
        if (localGeometryRef.current.size === 0) return false;
        // The flag is what makes the cancel durable; see
        // `applyCanvasDragCancellation` for why clearing the overlay alone
        // leaves the drag's last frame free to commit.
        dragCancelledRef.current = true;
        localGeometryRef.current = EMPTY_CANVAS_GEOMETRY;
        setLocalGeometry(EMPTY_CANVAS_GEOMETRY);
        publishMovingAwareness(EMPTY_CANVAS_GEOMETRY);
        showGuides(EMPTY_GUIDES);
        return true;
      },
      clearSelection: () => {
        if (selectedIds.size === 0) return false;
        setSelectedIds(new Set<string>());
        return true;
      },
      returnToSelectTool: () => {
        if (!handTool && !pinPlacement) return false;
        setTool('select');
        setPinPlacement(false);
        return true;
      },
      closePanel: () => {
        if (pendingComment === null && revisionsNodeId === null) return false;
        setPendingComment(null);
        setRevisionsNodeId(null);
        return true;
      },
    }),
    [
      activeNodeId,
      deactivate,
      handTool,
      pendingComment,
      pinPlacement,
      publishMovingAwareness,
      revisionsNodeId,
      selectedIds,
      setTool,
      showGuides,
    ]
  );

  /**
   * Edges share the selection set with nodes -- both fold through
   * `applyCanvasSelection` -- so this is how many of the selected ids are
   * edges. The delete command needs it, because the registry's `enabled` rule
   * only counts nodes.
   */
  const selectedEdgeCount = useMemo(
    () =>
      (document.edges ?? []).filter((edge) => selectedIds.has(edge.id)).length,
    [document.edges, selectedIds]
  );

  const { ctx: commandContext, run: runCommand } = useCanvasCommands({
    documentRef,
    document,
    selectedIds,
    setSelectedIds,
    readOnly,
    activeNodeId,
    tool: panel.tool,
    setTool,
    commit,
    camera,
    addCard,
    togglePin:
      comments?.canComment === true
        ? () => {
            setPendingComment(null);
            setPinPlacement((armed) => !armed);
          }
        : undefined,
    togglePanelPref,
    escape: escapeActions,
  });

  /**
   * The board's keyboard, resolved by `canvasKeymap` rather than by a ladder
   * of `if (event.key === ...)`.
   *
   * The guards that matter -- a hot card owns the keyboard, typing into an
   * input is not a shortcut -- live in `resolveCanvasKey` and are tested there.
   * This listener's only judgement is that a resolved command consumes the
   * event: leaving the default in place would let Cmd+A select the whole
   * transcript behind the board and Backspace navigate the window back.
   */
  useEffect(() => {
    /**
     * The board only answers the keyboard when it is the thing being used.
     *
     * Two ways it can be mounted and not be: Nimbalyst keeps every mode
     * component mounted and hides the inactive ones with `display: none`, so a
     * board sitting behind the Agent transcript still has a live window
     * listener and a zero-sized box; and a visible board is not the focused
     * pane just because it is on screen. Without both checks, typing "v" into a
     * chat box would arm the hand tool on a board nobody is looking at, and
     * Cmd+A would be swallowed from whatever the user actually meant it for.
     * The focus test is the same one the undo handler in CanvasEditor makes.
     */
    const boardIsInPlay = (event: KeyboardEvent): boolean => {
      const surface = wrapperRef.current;
      if (!surface) return false;
      const box = surface.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return false;
      const root = surface.closest('.canvas-editor') ?? surface;
      const target = event.target as Node | null;
      if (target !== null && root.contains(target)) return true;
      const active = window.document.activeElement;
      return active !== null && root.contains(active);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!boardIsInPlay(event)) return;
      // React Flow's own accessibility keys are off (`disableKeyboardA11y`),
      // but anything else that has already claimed this press -- a dialog, a
      // Monaco instance inside a hot card -- gets to keep it.
      if (event.defaultPrevented) return;

      /*
       * Escape reaches an active card before the keymap does.
       *
       * A hot card's editor owns the focus, and `resolveCanvasKey` refuses
       * every key typed into an editable element -- correctly, or "v" would
       * arm the hand tool mid-sentence. Escape is the one key that has to cross
       * that line anyway: it is how a card is deactivated, and there is no
       * other way out of a card the user has opened.
       */
      if (event.key === 'Escape' && activeNodeId !== null) {
        event.preventDefault();
        deactivate();
        return;
      }

      const id = resolveCanvasCommand(
        {
          key: event.key,
          code: event.code,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          target: event.target,
        },
        commandContext,
        selectedEdgeCount
      );
      if (id === null) return;
      event.preventDefault();
      runCommand(id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeNodeId, commandContext, deactivate, runCommand, selectedEdgeCount]);

  /**
   * Keep React Flow's own `selected` flags in step with the surface's set.
   *
   * Two paths now change the selection behind React Flow's back: group
   * expansion (selecting one member selects the rest) and the commands that
   * select for you, like select-all and duplicate. React Flow draws the
   * multi-selection rectangle from its *own* store, so a set the surface widened
   * would paint a rectangle around the one card the user clicked while the
   * commands acted on five.
   */
  useEffect(() => {
    flow.setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const selected = selectedIds.has(node.id);
        if (node.selected === selected) return node;
        changed = true;
        return { ...node, selected };
      });
      return changed ? next : current;
    });
  }, [flow, selectedIds]);

  const contextMenu = useCanvasContextMenu();

  /**
   * The three actions the selection bar carries that are not registry
   * commands: colour takes an argument, and comment and history open a host
   * surface rather than editing the board. They are the two the retired
   * per-card `NodeToolbar` owned, plus the colour swatches it never had.
   */
  const colorSelection = useCallback(
    (color: string | null) => {
      if (readOnly) return;
      commit(
        [...selectedIds].reduce(
          (next, id) =>
            updateCanvasNode(next, id, { color: color ?? undefined }),
          documentRef.current
        )
      );
    },
    [commit, readOnly, selectedIds]
  );

  const selectionBarNode =
    commandContext.selection.length === 1 ? commandContext.selection[0] : null;

  const dropStickyAt = useCallback(
    (at: { x: number; y: number }) => {
      if (readOnly) return;
      place(
        createNativeCanvasNode(
          documentRef.current,
          'sticky',
          flow.screenToFlowPosition(at)
        )
      );
    },
    [flow, place, readOnly]
  );

  const dropCommentAt = useCallback(
    (at: { x: number; y: number }) => {
      if (comments?.canComment !== true) return;
      const point = flow.screenToFlowPosition(at);
      setPinPlacement(false);
      setPendingComment({
        kind: 'point',
        point: {
          x: toCanvasCoordinate(point.x),
          y: toCanvasCoordinate(point.y),
        },
      });
    },
    [comments, flow]
  );

  // Restore this user's own last view if the host remembers one, then the
  // board's saved home view, and otherwise frame the cards. Read once: React
  // Flow owns the viewport after mount, and re-applying it on every document
  // change would yank the board back mid-pan -- which is also exactly what a
  // teammate's pan used to do when the viewport lived in the shared document.
  const savedViewport = useRef(
    initialViewport ?? readCanvasViewport(document)
  ).current;

  // Fit after the nodes are measured, not via the `fitView` prop. The prop fits
  // at init, when the cards have no measured box yet, and the resulting zoom
  // clamps to `minZoom` -- the board opens at 10%. Waiting on
  // `useNodesInitialized` is the same fix the old mockup canvas made with a
  // ladder of setTimeouts, without guessing at a delay.
  const nodesInitialized = useNodesInitialized();
  const hasFitRef = useRef(savedViewport !== null);
  useEffect(() => {
    if (hasFitRef.current || !nodesInitialized) return;
    hasFitRef.current = true;
    void flow.fitView({ padding: 0.2, maxZoom: 1 });
  }, [nodesInitialized, flow]);

  useEffect(() => {
    if (!nodesInitialized || !onAwarenessChange) return;
    const frame = requestAnimationFrame(publishViewportAwareness);
    return () => cancelAnimationFrame(frame);
  }, [nodesInitialized, onAwarenessChange, publishViewportAwareness]);

  // Cmd/Ctrl + wheel zooms about the pointer; see useCanvasWheelZoom for why
  // the board claims that gesture rather than leaving it to React Flow.
  useCanvasWheelZoom(flow, wrapperRef, {
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
  });

  // Read `altKey` off the event rather than matching `event.key`: on macOS
  // Option changes the character a key produces, so the keydown that arrives
  // while snapping is defeated frequently is not named 'Alt' at all. The blur
  // reset stops a modifier released outside the window from sticking on.
  useEffect(() => {
    const sync = (event: KeyboardEvent) => setSnapDefeated(event.altKey);
    const release = () => setSnapDefeated(false);
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('blur', release);
    };
  }, []);

  return (
    <div
      className={`canvas-surface${
        dropActive ? ' canvas-surface--drop-target' : ''
      }${handTool ? ' canvas-surface--hand' : ''}`}
      ref={wrapperRef}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={onDragLeave}
    >
      <CanvasEdgeMarkers />
      <CanvasCommandTooltips surfaceRef={wrapperRef} />

      {/* The provider wraps <ReactFlow>, not its children: card components are
          rendered by React Flow's own node renderer, which is a sibling of the
          children we pass in, so a provider placed inside would never reach
          them. */}
      <CanvasCardCallbacksContext.Provider value={cardCallbacks}>
        <CanvasCardCommentsContext.Provider value={cardComments}>
          <CanvasCardRevisionsContext.Provider value={cardRevisions}>
            <CanvasCardClaimsContext.Provider value={claims}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onMoveStart={() => setGestureActive(true)}
                onMove={onMove}
                onMoveEnd={onMoveEnd}
                onNodeDragStart={() => {
                  // Close whatever step preceded this drag, so "move a card, move
                  // another card" is two undos rather than one.
                  onEditBoundary?.();
                }}
                // A click on an ordinary card selects it and React Flow does that
                // itself. A frame is never selectable -- that is what keeps a
                // marquee off it (see `canvasNodeSelectable`) -- so its click is the
                // surface's to answer, through the same set the selection bar, the
                // context menu, and group expansion all read.
                onNodeClick={(event, node) => {
                  if (node.data.kind !== 'group') return;
                  // Group-aware on its own, so it is not expanded afterwards: an
                  // expansion would undo the deselecting half of a Shift+click.
                  setSelectedIds(
                    canvasClickSelection(
                      selectedIds,
                      node.id,
                      event.shiftKey || event.metaKey || event.ctrlKey,
                      documentRef.current.nodes ?? []
                    )
                  );
                }}
                onNodeDoubleClick={(_event, node) => activate(node.id)}
                onPaneClick={onPaneClick}
                onPaneContextMenu={(event) =>
                  contextMenu.open(event as ReactMouseEvent, 'canvas')
                }
                // Right-clicking a card that is not in the selection makes it the
                // selection first: a menu whose items act on something the user is
                // not pointing at is the classic right-click bug.
                onNodeContextMenu={(event, node) => {
                  // Through the same expansion a click goes through: right-clicking
                  // one member of a group and getting a menu that acts on that card
                  // alone would be a different answer to the same question.
                  if (!selectedIds.has(node.id)) {
                    // Never a toggle -- it only replaces a selection the user is
                    // not pointing at -- so this is a plain click, through the one
                    // helper that knows a group is selected as a unit.
                    setSelectedIds(
                      canvasClickSelection(
                        selectedIds,
                        node.id,
                        false,
                        documentRef.current.nodes ?? []
                      )
                    );
                  }
                  contextMenu.open(event, 'selection');
                }}
                defaultViewport={savedViewport ?? undefined}
                minZoom={MIN_ZOOM}
                maxZoom={MAX_ZOOM}
                panOnScroll
                // The tool is the pointer's meaning, and it is exactly this pair.
                // Select leaves the left button to the rubber band and gives pan to
                // the middle and right buttons; hand gives the left button back to
                // panning and takes the band away. Space is the held-down escape
                // hatch out of select without touching the rail.
                panOnDrag={handTool ? true : [1, 2]}
                selectionOnDrag={!handTool}
                // Touch, not enclose: a band that clips a card selects it, which is
                // what every board tool does and what the reference does.
                selectionMode={SelectionMode.Partial}
                panActivationKeyCode="Space"
                // React Flow moves the selected nodes on an arrow key of its own
                // accord, one step per press, outside the command runner and
                // outside the undo boundary the runner opens. With the board's own
                // nudge commands bound to the same keys, one ArrowRight moved the
                // selection twice and left two undo steps behind it.
                disableKeyboardA11y
                zoomOnDoubleClick={false}
                snapToGrid={!snapDefeated && panel.gridSnap}
                snapGrid={SNAP_GRID}
                // LOD owns editor virtualization. Culling these cheap shells too
                // remounts them on every viewport crossing and bypasses the LOD
                // gesture freeze (including the editors it was keeping alive).
                zIndexMode="manual"
                elevateNodesOnSelect={false}
                autoPanOnSelection={false}
                nodesDraggable={!readOnly}
                nodesConnectable={!readOnly}
                elementsSelectable
                // Delete is a registry command now, not React Flow's own key
                // handling: the command skips locked cards and lands as one undo
                // step, and leaving both in place would delete twice.
                deleteKeyCode={null}
                proOptions={{ hideAttribution: false }}
                className="canvas-surface__flow"
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={20}
                  size={1}
                  color="var(--nim-border)"
                />
                <ViewportPortal>
                  <svg
                    className="canvas-guides"
                    aria-hidden
                    width={0}
                    height={0}
                    // Inside the transformed viewport, so the endpoints below are
                    // plain canvas coordinates and the guides move with the board.
                    // `overflow: visible` is what lets a line drawn at a negative
                    // coordinate paint at all.
                    style={{ position: 'absolute', overflow: 'visible' }}
                  >
                    {guides.map((guide) => (
                      <line
                        key={`${guide.kind}:${guide.x1},${guide.y1},${guide.x2},${guide.y2}`}
                        className={`canvas-guides__line canvas-guides__line--${guide.kind}`}
                        x1={guide.x1}
                        y1={guide.y1}
                        x2={guide.x2}
                        y2={guide.y2}
                      />
                    ))}
                  </svg>
                </ViewportPortal>
                <CanvasPresenceLayer
                  participants={participants}
                  nodes={paintedDocument.nodes ?? []}
                />
                {comments?.enabled === true && (
                  <CanvasCommentPins
                    threads={comments.threads}
                    onOpenThread={comments.openThread}
                  />
                )}
                {pendingComment !== null && comments !== undefined && (
                  <Panel
                    position="bottom-left"
                    className="canvas-comment-panel"
                  >
                    <Suspense fallback={null}>
                      <CanvasCommentComposer
                        target={pendingComment}
                        targetLabel={canvasCommentTargetLabel(
                          pendingComment,
                          nodeLabelOf
                        )}
                        getMembers={comments.getMembers}
                        onSubmit={submitPendingComment}
                        onCancel={() => setPendingComment(null)}
                      />
                    </Suspense>
                  </Panel>
                )}
                {agentRequest !== undefined && comments !== undefined && (
                  <CanvasAgentRequestPanel
                    request={agentRequest}
                    onConfirm={comments.confirmAgentRequest}
                    onDismiss={comments.dismissAgentRequest}
                  />
                )}
                {revisionCard !== null && revisionSource !== undefined && (
                  <Panel
                    position="bottom-right"
                    className="canvas-revision-panel"
                  >
                    <Suspense fallback={null}>
                      <CanvasRevisionRail
                        nodeId={revisionCard.nodeId}
                        label={revisionCard.label || revisionCard.nodeId}
                        reference={revisionCard.reference}
                        source={revisionSource}
                        canPin={!readOnly}
                        onPin={pinRevision}
                        onClose={() => setRevisionsNodeId(null)}
                      />
                    </Suspense>
                  </Panel>
                )}
                <CanvasSelectionBar
                  selection={commandContext.selection}
                  ctx={commandContext}
                  run={runCommand}
                  onColor={colorSelection}
                  onComment={
                    comments?.canComment === true && selectionBarNode !== null
                      ? () => {
                          setPinPlacement(false);
                          setPendingComment({
                            kind: 'node',
                            nodeId: selectionBarNode.id,
                          });
                        }
                      : undefined
                  }
                  onHistory={
                    revisionSource !== undefined &&
                    selectionBarNode !== null &&
                    canvasCardReference(selectionBarNode) !== null
                      ? () => setRevisionsNodeId(selectionBarNode.id)
                      : undefined
                  }
                />
                <Panel position="top-right" className="canvas-presence-panel">
                  <CanvasPresenceRoster
                    participants={participants}
                    onJumpTo={jumpToParticipant}
                  />
                </Panel>
                <CanvasZoomWidget
                  minimap={panel.minimap}
                  gridSnap={panel.gridSnap}
                  smartGuides={panel.smartGuides}
                  onToggle={togglePanelPref}
                  onZoomTo={camera.zoomTo}
                  onZoomIn={camera.zoomIn}
                  onZoomOut={camera.zoomOut}
                  onFitAll={camera.fitAll}
                  onFitSelection={camera.fitSelection}
                  onSavedView={camera.savedView}
                  hasSavedView={savedHomeView !== null}
                  navigation={
                    Array.isArray(document['x-nimbalyst']?.navigation) ? (
                      <CanvasNavigationPanel
                        document={document}
                        onNavigate={navigateScreen}
                        onOverview={returnToNavigationOverview}
                      />
                    ) : undefined
                  }
                />
                {/* React Flow has no colorMode set, so it paints minimap nodes with
                its light-mode defaults -- white swatches on a dark board. The
                mask and background beside these are themed for the same reason. */}
                {panel.minimap && (
                  <MiniMap
                    pannable
                    zoomable
                    maskColor="color-mix(in srgb, var(--nim-bg) 65%, transparent)"
                    nodeColor="var(--nim-bg-tertiary)"
                    nodeStrokeColor="var(--nim-border)"
                    style={{ background: 'var(--nim-bg)' }}
                  />
                )}
                <CanvasToolRail
                  tool={panel.tool}
                  onToolChange={setTool}
                  readOnly={readOnly}
                  onAddCard={addCard}
                  onAddReference={
                    pickCardReference === undefined
                      ? undefined
                      : () => void addReferenceCard()
                  }
                  onTogglePin={
                    comments?.canComment === true
                      ? () => {
                          setPendingComment(null);
                          setPinPlacement((armed) => !armed);
                        }
                      : undefined
                  }
                  pinPlacement={pinPlacement}
                  onSaveView={saveHomeView}
                />
              </ReactFlow>
            </CanvasCardClaimsContext.Provider>
          </CanvasCardRevisionsContext.Provider>
        </CanvasCardCommentsContext.Provider>
      </CanvasCardCallbacksContext.Provider>

      {/* Portalled to the document body, so it is mounted outside the flow
          rather than inside its clipping box. */}
      <CanvasContextMenu
        anchor={contextMenu.menu?.anchor ?? null}
        kind={contextMenu.menu?.kind ?? 'canvas'}
        ctx={commandContext}
        run={runCommand}
        onClose={contextMenu.close}
        onOpenScreenshot={getCanvasCallbacks().openScreenshotSource}
        onAddSticky={dropStickyAt}
        onAddComment={dropCommentAt}
      />

      {(document.nodes ?? []).length === 0 && (
        <div className="canvas-surface__empty">
          {readOnly
            ? 'This board is empty.'
            : pickCardReference !== undefined
            ? 'Empty board. Add a sticky, text, image, frame, or an existing doc to start.'
            : 'Empty board. Add a sticky, text, image, or frame to start.'}
        </div>
      )}
    </div>
  );
}
