/**
 * The one page tree (documents nest in documents, typed pages can be placed
 * under any page). Not exported from the docs barrel: the sidebar loads it
 * lazily, only for a page-tree scope, so it stays out of the docs-ui eager
 * bundle.
 */
import {
  buildCollabTreeAdaptive,
  compareTreeNodes,
  compareTypeNodes,
  createTypeNodes,
  isTypePageDocumentId,
  joinCollabPath,
  pageDisplayName,
  type CollabTreeItemNode,
  type CollabTreeNode,
  type CollabTreeTypeNode,
  type CollabTypeTreeResolver,
} from './collabTree';
import { isHomePageId } from './homePage';

import type { PageTreeSession } from './pageTreeSession';
import type { SharedDocument, SharedFolder, SharedItemPlacement, SharedParentKind, SharedTypePlacement } from './types';

export interface CollabPageTreeInput {
  resolver?: CollabTypeTreeResolver;
  typePlacements?: SharedTypePlacement[];
  itemPlacements?: SharedItemPlacement[];
}

/** Spacing for a re-spaced sibling group. */
export const RENUMBER_STEP = 1024;

/**
 * Sort orders below this were written by a reorder; placements made without
 * one carry a millisecond timestamp, far above it. A sibling group holding any
 * order below it has been reordered, and from then on pages, types and typed
 * pages share one order. A group nobody reordered keeps the kind blocks
 * (`compareTreeNodes`).
 */
const REORDERED_CEILING = 1e11;

const isReordered = (orders: Array<number | null>): boolean =>
  orders.some((order) => order !== null && order < REORDERED_CEILING);

/**
 * The order a new page gets at the end of its group: past every sibling once
 * the group has been reordered, and none (today's place by name) before that.
 */
export function nextSiblingOrder(siblingOrders: Array<number | null | undefined>): number | null {
  const orders = siblingOrders.map((order) => order ?? null);
  if (!isReordered(orders)) return null;
  return Math.max(...orders.filter((order): order is number => order !== null)) + RENUMBER_STEP;
}


/**
 * A new page's order at the end of its group under (parentId, parentKind):
 * pages, placed types and placed typed pages there (see `nextSiblingOrder`).
 */
export function nextPageOrder(
  documents: SharedDocument[],
  typePlacements: SharedTypePlacement[],
  itemPlacements: SharedItemPlacement[],
  parentId: string | null,
  parentKind: SharedParentKind,
): number | null {
  const sameParent = (id: string | null | undefined, kind: SharedParentKind | undefined) =>
    (id ?? null) === parentId && (parentId === null || (kind ?? 'page') === parentKind);
  return nextSiblingOrder([
    ...documents
      .filter((document) => document.trashedAt == null && !isTypePageDocumentId(document.documentId)
        && sameParent(document.parentFolderId, document.parentKind))
      .map((document) => document.sortOrder),
    ...typePlacements.filter((placement) => sameParent(placement.parentFolderId, placement.parentKind)).map((placement) => placement.sortOrder),
    ...itemPlacements.filter((placement) => sameParent(placement.parentId, placement.parentKind)).map((placement) => placement.sortOrder),
  ]);
}

/**
 * Whether a sibling under the tree row `parentNodeId` (null for root) already
 * shows `name`. Names compare as the tree shows them, so an older "Child.md"
 * and a new bare "Child" collide.
 */
export function pageNameTaken(
  tree: CollabTreeNode[],
  parentNodeId: string | null,
  name: string,
  documentType: string,
  exceptDocumentId?: string,
): boolean {
  const find = (nodes: CollabTreeNode[]): CollabTreeNode | undefined => {
    for (const node of nodes) {
      if (node.id === parentNodeId) return node;
      const hit = find(childList(node));
      if (hit) return hit;
    }
    return undefined;
  };
  const parent = parentNodeId ? find(tree) : undefined;
  const siblings = parentNodeId ? (parent ? childList(parent) : []) : tree;
  const wanted = pageDisplayName(name, documentType);
  return siblings.some((node) => node.type === 'document'
    && node.document.documentId !== exceptDocumentId
    && pageDisplayName(node.name, node.document.documentType) === wanted);
}

/**
 * Whether another page under (parentId, parentKind) already shows the name
 * `title` (default: the page's own title), for a rename or a move.
 */
export function pageNameConflict(
  tree: CollabTreeNode[],
  page: SharedDocument,
  parentId: string | null,
  parentKind: SharedParentKind | undefined,
  title = page.title,
): boolean {
  return pageNameTaken(tree, parentNodeIdOf(parentId, parentKind), title, page.documentType, page.documentId);
}

/** The tree row id of a parent: a page's or a typed page's, null for root. */
export const parentNodeIdOf = (parentId: string | null | undefined, parentKind: SharedParentKind | undefined): string | null =>
  !parentId ? null : `${parentKind === 'item' ? 'item' : 'document'}:${parentId}`;

/**
 * A type and every listed type whose `extends` chain reaches it, the type
 * first. Without `listedTypes` the resolver cannot name subtypes, so only the
 * type itself. Tolerates `extends` cycles.
 */
export function typeWithSubtypes(
  typeId: string,
  resolver: Pick<CollabTypeTreeResolver, 'typeExtends' | 'listedTypes'>,
): string[] {
  const result = [typeId];
  for (const { typeId: candidate } of resolver.listedTypes?.() ?? []) {
    if (candidate === typeId) continue;
    const seen = new Set([candidate]);
    let current = resolver.typeExtends?.(candidate) ?? null;
    while (current && !seen.has(current)) {
      if (current === typeId) {
        result.push(candidate);
        break;
      }
      seen.add(current);
      current = resolver.typeExtends?.(current) ?? null;
    }
  }
  return result;
}

/** How many items a type row counts: its own and its subtypes'. */
function typeItemCount(typeId: string, resolver: CollabTypeTreeResolver): number {
  return typeWithSubtypes(typeId, resolver)
    .reduce((total, id) => total + resolver.itemsOfType(id).length, 0);
}

const childList = (node: CollabTreeNode): CollabTreeNode[] => {
  if (node.type === 'type') return node.children;
  if (node.type === 'folder') return node.children;
  node.children ??= [];
  return node.children;
};

/** A node's order among its siblings; null for a page nobody ordered and an item under its type. */
function nodeSortOrder(node: CollabTreeNode): number | null {
  switch (node.type) {
    case 'document': return node.document.sortOrder ?? null;
    case 'type': return node.placement.sortOrder;
    case 'item': return node.placed ? node.sortOrder ?? null : null;
    default: return null;
  }
}

/** Home sits above its siblings and outside their order (see `homePage.ts`). */
const isPinnedHome = (node: CollabTreeNode): boolean => node.type === 'document' && isHomePageId(node.document.documentId);

function sortSiblings(nodes: CollabTreeNode[]): void {
  const ordered = nodes.filter((node) => !isPinnedHome(node));
  if (!isReordered(ordered.map(nodeSortOrder))) {
    ordered.sort(compareTreeNodes);
  } else {
    ordered.sort((left, right) => {
      const a = nodeSortOrder(left);
      const b = nodeSortOrder(right);
      if (a !== null && b !== null && a !== b) return a - b;
      if (a === null && b !== null) return 1;
      if (b === null && a !== null) return -1;
      return compareTreeNodes(left, right);
    });
  }
  nodes.splice(0, nodes.length, ...nodes.filter(isPinnedHome), ...ordered);
}

/** A type node's children keep their built order: subtypes, then items in the resolver's order. */
function sortPageTree(nodes: CollabTreeNode[], sortThisGroup = true): void {
  if (sortThisGroup) sortSiblings(nodes);
  for (const node of nodes) sortPageTree(childList(node), node.type !== 'type');
}

const parentKeyOf = (parentId: string | null | undefined, parentKind: SharedParentKind | undefined): string | null =>
  !parentId ? null : parentKind === 'item' ? `item:${parentId}` : `document:${parentId}`;

/**
 * The one page tree: pages, placed types and typed pages (tracker items) can
 * each sit under a page or a typed page; an unplaced typed page sits under its
 * type and can still hold children there. A node whose parent is not here (a
 * missing page, an item gone from the tracker) sits at root, except a typed
 * page placed under a missing page, which stays under its type. A corrupt
 * cycle (through pages, typed pages or a type) is broken by rooting the node
 * where the walk up repeats, so nothing ever disappears.
 */
export function buildCollabPageTree(
  documents: SharedDocument[],
  input: CollabPageTreeInput = {},
): CollabTreeNode[] {
  const nodes = new Map<string, CollabTreeNode>();
  const parentKeys = new Map<string, string | null>();
  const add = (node: CollabTreeNode, parentKey: string | null) => {
    if (nodes.has(node.id)) return;
    nodes.set(node.id, node);
    parentKeys.set(node.id, parentKey);
  };

  for (const page of documents) {
    if (isTypePageDocumentId(page.documentId)) continue;
    add({
      id: `document:${page.documentId}`,
      type: 'document',
      path: '',
      name: pageDisplayName(page.title, page.documentType) || page.documentId,
      document: page,
      children: [],
    }, parentKeyOf(page.parentFolderId, page.parentKind));
  }

  const { resolver } = input;
  if (resolver) {
    const itemNode = (itemId: string, typeId: string, title: string, placement?: SharedItemPlacement): CollabTreeItemNode => {
      const typeLabel = resolver.typeLabel?.(typeId) ?? resolver.typeName(typeId) ?? undefined;
      const typeError = resolver.typeError?.(typeId);
      return {
        id: `item:${itemId}`,
        type: 'item',
        itemId,
        typeId,
        path: '',
        name: title || itemId,
        children: [],
        ...(typeLabel ? { typeLabel } : {}),
        ...(typeError ? { typeError } : {}),
        ...(placement ? { placed: true, sortOrder: placement.sortOrder } : {}),
      };
    };
    const { nodes: typeNodes, parentType } = createTypeNodes(input.typePlacements ?? [], resolver);
    for (const node of typeNodes.values()) {
      node.count = typeItemCount(node.typeId, resolver);
      const base = parentType.get(node.typeId);
      add(node, base ? `type:${base}` : parentKeyOf(node.placement.parentFolderId, node.placement.parentKind));
    }
    const placedItemIds = new Set<string>();
    for (const placement of resolver.item ? input.itemPlacements ?? [] : []) {
      const parentKey = parentKeyOf(placement.parentId, placement.parentKind);
      if (parentKey?.startsWith('document:') && !nodes.has(parentKey)) continue;
      const item = resolver.item!(placement.itemId);
      if (!item || placedItemIds.has(item.itemId)) continue;
      placedItemIds.add(item.itemId);
      add(itemNode(item.itemId, item.typeId, item.title, placement), parentKey);
    }
    for (const node of typeNodes.values()) {
      for (const item of resolver.itemsOfType(node.typeId)) {
        if (!placedItemIds.has(item.itemId)) add(itemNode(item.itemId, node.typeId, item.title), `type:${node.typeId}`);
      }
    }
  }

  const effectiveParent = new Map<string, string | null>();
  const childrenByParent = new Map<string | null, CollabTreeNode[]>();
  for (const [id, key] of parentKeys) {
    const parentKey = key && key !== id && nodes.has(key) ? key : null;
    effectiveParent.set(id, parentKey);
    const siblings = childrenByParent.get(parentKey) ?? [];
    siblings.push(nodes.get(id)!);
    childrenByParent.set(parentKey, siblings);
  }

  const roots: CollabTreeNode[] = [];
  const attached = new Set<string>();
  const attach = (node: CollabTreeNode, parent: CollabTreeNode | null) => {
    if (attached.has(node.id)) return;
    attached.add(node.id);
    node.path = joinCollabPath(parent?.path ?? '', node.name);
    (parent ? childList(parent) : roots).push(node);
    let children = childrenByParent.get(node.id) ?? [];
    if (node.type === 'type') {
      const subtypes = children.filter((child): child is CollabTreeTypeNode => child.type === 'type').sort(compareTypeNodes);
      children = [...subtypes, ...children.filter((child) => child.type !== 'type')];
    }
    for (const child of children) attach(child, node);
  };
  for (const node of childrenByParent.get(null) ?? []) attach(node, null);
  for (const node of nodes.values()) {
    if (attached.has(node.id)) continue;
    // Unreachable from root means the walk up ends in a cycle: root where it repeats.
    const seen = new Set<string>();
    let current = node.id;
    while (!seen.has(current)) {
      seen.add(current);
      current = effectiveParent.get(current) ?? current;
    }
    attach(nodes.get(current)!, null);
  }

  sortPageTree(roots);
  return roots;
}

export type PageTreeDragged =
  | { kind: 'page'; documentId: string }
  | { kind: 'type'; typeId: string }
  | { kind: 'item'; itemId: string; typeId: string };

/** Where on a row a drag is: its upper or lower edge, or its middle. */
export type PageTreeDropZone = 'before' | 'inside' | 'after';

/** One row's new parent and order. A page's order is null until its group is reordered. */
export type PageTreeWrite =
  | { kind: 'page'; documentId: string; parentId: string | null; parentKind: SharedParentKind; sortOrder: number | null }
  | { kind: 'type'; typeId: string; parentFolderId: string | null; parentKind: SharedParentKind; sortOrder: number }
  | { kind: 'item'; itemId: string; parentId: string | null; parentKind: SharedParentKind; sortOrder: number };

/** What a drop writes: the dragged row, after any siblings re-spaced to make room (`renumber`). */
export type PageTreeDropPlan =
  | (PageTreeWrite & { renumber?: PageTreeWrite[] })
  | { kind: 'unplace-item'; itemId: string };

/** The upper and lower quarters of a row insert beside it; the middle drops inside. */
export function pageTreeDropZone(offsetY: number, height: number): PageTreeDropZone {
  if (offsetY < height / 4) return 'before';
  if (offsetY > height * 0.75) return 'after';
  return 'inside';
}

const nodeIdOf = (dragged: PageTreeDragged): string =>
  dragged.kind === 'page' ? `document:${dragged.documentId}` : dragged.kind === 'type' ? `type:${dragged.typeId}` : `item:${dragged.itemId}`;

/**
 * A sort order that lands at `index` among `orders` (ascending), or null when
 * there is no room: a neighbour with no order, tied neighbours, or a gap too
 * small for a distinct float.
 */
function orderAt(orders: Array<number | null>, index: number): number | null {
  const prev = orders[index - 1];
  const next = orders[index];
  if (prev === null || next === null) return null;
  const order = prev !== undefined && next !== undefined ? (prev + next) / 2
    : next !== undefined ? next - 1
      : prev !== undefined ? prev + 1
        : Date.now();
  if (prev !== undefined && !(order > prev)) return null;
  if (next !== undefined && !(order < next)) return null;
  return order;
}

/** A sibling's write when its group is re-spaced; null for a row that has no order of its own. */
function siblingWrite(node: CollabTreeNode, parentId: string | null, parentKind: SharedParentKind, sortOrder: number): PageTreeWrite | null {
  if (node.type === 'document') return { kind: 'page', documentId: node.document.documentId, parentId, parentKind, sortOrder };
  if (node.type === 'type') return { kind: 'type', typeId: node.typeId, parentFolderId: parentId, parentKind, sortOrder };
  if (node.type === 'item' && node.placed) return { kind: 'item', itemId: node.itemId, parentId, parentKind, sortOrder };
  return null;
}

/**
 * Plan dropping `dragged` on the row `targetId`. An edge drop lands in the
 * row's parent next to it; a middle drop lands inside the row (a page or a
 * typed page). Null means the drop is refused or changes nothing.
 *
 * Order (one order across pages, types and typed pages): an edge drop is a
 * reorder. In a group nobody reordered yet it re-spaces the whole group in its
 * displayed order; after that it takes the gap at the drop point, re-spacing
 * only when there is none. A middle drop lands at the end of the group.
 *
 * A subtype always renders inside its placed base (see `createTypeNodes`), so
 * it moves only within that base. A drop that would put a row inside itself is
 * refused, also when the way up passes through a type node (an unplaced typed
 * page sits under its type, which the server cannot see).
 */
export function planPageTreeDrop(
  tree: CollabTreeNode[],
  dragged: PageTreeDragged,
  targetId: string,
  zone: PageTreeDropZone,
): PageTreeDropPlan | null {
  const parents = new Map<string, CollabTreeNode | null>();
  const nodes = new Map<string, CollabTreeNode>();
  const index = (list: CollabTreeNode[], parent: CollabTreeNode | null) => {
    for (const node of list) {
      nodes.set(node.id, node);
      parents.set(node.id, parent);
      index(childList(node), node);
    }
  };
  index(tree, null);
  const target = nodes.get(targetId);
  const draggedId = nodeIdOf(dragged);
  if (!target || targetId === draggedId) return null;
  const container = zone === 'inside' ? target : parents.get(targetId) ?? null;
  const anchor = zone === 'inside' ? null : target;
  const children = container ? childList(container) : tree;
  const currentParent = parents.get(draggedId) ?? null;
  // A pinned Home is not part of the order: a drop beside it lands first.
  const others = children.filter((node) => node.id !== draggedId && !isPinnedHome(node));
  const at = !anchor ? others.length
    : isPinnedHome(anchor) ? 0
      : others.findIndex((node) => node.id === anchor.id) + (zone === 'after' ? 1 : 0);

  // Not inside itself or below itself, also when the way up passes through a
  // type node (an unplaced typed page sits under its type).
  for (let node: CollabTreeNode | null = container; node; node = parents.get(node.id) ?? null) {
    if (node.id === draggedId) return null;
  }

  if (container?.type === 'type') {
    if (dragged.kind === 'item') {
      // Back under its own type; the order there is the type's, not the tree's.
      const node = nodes.get(draggedId);
      return node?.type === 'item' && node.placed && container.typeId === dragged.typeId
        ? { kind: 'unplace-item', itemId: dragged.itemId }
        : null;
    }
    if (dragged.kind !== 'type' || currentParent?.id !== container.id) return null;
    const parentFolderId = container.placement.parentFolderId ?? null;
    const parentKind = container.placement.parentKind ?? 'page';
    const subtypes = others.filter((node): node is CollabTreeTypeNode => node.type === 'type');
    const self = nodes.get(draggedId) as CollabTreeTypeNode | undefined;
    if (!anchor) return { kind: 'type', typeId: dragged.typeId, parentFolderId, parentKind, sortOrder: self?.placement.sortOrder ?? 0 };
    const subtypeAt = subtypes.findIndex((node) => node.id === anchor.id) + (zone === 'after' ? 1 : 0);
    const orders = subtypes.map((node) => node.placement.sortOrder);
    const sortOrder = orderAt(orders, subtypeAt);
    if (sortOrder !== null) return { kind: 'type', typeId: dragged.typeId, parentFolderId, parentKind, sortOrder };
    const spaced = (position: number) => (position + 1) * RENUMBER_STEP;
    const renumber = subtypes
      .map((node, position) => ({ node, next: spaced(position < subtypeAt ? position : position + 1) }))
      .filter(({ node, next }) => node.placement.sortOrder !== next)
      .map(({ node, next }): PageTreeWrite => ({ kind: 'type', typeId: node.typeId, parentFolderId, parentKind, sortOrder: next }));
    return { kind: 'type', typeId: dragged.typeId, parentFolderId, parentKind, sortOrder: spaced(subtypeAt), ...(renumber.length ? { renumber } : {}) };
  }

  if (container && container.type !== 'document' && container.type !== 'item') return null;
  if (dragged.kind === 'type' && currentParent?.type === 'type') return null;
  const parentId = container?.type === 'document' ? container.document.documentId
    : container?.type === 'item' ? container.itemId
      : null;
  const parentKind: SharedParentKind = container?.type === 'item' ? 'item' : 'page';
  const write = (sortOrder: number | null): PageTreeWrite => {
    if (dragged.kind === 'page') return { kind: 'page', documentId: dragged.documentId, parentId, parentKind, sortOrder };
    const order = sortOrder ?? Date.now();
    return dragged.kind === 'type'
      ? { kind: 'type', typeId: dragged.typeId, parentFolderId: parentId, parentKind, sortOrder: order }
      : { kind: 'item', itemId: dragged.itemId, parentId, parentKind, sortOrder: order };
  };
  const sameParent = (currentParent?.id ?? null) === (container?.id ?? null);
  const orders = others.map(nodeSortOrder);
  const reordered = isReordered(orders);

  if (!anchor) {
    if (sameParent) return null;
    if (!reordered) {
      // Today's place: a page by name, a type or typed page after its own kind.
      if (dragged.kind === 'page') return write(null);
      const kind = dragged.kind === 'type' ? 'type' : 'item';
      const ownKind = others.filter((node) => node.type === kind && (kind === 'type' || (node as CollabTreeItemNode).placed));
      return write(orderAt(ownKind.map(nodeSortOrder), ownKind.length));
    }
  }
  if (reordered) {
    const sortOrder = orderAt(orders, at);
    if (sortOrder !== null) return write(sortOrder);
  }
  const spaced = (position: number) => (position + 1) * RENUMBER_STEP;
  const renumber = others
    .map((node, position) => ({ node, next: spaced(position < at ? position : position + 1) }))
    .filter(({ node, next }) => nodeSortOrder(node) !== next)
    .map(({ node, next }) => siblingWrite(node, parentId, parentKind, next))
    .filter((entry): entry is PageTreeWrite => entry !== null);
  return { ...write(spaced(at)), ...(renumber.length ? { renumber } : {}) };
}

/** The parts of a drag event a row drop reads (a React or DOM drag event). */
interface RowDragEvent {
  clientY: number;
  currentTarget: { getBoundingClientRect(): { top: number; height: number }; contains(node: never): boolean };
  relatedTarget: unknown;
  dataTransfer: { dropEffect: string };
  preventDefault(): void;
  stopPropagation(): void;
}

export interface PageTreeRowDropContext {
  tree: CollabTreeNode[];
  dragged: PageTreeDragged | null;
  documents: SharedDocument[];
  dropIndicator: { nodeId: string; zone: 'before' | 'after' } | null;
  dropTargetPath: string | null;
  setDropIndicator(value: { nodeId: string; zone: 'before' | 'after' } | null): void;
  setDropTargetPath(value: string | null): void;
  /** A drop the planner accepted, for the host to write. */
  onDropPlan(plan: PageTreeDropPlan, zone: PageTreeDropZone, node: CollabTreeNode): void;
}

/** Plan a drop at the pointer; a page that changes parent also needs a free name there. */
function planRowDrop(context: PageTreeRowDropContext, node: CollabTreeNode, event: RowDragEvent) {
  if (!context.dragged) return null;
  const rect = event.currentTarget.getBoundingClientRect();
  const zone = pageTreeDropZone(event.clientY - rect.top, rect.height);
  const plan = planPageTreeDrop(context.tree, context.dragged, node.id, zone);
  if (plan?.kind === 'page') {
    const moved = context.documents.find((document) => document.documentId === plan.documentId);
    const sameParent = (moved?.parentFolderId ?? null) === plan.parentId
      && (plan.parentId === null || (moved?.parentKind ?? 'page') === plan.parentKind);
    if (moved && !sameParent && pageNameConflict(context.tree, moved, plan.parentId, plan.parentKind)) return null;
  }
  return plan ? { plan, zone } : null;
}

/**
 * A page-tree row as a drop target: an edge drop inserts beside the row (a
 * line above or below it), the middle drops inside (the row highlighted).
 */
export function pageTreeRowDrop(context: PageTreeRowDropContext, node: CollabTreeNode) {
  const { dropIndicator, dropTargetPath, setDropIndicator, setDropTargetPath } = context;
  return {
    onDragOver: (event: RowDragEvent) => {
      const planned = planRowDrop(context, node, event);
      if (!planned) {
        if (dropIndicator?.nodeId === node.id) setDropIndicator(null);
        if (dropTargetPath === node.path) setDropTargetPath(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      if (planned.zone === 'inside') {
        if (dropIndicator) setDropIndicator(null);
        if (dropTargetPath !== node.path) setDropTargetPath(node.path);
      } else {
        if (dropTargetPath) setDropTargetPath(null);
        if (dropIndicator?.nodeId !== node.id || dropIndicator.zone !== planned.zone) {
          setDropIndicator({ nodeId: node.id, zone: planned.zone });
        }
      }
    },
    onDragLeave: (event: RowDragEvent) => {
      event.stopPropagation();
      if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as never)) return;
      if (dropTargetPath === node.path) setDropTargetPath(null);
      if (dropIndicator?.nodeId === node.id) setDropIndicator(null);
    },
    onDrop: (event: RowDragEvent) => {
      const planned = planRowDrop(context, node, event);
      if (!planned) return;
      event.preventDefault();
      event.stopPropagation();
      context.onDropPlan(planned.plan, planned.zone, node);
    },
    className: dropIndicator?.nodeId === node.id
      ? ` collab-tree-drop-${dropIndicator.zone}`
      : dropTargetPath === node.path ? ' drag-over' : '',
  };
}

/**
 * Move or reorder a page in the page tree through the session. Says what
 * happened: refused for a taken name or a cycle, nothing to do, or done.
 */
export function movePageInTree(
  session: PageTreeSession,
  tree: CollabTreeNode[],
  page: SharedDocument,
  parentId: string | null,
  options: { parentKind?: SharedParentKind; sortOrder?: number | null } = {},
): 'taken' | 'cycle' | 'unchanged' | 'reordered' | 'moved' {
  const parentKind = options.parentKind ?? 'page';
  const sameParent = (page.parentFolderId ?? null) === parentId
    && (parentId === null || (page.parentKind ?? 'page') === parentKind);
  if (sameParent && options.sortOrder === undefined) return 'unchanged';
  if (!sameParent && pageNameConflict(tree, page, parentId, parentKind)) return 'taken';
  if (!session.movePage(page.documentId, parentId, options)) return 'cycle';
  return sameParent ? 'reordered' : 'moved';
}

/** Where a move puts a row: under a page or typed page (null id = root), or back under its own type. */
export type PageTreeDestination = { parentId: string | null; parentKind: SharedParentKind } | { underType: true };

/**
 * Send a typed page to a destination through the session, refusing one that
 * would put it inside itself (also through its type). Every path uses this:
 * drops, the row menu's "Back under its type" and the move dialog.
 */
export function moveItemInTree(
  session: PageTreeSession,
  tree: CollabTreeNode[],
  itemId: string,
  destination: PageTreeDestination,
): 'cycle' | ReturnType<PageTreeSession['setItemPlacement']> {
  const under = 'underType' in destination;
  if (treeMoveRefused(tree, `item:${itemId}`, under
    ? { underOwnType: true }
    : { nodeId: parentNodeIdOf(destination.parentId, destination.parentKind) })) {
    return 'cycle';
  }
  return under
    ? session.removeItemPlacement(itemId)
    : session.setItemPlacement(itemId, destination.parentId, undefined, destination.parentKind);
}

/** Apply one row's write from a drop plan through the docs session. */
export function applyPageTreeWrite(session: PageTreeSession, write: PageTreeWrite, onError: (error: unknown) => void): void {
  if (write.kind === 'page') {
    session.movePage(write.documentId, write.parentId, { parentKind: write.parentKind, sortOrder: write.sortOrder });
  } else if (write.kind === 'type') {
    session.moveTypePlacement(write.typeId, write.parentFolderId, write.sortOrder, write.parentKind).catch(onError);
  } else {
    void session.setItemPlacement(write.itemId, write.parentId, write.sortOrder, write.parentKind).then((result) => {
      if (!result.ok) onError(new Error(result.error));
    });
  }
}

/**
 * Whether moving the row `movingNodeId` under a row (`nodeId`, null for root)
 * or, for a typed page, back under its own type would put it inside itself, walking up
 * the tree as shown, type nodes included. The menu and the move dialog ask
 * this before writing; drops go through `planPageTreeDrop`, which does the
 * same.
 */
export function treeMoveRefused(
  tree: CollabTreeNode[],
  movingNodeId: string,
  target: { nodeId: string | null } | { underOwnType: true },
): boolean {
  const parents = new Map<string, CollabTreeNode | null>();
  const nodes = new Map<string, CollabTreeNode>();
  const index = (list: CollabTreeNode[], parent: CollabTreeNode | null) => {
    for (const node of list) {
      nodes.set(node.id, node);
      parents.set(node.id, parent);
      index(childList(node), node);
    }
  };
  index(tree, null);
  const moving = nodes.get(movingNodeId);
  const containerId = 'nodeId' in target ? target.nodeId : moving?.type === 'item' ? `type:${moving.typeId}` : null;
  for (let node = containerId ? nodes.get(containerId) ?? null : null; node; node = parents.get(node.id) ?? null) {
    if (node.id === movingNodeId) return true;
  }
  return false;
}

/** The tree for a scope: the one page tree when the store says so, else folders. */
export function buildCollabTreeForScope(input: CollabPageTreeInput & {
  pageTree: boolean;
  documents: SharedDocument[];
  folders: SharedFolder[];
}): CollabTreeNode[] {
  if (input.pageTree) return buildCollabPageTree(input.documents, input);
  return buildCollabTreeAdaptive(
    input.documents,
    input.folders,
    input.resolver ? { placements: input.typePlacements ?? [], resolver: input.resolver } : undefined,
  );
}
