/**
 * Live Project Canvas <-> Y.Doc binding.
 *
 * The Y.Doc is the only mutable document model in collaborative mode. React
 * receives immutable projections through `onDocumentChange`; it never becomes
 * a mirrored source that is subscribed back wholesale. A local surface edit is
 * instead expressed as `(renderedBefore, renderedAfter)`: the binding diffs
 * those two projections to learn the user's intent, then applies only those
 * fields to the Y.Doc's current state. If a remote transaction arrived after
 * the rendered projection but before React painted it, untouched remote fields
 * therefore survive.
 *
 * Nodes and edges use the codec's keyed entity maps and retain their Y.Map
 * identity for their whole lifetime. Inserts receive a fractional z-rank from
 * their neighbours; two clients inserting at the same position compute the
 * same rank and settle by their stable content-derived ids. Every local
 * transaction carries a binding-private origin, and the optional UndoManager
 * tracks only that origin, so undo never rolls back a teammate.
 */
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  NIMBALYST_CANVAS_NAMESPACE,
  type CanvasAnyNode,
  type CanvasDocument,
  type CanvasEdge,
} from './CanvasDocument';
import {
  CANVAS_EXTRAS_NAMESPACE,
  CANVAS_EXTRAS_TOP_LEVEL,
  canvasNodeFields,
  getCanvasYEdges,
  getCanvasYExtras,
  getCanvasYMeta,
  getCanvasYNodes,
  readCanvasDocumentFromYDoc,
} from './canvasCollabCodec';
import {
  CANVAS_NODE_RANK_FIELD,
  canvasRankBetween,
  normalizeCanvasRank,
} from './canvasRank';
// Type-only, and canvasPresence imports only types back, so the cycle is
// erased at build time and never reaches the module graph.
import type { CanvasAgentPresence } from './canvasPresence';

export const CANVAS_AWARENESS_FIELD = 'canvas';

export interface CanvasAwarenessPoint {
  x: number;
  y: number;
}

export interface CanvasAwarenessViewportRect extends CanvasAwarenessPoint {
  width: number;
  height: number;
}

/** A card under someone's pointer right now, and where they are holding it. */
export interface CanvasAwarenessNodeGeometry extends CanvasAwarenessViewportRect {
  nodeId: string;
}

export interface CanvasAwarenessState {
  cursor?: CanvasAwarenessPoint;
  viewport?: CanvasAwarenessViewportRect;
  selectedNodeId?: string;
  /**
   * Cards this client is mid-gesture on, streaming at pointer cadence.
   *
   * Presence, not document: a drag produces a new box every frame, all but the
   * last of them are about to be replaced, and pushing each one into the Y.Doc
   * bought an outbox row and a renderer-to-main IPC call per frame for a number
   * nobody would ever read back. The board still moves live on every client
   * because that is exactly what awareness is for; the position becomes a
   * document edit once, when the pointer comes up. See `canvasGestureKind`.
   */
  moving?: readonly CanvasAwarenessNodeGeometry[];
  /**
   * Agent sessions this client hosts, each with its declared working set.
   *
   * Nested inside the hosting client's entry rather than given an awareness
   * client of its own, because that is what an agent actually is here: a
   * session running inside somebody's Nimbalyst, on their behalf. It also makes
   * expiry structural -- when this client's entry goes, every session it was
   * running goes with it, and no card is left haloed by a process that died.
   */
  agents?: readonly CanvasAgentPresence[];
}

export interface CanvasAwarenessPatch {
  cursor?: CanvasAwarenessPoint | null;
  viewport?: CanvasAwarenessViewportRect | null;
  selectedNodeId?: string | null;
  moving?: readonly CanvasAwarenessNodeGeometry[] | null;
  agents?: readonly CanvasAgentPresence[] | null;
}

export interface CanvasAwarenessEntry extends CanvasAwarenessState {
  clientId: number;
  user?: { id: string; name: string; color: string };
}

export interface CanvasBindingOptions {
  onDocumentChange?(document: CanvasDocument): void;
  onAwarenessChange?(entries: ReadonlyMap<number, CanvasAwarenessEntry>): void;
  awareness?: Awareness;
  enableUndoManager?: boolean;
}

type CanvasEntity = CanvasAnyNode | CanvasEdge;

export class CanvasBinding {
  private readonly yNodes: Y.Map<Y.Map<unknown>>;
  private readonly yEdges: Y.Map<Y.Map<unknown>>;
  private readonly yMeta: Y.Map<unknown>;
  private readonly yExtras: Y.Map<unknown>;
  private readonly origin = Symbol('canvas-binding');
  private readonly awareness?: Awareness;
  private readonly options: CanvasBindingOptions;
  private destroyed = false;
  private lastProjectedTransaction: Y.Transaction | null = null;

  public readonly undoManager?: Y.UndoManager;

  private readonly onNodesChanged = (
    _events: Y.YEvent<Y.AbstractType<unknown>>[],
    transaction: Y.Transaction
  ): void => this.projectTransaction(transaction);

  private readonly onEdgesChanged = (
    _events: Y.YEvent<Y.AbstractType<unknown>>[],
    transaction: Y.Transaction
  ): void => this.projectTransaction(transaction);

  private readonly onMetaChanged = (
    _event: Y.YMapEvent<unknown>,
    transaction: Y.Transaction
  ): void => this.projectTransaction(transaction);

  private readonly onExtrasChanged = (
    _event: Y.YMapEvent<unknown>,
    transaction: Y.Transaction
  ): void => this.projectTransaction(transaction);

  private readonly onAwarenessChanged = (): void => {
    if (this.destroyed) return;
    this.options.onAwarenessChange?.(this.getAwarenessEntries());
  };

  constructor(
    private readonly yDoc: Y.Doc,
    options: CanvasBindingOptions = {}
  ) {
    this.options = options;
    this.awareness = options.awareness;
    this.yNodes = getCanvasYNodes(yDoc);
    this.yEdges = getCanvasYEdges(yDoc);
    this.yMeta = getCanvasYMeta(yDoc);
    this.yExtras = getCanvasYExtras(yDoc);

    this.yNodes.observeDeep(this.onNodesChanged);
    this.yEdges.observeDeep(this.onEdgesChanged);
    this.yMeta.observe(this.onMetaChanged);
    this.yExtras.observe(this.onExtrasChanged);
    this.awareness?.on('change', this.onAwarenessChanged);

    if (options.enableUndoManager) {
      this.undoManager = new Y.UndoManager(
        [this.yNodes, this.yEdges, this.yMeta, this.yExtras],
        { trackedOrigins: new Set([this.origin]) }
      );
    }

    options.onDocumentChange?.(this.getDocument());
    options.onAwarenessChange?.(this.getAwarenessEntries());
  }

  /** Current Y.Doc state projected for React, including CRDT-only z ranks. */
  getDocument(): CanvasDocument {
    return readCanvasDocumentFromYDoc(this.yDoc, { includeNodeRanks: true });
  }

  /**
   * Apply one surface edit without treating React's full object as authority.
   * `before` must be the projection the surface actually rendered when it
   * produced `after`, not a newer ref that may already contain a remote update.
   */
  applyLocalDocument(before: CanvasDocument, after: CanvasDocument): void {
    if (this.destroyed || before === after) return;
    this.yDoc.transact(() => {
      patchEntityCollection(
        this.yNodes,
        before.nodes ?? [],
        after.nodes ?? [],
        (entry, index) =>
          this.rankForInsertedNode(after.nodes ?? [], entry, index)
      );
      patchEntityCollection(this.yEdges, before.edges ?? [], after.edges ?? []);
      patchMapByIntent(this.yMeta, boardMeta(before), boardMeta(after));
      patchMapByIntent(this.yExtras, extras(before), extras(after));
    }, this.origin);
  }

  /**
   * Close the current undo step.
   *
   * `Y.UndoManager` merges transactions that land within its 500ms
   * `captureTimeout` into one step, which is what makes typing into a card undo
   * as a sentence rather than a letter at a time. It is also what would make two
   * quick drags of two different cards undo as one, so the surface calls this at
   * every gesture boundary.
   */
  stopCapturing(): void {
    this.undoManager?.stopCapturing();
  }

  setAwareness(patch: CanvasAwarenessPatch): void {
    if (!this.awareness || this.destroyed) return;
    const local = this.awareness.getLocalState() as Record<
      string,
      unknown
    > | null;
    const current = parseCanvasAwareness(local?.[CANVAS_AWARENESS_FIELD]) ?? {};
    const next: CanvasAwarenessState = { ...current };

    if ('cursor' in patch) {
      if (patch.cursor === null) delete next.cursor;
      else if (isPoint(patch.cursor)) next.cursor = { ...patch.cursor };
    }
    if ('viewport' in patch) {
      if (patch.viewport === null) delete next.viewport;
      else if (isViewportRect(patch.viewport))
        next.viewport = { ...patch.viewport };
    }
    if ('selectedNodeId' in patch) {
      if (patch.selectedNodeId === null) delete next.selectedNodeId;
      else if (typeof patch.selectedNodeId === 'string') {
        next.selectedNodeId = patch.selectedNodeId;
      }
    }
    if ('moving' in patch) {
      const moving = patch.moving;
      if (moving === null || moving === undefined || moving.length === 0) {
        delete next.moving;
      } else next.moving = moving.filter(isNodeGeometry).map(normalizeGeometry);
    }
    if ('agents' in patch) {
      const agents = patch.agents;
      if (agents === null || agents === undefined || agents.length === 0) {
        delete next.agents;
      } else next.agents = agents.map(normalizeAgentPresence);
    }

    // Yjs emits an `update` for `setLocalStateField` whether or not the value
    // moved, and every listener in the room wakes up for it. Callers publish
    // from React effects that re-run for reasons that have nothing to do with
    // presence -- a projection identity changing, a card being edited, a drag
    // frame republishing an unchanged selection -- so without this, ordinary
    // document work generates presence traffic that carries no information.
    if (sameAwarenessState(current, next)) return;

    this.awareness.setLocalStateField(
      CANVAS_AWARENESS_FIELD,
      Object.keys(next).length > 0 ? next : null
    );
  }

  /** This client's awareness id, so presence can leave your own cursor out. */
  getLocalClientId(): number | null {
    return this.awareness?.clientID ?? null;
  }

  getAwarenessEntries(): ReadonlyMap<number, CanvasAwarenessEntry> {
    const entries = new Map<number, CanvasAwarenessEntry>();
    for (const [clientId, raw] of this.awareness?.getStates() ?? []) {
      const state = raw as Record<string, unknown>;
      const canvas = parseCanvasAwareness(state[CANVAS_AWARENESS_FIELD]);
      if (!canvas) continue;
      const user = parseUser(state.user);
      entries.set(clientId, { clientId, ...canvas, ...(user ? { user } : {}) });
    }
    return entries;
  }

  undo(): boolean {
    if (!this.undoManager || this.undoManager.undoStack.length === 0) {
      return false;
    }
    this.undoManager.undo();
    return true;
  }

  redo(): boolean {
    if (!this.undoManager || this.undoManager.redoStack.length === 0) {
      return false;
    }
    this.undoManager.redo();
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.yNodes.unobserveDeep(this.onNodesChanged);
    this.yEdges.unobserveDeep(this.onEdgesChanged);
    this.yMeta.unobserve(this.onMetaChanged);
    this.yExtras.unobserve(this.onExtrasChanged);
    this.undoManager?.destroy();
    if (this.awareness) {
      this.awareness.off('change', this.onAwarenessChanged);
      try {
        this.awareness.setLocalStateField(CANVAS_AWARENESS_FIELD, null);
      } catch {
        // The host may have destroyed awareness first during provider teardown.
      }
    }
  }

  private projectTransaction(transaction: Y.Transaction): void {
    if (this.destroyed || this.lastProjectedTransaction === transaction) return;
    this.lastProjectedTransaction = transaction;
    this.options.onDocumentChange?.(this.getDocument());
  }

  private rankForInsertedNode(
    ordered: readonly CanvasAnyNode[],
    node: CanvasAnyNode,
    index: number
  ): string {
    const supplied = normalizeCanvasRank(node[CANVAS_NODE_RANK_FIELD]);
    if (supplied !== null) return supplied;

    const rankAt = (candidate: CanvasAnyNode): string | null =>
      normalizeCanvasRank(candidate[CANVAS_NODE_RANK_FIELD]) ??
      normalizeCanvasRank(
        this.yNodes.get(candidate.id)?.get(CANVAS_NODE_RANK_FIELD)
      );
    let lower: string | null = null;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      lower = rankAt(ordered[cursor]);
      if (lower !== null) break;
    }
    let upper: string | null = null;
    for (let cursor = index + 1; cursor < ordered.length; cursor += 1) {
      upper = rankAt(ordered[cursor]);
      if (upper !== null) break;
    }

    // Equal ranks can exist after concurrent same-position inserts. Their ids
    // already provide a total order; sharing that rank is the only valid key
    // between equal bounds and remains deterministic on every client.
    if (lower !== null && upper !== null && lower >= upper) return lower;
    return canvasRankBetween(lower, upper);
  }
}

function patchEntityCollection<T extends CanvasEntity>(
  target: Y.Map<Y.Map<unknown>>,
  before: readonly T[],
  after: readonly T[],
  rankForInsert?: (entry: T, index: number) => string
): void {
  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  const fieldsFor = (entry: T) =>
    rankForInsert
      ? canvasNodeFields(entry as CanvasAnyNode)
      : entityFields(entry);

  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) target.delete(id);
  }

  after.forEach((entry, index) => {
    const previous = beforeById.get(entry.id);
    let fields = target.get(entry.id);
    if (!fields) {
      fields = new Y.Map<unknown>();
      const incoming = fieldsFor(entry);
      for (const [key, value] of incoming) fields.set(key, value);
      if (rankForInsert && !incoming.has(CANVAS_NODE_RANK_FIELD)) {
        fields.set(CANVAS_NODE_RANK_FIELD, rankForInsert(entry, index));
      }
      target.set(entry.id, fields);
      return;
    }
    if (!previous) {
      // Simultaneous creation with the same content-derived id keeps the
      // existing entity map and converges through per-field writes.
      patchMapByIntent(fields, new Map(), fieldsFor(entry));
      if (rankForInsert && !fields.has(CANVAS_NODE_RANK_FIELD)) {
        fields.set(CANVAS_NODE_RANK_FIELD, rankForInsert(entry, index));
      }
      return;
    }
    patchMapByIntent(fields, fieldsFor(previous), fieldsFor(entry));
  });
}

function entityFields(entity: CanvasEntity): Map<string, unknown> {
  return new Map(Object.entries(entity).filter(([key]) => key !== 'id'));
}

function patchMapByIntent(
  target: Y.Map<unknown>,
  before: ReadonlyMap<string, unknown>,
  after: ReadonlyMap<string, unknown>
): void {
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const hadBefore = before.has(key);
    const hasAfter = after.has(key);
    if (hadBefore === hasAfter && jsonEqual(before.get(key), after.get(key))) {
      continue;
    }
    if (!hasAfter) target.delete(key);
    else if (!jsonEqual(target.get(key), after.get(key))) {
      target.set(key, after.get(key));
    }
  }
}

function boardMeta(document: CanvasDocument): Map<string, unknown> {
  const meta = document[NIMBALYST_CANVAS_NAMESPACE]?.meta;
  return new Map(isRecord(meta) ? Object.entries(meta) : []);
}

function extras(document: CanvasDocument): Map<string, unknown> {
  const result = new Map<string, unknown>();
  const topLevel: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (
      key !== 'nodes' &&
      key !== 'edges' &&
      key !== NIMBALYST_CANVAS_NAMESPACE
    ) {
      topLevel[key] = value;
    }
  }
  if (Object.keys(topLevel).length > 0) {
    result.set(CANVAS_EXTRAS_TOP_LEVEL, topLevel);
  }

  const namespace = document[NIMBALYST_CANVAS_NAMESPACE];
  if (isRecord(namespace)) {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(namespace)) {
      if (key !== 'meta') rest[key] = value;
    }
    if (Object.keys(rest).length > 0) {
      result.set(CANVAS_EXTRAS_NAMESPACE, rest);
    }
  }
  return result;
}

function parseCanvasAwareness(value: unknown): CanvasAwarenessState | null {
  if (!isRecord(value)) return null;
  const result: CanvasAwarenessState = {};
  if (isPoint(value.cursor)) result.cursor = { ...value.cursor };
  if (isViewportRect(value.viewport)) result.viewport = { ...value.viewport };
  if (typeof value.selectedNodeId === 'string') {
    result.selectedNodeId = value.selectedNodeId;
  }
  const moving = Array.isArray(value.moving)
    ? value.moving.filter(isNodeGeometry).map(normalizeGeometry)
    : [];
  if (moving.length > 0) result.moving = moving;
  const agents = parseAgents(value.agents);
  if (agents.length > 0) result.agents = agents;
  return Object.keys(result).length > 0 ? result : null;
}

function sameAwarenessState(
  left: CanvasAwarenessState,
  right: CanvasAwarenessState
): boolean {
  return jsonEqual(left, right);
}

function isNodeGeometry(value: unknown): value is CanvasAwarenessNodeGeometry {
  if (!isRecord(value) || !isViewportRect(value)) return false;
  return typeof value.nodeId === 'string' && value.nodeId.length > 0;
}

/** Awareness values are structured-cloned onto the wire; keep them plain. */
function normalizeGeometry(
  geometry: CanvasAwarenessNodeGeometry
): CanvasAwarenessNodeGeometry {
  return {
    nodeId: geometry.nodeId,
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
  };
}

/**
 * Parse defensively: awareness is remote input, and a peer on a newer build may
 * publish fields this one has never heard of. An entry missing `sessionId` /
 * `sessionName` is dropped rather than rendered as an anonymous halo.
 */
function parseAgents(value: unknown): readonly CanvasAgentPresence[] {
  if (!Array.isArray(value)) return [];
  const agents: CanvasAgentPresence[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      typeof raw.sessionId !== 'string' ||
      raw.sessionId.length === 0 ||
      typeof raw.sessionName !== 'string'
    ) {
      continue;
    }
    const nodeIds = Array.isArray(raw.nodeIds)
      ? raw.nodeIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0
        )
      : [];
    agents.push({
      sessionId: raw.sessionId,
      sessionName: raw.sessionName,
      nodeIds,
      ...(typeof raw.onBehalfOfUserId === 'string'
        ? { onBehalfOfUserId: raw.onBehalfOfUserId }
        : {}),
      ...(typeof raw.onBehalfOfDisplayName === 'string'
        ? { onBehalfOfDisplayName: raw.onBehalfOfDisplayName }
        : {}),
      ...(isPoint(raw.cursor) ? { cursor: { ...raw.cursor } } : {}),
      ...(isViewportRect(raw.viewport)
        ? { viewport: { ...raw.viewport } }
        : {}),
    });
  }
  return agents;
}

/** Awareness values are structured-cloned onto the wire; keep them plain. */
function normalizeAgentPresence(
  agent: CanvasAgentPresence
): CanvasAgentPresence {
  return {
    sessionId: agent.sessionId,
    sessionName: agent.sessionName,
    nodeIds: [...agent.nodeIds],
    ...(agent.onBehalfOfUserId === undefined
      ? {}
      : { onBehalfOfUserId: agent.onBehalfOfUserId }),
    ...(agent.onBehalfOfDisplayName === undefined
      ? {}
      : { onBehalfOfDisplayName: agent.onBehalfOfDisplayName }),
    ...(agent.cursor ? { cursor: { ...agent.cursor } } : {}),
    ...(agent.viewport ? { viewport: { ...agent.viewport } } : {}),
  };
}

function parseUser(
  value: unknown
): { id: string; name: string; color: string } | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.color !== 'string'
  ) {
    return null;
  }
  return { id: value.id, name: value.name, color: value.color };
}

function isPoint(value: unknown): value is CanvasAwarenessPoint {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  );
}

function isViewportRect(value: unknown): value is CanvasAwarenessViewportRect {
  if (!isPoint(value)) return false;
  const rect = value as CanvasAwarenessPoint & Record<string, unknown>;
  return (
    typeof rect.width === 'number' &&
    Number.isFinite(rect.width) &&
    rect.width >= 0 &&
    typeof rect.height === 'number' &&
    Number.isFinite(rect.height) &&
    rect.height >= 0
  );
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) => hasOwn(right, key) && jsonEqual(left[key], right[key])
      )
    );
  }
  return false;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
